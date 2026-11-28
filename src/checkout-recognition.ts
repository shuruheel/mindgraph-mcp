import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  loadConsentStore,
  pathContains,
  type LoadedConsentStore,
  type OnDecision,
} from "./consent.js";
import { mindgraphConfigDir, mindgraphRuntimeDir } from "./hook-env.js";
import { sessionConsent } from "./session-consent.js";

/**
 * Automatic checkout recognition, explicit opt-out precedence, and non-git
 * local folder continuity for Omarchy desktop onboarding (ADR Decision 1).
 *
 * Precedence is fail-closed with respect to privacy:
 * 1. `MINDGRAPH_HOOKS=off` pauses everything with zero network calls.
 * 2. Explicit per-repo / workspace consent (`sessionConsent`) wins verbatim.
 * 3. Explicit exclusions (`reconnectExcluded`, `excludedDirectories`) block
 *    before inspecting `.git` or calling any remote resolver.
 * 4. Plain non-git folders get a salted on-device continuity ID in
 *    `<runtimeDir>/local-folders.json` (mode 0600) and never leave the device.
 * 5. Git remotes are read via `git config --no-includes --file <git>/config`,
 *    normalized without credentials, checked against `excludedRemotes`, and
 *    only the canonical `normalizedOrigin` is ever passed to `resolveRemote`.
 */

export const DESKTOP_EXCLUSIONS_FILENAME = "desktop-exclusions.json";
export const LOCAL_FOLDERS_FILENAME = "local-folders.json";

const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:"]);
const DEFAULT_PORTS: Record<string, string> = {
  "https:": "443",
  "http:": "80",
  "ssh:": "22",
  "git:": "9418",
};
const LOCAL_FOLDER_ID_RE = /^local-folder:[0-9a-f]{16}$/;

export interface DesktopExclusions {
  v: 1;
  excludedDirectories: string[];
  excludedRemotes: string[];
}

export interface LocalFolderEntry {
  id: string;
  path: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface LocalFoldersStore {
  v: 1;
  salt: string;
  folders: Record<string, LocalFolderEntry>;
}

export interface RemoteLookupInput {
  /** Canonical normalized git origin (`host/path`), never a local path or secret. */
  normalizedOrigin: string;
}

export type RemoteLookupResult =
  | {
      status: "matched";
      orgId: string;
      spaceUid: string;
      repoUid: string;
    }
  | {
      status: "ambiguous";
      candidateCount: number;
    }
  | {
      status: "new_identity";
      spaceUid: string;
    };

export type RemoteResolver = (
  input: RemoteLookupInput,
) => Promise<RemoteLookupResult> | RemoteLookupResult;

export interface RecognizeCheckoutOptions {
  env?: NodeJS.ProcessEnv;
  loadedConsent?: LoadedConsentStore;
  runtimeDir?: string;
  now?: () => Date;
  resolveRemote?: RemoteResolver;
}

export type ExcludedReason =
  | "hooks_paused"
  | "directory_excluded"
  | "remote_excluded"
  | "cwd_unresolvable";

export type CheckoutRecognitionResult =
  | {
      kind: "excluded";
      reason: ExcludedReason;
    }
  | {
      kind: "consented";
      root: string;
      repoId: string | null;
      spaceUid: string | null;
      decision: OnDecision;
    }
  | {
      kind: "local_folder";
      localFolderId: string;
      root: string;
    }
  | {
      kind: "recognized";
      root: string;
      normalizedOrigin: string;
      orgId: string;
      spaceUid: string;
      repoUid: string;
    }
  | {
      kind: "ambiguous_personal";
      root: string;
      normalizedOrigin: string;
      candidateCount: number;
    }
  | {
      kind: "personal_provisioned";
      root: string;
      normalizedOrigin: string;
      spaceUid: string;
    }
  | {
      kind: "git_unlinked";
      root: string;
      normalizedOrigin: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanRepoPath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes("\\") || /[\s\0-\x1f\x7f]/.test(rawPath)) {
    return null;
  }
  let cleaned = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  cleaned = cleaned.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!cleaned) return null;
  const segments = cleaned.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    return null;
  }
  return cleaned;
}

/**
 * Normalize HTTPS, HTTP, SSH (`git@host:org/repo.git`), `ssh://`, and `git://`
 * remote URLs to canonical `host/path` (lowercase host, credentials stripped,
 * leading/trailing slashes and `.git` suffix removed). Rejects local filesystem
 * paths and invalid URLs.
 */
export function normalizeGitOrigin(rawUrl: string): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\s\0-\x1f\x7f]/.test(trimmed)) return null;

  // Reject local filesystem paths up front.
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return null;
  }

  if (trimmed.includes("://")) {
    const schemeEnd = trimmed.indexOf("://") + 3;
    const pathStart = trimmed.indexOf("/", schemeEnd);
    if (pathStart !== -1) {
      const rawPath = trimmed.slice(pathStart).split(/[?#]/, 1)[0];
      if (
        rawPath.includes("\\") ||
        rawPath.split("/").some((seg) => seg === "." || seg === "..")
      ) {
        return null;
      }
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    const protocol = parsed.protocol.toLowerCase();
    if (!ALLOWED_PROTOCOLS.has(protocol)) return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) return null;
    const port =
      parsed.port && parsed.port !== DEFAULT_PORTS[protocol] ? `:${parsed.port}` : "";
    const repoPath = cleanRepoPath(parsed.pathname);
    if (!repoPath) return null;
    return `${hostname}${port}/${repoPath}`;
  }

  // SCP-style SSH remote: [user[:pass]@]host:org/repo[.git]
  const scp = /^(?:([^@/\s]+)@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(.+)$/.exec(
    trimmed,
  );
  if (!scp) return null;
  const [, userInfo, rawHost, rawPath] = scp;
  if (!userInfo && !rawHost.includes(".")) return null;
  const host = rawHost.toLowerCase();
  const repoPath = cleanRepoPath(rawPath);
  if (!repoPath) return null;
  return `${host}/${repoPath}`;
}

function normalizeRemoteExclusionInput(remote: string): string | null {
  const fromUrl = normalizeGitOrigin(remote);
  if (fromUrl) return fromUrl;
  if (typeof remote !== "string") return null;
  const trimmed = remote.trim();
  if (
    !trimmed ||
    trimmed.includes("://") ||
    trimmed.includes("@") ||
    /[\s\0-\x1f\x7f]/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("~")
  ) {
    return null;
  }
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0) return null;
  const hostPart = trimmed.slice(0, slashIdx);
  if (!hostPart.includes(".")) return null;
  return normalizeGitOrigin(`https://${trimmed}`);
}

function canonicalizePath(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function realpathOrUndefined(target: string): string | undefined {
  try {
    return fs.realpathSync.native(path.resolve(target));
  } catch {
    return undefined;
  }
}

function atomicWriteJson(file: string, data: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      const stat = fs.statSync(dir);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if ((stat.mode & 0o022) !== 0 && stat.uid === uid) {
        fs.chmodSync(dir, stat.mode & 0o7755);
      }
    } catch {
      // Best-effort tightening of parent directory permissions.
    }
  }
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    fs.rmSync(temp, { force: true });
    throw error;
  }
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
  }
}

// ── Local deny-list persistence (~/.mindgraph/desktop-exclusions.json) ────────

export function desktopExclusionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mindgraphConfigDir(env).dir, DESKTOP_EXCLUSIONS_FILENAME);
}

function emptyExclusions(): DesktopExclusions {
  return { v: 1, excludedDirectories: [], excludedRemotes: [] };
}

export function loadDesktopExclusions(
  env: NodeJS.ProcessEnv = process.env,
): DesktopExclusions {
  const file = desktopExclusionsPath(env);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.v !== 1) return emptyExclusions();
    const dirs = Array.isArray(parsed.excludedDirectories)
      ? Array.from(
          new Set(
            parsed.excludedDirectories.filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0,
            ),
          ),
        )
      : [];
    const remotes = Array.isArray(parsed.excludedRemotes)
      ? Array.from(
          new Set(
            parsed.excludedRemotes.filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0,
            ),
          ),
        )
      : [];
    return {
      v: 1,
      excludedDirectories: dirs,
      excludedRemotes: remotes,
    };
  } catch {
    return emptyExclusions();
  }
}

function saveDesktopExclusions(
  exclusions: DesktopExclusions,
  env: NodeJS.ProcessEnv = process.env,
): DesktopExclusions {
  const where = mindgraphConfigDir(env);
  if (where.refused) {
    throw new Error(`${where.refused}; desktop exclusions were not saved.`);
  }
  const normalized: DesktopExclusions = {
    v: 1,
    excludedDirectories: Array.from(new Set(exclusions.excludedDirectories)),
    excludedRemotes: Array.from(new Set(exclusions.excludedRemotes)),
  };
  atomicWriteJson(path.join(where.dir, DESKTOP_EXCLUSIONS_FILENAME), normalized);
  return normalized;
}

export function addExcludedDirectory(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopExclusions {
  const canonical = canonicalizePath(directory);
  const current = loadDesktopExclusions(env);
  if (!current.excludedDirectories.includes(canonical)) {
    current.excludedDirectories.push(canonical);
  }
  return saveDesktopExclusions(current, env);
}

export function removeExcludedDirectory(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopExclusions {
  const resolved = path.resolve(directory);
  const canonical = canonicalizePath(directory);
  const current = loadDesktopExclusions(env);
  current.excludedDirectories = current.excludedDirectories.filter((entry) => {
    const entryCanonical = canonicalizePath(entry);
    return (
      entry !== directory &&
      entry !== resolved &&
      entry !== canonical &&
      entryCanonical !== canonical
    );
  });
  return saveDesktopExclusions(current, env);
}

export function addExcludedRemote(
  remote: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopExclusions {
  const normalized = normalizeRemoteExclusionInput(remote);
  if (!normalized) {
    throw new Error(`Cannot exclude invalid git remote: ${remote}`);
  }
  const current = loadDesktopExclusions(env);
  const exists = current.excludedRemotes.some(
    (entry) => entry.toLowerCase() === normalized.toLowerCase(),
  );
  if (!exists) {
    current.excludedRemotes.push(normalized);
  }
  return saveDesktopExclusions(current, env);
}

// ── Non-git local folder continuity store (<runtimeDir>/local-folders.json) ───

export function localFoldersPath(
  env: NodeJS.ProcessEnv = process.env,
  runtimeDir?: string,
): string {
  return path.join(runtimeDir || mindgraphRuntimeDir(env), LOCAL_FOLDERS_FILENAME);
}

export function loadLocalFoldersStore(
  env: NodeJS.ProcessEnv = process.env,
  runtimeDir?: string,
): LocalFoldersStore | undefined {
  const file = localFoldersPath(env, runtimeDir);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.v !== 1) return undefined;
    if (typeof parsed.salt !== "string" || parsed.salt.length < 16) return undefined;
    const folders: Record<string, LocalFolderEntry> = {};
    if (isRecord(parsed.folders)) {
      for (const [key, value] of Object.entries(parsed.folders)) {
        if (
          isRecord(value) &&
          typeof value.id === "string" &&
          LOCAL_FOLDER_ID_RE.test(value.id) &&
          typeof value.path === "string" &&
          typeof value.createdAt === "string" &&
          typeof value.lastSeenAt === "string"
        ) {
          folders[key] = {
            id: value.id,
            path: value.path,
            createdAt: value.createdAt,
            lastSeenAt: value.lastSeenAt,
          };
        }
      }
    }
    return { v: 1, salt: parsed.salt, folders };
  } catch {
    return undefined;
  }
}

export function resolveLocalFolderId(
  folderPath: string,
  opts: { env?: NodeJS.ProcessEnv; runtimeDir?: string; now?: () => Date } = {},
): string {
  const env = opts.env ?? process.env;
  const canonical = canonicalizePath(folderPath);
  const file = localFoldersPath(env, opts.runtimeDir);
  const timestamp = (opts.now ?? (() => new Date()))().toISOString();

  let store = loadLocalFoldersStore(env, opts.runtimeDir);
  if (!store) {
    store = {
      v: 1,
      salt: crypto.randomBytes(32).toString("hex"),
      folders: {},
    };
  }

  const existing = store.folders[canonical];
  if (existing && LOCAL_FOLDER_ID_RE.test(existing.id)) {
    return existing.id;
  }

  const digest = crypto
    .createHash("sha256")
    .update(`${store.salt}\0${canonical}`)
    .digest("hex")
    .slice(0, 16);
  const id = `local-folder:${digest}`;
  store.folders[canonical] = {
    id,
    path: canonical,
    createdAt: timestamp,
    lastSeenAt: timestamp,
  };
  atomicWriteJson(file, store);
  return id;
}

// ── Git root & safe remote inspection ─────────────────────────────────────────

function findGitRoot(realDirectory: string): string | undefined {
  let current = realDirectory;
  for (;;) {
    try {
      fs.lstatSync(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function resolveGitConfigFile(gitRoot: string): string | null {
  const dotGit = path.join(gitRoot, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    const config = path.join(dotGit, "config");
    try {
      return fs.lstatSync(config).isFile() ? config : null;
    } catch {
      return null;
    }
  }
  if (stat.isFile()) {
    try {
      const content = fs.readFileSync(dotGit, "utf8").slice(0, 4096);
      const firstLine = content.split(/\r?\n/)[0] ?? "";
      const match = /^gitdir:\s*(.+?)\s*$/.exec(firstLine);
      if (!match) return null;
      const gitDir = fs.realpathSync.native(path.resolve(gitRoot, match[1]));
      let configDir = gitDir;
      const commonDirFile = path.join(gitDir, "commondir");
      try {
        if (fs.lstatSync(commonDirFile).isFile()) {
          const common = fs.readFileSync(commonDirFile, "utf8").trim();
          if (common) {
            configDir = fs.realpathSync.native(path.resolve(gitDir, common));
          }
        }
      } catch {
        // Submodule or standalone gitdir without commondir.
      }
      const config = path.join(configDir, "config");
      return fs.lstatSync(config).isFile() ? config : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function readGitOriginUrl(gitRoot: string): string | null {
  const configFile = resolveGitConfigFile(gitRoot);
  if (!configFile) return null;
  try {
    const raw = execFileSync(
      "git",
      ["config", "--no-includes", "--file", configFile, "--get", "remote.origin.url"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
        maxBuffer: 8192,
      },
    ).trim();
    return raw || null;
  } catch {
    return null;
  }
}

function isDirectoryExcluded(
  realCwd: string,
  reconnectExcluded: readonly string[] | undefined,
  excludedDirectories: readonly string[],
): boolean {
  for (const excluded of reconnectExcluded ?? []) {
    if (pathContains(canonicalizePath(excluded), realCwd)) return true;
  }
  for (const excluded of excludedDirectories) {
    if (pathContains(canonicalizePath(excluded), realCwd)) return true;
  }
  return false;
}

function isRemoteExcluded(
  normalizedOrigin: string,
  excludedRemotes: readonly string[],
): boolean {
  const target = normalizedOrigin.toLowerCase();
  for (const entry of excludedRemotes) {
    const canonical = normalizeRemoteExclusionInput(entry) ?? entry;
    if (canonical.toLowerCase() === target) return true;
  }
  return false;
}

// ── Main checkout recognition pipeline ────────────────────────────────────────

export async function recognizeCheckout(
  cwd: string,
  opts: RecognizeCheckoutOptions = {},
): Promise<CheckoutRecognitionResult> {
  const env = opts.env ?? process.env;

  // a. Global pause always wins with zero network calls.
  if (env.MINDGRAPH_HOOKS === "off") {
    return { kind: "excluded", reason: "hooks_paused" };
  }

  // b. Existing explicit consent (or sibling reconnect) wins verbatim.
  const loaded = opts.loadedConsent ?? loadConsentStore(env);
  const decision = sessionConsent(cwd, env, loaded);
  if (decision.state === "on") {
    return {
      kind: "consented",
      root: decision.root,
      repoId: decision.repo?.repo_id ?? null,
      spaceUid: decision.space_uid,
      decision,
    };
  }

  const realCwd = decision.directory ?? realpathOrUndefined(cwd);
  if (!realCwd) {
    return { kind: "excluded", reason: "cwd_unresolvable" };
  }

  // c. Explicit directory opt-outs win before touching `.git` or the network.
  const exclusions = loadDesktopExclusions(env);
  if (
    isDirectoryExcluded(
      realCwd,
      loaded.store?.reconnectExcluded,
      exclusions.excludedDirectories,
    )
  ) {
    return { kind: "excluded", reason: "directory_excluded" };
  }

  // d. Plain non-git folders stay strictly local with a salted on-device ID.
  const gitRoot = findGitRoot(realCwd);
  if (!gitRoot) {
    const localFolderId = resolveLocalFolderId(realCwd, {
      env,
      runtimeDir: opts.runtimeDir,
      now: opts.now,
    });
    return {
      kind: "local_folder",
      localFolderId,
      root: realCwd,
    };
  }

  // e. Safely read remote.origin.url, normalize without credentials, check deny-list.
  const rawOrigin = readGitOriginUrl(gitRoot);
  const normalizedOrigin = rawOrigin ? normalizeGitOrigin(rawOrigin) : null;
  if (normalizedOrigin && isRemoteExcluded(normalizedOrigin, exclusions.excludedRemotes)) {
    return { kind: "excluded", reason: "remote_excluded" };
  }

  if (!normalizedOrigin || !opts.resolveRemote) {
    return {
      kind: "git_unlinked",
      root: gitRoot,
      normalizedOrigin,
    };
  }

  // f. Online org lookup receives ONLY `{ normalizedOrigin }`, never local paths.
  const lookup = await opts.resolveRemote({ normalizedOrigin });
  switch (lookup.status) {
    case "matched":
      return {
        kind: "recognized",
        root: gitRoot,
        normalizedOrigin,
        orgId: lookup.orgId,
        spaceUid: lookup.spaceUid,
        repoUid: lookup.repoUid,
      };
    case "ambiguous":
      return {
        kind: "ambiguous_personal",
        root: gitRoot,
        normalizedOrigin,
        candidateCount: lookup.candidateCount,
      };
    case "new_identity":
      return {
        kind: "personal_provisioned",
        root: gitRoot,
        normalizedOrigin,
        spaceUid: lookup.spaceUid,
      };
  }
}
