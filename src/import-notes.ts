import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MindGraph } from "mindgraph";
import { requireHumanTerminal } from "./agent-shell.js";
import { loadConsentStore, pathContains, resolveConsent, type OnDecision } from "./consent.js";
import { COMMAND, displayPath, storeProblem, type ConsentIo } from "./consent-cli.js";
import { nodeGit, printable, type GitRunner } from "./consent-plan.js";
import { assertEvalBaseUrl, evalBaseUrlRefusal, evalHomeRefusal, isLoopbackUrl } from "./eval-guard.js";
import { loadHookEnv, mindgraphConfigDir, passwdHome, type HookEnv } from "./hook-env.js";
import { containsSecret } from "./hook-memory.js";

/**
 * `import notes`: copy Claude Code's auto-memory notes for a consented root
 * into that root's memory space, one item per note, with no model call.
 *
 * The notes stay the source: this module reads the memory folder and never
 * writes to it. Identity is the note's path inside the folder (the item's
 * `custom_id`); a changed content hash is a new revision of the same item; a
 * note that disappears, or is now left out, is hidden (tombstoned) on the next
 * import. A local manifest records what was sent so unchanged notes are
 * skipped; the server's `custom_id` upsert stays the source of truth.
 */

export const ID_PREFIX = "claude-auto-memory:";
export const SOURCE = "claude_auto_memory";
/** The server's limit for one remembered text (`REMEMBER_TEXT_MAX_BYTES`). */
export const TEXT_MAX_BYTES = 8 * 1024;
const CUSTOM_ID_MAX_BYTES = 512;
const READ_MAX_BYTES = 64 * 1024;
const SETTINGS_MAX_BYTES = 1024 * 1024;
const WALK_MAX_DEPTH = 5;
const WALK_MAX_ENTRIES = 2_000;
const ANCHORS_PER_NOTE = 50;
const INDEX_FILES = new Set(["MEMORY.md", "CATALOG.md", "README.md", "ARCHIVE.md"]);
/** Frontmatter `mindgraph: skip` leaves a note out of every import. */
export const OPT_OUT_KEY = "mindgraph";
export const OPT_OUT_VALUE = "skip";
/** Hex characters of the per-source part of every `custom_id`. */
const SOURCE_TAG_LENGTH = 12;

// ── Secrets ───────────────────────────────────────────────────────────

/** Shapes the import treats as secrets on top of `containsSecret`, which was
 * written for redaction: it needs a word boundary before a key name and a
 * closed PEM block, so `AWS_SECRET_ACCESS_KEY=...` or half a private key
 * would pass. A note that matches is left out whole, so these lean wide. */
const IMPORT_SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/,
  /[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i,
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /npm_[A-Za-z0-9]{36}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /FlyV1 /,
];

/** Whether the import must leave `text` (a note, its path or its name) out. */
export function looksLikeSecret(text: string): boolean {
  return containsSecret(text) || IMPORT_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// ── Filesystem seam ───────────────────────────────────────────────────

export interface NoteStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
}

/** Every read the import makes goes through this, so tests can see it. */
export interface NoteFs {
  lstat(p: string): NoteStat | undefined;
  readdir(p: string): string[];
  readFile(p: string): string;
  realpath(p: string): string | undefined;
}

export const nodeNoteFs: NoteFs = {
  lstat: (p) => {
    try {
      const s = fs.lstatSync(p);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
      };
    } catch {
      return undefined;
    }
  },
  readdir: (p) => fs.readdirSync(p),
  readFile: (p) => fs.readFileSync(p, "utf8"),
  realpath: (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return undefined;
    }
  },
};

// ── Where Claude Code keeps the notes ─────────────────────────────────

/** Claude Code's configuration directory: `CLAUDE_CONFIG_DIR` when it is an
 * absolute path, else `.claude` in the account's home directory. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir && path.isAbsolute(dir)) return path.normalize(dir);
  const home = passwdHome();
  return home ? path.join(home, ".claude") : undefined;
}

/** Claude Code's project folder name for a launch directory: the absolute
 * path with every character that is not a letter or digit replaced by `-`. */
export function projectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

export interface MemoryLocation {
  dir: string;
  /** Which setting chose the folder. */
  source: "default" | "project_name" | "user" | "local";
  settingsFile?: string;
}

function readSettings(file: string, nfs: NoteFs): Record<string, unknown> | undefined {
  const stat = nfs.lstat(file);
  if (!stat?.isFile || stat.size > SETTINGS_MAX_BYTES) return undefined;
  try {
    const parsed = JSON.parse(nfs.readFile(file)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether git tracks `rel` in `root`; a failed git call counts as no. */
function tracked(root: string, rel: string, git: GitRunner): boolean {
  try {
    git(["-C", root, "ls-files", "--error-unmatch", "--", rel]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The auto-memory folder Claude Code uses for `root`: `autoMemoryDirectory`
 * from local settings that git does not track, then user settings (absolute
 * or `~/` only), else
 * `<config dir>/projects/<CLAUDE_CODE_PROJECT_DIR_NAME or slug>/memory`.
 * Like Claude Code, the checked-in `.claude/settings.json` is never honoured:
 * a cloned repository must not choose which of your folders is read.
 */
export function findMemoryDirectory(
  root: string,
  env: NodeJS.ProcessEnv,
  nfs: NoteFs = nodeNoteFs,
  git: GitRunner = nodeGit(env),
): MemoryLocation | undefined {
  const config = claudeConfigDir(env);
  const local = path.join(".claude", "settings.local.json");
  const candidates: Array<[MemoryLocation["source"], string | undefined]> = [
    ["local", tracked(root, local, git) ? undefined : path.join(root, local)],
    ["user", config ? path.join(config, "settings.json") : undefined],
  ];
  for (const [source, file] of candidates) {
    if (!file) continue;
    const value = readSettings(file, nfs)?.autoMemoryDirectory;
    if (typeof value !== "string" || value === "") continue;
    let dir: string | undefined;
    if (value.startsWith("~/")) {
      const home = passwdHome();
      dir = home ? path.join(home, value.slice(2)) : undefined;
    } else if (path.isAbsolute(value)) {
      dir = path.normalize(value);
    }
    if (dir) return { dir, source, settingsFile: file };
  }
  if (!config) return undefined;
  const named = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CODE_PROJECT_DIR_NAME : undefined;
  if (named && /^[^/\\]+$/.test(named) && named !== "." && named !== "..") {
    return { dir: path.join(config, "projects", named, "memory"), source: "project_name" };
  }
  return { dir: path.join(config, "projects", projectSlug(root), "memory"), source: "default" };
}

/** The nearest directory at or above `dir` holding `.git`. */
function repositoryAbove(dir: string, nfs: NoteFs): string | undefined {
  let current = dir;
  for (;;) {
    if (nfs.lstat(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Why `dir` (a real path) can never be a notes folder, if it cannot: a
 * file-system root, the home folder, or `root` itself or a folder above it. */
export function unsafeMemoryDir(dir: string, root: string, nfs: NoteFs = nodeNoteFs): string | undefined {
  if (dir.length < 3 || path.dirname(dir) === dir) return "a file-system root";
  const home = passwdHome();
  if (home && (dir === home || dir === nfs.realpath(home))) return "your home folder";
  if (pathContains(dir, root) || pathContains(dir, nfs.realpath(root) ?? root)) {
    return `${displayPath(root)} itself or a folder above it`;
  }
  return undefined;
}

// ── Reading the notes ─────────────────────────────────────────────────

/** Top-level keys and one nested level (`metadata.type`), lower-cased. A
 * frontmatter block without its closing `---` counts as none. */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const out: Record<string, string> = {};
  let parent: string | undefined;
  for (let i = 1; i < lines.length && i < 200; i++) {
    const line = lines[i];
    if (line.trim() === "---" || line.trim() === "...") return out;
    const match = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, indent, key, raw] = match;
    const value = raw.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (indent.length === 0) {
      parent = value === "" ? key.toLowerCase() : undefined;
      out[key.toLowerCase()] = value;
    } else if (parent) {
      out[`${parent}.${key.toLowerCase()}`] = value;
    }
  }
  return {};
}

export type ExcludeReason =
  | "index"
  | "user"
  | "opted_out"
  | "secret"
  | "too_large"
  | "empty"
  | "name_too_long"
  | "link"
  | "repository";

export interface Anchor {
  /** Path relative to the consented root, with `/` separators. */
  path: string;
  /** `git hash-object --no-filters` of the file when the note was sent. */
  blob: string;
}

export interface FoundNote {
  logical: string;
  bytes: number;
  reason?: ExcludeReason;
  /** Set only for notes that may be sent. */
  text?: string;
  label?: string;
  sha256?: string;
}

/** Every `.md` file under `dir` (no links followed, no dot entries, no nested
 * repositories), classified. Excluded notes keep no text. `complete` is false
 * when a folder could not be listed or the entry cap was reached: a note
 * missing from `notes` then may still exist. */
export function readNotes(
  dir: string,
  options: { includeUser: boolean; nfs?: NoteFs },
): { notes: FoundNote[]; complete: boolean } {
  const nfs = options.nfs ?? nodeNoteFs;
  const out: FoundNote[] = [];
  let seen = 0;
  let complete = true;
  const walk = (current: string, depth: number) => {
    let names: string[];
    try {
      names = nfs.readdir(current).sort();
    } catch {
      complete = false;
      return;
    }
    for (const name of names) {
      if (++seen > WALK_MAX_ENTRIES) {
        complete = false;
        return;
      }
      if (name.startsWith(".")) continue;
      const full = path.join(current, name);
      const logical = path.relative(dir, full).split(path.sep).join("/");
      const stat = nfs.lstat(full);
      if (!stat) continue;
      if (stat.isSymbolicLink) {
        if (name.endsWith(".md")) out.push({ logical, bytes: 0, reason: "link" });
        continue;
      }
      if (stat.isDirectory) {
        if (nfs.lstat(path.join(full, ".git"))) {
          out.push({ logical: `${logical}/`, bytes: 0, reason: "repository" });
        } else if (depth < WALK_MAX_DEPTH && name !== "node_modules") {
          walk(full, depth + 1);
        }
        continue;
      }
      if (!stat.isFile || !name.endsWith(".md")) continue;
      out.push(classify(full, logical, stat.size, depth === 0 && INDEX_FILES.has(name), options.includeUser, nfs));
    }
  };
  walk(dir, 0);
  return { notes: out, complete };
}

function classify(
  file: string,
  logical: string,
  size: number,
  index: boolean,
  includeUser: boolean,
  nfs: NoteFs,
): FoundNote {
  // A path is the item's key and label, so a secret in it is a secret sent.
  if (looksLikeSecret(logical)) return { logical, bytes: size, reason: "secret" };
  if (index) return { logical, bytes: size, reason: "index" };
  if (size > READ_MAX_BYTES) return { logical, bytes: size, reason: "too_large" };
  let raw: string;
  try {
    raw = nfs.readFile(file);
  } catch {
    return { logical, bytes: size, reason: "empty" };
  }
  // The secret check runs first: a matching note is named, never described.
  if (looksLikeSecret(raw)) return { logical, bytes: size, reason: "secret" };
  const front = parseFrontmatter(raw);
  if ((front[OPT_OUT_KEY] ?? "").toLowerCase() === OPT_OUT_VALUE) {
    return { logical, bytes: size, reason: "opted_out" };
  }
  const isUser = (value: string | undefined) => (value ?? "").toLowerCase() === "user";
  if (!includeUser && (isUser(front.type) || isUser(front["metadata.type"]))) {
    return { logical, bytes: size, reason: "user" };
  }
  const text = raw.trim();
  const bytes = Buffer.byteLength(text);
  if (!text) return { logical, bytes, reason: "empty" };
  if (bytes > TEXT_MAX_BYTES) return { logical, bytes, reason: "too_large" };
  if (Buffer.byteLength(ID_PREFIX + logical) + SOURCE_TAG_LENGTH + 1 > CUSTOM_ID_MAX_BYTES) {
    return { logical, bytes, reason: "name_too_long" };
  }
  const label = front.name?.slice(0, 120) || path.basename(logical, ".md");
  if (looksLikeSecret(label)) return { logical, bytes, reason: "secret" };
  return {
    logical,
    bytes,
    text,
    label,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

/** Backticked strings that look like file paths, without a `:line` suffix. */
export function anchorCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]{1,300})`/g)) {
    const s = match[1].trim().replace(/:\d+(?:-\d+)?(?::\d+)?$/, "");
    if (!s || /\s/.test(s) || s.startsWith("-") || s.includes("://")) continue;
    if (!s.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(s)) continue;
    out.add(s);
    if (out.size >= ANCHORS_PER_NOTE) break;
  }
  return [...out];
}

/** Anchors for the candidates that are regular files git tracks inside `root`
 * (real paths, outside `.git`), each with its blob hash. Untracked and
 * ignored files such as `.env` get none: a content hash of a secrets file
 * confirms a guessed value. */
export function resolveAnchors(
  root: string,
  candidates: string[],
  git: GitRunner,
  nfs: NoteFs = nodeNoteFs,
): Anchor[] {
  const rels: string[] = [];
  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
    const real = nfs.realpath(abs);
    if (!real || real === root || !pathContains(root, real)) continue;
    const rel = path.relative(root, real);
    if (rel.split(path.sep).includes(".git") || !nfs.lstat(real)?.isFile) continue;
    const posix = rel.split(path.sep).join("/");
    if (!rels.includes(posix)) rels.push(posix);
  }
  if (rels.length === 0) return [];
  let known: Set<string>;
  try {
    known = new Set(git(["-C", root, "ls-files", "-z", "--", ...rels]).split("\0"));
  } catch {
    return [];
  }
  const kept = rels.filter((rel) => known.has(rel));
  rels.length = 0;
  rels.push(...kept);
  if (rels.length === 0) return [];
  let hashes: string[];
  try {
    hashes = git(["-C", root, "hash-object", "--no-filters", "--", ...rels])
      .trim()
      .split(/\r?\n/);
  } catch {
    return [];
  }
  if (hashes.length !== rels.length) return [];
  return rels.map((rel, i) => ({ path: rel, blob: hashes[i].trim() }));
}

// ── Manifest (what this machine sent) ─────────────────────────────────

export interface SentNote {
  sha256: string;
  custom_id: string;
  anchors: Anchor[];
  imported_at: string;
}

/** An item sent into another space that still has to be hidden there. */
export interface PendingHide {
  logical: string;
  custom_id: string;
  space_uid: string;
}

/** Where items went: the server and organization, as hooks.json names them. */
export interface Destination {
  base_url: string;
  org_id: string | null;
}

export interface ManifestEntry extends Destination {
  root: string;
  memory_dir: string;
  space_uid: string;
  notes: Record<string, SentNote>;
  /** Kept until each forget succeeds, so a failed run cannot lose them. */
  hide?: PendingHide[];
}

interface Manifest {
  v: 1;
  /** Random, made once per MindGraph home; part of every item key. */
  source_id?: string;
  imports: Record<string, ManifestEntry>;
}

export function manifestPath(env: NodeJS.ProcessEnv): string {
  return path.join(mindgraphConfigDir(env).dir, "import-notes.json");
}

export function destinationOf(stored: HookEnv): Destination {
  return {
    base_url: (stored.baseUrl || "https://api.mindgraph.cloud").replace(/\/+$/, ""),
    org_id: stored.orgId || null,
  };
}

/** One record per notes folder and destination: a new server or
 * organization starts empty, and nothing is hidden there for notes sent
 * elsewhere. */
function manifestKey(root: string, memoryDir: string, to: Destination): string {
  return crypto
    .createHash("sha256")
    .update([root, memoryDir, to.base_url, to.org_id ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/** The per-source part of the item keys: this MindGraph home and this notes
 * folder. Space ids are shared across an organization, so without it two
 * people with a note at the same path would overwrite and hide each other's
 * items. */
export function sourceTag(sourceId: string, memoryDir: string): string {
  return crypto.createHash("sha256").update(`${sourceId}\u0000${memoryDir}`).digest("hex").slice(0, SOURCE_TAG_LENGTH);
}

function loadManifest(file: string): Manifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
    if (parsed?.v === 1 && typeof parsed.imports === "object" && parsed.imports) {
      parsed.source_id ||= crypto.randomUUID();
      return parsed;
    }
  } catch {
    // Missing or unreadable: every note is sent again under a new source id.
  }
  return { v: 1, source_id: crypto.randomUUID(), imports: {} };
}

/** What a run starts from: the notes already sent into `space`, and the
 * items left in other spaces that still have to be hidden. An item pending in
 * `space` itself rejoins `notes` with no hash, so it is sent again if the
 * note is still there and hidden if not. */
export function carryOver(
  previous: ManifestEntry | undefined,
  space: string,
): { notes: Record<string, SentNote>; hide: PendingHide[] } {
  const ours = (id: unknown): id is string => typeof id === "string" && id.startsWith(ID_PREFIX);
  const notes: Record<string, SentNote> = {};
  const pending: PendingHide[] = [...(Array.isArray(previous?.hide) ? previous.hide : [])];
  for (const [logical, sent] of Object.entries(previous?.notes ?? {})) {
    if (previous!.space_uid === space) notes[logical] = sent;
    else pending.push({ logical, custom_id: sent.custom_id, space_uid: previous!.space_uid });
  }
  for (const [logical, sent] of Object.entries(notes)) if (!ours(sent.custom_id)) delete notes[logical];
  const hide: PendingHide[] = [];
  for (const item of pending) {
    if (!ours(item.custom_id) || typeof item.space_uid !== "string") continue;
    if (item.space_uid !== space) {
      if (!hide.some((h) => h.space_uid === item.space_uid && h.custom_id === item.custom_id)) hide.push(item);
    } else {
      notes[item.logical] ??= { sha256: "", custom_id: item.custom_id, anchors: [], imported_at: "" };
    }
  }
  return { notes, hide };
}

function saveManifest(file: string, manifest: Manifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// ── Plan ──────────────────────────────────────────────────────────────

export interface PlannedNote extends FoundNote {
  status: "new" | "updated";
  text: string;
  label: string;
  sha256: string;
  custom_id: string;
  anchors: Anchor[];
}

export interface Withdrawal {
  logical: string;
  custom_id: string;
  space_uid: string;
  why: "deleted" | "moved" | ExcludeReason;
}

export interface ImportPlan {
  root: string;
  memory: MemoryLocation;
  space_uid: string;
  send: PlannedNote[];
  unchanged: string[];
  excluded: FoundNote[];
  withdraw: Withdrawal[];
  /** False when the folder could not be read in full; nothing is then
   * hidden as deleted. */
  complete: boolean;
}

export function planImport(input: {
  root: string;
  memory: MemoryLocation;
  space_uid: string;
  /** `sourceTag` of this home and notes folder. */
  source: string;
  previous?: ManifestEntry;
  includeUser: boolean;
  git: GitRunner;
  nfs?: NoteFs;
}): ImportPlan {
  const nfs = input.nfs ?? nodeNoteFs;
  const read = readNotes(input.memory.dir, { includeUser: input.includeUser, nfs });
  const found = read.notes;
  // Notes sent to another space are hidden there and sent again here.
  const { notes: before, hide } = carryOver(input.previous, input.space_uid);
  const plan: ImportPlan = {
    root: input.root,
    memory: input.memory,
    space_uid: input.space_uid,
    send: [],
    unchanged: [],
    excluded: [],
    withdraw: [],
    complete: read.complete,
  };
  const present = new Map(found.map((note) => [note.logical, note]));
  for (const note of found) {
    if (note.reason) {
      plan.excluded.push(note);
      continue;
    }
    const prior = before[note.logical];
    if (prior?.sha256 === note.sha256) {
      plan.unchanged.push(note.logical);
      continue;
    }
    plan.send.push({
      ...(note as Required<Pick<FoundNote, "text" | "label" | "sha256">> & FoundNote),
      status: prior ? "updated" : "new",
      custom_id: prior?.custom_id ?? `${ID_PREFIX}${input.source}:${note.logical}`,
      anchors: resolveAnchors(input.root, anchorCandidates(note.text!), input.git, nfs),
    });
  }
  for (const item of hide) plan.withdraw.push({ ...item, why: "moved" });
  for (const [logical, sent] of Object.entries(before)) {
    const now = present.get(logical);
    if (now && !now.reason) continue;
    // A note the walk did not reach may still be there.
    if (!now && !read.complete) continue;
    plan.withdraw.push({ logical, custom_id: sent.custom_id, space_uid: input.space_uid, why: now?.reason ?? "deleted" });
  }
  return plan;
}

// ── The card ──────────────────────────────────────────────────────────

const REASON_TEXT: Record<ExcludeReason, string> = {
  index: "Indexes, not notes",
  user: `About you (type user); add --include-user to send them`,
  opted_out: `Marked "${OPT_OUT_KEY}: ${OPT_OUT_VALUE}" in their frontmatter`,
  secret: "Text that looks like a secret (names only; nothing from them is shown or sent)",
  too_large: `Longer than ${TEXT_MAX_BYTES / 1024} KB, the most one item holds`,
  empty: "Empty or unreadable",
  name_too_long: "File path too long to use as the item's key",
  link: "Links (not followed)",
  repository: "Repositories inside the memory folder (never read)",
};

const WITHDRAW_TEXT: Record<Withdrawal["why"], string> = {
  deleted: "no longer in the folder",
  moved: "imported before into other memory; sent again here",
  index: "now an index",
  user: "now type user",
  opted_out: `now marked "${OPT_OUT_KEY}: ${OPT_OUT_VALUE}"`,
  secret: "now holds text that looks like a secret",
  too_large: `now longer than ${TEXT_MAX_BYTES / 1024} KB`,
  empty: "now empty or unreadable",
  name_too_long: "path now too long",
  link: "now a link",
  repository: "now a repository",
};

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function importCard(plan: ImportPlan, decision: OnDecision, stored: HookEnv): string[] {
  const name = (s: string) => printable(s);
  const baseUrl = (stored.baseUrl || "https://api.mindgraph.cloud").replace(/\/+$/, "");
  const org = stored.orgId ? `organization ${stored.orgId}` : "the API key's default organization";
  const what = decision.repo
    ? `repository ${path.basename(decision.repo.root)}`
    : `${decision.kind === "workspace" ? "workspace" : "repository"} ${path.basename(decision.root)}`;
  const from =
    plan.memory.source === "default" || plan.memory.source === "project_name"
      ? `(Claude Code's memory for ${displayPath(plan.root)})`
      : `(set by autoMemoryDirectory in ${displayPath(plan.memory.settingsFile!)})`;
  const lines = [
    "Import your Claude Code notes into MindGraph?",
    "",
    `From  ${name(displayPath(plan.memory.dir))}`,
    `      ${name(from)}`,
  ];
  if (plan.memory.source === "local") {
    lines.push(
      `      A settings file inside ${name(displayPath(plan.root))} chose this folder. Check that it is`,
      "      the folder that holds your notes before you import.",
    );
  }
  if (isLoopbackUrl(baseUrl)) {
    lines.push(`To    MindGraph on this machine (${baseUrl}), memory for ${name(what)} (${plan.space_uid})`);
    lines.push("      Nothing leaves this machine.");
  } else {
    lines.push(`To    ${baseUrl}, ${name(org)}, memory for ${name(what)} (${plan.space_uid})`);
    lines.push(
      "      These notes will leave this machine. Anyone holding an API key for that",
      "      organization can read them; the memory label does not limit who can read.",
    );
  }
  lines.push("", "What would be sent");
  const linked = plan.send.filter((n) => n.anchors.length > 0).length;
  if (plan.send.length === 0) {
    lines.push("  Nothing new or changed.");
  } else {
    const fresh = plan.send.filter((n) => n.status === "new").length;
    lines.push(
      `  ${plan.send.length} note${plan.send.length === 1 ? "" : "s"}: ${fresh} new, ${plan.send.length - fresh} updated${linked ? `; ${linked} name${linked === 1 ? "s" : ""} files git tracks in ${displayPath(plan.root)}` : ""}.`,
    );
    const width = Math.min(48, Math.max(...plan.send.map((n) => n.logical.length)));
    for (const note of plan.send) {
      const links = note.anchors.length ? `  names ${note.anchors.length} file${note.anchors.length === 1 ? "" : "s"}` : "";
      lines.push(`    ${note.status.padEnd(7)}  ${name(note.logical).padEnd(width)}  ${size(note.bytes).padStart(7)}${links}`);
    }
  }
  if (plan.unchanged.length) {
    lines.push(`  ${plan.unchanged.length} unchanged since the last import are skipped.`);
  }
  if (plan.withdraw.length) {
    lines.push(`  ${plan.withdraw.length} imported before will be hidden in MindGraph (restorable):`);
    for (const gone of plan.withdraw) {
      lines.push(`    ${name(gone.logical)}  ${WITHDRAW_TEXT[gone.why]} (hidden in ${name(gone.space_uid)})`);
    }
  }
  if (!plan.complete) {
    lines.push(
      "  Part of the notes folder could not be read, so notes missing from this",
      "  list are not hidden this time.",
    );
  }
  if (plan.excluded.length) {
    lines.push("Never sent");
    for (const reason of Object.keys(REASON_TEXT) as ExcludeReason[]) {
      const notes = plan.excluded.filter((n) => n.reason === reason);
      if (!notes.length) continue;
      lines.push(`  ${REASON_TEXT[reason]}:`);
      for (const note of notes) {
        lines.push(`    ${looksLikeSecret(note.logical) ? "(a file whose path looks like a secret)" : name(note.logical)}`);
      }
    }
  }
  lines.push(
    "How",
    "  One MindGraph item per note, stored as written. Nothing is extracted from it",
    "  and the import makes no language-model call (MindGraph indexes each item for",
    "  search, as it does every memory). Your files are never changed. Importing",
    "  again sends changed notes only and hides notes you deleted. A hidden item",
    "  can be restored, and earlier revisions stay in an item's history. Items",
    "  are keyed to this notes folder on this machine, so an import never changes",
    "  or hides notes someone else, or another machine, imported.",
  );
  return lines;
}

// ── Sending ───────────────────────────────────────────────────────────

/** The two memory routes the import uses. */
export interface ImportClient {
  remember(body: Record<string, unknown>): Promise<unknown>;
  forget(body: Record<string, unknown>): Promise<unknown>;
}

/** The SDK client posting to `/memory/v1/remember` and `/memory/v1/forget`.
 * mindgraph 0.17.0 has no memory v1 method, so this uses its request helper
 * (auth, org header, error type) through a narrow cast. */
export function sdkImportClient(stored: HookEnv): ImportClient {
  const client = new MindGraph({
    baseUrl: assertEvalBaseUrl(stored.baseUrl || "https://api.mindgraph.cloud"),
    apiKey: stored.apiKey,
    orgId: stored.orgId,
    maxRetries: 1,
    timeoutMs: 30_000,
    telemetrySurface: "mcp",
  });
  const post = (client as unknown as { post?: (p: string, b: unknown) => Promise<unknown> }).post;
  if (typeof post !== "function") {
    throw new Error("This version of the MindGraph SDK cannot send memory requests.");
  }
  return {
    remember: (body) => post.call(client, "/memory/v1/remember", body),
    forget: (body) => post.call(client, "/memory/v1/forget", body),
  };
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function rawCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; body?: { code?: unknown } };
  const code = e?.code ?? e?.body?.code;
  return typeof code === "string" ? code : undefined;
}

function errorCode(error: unknown): string {
  return rawCode(error) ?? (errorStatus(error) ? `HTTP ${errorStatus(error)}` : "no response");
}

export interface SendResult {
  sent: { new: number; updated: number; unchanged: number };
  hidden: number;
  failed: Array<{ logical: string; code: string }>;
  /** Why the run stopped early: no response, or a refusal that would apply
   * to every remaining request (credentials, permission, rate limit, or a
   * space this key cannot see). */
  stopped: false | "unreachable" | "refused";
}

/** Send the plan. Each success is recorded in `entry` as it lands; a request
 * that gets no response, or a refusal for the whole run, stops the rest. */
export async function sendImport(
  plan: ImportPlan,
  client: ImportClient,
  entry: ManifestEntry,
  now: () => Date,
): Promise<SendResult> {
  const result: SendResult = { sent: { new: 0, updated: 0, unchanged: 0 }, hidden: 0, failed: [], stopped: false };
  const stop = (error: unknown): SendResult["stopped"] => {
    const status = errorStatus(error);
    if (status === undefined || status === 0 || status >= 500) return "unreachable";
    if (status === 401 || status === 403 || status === 429 || rawCode(error) === "scope_not_found") return "refused";
    return false;
  };
  const hidden = (gone: Withdrawal) => {
    if (gone.space_uid === entry.space_uid) {
      if (entry.notes[gone.logical]?.custom_id === gone.custom_id) delete entry.notes[gone.logical];
    } else {
      entry.hide = (entry.hide ?? []).filter((h) => !(h.space_uid === gone.space_uid && h.custom_id === gone.custom_id));
    }
  };
  for (const note of plan.send) {
    try {
      const response = (await client.remember({
        scope: { space_uid: plan.space_uid },
        text: note.text,
        custom_id: note.custom_id,
        label: note.label,
        props: {
          source: SOURCE,
          logical_path: note.logical,
          content_sha256: note.sha256,
          anchors: note.anchors,
        },
      })) as { action?: unknown } | undefined;
      const action = response?.action;
      if (action === "unchanged") result.sent.unchanged++;
      else if (action === "updated" || note.status === "updated") result.sent.updated++;
      else result.sent.new++;
      entry.notes[note.logical] = {
        sha256: note.sha256,
        custom_id: note.custom_id,
        anchors: note.anchors,
        imported_at: now().toISOString(),
      };
    } catch (error) {
      result.failed.push({ logical: note.logical, code: errorCode(error) });
      result.stopped = stop(error);
      if (result.stopped) return result;
    }
  }
  for (const gone of plan.withdraw) {
    try {
      await client.forget({
        scope: { space_uid: gone.space_uid },
        custom_id: gone.custom_id,
        reason: `Claude Code note ${gone.why === "deleted" ? "removed" : "left out of the import"}`,
      });
      result.hidden++;
      hidden(gone);
    } catch (error) {
      // Only a missing item is already gone; `scope_not_found` and other
      // 404s leave it live, so it stays on the list.
      if (errorStatus(error) === 404 && rawCode(error) === "not_found") {
        hidden(gone);
        continue;
      }
      result.failed.push({ logical: gone.logical, code: errorCode(error) });
      result.stopped = stop(error);
      if (result.stopped) return result;
    }
  }
  return result;
}

// ── Command ───────────────────────────────────────────────────────────

export interface ImportOptions {
  dryRun?: boolean;
  includeUser?: boolean;
  nfs?: NoteFs;
  /** Tests inject a recording client; the default is the SDK. */
  client?: (stored: HookEnv) => ImportClient;
}

const OFF_HERE = `MindGraph is off here. Turn it on first: ${COMMAND} on`;

/** `import notes [path]`. Returns the exit code. */
export async function runImportNotes(
  target: string | undefined,
  io: ConsentIo,
  options: ImportOptions = {},
): Promise<number> {
  // A dry run reads and prints only, so like `off --all --dry-run` it runs
  // from any shell.
  if (!options.dryRun) {
    const terminal = requireHumanTerminal(io);
    if (!terminal.ok) {
      io.err(terminal.message);
      return 2;
    }
  }
  // An evaluation run imports only from its own MINDGRAPH_HOME: without one
  // it would read the person's real consent store and connection settings.
  const homeRefusal = evalHomeRefusal(io.env);
  if (homeRefusal) {
    io.err(homeRefusal);
    return 1;
  }
  const loaded = loadConsentStore(io.env);
  const problem = storeProblem(loaded);
  if (problem) {
    io.err(problem);
    return 1;
  }
  const directory = path.resolve(io.cwd, target ?? ".");
  const decision = resolveConsent(directory, loaded, { env: io.env });
  if (decision.state !== "on") {
    io.err(decision.reason === "hooks_paused" ? "MINDGRAPH_HOOKS=off is set in this shell, so MindGraph is off; nothing was read." : OFF_HERE);
    return 1;
  }
  const root = decision.repo?.root ?? decision.root;
  if (!decision.space_uid) {
    io.err(
      `${displayPath(root)} has no memory space of its own yet, so there is nowhere to import to; nothing was read or sent.`,
    );
    return 1;
  }
  const nfs = options.nfs ?? nodeNoteFs;
  const git = io.git ?? nodeGit(io.env);
  const memory = findMemoryDirectory(root, io.env, nfs, git);
  const memoryDir = memory && nfs.realpath(memory.dir);
  if (!memory || !memoryDir || !nfs.lstat(memoryDir)?.isDirectory) {
    io.out(
      `No Claude Code notes found for ${displayPath(root)}${memory ? ` (looked in ${printable(displayPath(memory.dir))})` : ""}; nothing to import.`,
    );
    return 0;
  }
  const unsafe = unsafeMemoryDir(memoryDir, root, nfs);
  if (unsafe) {
    io.err(
      `The notes folder ${printable(displayPath(memoryDir))}` +
        (memory.settingsFile ? ` (set by autoMemoryDirectory in ${printable(displayPath(memory.settingsFile))})` : "") +
        ` is ${printable(unsafe)}, so it is never read as a notes folder; nothing was read or sent.`,
    );
    return 1;
  }
  const repository = repositoryAbove(memoryDir, nfs);
  if (repository) {
    io.err(
      `The notes folder ${printable(displayPath(memoryDir))} is inside the repository ${printable(displayPath(repository))}. ` +
        "Notes in a repository are written by its authors, so they are never imported; nothing was read or sent.",
    );
    return 1;
  }
  const located: MemoryLocation = { ...memory, dir: memoryDir };
  const file = manifestPath(io.env);
  const manifest = loadManifest(file);
  const stored = loadHookEnv(mindgraphConfigDir(io.env).dir);
  const destination = destinationOf(stored);
  // An evaluation run imports only into a loopback server; refuse before the
  // card, so nothing is asked and nothing is sent.
  const evalRefusal = evalBaseUrlRefusal(destination.base_url, io.env);
  if (evalRefusal) {
    io.err(evalRefusal);
    return 1;
  }
  const key = manifestKey(root, memoryDir, destination);
  const previous = manifest.imports[key];
  const plan = planImport({
    root,
    memory: located,
    space_uid: decision.space_uid,
    source: sourceTag(manifest.source_id!, memoryDir),
    previous,
    includeUser: options.includeUser === true,
    git,
    nfs,
  });
  for (const line of importCard(plan, decision, stored)) io.out(line);
  // Items sent to another server or organization are left alone there: a
  // forget sent here could only hit someone else's items.
  const elsewhere = Object.entries(manifest.imports).filter(
    ([k, e]) => k !== key && e.root === root && e.memory_dir === memoryDir && Object.keys(e.notes ?? {}).length > 0,
  );
  for (const [, e] of elsewhere) {
    io.out(
      `Notes imported before to ${printable(e.base_url ?? "another MindGraph")}${e.org_id ? `, organization ${printable(e.org_id)}` : ""} ` +
        "stay there; this import does not change or hide them. Hide them there if you no longer want them.",
    );
  }
  io.out("");
  if (options.dryRun) {
    io.out("Dry run: nothing was sent.");
    return 0;
  }
  if (plan.send.length === 0 && plan.withdraw.length === 0) {
    io.out("Nothing to send.");
    return 0;
  }
  if (!stored.apiKey) {
    io.err(
      `No API key is saved for MindGraph on this machine, so nothing was sent. Save one with ${COMMAND} install-hooks --harness claude-code --api-key <key>`,
    );
    return 1;
  }
  const action = [
    plan.send.length ? `send ${plan.send.length} note${plan.send.length === 1 ? "" : "s"}` : "",
    plan.withdraw.length ? `hide ${plan.withdraw.length}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  io.out(`  1. Import: ${action}`);
  io.out("  2. Not now");
  let choice: string | undefined;
  for (let attempt = 0; attempt < 5 && choice === undefined; attempt++) {
    const answer = (await io.ask("Choose 1-2. Enter repeats the question. ")).trim();
    if (answer === "1" || answer === "2") choice = answer;
  }
  if (choice !== "1") {
    io.out("Not now: nothing was sent.");
    return 0;
  }
  // Items left in another space stay listed under `hide` until each forget
  // succeeds, so a run that stops partway cannot lose them.
  const carried = carryOver(previous, plan.space_uid);
  const entry: ManifestEntry = {
    root,
    memory_dir: memoryDir,
    ...destination,
    space_uid: plan.space_uid,
    notes: { ...carried.notes },
    hide: [...carried.hide],
  };
  const client = (options.client ?? sdkImportClient)(stored);
  const result = await sendImport(plan, client, entry, io.now ?? (() => new Date()));
  manifest.imports[key] = entry;
  saveManifest(file, manifest);
  const imported = result.sent.new + result.sent.updated + result.sent.unchanged;
  io.out(
    `Imported ${imported} note${imported === 1 ? "" : "s"} into memory for ${path.basename(root)}: ` +
      `${result.sent.new} new, ${result.sent.updated} updated, ${plan.unchanged.length + result.sent.unchanged} unchanged; ${result.hidden} hidden.`,
  );
  if (plan.excluded.length) {
    io.out(`Left out: ${plan.excluded.length} (listed above under "Never sent").`);
  }
  if (result.failed.length) {
    io.err(
      result.stopped === "unreachable"
        ? "MindGraph stopped responding; the rest were not sent. Run the import again when it responds."
        : result.stopped === "refused"
          ? `MindGraph refused the import (${printable(result.failed[result.failed.length - 1].code)}), so the rest were not tried. Check the API key, organization and memory space, then run the import again.`
          : "Some notes were not imported:",
    );
    for (const failure of result.failed) io.err(`  ${printable(failure.logical)}: ${failure.code}`);
    return 1;
  }
  return 0;
}
