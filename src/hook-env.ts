import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Persisted connection settings for command hooks.
 *
 * Hooks are spawned by the harness with whatever environment the harness
 * happens to have — which usually does NOT include MINDGRAPH_API_KEY or
 * MINDGRAPH_BASE_URL (those live in the MCP server registration, a different
 * process). Without a persisted fallback, installed hooks silently no-op.
 *
 * The file is USER-level and mode 0600 because the API key is a secret:
 * project-scoped `.claude/settings.json` is commonly committed, so credentials
 * must never be written there. The `hook` command takes the key, base URL and
 * organization from this file only, so a project's settings cannot redirect
 * hook traffic; the agent id may still come from MINDGRAPH_AGENT_ID.
 */
export interface HookEnv {
  baseUrl?: string;
  apiKey?: string;
  /** Per-member agent identity — two teammates defaulting to the same
   * agent_id become ONE logical agent to leases and resume selection. */
  agentId?: string;
  /** Org pinned at install time. Hooks run with the harness's environment,
   * which usually lacks MINDGRAPH_ORG_ID even when the MCP registration has
   * it — on a multi-org key the hooks would otherwise open Sessions and claim
   * leases in the key's default org while the MCP tools write to the pinned
   * one. */
  orgId?: string;
  /** Claude UserPromptSubmit recall: true only after an explicit
   * `--prompt-recall` (default off). Persisted as `promptRecallOptIn`. The
   * older `promptRecall` key is deliberately not read: installs before the
   * default flipped wrote `promptRecall: true` whether or not the user chose
   * it, so it records the old default, not a choice. */
  promptRecall?: boolean;
  /** Claude PreCompact/SessionEnd transcript capture (default off). */
  capture?: boolean;
}

/**
 * Stable per-user agent identity, shared by BOTH harness adapters.
 *
 * The old default was the harness name, which made (a) every Claude Code
 * session on every machine one logical agent, and (b) cross-harness handoff
 * impossible: a task leased under agent "codex" failed the own-prior-work
 * gate under agent "claude-code", so the headline promise — resume your work
 * in the other harness — could never bind. Deriving the default from
 * user@host gives each person/machine one identity that both harnesses
 * share. MINDGRAPH_AGENT_ID still overrides for cross-device continuity or
 * per-teammate identities.
 */
export function stableAgentId(): string {
  let user = "user";
  try {
    user = os.userInfo().username || "user";
  } catch {
    // Some containers have no passwd entry for the current uid.
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${user}@${os.hostname()}`)
    .digest("hex")
    .slice(0, 12);
  return `u-${digest}`;
}

/**
 * Where MindGraph keeps `hooks.json` (connection settings and the consent
 * store).
 *
 * The account's home directory comes from the password database, not from
 * `$HOME`: an environment that redirects `$HOME` must not be able to point the
 * hooks at a store it wrote. `MINDGRAPH_HOME` names the directory that holds
 * `hooks.json`, but only outside every git work tree, so a repository can
 * never supply its own store. A refused override falls back to the account's
 * home directory and says why in `refused`; the consent store treats that as
 * unsafe (no consent anywhere). The runner (`~/.mindgraph/bin`) and the
 * runtime directory still follow `os.homedir()`.
 */
export interface ConfigDir {
  dir: string;
  source: "passwd" | "override" | "home";
  /** Set when the chosen location is not trusted for consent. */
  refused?: string;
}

/** The home directory from the password database, or undefined without one. */
export function passwdHome(): string | undefined {
  try {
    return os.userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/** The nearest directory at or above `target` that contains `.git`. */
export function gitWorkTreeAbove(target: string): string | undefined {
  let current = path.resolve(target);
  // Resolve the nearest existing ancestor, so a store directory that does not
  // exist yet is judged by where it would be created.
  for (;;) {
    try {
      current = fs.realpathSync.native(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function mindgraphConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): ConfigDir {
  let refused: string | undefined;
  const override = env.MINDGRAPH_HOME;
  if (override !== undefined && override !== "") {
    if (!path.isAbsolute(override)) {
      refused = `MINDGRAPH_HOME (${override}) is not an absolute path, so it is ignored`;
    } else {
      const tree = gitWorkTreeAbove(override);
      if (!tree) return { dir: path.normalize(override), source: "override" };
      refused = `MINDGRAPH_HOME (${override}) is inside a git work tree (${tree}), so it is ignored`;
    }
  }
  const home = passwdHome();
  if (home) {
    return { dir: path.join(home, ".mindgraph"), source: "passwd", refused };
  }
  const fallback = os.homedir();
  const tree = gitWorkTreeAbove(fallback);
  return {
    dir: path.join(fallback, ".mindgraph"),
    source: "home",
    refused:
      refused ??
      (tree
        ? `the home directory (${fallback}) is inside a git work tree (${tree}) and has no account entry`
        : undefined),
  };
}

export function hookEnvPath(dir?: string, env?: NodeJS.ProcessEnv): string {
  return path.join(dir || mindgraphConfigDir(env).dir, "hooks.json");
}

/** Keys that are removed from `hooks.json` on every write. `promptRecall` is
 * the old default-on flag: it records the old default, not a choice. */
export const RETIRED_KEYS = ["promptRecall"] as const;

function hookEnvFromRecord(parsed: Record<string, unknown>): HookEnv {
  return {
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
    apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
    agentId: typeof parsed.agentId === "string" ? parsed.agentId : undefined,
    orgId: typeof parsed.orgId === "string" ? parsed.orgId : undefined,
    promptRecall:
      typeof parsed.promptRecallOptIn === "boolean"
        ? parsed.promptRecallOptIn
        : undefined,
    capture: typeof parsed.capture === "boolean" ? parsed.capture : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadHookEnv(dir?: string): HookEnv {
  try {
    const raw = fs.readFileSync(hookEnvPath(dir), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return hookEnvFromRecord(parsed);
  } catch {
    return {};
  }
}

/** The hook features that actually run, from the stored choices. The hook
 * command and the consent card both use this, so the card never describes a
 * feature the hooks do not run. */
export function resolvedHookFeatures(stored: HookEnv): {
  promptRecall: boolean;
  capture: boolean;
} {
  return {
    promptRecall: stored.promptRecall === true,
    capture: stored.capture === true,
  };
}

/**
 * Read-modify-write of `hooks.json`, keeping every key the caller does not
 * touch (the consent store among them). The file is replaced atomically: a
 * fresh temporary file (mode 0600) is written, synced and renamed over the
 * old one, so a reader never sees a torn file. Concurrent writers: the last
 * rename wins; there is no lock. A file that exists but is not a JSON object
 * is never replaced.
 */
export function updateHookConfig(
  mutate: (raw: Record<string, unknown>) => void,
  target: { dir?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const file = hookEnvPath(target.dir, target.env);
  const dir = path.dirname(file);
  // A symlinked hooks.json (a dotfile manager's) is written through, as a
  // plain write always did: the new file replaces the link's target, and the
  // link stays.
  let writeTo = file;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) writeTo = fs.realpathSync.native(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let raw: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = fs.readFileSync(writeTo, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed)) {
      throw new Error(
        `${file} is not valid JSON, so it was left unchanged. Fix or remove it, then run this again.`,
      );
    }
    raw = parsed;
  }
  for (const key of RETIRED_KEYS) delete raw[key];
  mutate(raw);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The consent store is refused in a group- or world-writable directory, and
  // mkdir leaves an existing one (made under umask 002) as it was.
  if (process.platform !== "win32") {
    const stat = fs.statSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if ((stat.mode & 0o022) !== 0 && stat.uid === uid) {
      fs.chmodSync(dir, stat.mode & 0o7755);
    }
  }
  const temporary = `${writeTo}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeSync(fd, `${JSON.stringify(raw, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, writeTo);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.chmodSync(writeTo, 0o600);
  try {
    const dirFd = fs.openSync(path.dirname(writeTo), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best effort (unsupported on some platforms).
  }
  return file;
}

export function saveHookEnv(
  env: Omit<HookEnv, "orgId"> & {
    /** undefined = keep the stored pin; null = CLEAR it. Without an explicit
     * clear, a stale org pin survived every reinstall and silently routed
     * hook writes to the wrong tenant forever. */
    orgId?: string | null;
  },
  dir?: string,
): string {
  return updateHookConfig(
    (raw) => {
      const existing = hookEnvFromRecord(raw);
      const merged: HookEnv = {
        baseUrl: env.baseUrl ?? existing.baseUrl,
        apiKey: env.apiKey ?? existing.apiKey,
        agentId: env.agentId ?? existing.agentId,
        orgId: env.orgId === null ? undefined : (env.orgId ?? existing.orgId),
        promptRecall: env.promptRecall ?? existing.promptRecall,
        capture: env.capture ?? existing.capture,
      };
      // The opt-in is written under its own key; the legacy `promptRecall` key
      // is dropped on every write (RETIRED_KEYS). Every other key, the consent
      // store included, is kept as it is.
      const { promptRecall, ...stored } = merged;
      const record: Record<string, unknown> = {
        ...stored,
        promptRecallOptIn: promptRecall,
      };
      for (const [key, value] of Object.entries(record)) {
        if (value === undefined) delete raw[key];
        else raw[key] = value;
      }
    },
    { dir },
  );
}
