import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathContains } from "./consent.js";
import { CHANGED_MARK, CHARS_PER_TOKEN, cleanTitle, moreLine, TITLES_LINE } from "./session-block.js";

/**
 * The action-time line: after a successful Edit, MultiEdit or Write of a file
 * that memory is anchored to, the titles of that memory, read from the
 * session's local anchor table. This path makes no network call and spawns no
 * process: the table is read once per process and the file's git blob hash is
 * computed in-process.
 */

/** Tools whose successful call can bring the line (Read is not matched). */
export const ACTION_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
export const ACTION_MAX_TOKENS = 200;
const ACTION_MAX_ITEMS = 3;
/** Files larger than this are not hashed; their items carry no mark. */
const HASH_MAX_BYTES = 8 * 1024 * 1024;

export const STALE_LINE =
  "Marked (code changed since): code changed since this was written; check it, and supersede it if it is wrong (open it for its uid, then save the correction with supersedes_uid set to that uid).";
const OPEN_ONE = "Open one: mindgraph_memory action=open handle=<handle>";

export interface TableEntry {
  handle: string;
  title: string;
  /** The file's git blob hash when the item was written; absent in tables
   * written before it was recorded. */
  blob?: string;
}

export interface ActionCandidate {
  /** Real path of the edited file. */
  real: string;
  /** The path shown to the model, relative to the repository. */
  display: string;
  entries: TableEntry[];
  /** Whether the file's current blob differs from the one stored with the
   * entry. Lazy and memoised: the file is read and hashed only when a line
   * is actually composed. */
  stale: (entry: TableEntry) => boolean;
}

/** Where the session is: the consented repository root the anchor table is
 * keyed by and, in a linked worktree of it, that worktree's top. */
export interface ActionPlace {
  root: string;
  worktree?: string;
}

type Table = { repositories?: Record<string, Record<string, TableEntry[]>> };
let cached: { file: string; mtimeMs: number; size: number; table: Table } | undefined;

/** The anchor table, read once per process (and again only if it changed). */
export function readAnchorTableFile(file: string): Table | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined; // No anchored memory this session.
  }
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.table;
  }
  // A corrupt table throws: the caller counts it as a fail-open.
  const table = JSON.parse(fs.readFileSync(file, "utf8")) as Table;
  cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, table };
  return table;
}

/** Git's blob hash of `content`: SHA-1 for a 40-hex anchor, SHA-256 for a
 * 64-hex anchor (a sha256 object-format repository). Same as
 * `git hash-object --no-filters`. */
export function gitBlobHash(content: Buffer, hexLength: number): string {
  return crypto
    .createHash(hexLength === 64 ? "sha256" : "sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

/** Whether a tool result is a failure in any of the shapes hooks receive. */
function failed(response: unknown): boolean {
  if (typeof response === "string") return /^\s*(error|<tool_use_error>)/i.test(response);
  if (!response || typeof response !== "object") return false;
  const r = response as Record<string, unknown>;
  return Boolean(r.error) || r.is_error === true || r.isError === true || r.success === false;
}

/**
 * The memory anchored to the file a successful edit touched, or undefined.
 * Throws only on a corrupt table (the caller fails open and counts it).
 */
export function actionCandidate(
  input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown; cwd: string },
  place: ActionPlace,
  tableFile: string,
): ActionCandidate | undefined {
  if (!ACTION_TOOLS.has(input.tool_name || "") || failed(input.tool_response)) return undefined;
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath) return undefined;
  let real: string;
  try {
    real = fs.realpathSync.native(path.resolve(input.cwd, filePath));
  } catch {
    return undefined;
  }
  // The table is keyed by the consented repository's own checkout. A file in
  // the session's linked worktree is looked up at the same relative path there
  // (the worktree may sit inside that checkout, so it is tried first), and
  // its own content is what gets hashed.
  const base = place.worktree && pathContains(place.worktree, real) ? place.worktree : place.root;
  if (!pathContains(base, real)) return undefined;
  const rel = path.relative(base, real);
  let key = real;
  if (base !== place.root) {
    key = path.join(place.root, rel);
    try {
      key = fs.realpathSync.native(key);
    } catch {
      // Not in the main checkout (a file new in this worktree): the joined path.
    }
  }
  const listed = readAnchorTableFile(tableFile)?.repositories?.[place.root]?.[key];
  if (!Array.isArray(listed) || listed.length === 0) return undefined;
  const entries = listed
    .filter((e) => e && typeof e.handle === "string" && typeof e.title === "string")
    .map((e) => ({
      handle: e.handle,
      title: e.title,
      blob: typeof e.blob === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(e.blob) ? e.blob : undefined,
    }));
  if (entries.length === 0) return undefined;
  let content: Buffer | null | undefined;
  const hashes = new Map<number, string | undefined>();
  const current = (hexLength: number): string | undefined => {
    if (!hashes.has(hexLength)) {
      if (content === undefined) {
        try {
          content = fs.statSync(real).size <= HASH_MAX_BYTES ? fs.readFileSync(real) : null;
        } catch {
          content = null;
        }
      }
      hashes.set(hexLength, content ? gitBlobHash(content, hexLength) : undefined);
    }
    return hashes.get(hexLength);
  };
  // File level only: with a symbol's span hash an edit elsewhere in the file
  // would leave the mark off, but anchors carry no span yet.
  const stale = (entry: TableEntry): boolean => {
    if (!entry.blob) return false;
    const now = current(entry.blob.length);
    return Boolean(now && now !== entry.blob);
  };
  const display = cleanTitle(rel.split(path.sep).join("/")) || ".";
  return { real, display, entries, stale };
}

/** The top of the linked worktree holding `directory`: the first directory
 * upward with a `.git` file (a stat per level, no process). Memoised. */
const worktreeTops = new Map<string, string | undefined>();
export function worktreeTop(directory: string): string | undefined {
  if (worktreeTops.has(directory)) return worktreeTops.get(directory);
  let top: string | undefined;
  for (let dir = directory; ; dir = path.dirname(dir)) {
    try {
      if (fs.statSync(path.join(dir, ".git")).isFile()) top = dir;
      break;
    } catch {
      // No .git here: keep walking up.
    }
    if (path.dirname(dir) === dir) break;
  }
  worktreeTops.set(directory, top);
  return top;
}

/**
 * The line, within `roomChars` (at most 200 tokens): a header, the "not
 * instructions" framing, up to three quoted titles, the staleness note when
 * one is marked, and how many more. Undefined when not even one title fits.
 */
export function renderActionLine(
  candidate: { display: string; entries: Array<TableEntry & { stale: boolean }> },
  roomChars: number,
): { text: string; handles: string[] } | undefined {
  const room = Math.min(roomChars, ACTION_MAX_TOKENS * CHARS_PER_TOKEN);
  const head = [`MindGraph: memory attached to ${candidate.display}`, TITLES_LINE, OPEN_ONE];
  const rows: string[] = [];
  const handles: string[] = [];
  let stale = false;
  const compose = (extraStale: boolean, shown: number) =>
    [
      ...head,
      ...rows,
      ...(stale || extraStale ? [STALE_LINE] : []),
      ...(shown < candidate.entries.length ? [`and ${moreLine(candidate.entries.length - shown)}`] : []),
    ].join("\n");
  for (const entry of candidate.entries) {
    if (rows.length >= ACTION_MAX_ITEMS) break;
    const row = `  [${entry.handle}] ${JSON.stringify(cleanTitle(entry.title))}${entry.stale ? CHANGED_MARK : ""}`;
    rows.push(row);
    if (compose(entry.stale, rows.length).length > room) {
      rows.pop();
      break;
    }
    handles.push(entry.handle);
    stale ||= entry.stale;
  }
  if (rows.length === 0) return undefined;
  return { text: compose(false, rows.length), handles };
}

/** Said once per context in place of a line when the budget is spent. */
export function actionSpentLine(budget: number, items: number): string {
  return `MindGraph: session memory budget used (${budget.toLocaleString("en-US")} tokens). ${items} item${items === 1 ? "" : "s"} attached to files you touched ${items === 1 ? "was" : "were"} not shown: mindgraph_memory action=index`;
}

// ── Scope check (no spend) ────────────────────────────────────────────

/** What the hooks recorded about the items they may inject and did. */
export interface ScopeRecord {
  /** handle → [uid, the item's own space as the server reported it]. Only
   * live, current items are recorded: replaced and out-of-date items are
   * never given a handle. */
  known?: Record<string, [string, string]>;
  /** handle → the consented place's space when it was injected. */
  injected?: Record<string, string>;
  /** uids this session replaced with a supersedes_uid write, in order. */
  replaced?: string[];
  /** Items named by action-time lines, in order: [handle, uid, how many
   * entries `replaced` had then]. */
  named?: Array<[string, string, number]>;
  /** Prompt recall's injected items: uid (or label) → [the item's space as
   * the response reported it ("" when it did not), the consented space].
   * Recall reads across spaces, so these are checked one by one. */
  recalled?: Record<string, [string, string]>;
}

export interface ScopeResult {
  injected: number;
  problems: string[];
}

/**
 * Every injected item came from the consented place's own space, and none
 * was named at an edited file after this session replaced it. Deterministic
 * over the recorded ledger.
 */
export function checkScope(record: ScopeRecord | undefined): ScopeResult {
  const injected = Object.entries(record?.injected ?? {});
  const recalled = Object.entries(record?.recalled ?? {});
  const problems: string[] = [];
  for (const [handle, space] of injected) {
    const fact = record?.known?.[handle];
    if (!fact) problems.push(`${handle}: injected, but not among the current items read from this place's memory`);
    else if (fact[1] !== space) problems.push(`${handle}: stored in ${fact[1] || "an unnamed space"}, not ${space}`);
  }
  const replaced = record?.replaced ?? [];
  for (const [handle, uid, before] of record?.named ?? []) {
    if (uid && replaced.slice(0, before).includes(uid)) {
      problems.push(`${handle}: named at an edited file after this session replaced it`);
    }
  }
  for (const [key, [space, consented]] of recalled) {
    if (!space) problems.push(`${key}: recalled for a prompt; its space was not reported, so it was not checked`);
    else if (space !== consented) problems.push(`${key}: recalled for a prompt from ${space}, not ${consented}`);
  }
  return { injected: injected.length + recalled.length, problems };
}

export function formatScope(result: ScopeResult): string {
  if (result.problems.length === 0) {
    return `Scope: ${result.injected} item${result.injected === 1 ? "" : "s"} injected, all from this place's own memory space and none named after this session replaced it.`;
  }
  return [`Scope check failed: ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} over ${result.injected} injected items.`, ...result.problems.map((p) => `  ${p}`)].join("\n");
}
