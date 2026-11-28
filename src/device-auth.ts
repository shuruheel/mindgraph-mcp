import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertEvalBaseUrl, isLoopbackUrl } from "./eval-guard.js";
import { loadHookEnv, mindgraphConfigDir, mindgraphRuntimeDir } from "./hook-env.js";

/**
 * Multi-process safe desktop device-grant store and refresh-token coordinator.
 *
 * Claude Code MCP, Codex MCP, session hooks, CLI commands, and the Omarchy
 * shell plugin run as separate OS processes. All of them share one owner-only
 * `device-auth.json` file (mode 0600) and serialize refresh-token rotation
 * through an exclusive lock file (`token.lock`) with double-checked re-read so
 * concurrent callers never double-rotate a refresh token.
 */

export const DEVICE_AUTH_FILENAME = "device-auth.json";
const TOKEN_LOCK_FILENAME = "token.lock";
const REFRESH_SKEW_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export interface DeviceAuthRecord {
  v: 1;
  baseUrl: string;
  dashboardUrl: string;
  orgId?: string;
  accountId?: string;
  grantId?: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Unix epoch milliseconds when `accessToken` expires. */
  expiresAt: number;
  scopes: string[];
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  updatedAt: string;
}

export interface DesktopConnectionStatus {
  connected: boolean;
  authMode: "device_grant" | "api_key" | "loopback" | "none";
  baseUrl?: string;
  dashboardUrl?: string;
  orgId?: string;
  accountId?: string;
  expiresAt?: number;
}

export interface RevokeResult {
  localCleared: boolean;
  remoteRevoked: boolean;
  pendingRemoteRevocation: boolean;
  reason?: string;
}

export type TokenRefreshFn = (
  current: DeviceAuthRecord,
) => Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
}>;

export function deviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mindgraphConfigDir(env).dir, DEVICE_AUTH_FILENAME);
}

function tokenLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mindgraphRuntimeDir(env), TOKEN_LOCK_FILENAME);
}

function isValidDeviceAuthRecord(value: unknown): value is DeviceAuthRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.baseUrl === "string" &&
    r.baseUrl.length > 0 &&
    typeof r.dashboardUrl === "string" &&
    r.dashboardUrl.length > 0 &&
    typeof r.clientId === "string" &&
    r.clientId.length > 0 &&
    typeof r.accessToken === "string" &&
    r.accessToken.length > 0 &&
    typeof r.expiresAt === "number" &&
    Number.isFinite(r.expiresAt) &&
    Array.isArray(r.scopes) &&
    r.scopes.every((s) => typeof s === "string")
  );
}

export function loadDeviceAuth(env: NodeJS.ProcessEnv = process.env): DeviceAuthRecord | undefined {
  const file = deviceAuthPath(env);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isValidDeviceAuthRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveDeviceAuth(
  record: DeviceAuthRecord,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertEvalBaseUrl(record.baseUrl, env);
  const file = deviceAuthPath(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const normalized: DeviceAuthRecord = {
    ...record,
    v: 1,
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  return file;
}

export function clearDeviceAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = deviceAuthPath(env);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return existed;
}

export function desktopConnectionStatus(
  env: NodeJS.ProcessEnv = process.env,
  cloudApi = "https://api.mindgraph.cloud",
  cloudDashboard = "https://mindgraph.cloud",
): DesktopConnectionStatus {
  const device = loadDeviceAuth(env);
  if (device) {
    return {
      connected: true,
      authMode: "device_grant",
      baseUrl: device.baseUrl,
      dashboardUrl: device.dashboardUrl,
      orgId: device.orgId,
      accountId: device.accountId,
      expiresAt: device.expiresAt,
    };
  }
  const hook = loadHookEnv(mindgraphConfigDir(env).dir);
  if (hook.apiKey) {
    return {
      connected: true,
      authMode: "api_key",
      baseUrl: hook.baseUrl || cloudApi,
      dashboardUrl: cloudDashboard,
      orgId: hook.orgId,
    };
  }
  if (hook.baseUrl && isLoopbackUrl(hook.baseUrl)) {
    return {
      connected: true,
      authMode: "loopback",
      baseUrl: hook.baseUrl,
      dashboardUrl: cloudDashboard,
      orgId: hook.orgId,
    };
  }
  return { connected: false, authMode: "none" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTokenLock<T>(
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T>,
  opts: { staleMs?: number; waitMs?: number } = {},
): Promise<T> {
  const lockFile = tokenLockPath(env);
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  const owner = `${process.pid}:${crypto.randomUUID()}`;

  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${owner}\n`, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for MindGraph token refresh lock.");
      }
      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const content = fs.readFileSync(lockFile, "utf8").trim();
      if (content === owner) fs.rmSync(lockFile, { force: true });
    } catch {
      // Lock file already removed.
    }
  }
}

async function defaultRefreshGrant(
  current: DeviceAuthRecord,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch = fetch,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
}> {
  if (!current.refreshToken) {
    throw new Error("Device session expired and has no refresh token. Reconnect MindGraph.");
  }
  const endpoint = current.tokenEndpoint || `${current.baseUrl.replace(/\/+$/, "")}/oauth/token`;
  assertEvalBaseUrl(endpoint, env);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: current.clientId,
    refresh_token: current.refreshToken,
  });
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Device token refresh failed (HTTP ${response.status}). Reconnect MindGraph.`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Token endpoint did not return an access_token.");
  }
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : current.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : current.scopes,
  };
}

/**
 * Returns a valid bearer token for desktop-managed calls.
 *
 * - Uses `device-auth.json` when present, refreshing under an exclusive file
 *   lock with double-checked re-read so concurrent processes never race.
 * - Falls back seamlessly to legacy `hooks.json` `apiKey` during migration.
 */
export async function getValidDesktopToken(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    now?: () => number;
    skewMs?: number;
    refresh?: TokenRefreshFn;
    fetchFn?: typeof fetch;
    staleLockMs?: number;
  } = {},
): Promise<{ token: string; authMode: "device_grant" | "api_key"; baseUrl: string; orgId?: string } | undefined> {
  const now = opts.now ?? (() => Date.now());
  const skewMs = opts.skewMs ?? REFRESH_SKEW_MS;
  const current = loadDeviceAuth(env);

  if (!current) {
    const hook = loadHookEnv(mindgraphConfigDir(env).dir);
    if (!hook.apiKey) return undefined;
    return {
      token: hook.apiKey,
      authMode: "api_key",
      baseUrl: hook.baseUrl || "https://api.mindgraph.cloud",
      orgId: hook.orgId,
    };
  }

  if (current.expiresAt - now() > skewMs) {
    return {
      token: current.accessToken,
      authMode: "device_grant",
      baseUrl: current.baseUrl,
      orgId: current.orgId,
    };
  }

  const refreshed = await withTokenLock(
    env,
    async () => {
      // Double-check after acquiring lock: another process may have just rotated it.
      const latest = loadDeviceAuth(env);
      if (!latest) {
        throw new Error("MindGraph was disconnected while refreshing credentials.");
      }
      if (latest.expiresAt - now() > skewMs) {
        return latest;
      }
      const next = opts.refresh
        ? await opts.refresh(latest)
        : await defaultRefreshGrant(latest, env, opts.fetchFn);
      const updated: DeviceAuthRecord = {
        ...latest,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? latest.refreshToken,
        expiresAt: next.expiresAt,
        scopes: next.scopes ?? latest.scopes,
        updatedAt: new Date(now()).toISOString(),
      };
      saveDeviceAuth(updated, env);
      return updated;
    },
    { staleMs: opts.staleLockMs },
  );

  return {
    token: refreshed.accessToken,
    authMode: "device_grant",
    baseUrl: refreshed.baseUrl,
    orgId: refreshed.orgId,
  };
}

/**
 * Best-effort RFC 7009 remote grant revocation followed by guaranteed local
 * device-auth deletion. Offline failures still clear local state immediately
 * and report `pendingRemoteRevocation: true`.
 */
export async function revokeDeviceAuth(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<RevokeResult> {
  const current = loadDeviceAuth(env);
  if (!current) {
    return { localCleared: false, remoteRevoked: false, pendingRemoteRevocation: false };
  }
  const tokenToRevoke = current.refreshToken || current.accessToken;
  const endpoint = current.revocationEndpoint || `${current.baseUrl.replace(/\/+$/, "")}/oauth/revoke`;
  let remoteRevoked = false;
  let reason: string | undefined;

  try {
    assertEvalBaseUrl(endpoint, env);
    const body = new URLSearchParams({
      token: tokenToRevoke,
      client_id: current.clientId,
      token_type_hint: current.refreshToken ? "refresh_token" : "access_token",
    });
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      remoteRevoked = true;
    } else {
      reason = `Remote revocation returned HTTP ${res.status}.`;
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  } finally {
    clearDeviceAuth(env);
  }

  return {
    localCleared: true,
    remoteRevoked,
    pendingRemoteRevocation: !remoteRevoked,
    ...(reason ? { reason } : {}),
  };
}
