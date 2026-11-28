import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  hookEnvPath,
  mindgraphConfigDir,
  passwdHome,
  updateHookConfig,
} from "./hook-env.js";

/**
 * Machine-local consent: MindGraph does work only in a directory that
 * resolves inside a root the user turned on.
 *
 * The store is the `consent` key of `hooks.json` (see `mindgraphConfigDir`).
 * Resolution reads that file, at most one `workspace.json` and a few small
 * git files, and stats a bounded number of paths. It makes no network call,
 * spawns no process and writes nothing. This module deliberately imports
 * neither `node:child_process` nor the CodeGraph adapter: nothing that
 * discovers repositories may decide consent.
 */

export interface PinnedRepository {
  /** Real path of the repository's top level, recorded at consent time. */
  root: string;
  repo_id: string;
  space_uid: string | null;
}

export interface ConsentRoot {
  /** Real path, recorded at consent time. */
  root: string;
  kind: "repo" | "workspace";
  root_enabled?: boolean;
  root_space_uid?: string | null;
  workspace_file?: string;
  workspace_sha256?: string;
  workspace_id?: string;
  repositories: PinnedRepository[];
  consented_at: string;
  consented_with?: { command: string; version: string };
}

export interface ConsentStore {
  v: 1;
  acknowledged_at?: string;
  reconnectSiblings?: boolean;
  reconnectExcluded?: string[];
  roots: ConsentRoot[];
}

export type StoreStatus =
  | "ok"
  | "missing"
  | "unreadable"
  | "unsupported_version"
  | "unsafe_permissions"
  | "unsafe_location";

export interface LoadedConsentStore {
  status: StoreStatus;
  store?: ConsentStore;
  path: string;
  /** Why the location is unsafe, when status is `unsafe_location`. */
  detail?: string;
}

export type ConsentReason =
  | "consented"
  | "reconnected"
  | "consented_worktree"
  | "store_missing"
  | "store_unreadable"
  | "store_unsupported_version"
  | "store_unsafe_permissions"
  | "store_unsafe_location"
  | "cwd_missing"
  | "cwd_unresolvable"
  | "not_consented"
  | "undeclared_repository"
  | "root_not_enabled"
  | "workspace_changed"
  | "workspace_missing"
  | "hooks_paused";

export interface OnDecision {
  state: "on";
  reason: "consented" | "consented_worktree" | "reconnected";
  /** Real path of the event's directory. */
  directory: string;
  /** The consented root this directory resolved to. */
  root: string;
  kind: "repo" | "workspace";
  /** The matched repository; undefined at a workspace root. */
  repo?: PinnedRepository;
  space_uid: string | null;
  /** The entry's whole pinned set; [] is valid and means none. */
  repositories: PinnedRepository[];
  storeAcknowledged: boolean;
}

export interface OffDecision {
  state: "off" | "needs_reapproval";
  reason: ConsentReason;
  directory?: string;
  root?: string;
  storeAcknowledged: boolean;
  /** Whether a `.git` was found at or above the directory (computed only when
   * no consented root contains it). */
  inRepository?: boolean;
  offerDesktopLink?: boolean;
}

export type ConsentDecision = OnDecision | OffDecision;

export interface ConsentStat {
  isFile: boolean;
  isDirectory: boolean;
  uid?: number;
  mode?: number;
}

/** Every filesystem access consent makes goes through this, so tests can
 * count it. `realpath`, `readFile` and `readHead` throw on failure. */
export interface ConsentFs {
  realpath(p: string): string;
  stat(p: string): ConsentStat | undefined;
  readFile(p: string): Buffer;
  readHead(p: string, max: number): string;
}

export const nodeConsentFs: ConsentFs = {
  realpath: (p) => fs.realpathSync.native(p),
  stat: (p) => {
    try {
      const s = fs.statSync(p);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        uid: s.uid,
        mode: s.mode,
      };
    } catch {
      return undefined;
    }
  },
  readFile: (p) => readRegular(p, READ_MAX, true),
  readHead: (p, max) => readRegular(p, max, false).toString("utf8"),
};

/** Largest file consent reads whole (`hooks.json`, `workspace.json`). */
export const READ_MAX = 1024 * 1024;
const HEAD_MAX = 4096;

/**
 * Read at most `max` bytes of a regular file. The open never blocks (a FIFO
 * opens at once) and anything that is not a regular file throws, so a path
 * swapped for a FIFO or a device such as `/dev/zero` fails closed instead of
 * hanging or reading without end. With `whole`, a file larger than `max`
 * throws too.
 */
function readRegular(p: string, max: number, whole: boolean): Buffer {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${p} is not a regular file`);
    if (whole && stat.size > max) throw new Error(`${p} is larger than ${max} bytes`);
    const buffer = Buffer.alloc(Math.min(stat.size, max));
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}
const SPACE_UID = /^space:[A-Za-z0-9_.:\-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `/a/b` contains `/a/b` and `/a/b/c`, never `/a/bc`. */
export function pathContains(root: string, candidate: string): boolean {
  const child = path.relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." &&
      !child.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(child))
  );
}

function strictlyInside(root: string, candidate: string): boolean {
  return root !== candidate && pathContains(root, candidate);
}

function validStoredPath(p: unknown, homes: readonly string[]): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (!path.isAbsolute(p) || path.normalize(p) !== p) return false;
  if (p === path.parse(p).root) return false;
  if (p.endsWith(path.sep)) return false;
  if (p.split(path.sep).includes("..")) return false;
  // Not the passwd home, nor any directory above it, in either spelling.
  if (homes.some((home) => pathContains(p, home))) return false;
  return true;
}

function validSpace(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SPACE_UID.test(value));
}

function parseRepository(
  raw: unknown,
  home: readonly string[],
): PinnedRepository | undefined {
  if (!isRecord(raw)) return undefined;
  if (!validStoredPath(raw.root, home)) return undefined;
  if (
    typeof raw.repo_id !== "string" ||
    raw.repo_id.length === 0 ||
    raw.repo_id.length > 512
  ) {
    return undefined;
  }
  const space = raw.space_uid === undefined ? null : raw.space_uid;
  if (!validSpace(space)) return undefined;
  return { root: raw.root, repo_id: raw.repo_id, space_uid: space };
}

function parseRoot(
  raw: unknown,
  home: readonly string[],
): ConsentRoot | undefined {
  if (!isRecord(raw)) return undefined;
  if (!validStoredPath(raw.root, home)) return undefined;
  if (typeof raw.consented_at !== "string") return undefined;
  if (!Array.isArray(raw.repositories)) return undefined;
  const repositories: PinnedRepository[] = [];
  for (const entry of raw.repositories) {
    const repository = parseRepository(entry, home);
    if (!repository) return undefined;
    repositories.push(repository);
  }
  let consentedWith: ConsentRoot["consented_with"];
  if (raw.consented_with !== undefined) {
    const w = raw.consented_with;
    if (
      !isRecord(w) ||
      typeof w.command !== "string" ||
      typeof w.version !== "string"
    ) {
      return undefined;
    }
    consentedWith = { command: w.command, version: w.version };
  }
  const root = raw.root;
  if (raw.kind === "repo") {
    if (repositories.length !== 1 || repositories[0].root !== root) {
      return undefined;
    }
    if (
      ["workspace_file", "workspace_sha256", "workspace_id", "root_enabled", "root_space_uid"].some(
        (key) => raw[key] !== undefined,
      )
    ) {
      return undefined;
    }
    return {
      root,
      kind: "repo",
      repositories,
      consented_at: raw.consented_at,
      ...(consentedWith ? { consented_with: consentedWith } : {}),
    };
  }
  if (raw.kind !== "workspace") return undefined;
  if (raw.workspace_file !== path.join(root, ".mindgraph", "workspace.json")) {
    return undefined;
  }
  if (
    typeof raw.workspace_sha256 !== "string" ||
    !SHA256_HEX.test(raw.workspace_sha256)
  ) {
    return undefined;
  }
  if (typeof raw.root_enabled !== "boolean") return undefined;
  const rootSpace = raw.root_space_uid === undefined ? null : raw.root_space_uid;
  if (!validSpace(rootSpace)) return undefined;
  if (raw.workspace_id !== undefined && typeof raw.workspace_id !== "string") {
    return undefined;
  }
  const seen = new Set<string>();
  for (const repository of repositories) {
    if (!strictlyInside(root, repository.root)) return undefined;
    if (seen.has(repository.root)) return undefined;
    seen.add(repository.root);
  }
  return {
    root,
    kind: "workspace",
    root_enabled: raw.root_enabled,
    root_space_uid: rootSpace,
    workspace_file: raw.workspace_file,
    workspace_sha256: raw.workspace_sha256,
    ...(typeof raw.workspace_id === "string"
      ? { workspace_id: raw.workspace_id }
      : {}),
    repositories,
    consented_at: raw.consented_at,
    ...(consentedWith ? { consented_with: consentedWith } : {}),
  };
}

/** The passwd home as written and as its real path (they differ when the
 * home sits behind a symlink, such as `/home -> /var/home`). */
function homeSpellings(): string[] {
  const home = passwdHome();
  if (!home) return [];
  const spellings = [path.normalize(home)];
  try {
    const real = fs.realpathSync.native(home);
    if (real !== spellings[0]) spellings.push(real);
  } catch {
    // A home that does not exist has no other spelling.
  }
  return spellings;
}

/**
 * Parse the `consent` value of `hooks.json`. Undefined when it is not an
 * object with `v: 1`. A root entry that fails validation is dropped, never
 * repaired; the others stand. A second entry for the same root is dropped.
 */
export function parseConsentStore(raw: unknown): ConsentStore | undefined {
  if (!isRecord(raw) || raw.v !== 1) return undefined;
  const home = homeSpellings();
  const roots: ConsentRoot[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.roots) ? raw.roots : []) {
    const root = parseRoot(entry, home);
    if (!root || seen.has(root.root)) continue;
    seen.add(root.root);
    roots.push(root);
  }
  return {
    v: 1,
    ...(typeof raw.acknowledged_at === "string"
      ? { acknowledged_at: raw.acknowledged_at }
      : {}),
    roots,
    ...(raw.reconnectSiblings === true ? { reconnectSiblings: true } : {}),
    ...(Array.isArray(raw.reconnectExcluded) ? { reconnectExcluded: raw.reconnectExcluded.filter((p): p is string => validStoredPath(p, home)) } : {}),
  };
}

function unsafeMode(stat: ConsentStat): boolean {
  if (process.platform === "win32") return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== undefined && stat.uid !== uid) {
    return true;
  }
  return stat.mode !== undefined && (stat.mode & 0o022) !== 0;
}

/**
 * Read the consent store. Every status other than `ok` means no consent
 * anywhere. A file with no `consent` key (every install from before consent)
 * is `ok` with zero roots and no `acknowledged_at`.
 */
export function loadConsentStore(
  env: NodeJS.ProcessEnv = process.env,
  options: { fs?: ConsentFs } = {},
): LoadedConsentStore {
  const cfs = options.fs ?? nodeConsentFs;
  const where = mindgraphConfigDir(env);
  const file = hookEnvPath(where.dir);
  if (where.refused) {
    return { status: "unsafe_location", path: file, detail: where.refused };
  }
  const fileStat = cfs.stat(file);
  if (!fileStat) return { status: "missing", path: file };
  const dirStat = cfs.stat(where.dir);
  if (!fileStat.isFile || !dirStat || unsafeMode(fileStat) || unsafeMode(dirStat)) {
    return { status: "unsafe_permissions", path: file };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cfs.readFile(file).toString("utf8"));
  } catch {
    return { status: "unreadable", path: file };
  }
  if (!isRecord(parsed)) return { status: "unreadable", path: file };
  if (parsed.consent === undefined) {
    return { status: "ok", store: { v: 1, roots: [] }, path: file };
  }
  if (!isRecord(parsed.consent)) return { status: "unreadable", path: file };
  const store = parseConsentStore(parsed.consent);
  if (!store) return { status: "unsupported_version", path: file };
  return { status: "ok", store, path: file };
}

/**
 * Change the consent store. Starts from `{v: 1, roots: []}` when there is
 * none, sets `acknowledged_at` on every write, and keeps every other key of
 * `hooks.json`. Refuses a store written by a newer version, an unsafe
 * location, and an entry that would not parse back.
 */
export function writeConsent(
  mutate: (store: ConsentStore) => void,
  options: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): string {
  const where = mindgraphConfigDir(options.env ?? process.env);
  if (where.refused) {
    throw new Error(`${where.refused}; nothing was saved.`);
  }
  return updateHookConfig(
    (raw) => {
      let store: ConsentStore;
      if (raw.consent === undefined) {
        store = { v: 1, roots: [] };
      } else {
        const parsed = parseConsentStore(raw.consent);
        if (!parsed) {
          throw new Error(
            `${hookEnvPath(where.dir)} has consent settings this version does not understand, so they were left unchanged. Update with npx -y mindgraph-mcp@latest.`,
          );
        }
        store = parsed;
      }
      mutate(store);
      store.acknowledged_at = (options.now ?? (() => new Date()))().toISOString();
      const roundTrip = parseConsentStore(JSON.parse(JSON.stringify(store)));
      if (!roundTrip || roundTrip.roots.length !== store.roots.length) {
        throw new Error("A consent entry is not valid; nothing was saved.");
      }
      raw.consent = roundTrip;
    },
    { dir: where.dir },
  );
}

/** The directory a hook event happened in: its own `cwd`, never the
 * process's. */
export function eventDirectory(input: { cwd?: unknown }): string | undefined {
  return typeof input.cwd === "string" && input.cwd.length > 0
    ? input.cwd
    : undefined;
}

const STORE_REASON: Record<Exclude<StoreStatus, "ok">, ConsentReason> = {
  missing: "store_missing",
  unreadable: "store_unreadable",
  unsupported_version: "store_unsupported_version",
  unsafe_permissions: "store_unsafe_permissions",
  unsafe_location: "store_unsafe_location",
};

interface Resolution {
  fs: ConsentFs;
  store: ConsentStore;
  acknowledged: boolean;
  /** Workspace entries whose file hash was checked, by root. */
  hashOk: Map<string, boolean>;
}

function workspaceHashState(
  entry: ConsentRoot,
  ctx: Resolution,
): "ok" | "workspace_missing" | "workspace_changed" {
  let bytes: Buffer;
  try {
    bytes = ctx.fs.readFile(entry.workspace_file!);
  } catch (error) {
    ctx.hashOk.set(entry.root, false);
    // Only a file that is not there is missing; one that is there but cannot
    // be read (not a regular file, too large) has changed.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "workspace_missing" : "workspace_changed";
  }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const ok = digest === entry.workspace_sha256;
  ctx.hashOk.set(entry.root, ok);
  return ok ? "ok" : "workspace_changed";
}

function hashValid(entry: ConsentRoot, ctx: Resolution): boolean {
  if (entry.kind !== "workspace") return true;
  const known = ctx.hashOk.get(entry.root);
  if (known !== undefined) return known;
  return workspaceHashState(entry, ctx) === "ok";
}

/** The cheap identity check: the pinned path is still a real path and still
 * has a `.git` (file or directory). */
function repositoryPresent(root: string, ctx: Resolution): boolean {
  let real: string;
  try {
    real = ctx.fs.realpath(root);
  } catch {
    return false;
  }
  return real === root && ctx.fs.stat(path.join(root, ".git")) !== undefined;
}

function on(
  reason: OnDecision["reason"],
  directory: string,
  entry: ConsentRoot,
  repo: PinnedRepository | undefined,
  ctx: Resolution,
): OnDecision {
  return {
    state: "on",
    reason,
    directory,
    root: entry.root,
    kind: entry.kind,
    ...(repo ? { repo } : {}),
    space_uid: repo ? repo.space_uid : (entry.root_space_uid ?? null),
    repositories: entry.repositories,
    storeAcknowledged: ctx.acknowledged,
  };
}

function headLine(file: string, ctx: Resolution): string | undefined {
  try {
    return ctx.fs.readHead(file, HEAD_MAX).split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

function realpathOr(p: string, ctx: Resolution): string | undefined {
  try {
    return ctx.fs.realpath(p);
  } catch {
    return undefined;
  }
}

/**
 * A linked worktree resolves to the repository it belongs to, when that
 * repository is consented and git's own records agree both ways: the
 * checkout's `.git` file names an admin directory inside the consented
 * repository's `.git/worktrees`, and that admin directory points back at this
 * checkout.
 */
function linkedWorktree(
  boundary: string,
  directory: string,
  ctx: Resolution,
): OnDecision | undefined {
  const first = headLine(path.join(boundary, ".git"), ctx);
  const match = first ? /^gitdir:\s*(.+?)\s*$/.exec(first) : null;
  if (!match) return undefined;
  const admin = realpathOr(path.resolve(boundary, match[1]), ctx);
  if (!admin) return undefined;
  const worktrees = path.dirname(admin);
  const gitDir = path.dirname(worktrees);
  if (path.basename(worktrees) !== "worktrees" || path.basename(gitDir) !== ".git") {
    return undefined;
  }
  const target = path.dirname(gitDir);

  // (a) the target must be a consented repository, or a workspace root that
  // is itself turned on.
  let chosen: { entry: ConsentRoot; repo?: PinnedRepository } | undefined;
  for (const entry of ctx.store.roots) {
    const pinned = entry.repositories.find((r) => r.root === target);
    if (pinned && (entry.kind === "repo" || hashValid(entry, ctx))) {
      chosen = { entry, repo: pinned };
      break;
    }
  }
  if (!chosen) {
    const entry = ctx.store.roots.find(
      (e) => e.kind === "workspace" && e.root === target && e.root_enabled === true,
    );
    if (entry && hashValid(entry, ctx)) chosen = { entry };
  }
  if (!chosen) return undefined;

  // (b) the admin directory belongs to the target's own .git.
  const common = headLine(path.join(admin, "commondir"), ctx)?.trim();
  if (!common || realpathOr(path.resolve(admin, common), ctx) !== gitDir) {
    return undefined;
  }
  // (c) git's back-pointer names this checkout.
  const back = headLine(path.join(admin, "gitdir"), ctx)?.trim();
  if (!back || realpathOr(path.dirname(path.resolve(admin, back)), ctx) !== boundary) {
    return undefined;
  }
  // (d) the target is still where it was turned on, with its .git directory.
  if (realpathOr(target, ctx) !== target) return undefined;
  if (!ctx.fs.stat(path.join(target, ".git"))?.isDirectory) return undefined;

  return on("consented_worktree", directory, chosen.entry, chosen.repo, ctx);
}

/** First directory from `directory` upward (stopping before `stop`, or at the
 * filesystem root) that contains `.git`. */
function gitBoundary(
  directory: string,
  stop: string | undefined,
  ctx: Resolution,
): { dir: string; stat: ConsentStat } | undefined {
  let current = directory;
  for (;;) {
    if (stop !== undefined && current === stop) return undefined;
    const stat = ctx.fs.stat(path.join(current, ".git"));
    if (stat) return { dir: current, stat };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Decide whether MindGraph may act for an event in `cwd`. Pure apart from
 * bounded reads through `ConsentFs`: no network, no process, no writes.
 */
export function resolveConsent(
  cwd: unknown,
  loaded: LoadedConsentStore,
  options: { fs?: ConsentFs; env?: NodeJS.ProcessEnv } = {},
): ConsentDecision {
  const env = options.env ?? process.env;
  const acknowledged = Boolean(loaded.store?.acknowledged_at);
  // 1. An environment variable can only ever turn MindGraph off.
  if (env.MINDGRAPH_HOOKS === "off") {
    return { state: "off", reason: "hooks_paused", storeAcknowledged: acknowledged };
  }
  // 2. Any store problem means no consent anywhere.
  if (loaded.status !== "ok" || !loaded.store) {
    const status = loaded.status === "ok" ? "unreadable" : loaded.status;
    return { state: "off", reason: STORE_REASON[status], storeAcknowledged: false };
  }
  // 3. Never substitute the process's directory for the event's. A cwd from
  // tool-call arguments can be any JSON value.
  if (typeof cwd !== "string" || cwd === "") {
    return { state: "off", reason: "cwd_missing", storeAcknowledged: acknowledged };
  }
  const ctx: Resolution = {
    fs: options.fs ?? nodeConsentFs,
    store: loaded.store,
    acknowledged,
    hashOk: new Map(),
  };
  // 4. Real path of the event's directory.
  if (!path.isAbsolute(cwd)) {
    return { state: "off", reason: "cwd_unresolvable", storeAcknowledged: acknowledged };
  }
  const directory = realpathOr(cwd, ctx);
  if (!directory) {
    return { state: "off", reason: "cwd_unresolvable", storeAcknowledged: acknowledged };
  }
  const off = (
    reason: ConsentReason,
    root?: string,
    state: OffDecision["state"] = "off",
  ): OffDecision => ({
    state,
    reason,
    directory,
    ...(root ? { root } : {}),
    storeAcknowledged: acknowledged,
  });

  // 5. The longest consented root containing the directory.
  let candidate: ConsentRoot | undefined;
  for (const entry of ctx.store.roots) {
    if (
      pathContains(entry.root, directory) &&
      (!candidate || entry.root.length > candidate.root.length)
    ) {
      candidate = entry;
    }
  }

  if (!candidate) {
    // 9. No candidate root: only a linked worktree of a consented
    // repository can be on.
    const boundary = gitBoundary(directory, undefined, ctx);
    if (boundary?.stat.isFile) {
      const worktree = linkedWorktree(boundary.dir, directory, ctx);
      if (worktree) return worktree;
    }
    return { ...off("not_consented"), inRepository: boundary !== undefined };
  }

  // 6. A workspace whose file changed or vanished is paused everywhere under
  // its root.
  if (candidate.kind === "workspace") {
    const state = workspaceHashState(candidate, ctx);
    if (state !== "ok") return off(state, candidate.root, "needs_reapproval");
  }

  // 7. The git boundary below the root.
  const boundary = gitBoundary(directory, candidate.root, ctx);
  const nestedOrWorktree = (): ConsentDecision => {
    if (boundary?.stat.isFile) {
      const worktree = linkedWorktree(boundary.dir, directory, ctx);
      if (worktree) return worktree;
    }
    return off("undeclared_repository", candidate!.root);
  };

  if (candidate.kind === "repo") {
    if (boundary) return nestedOrWorktree();
    const repo = candidate.repositories[0];
    // 8. Identity: still a real path with a .git.
    if (!repositoryPresent(repo.root, ctx)) return off("not_consented", candidate.root);
    return on("consented", directory, candidate, repo, ctx);
  }

  let pinned: PinnedRepository | undefined;
  for (const repository of candidate.repositories) {
    if (
      pathContains(repository.root, directory) &&
      (!pinned || repository.root.length > pinned.root.length)
    ) {
      pinned = repository;
    }
  }
  // A .git strictly inside the pinned repository is some other checkout.
  if (pinned && !(boundary && strictlyInside(pinned.root, boundary.dir))) {
    if (!repositoryPresent(pinned.root, ctx)) return off("not_consented", candidate.root);
    return on("consented", directory, candidate, pinned, ctx);
  }
  if (boundary) return nestedOrWorktree();
  // No repository boundary below the root: the session is at the root.
  if (candidate.root_enabled !== true) return off("root_not_enabled", candidate.root);
  return on("consented", directory, candidate, undefined, ctx);
}

/** Load the store and resolve `cwd` against it. */
export function consentFor(
  cwd: unknown,
  options: { fs?: ConsentFs; env?: NodeJS.ProcessEnv } = {},
): ConsentDecision {
  const env = options.env ?? process.env;
  if (env.MINDGRAPH_HOOKS === "off") {
    return { state: "off", reason: "hooks_paused", storeAcknowledged: false };
  }
  return resolveConsent(cwd, loadConsentStore(env, { fs: options.fs }), options);
}
