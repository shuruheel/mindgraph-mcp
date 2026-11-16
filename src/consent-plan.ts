import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeRemote } from "./codegraph.js";
import { nodeConsentFs, pathContains, READ_MAX } from "./consent.js";
import { passwdHome } from "./hook-env.js";

/**
 * What `on` would turn on for a directory. Planning runs git to find
 * repository tops and remotes but never writes; the identities that may need
 * a file (`resolveRepositoryId`) are resolved only after the person confirms.
 */

/** Runs git with argv (no shell) and returns stdout; throws on failure. */
export type GitRunner = (args: string[]) => string;

const GIT_ENV_DROP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
];

export function nodeGit(env: NodeJS.ProcessEnv = process.env): GitRunner {
  const clean: NodeJS.ProcessEnv = { ...env };
  // A variable such as GIT_DIR would make every repository look like one.
  for (const key of GIT_ENV_DROP) delete clean[key];
  return (args) =>
    execFileSync("git", args, {
      env: clean,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).toString("utf8");
}

export class ConsentPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentPlanError";
  }
}

export interface PlannedRepository {
  /** The `root` as the workspace file writes it, for the card. */
  name: string;
  /** Real path. */
  root: string;
  /** A `repo_id` the workspace file declares, when it is well formed. */
  declared_repo_id?: string;
  space_uid: string | null;
}

export interface RefusedEntry {
  /** The `root` as written, or a placeholder when there is none. */
  name: string;
  reason: string;
}

export interface RepoPlan {
  kind: "repo";
  /** Real path of the directory `on` was given. */
  target: string;
  /** Real path of the repository's top level. */
  root: string;
}

export interface WorkspacePlan {
  kind: "workspace";
  target: string;
  /** Real path of the directory holding `.mindgraph/workspace.json`. */
  root: string;
  workspace_file: string;
  /** Hash of the exact bytes this plan was made from. */
  workspace_sha256: string;
  workspace_id?: string;
  root_space_uid: string;
  /** `<root>/.git` is a directory, so the root's own worktrees resolve to it. */
  root_is_repository: boolean;
  /** Number of entries the file lists, valid or not. */
  listed: number;
  included: PlannedRepository[];
  refused: RefusedEntry[];
  /** Child directories with a `.git` that the file does not include. */
  undeclared: string[];
}

export type ConsentPlan = RepoPlan | WorkspacePlan;

const SPACE_UID = /^space:[A-Za-z0-9_.:\-]+$/;
const DECLARED_REPO_ID = /^[\w.@:/-]{1,512}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const UNDECLARED_SCAN_CAP = 200;

/** Control characters (C0, DEL, C1) and bidirectional overrides: a name
 * holding one could rewrite or hide lines of the card. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `s` with every control or bidi character shown as a visible `\u{..}`
 * escape. Names from a workspace file or from disk pass through this before
 * they reach the terminal. */
export function printable(s: string): string {
  return s.replace(UNPRINTABLE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realpath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** Real path of git's top level for `dir`, or undefined outside a repository. */
export function gitTopLevel(dir: string, git: GitRunner): string | undefined {
  let raw: string;
  try {
    raw = git(["-C", dir, "rev-parse", "--show-toplevel"]).trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  return realpath(path.resolve(dir, raw));
}

/** The repository's `origin` remote as `host/owner/name`, or undefined. */
export function remoteRepositoryId(root: string, git: GitRunner): string | undefined {
  try {
    return normalizeRemote(git(["-C", root, "config", "--get", "remote.origin.url"])) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check one `repositories[]` entry of a workspace file. Included entries are
 * real git top-levels strictly inside the workspace root; `seen` collects
 * included real paths so a second spelling of one is refused.
 */
export function validateWorkspaceEntry(
  workspaceRoot: string,
  entry: unknown,
  seen: Set<string>,
  git: GitRunner,
): { included: PlannedRepository } | { refused: RefusedEntry } {
  const raw = isRecord(entry) ? entry.root : undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    return { refused: { name: "(entry without a root)", reason: "no root" } };
  }
  const refuse = (reason: string) => ({ refused: { name: raw, reason } });
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.split(/[\\/]/).includes("..")) {
    return refuse("\"..\" and absolute roots are not allowed");
  }
  const lexical = path.resolve(workspaceRoot, raw);
  if (lexical === workspaceRoot) return refuse("the workspace root is turned on separately");
  const real = realpath(lexical);
  if (!real) return refuse("not found on this machine");
  if (real === workspaceRoot) return refuse("the workspace root is turned on separately");
  if (!pathContains(workspaceRoot, real)) return refuse("resolves outside the workspace");
  // The card names the entry as written, so it must be the repository's own
  // folder: a symlink would turn on a repository the card does not name.
  if (real !== lexical) {
    return refuse("reaches a repository through a symlink or another spelling; list the repository's own folder");
  }
  if (gitTopLevel(real, git) !== real || !fs.existsSync(path.join(real, ".git"))) {
    return refuse("not the top of a git repository");
  }
  if (seen.has(real)) return refuse("listed twice");
  seen.add(real);
  const record = entry as Record<string, unknown>;
  const declared =
    typeof record.repo_id === "string" && DECLARED_REPO_ID.test(record.repo_id)
      ? record.repo_id
      : undefined;
  const space =
    typeof record.space_uid === "string" && SPACE_UID.test(record.space_uid)
      ? record.space_uid
      : null;
  return {
    included: {
      name: raw,
      root: real,
      ...(declared ? { declared_repo_id: declared } : {}),
      space_uid: space,
    },
  };
}

/** The nearest `.mindgraph/workspace.json` at or above `target`, stopping
 * before the account's home directory and the filesystem root. A file (or
 * its `.mindgraph` folder) that another account owns is passed over, so a
 * shared folder such as /tmp cannot put someone else's workspace in front of
 * your repository. */
function findWorkspaceRoot(
  target: string,
  home: string | undefined,
  uid: number | undefined,
): string | undefined {
  let current = target;
  for (;;) {
    if (home !== undefined && pathContains(current, home)) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    const folder = path.join(current, ".mindgraph");
    const file = path.join(folder, "workspace.json");
    if (fs.existsSync(file) && ownedBy(folder, uid, true) && ownedBy(file, uid, false)) {
      return current;
    }
    current = parent;
  }
}

function ownedBy(p: string, uid: number | undefined, noFollow: boolean): boolean {
  if (uid === undefined) return true;
  try {
    return (noFollow ? fs.lstatSync(p) : fs.statSync(p)).uid === uid;
  } catch {
    return false;
  }
}

function homeSpellings(home: string | undefined): string[] {
  if (!home) return [];
  const out = [path.normalize(home)];
  const real = realpath(home);
  if (real && real !== out[0]) out.push(real);
  return out;
}

function forbiddenRoot(p: string, homes: string[]): boolean {
  return p === path.parse(p).root || homes.some((home) => pathContains(p, home));
}

/**
 * Work out what `on` would turn on for `target`. Throws `ConsentPlanError`
 * with the message to print when nothing can be turned on there.
 */
export function planConsent(
  target: string,
  options: { git?: GitRunner; home?: string; uid?: number } = {},
): ConsentPlan {
  const git = options.git ?? nodeGit();
  const home = options.home ?? passwdHome();
  const homes = homeSpellings(home);
  const real = realpath(target);
  if (!real || !fs.statSync(real).isDirectory()) {
    throw new ConsentPlanError(`No such directory: ${target}`);
  }
  if (forbiddenRoot(real, homes)) {
    throw new ConsentPlanError(
      `MindGraph turns on per repository, not for ${real === path.parse(real).root ? "the whole disk" : "your home directory"}. Run this inside a repository.`,
    );
  }

  const uid =
    "uid" in options ? options.uid : typeof process.getuid === "function" ? process.getuid() : undefined;
  const workspaceRoot = findWorkspaceRoot(real, homes[homes.length - 1], uid);
  if (workspaceRoot) return planWorkspace(real, workspaceRoot, git);

  const top = gitTopLevel(real, git);
  if (!top || !fs.existsSync(path.join(top, ".git"))) {
    throw new ConsentPlanError(
      `No git repository or MindGraph workspace at ${target}. MindGraph turns on per repository.`,
    );
  }
  if (forbiddenRoot(top, homes)) {
    throw new ConsentPlanError(
      `The repository at ${top} is your home directory; MindGraph turns on per repository, not for your whole home directory.`,
    );
  }
  return { kind: "repo", target: real, root: top };
}

function planWorkspace(target: string, root: string, git: GitRunner): WorkspacePlan {
  const file = path.join(root, ".mindgraph", "workspace.json");
  let bytes: Buffer;
  try {
    // The same bounded read resolution uses, so `on` refuses exactly the
    // files resolution would treat as changed (and never hangs on a FIFO).
    bytes = nodeConsentFs.readFile(file);
  } catch {
    throw new ConsentPlanError(
      `Cannot read ${file}: it must be a regular file of at most ${READ_MAX / (1024 * 1024)} MiB. Nothing was changed.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.repositories)) {
    throw new ConsentPlanError(
      `${file} is not a workspace file this version can read (it needs "v": 1 and a "repositories" list). Nothing was changed.`,
    );
  }
  const seen = new Set<string>();
  const included: PlannedRepository[] = [];
  const refused: RefusedEntry[] = [];
  for (const entry of parsed.repositories) {
    const result = validateWorkspaceEntry(root, entry, seen, git);
    if ("included" in result) included.push(result.included);
    else refused.push(result.refused);
  }
  const workspaceId =
    typeof parsed.workspace_id === "string" && WORKSPACE_ID.test(parsed.workspace_id)
      ? parsed.workspace_id
      : undefined;
  const rootSpace = `space:workspace:${
    workspaceId ?? crypto.createHash("sha256").update(root).digest("hex").slice(0, 12)
  }`;
  return {
    kind: "workspace",
    target,
    root,
    workspace_file: file,
    workspace_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    root_space_uid: rootSpace,
    root_is_repository: isDirectory(path.join(root, ".git")),
    listed: parsed.repositories.length,
    included,
    refused,
    undeclared: undeclaredRepositories(root, included),
  };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Child directories of `root` holding a `.git` that the plan does not
 * include, for the card only. One readdir, capped. */
function undeclaredRepositories(root: string, included: PlannedRepository[]): string[] {
  const roots = new Set(included.map((r) => r.root));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).slice(0, UNDECLARED_SCAN_CAP);
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !roots.has(path.join(root, entry.name)) &&
        fs.existsSync(path.join(root, entry.name, ".git")),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * The id a repository is pinned under: the workspace file's declared id when
 * well formed, else its `origin` remote, else a durable local id kept in
 * `<git-common-dir>/mindgraph/repository-id` (created here when missing,
 * which is why this runs only after the person confirmed). Matches the
 * identity the CodeGraph adapter computes for the same repository.
 */
export function resolveRepositoryId(
  root: string,
  declared: string | undefined,
  git: GitRunner,
): string {
  if (declared) return declared;
  const remote = remoteRepositoryId(root, git);
  if (remote) return remote;
  let common: string;
  try {
    common = git(["-C", root, "rev-parse", "--git-common-dir"]).trim();
  } catch {
    common = "";
  }
  if (!common) return `local:${path.basename(root)}`;
  const dir = path.join(path.resolve(root, common), "mindgraph");
  const file = path.join(dir, "repository-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Created below.
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const generated = crypto.randomUUID();
  try {
    fs.writeFileSync(file, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = fs.readFileSync(file, "utf8").trim();
    if (!winner) throw new Error(`empty repository identity file: ${file}`);
    return winner;
  }
}
