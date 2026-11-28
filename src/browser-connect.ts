import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { DeviceAuthRecord } from "./device-auth.js";
import { assertEvalBaseUrl, EvalLoopbackError, isLoopbackUrl } from "./eval-guard.js";

const POLL_INTERVAL = 2000; // 2 seconds
const POLL_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_CLOUD_API = "https://api.mindgraph.cloud";
const DEFAULT_CLOUD_DASHBOARD = "https://mindgraph.cloud";

export const DEFAULT_DEVICE_CLIENT_ID = "mindgraph-omarchy";
export const DEFAULT_DEVICE_SCOPES = ["graph:read", "graph:write", "board:read"] as const;

export interface BrowserDeviceSignInOptions {
  out?: (line: string) => void;
  dashboard?: string;
  apiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  clientId?: string;
  scopes?: readonly string[];
  fetchFn?: typeof fetch;
  openUrl?: (url: string) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface DevicePollAuthorized {
  code: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  orgId?: string;
  accountId?: string;
  grantId?: string;
  apiBaseUrl?: string;
}

class DeviceAuthTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceAuthTerminalError";
  }
}

function generateCode(): string {
  return crypto.randomBytes(32).toString("hex");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function assertHttpUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label} URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${label} URL protocol.`);
  }
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates an RFC 7636 PKCE code verifier (base64url, 43 characters from 32
 * cryptographically random bytes).
 */
export function generatePkceVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Computes the RFC 7636 S256 PKCE code challenge:
 * `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`.
 */
export function pkceChallengeS256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function openBrowser(url: string): void {
  // C44 (same class): the URL was interpolated into a shell string, and it
  // derives from MINDGRAPH_DASHBOARD_URL. Lower severity than the API-key path
  // since the operator sets their own env, but it is the same one-line fix, so
  // there is no reason to leave a second shell-interpolation site behind.
  try {
    switch (process.platform) {
      case "darwin":
        execFileSync("open", [url]);
        break;
      case "win32":
        // `start` is a cmd builtin, so cmd is unavoidable — but passing argv
        // keeps the URL out of the command STRING. The empty argument is
        // start's title placeholder.
        execFileSync("cmd", ["/c", "start", "", url]);
        break;
      case "linux":
        execFileSync("xdg-open", [url]);
        break;
    }
  } catch {
    // Silently fail — we'll show the URL for manual copy
  }
}

async function pollForKey(dashboard: string, code: string): Promise<string> {
  const pollUrl = `${dashboard}/api/connect?code=${code}`;
  const deadline = Date.now() + POLL_TIMEOUT;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(pollUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
      const data = await res.json();

      if (data.status === "authorized" && data.api_key) {
        return data.api_key;
      }
      if (data.status === "expired") {
        throw new Error("Session expired. Please try again.");
      }
      if (data.status === "claimed") {
        throw new Error("Session already used. Please try again.");
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("Session")) throw e;
      // Network error — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error("Timed out waiting for authorization.");
}


export async function browserSignIn(out: (line: string) => void, dashboard: string, env: NodeJS.ProcessEnv): Promise<string> {
  assertEvalBaseUrl(dashboard, env);
  const code = generateCode();
  const url = `${dashboard}/dashboard/connect?code=${code}`;
  out("Sign in to MindGraph in your browser. If it did not open, visit:");
  out(url);
  openBrowser(url);
  return pollForKey(dashboard, code);
}

async function pollForDeviceCode(
  dashboard: string,
  state: string,
  fetchFn: typeof fetch,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<DevicePollAuthorized> {
  const pollUrl = `${dashboard}/api/connect/device?state=${encodeURIComponent(state)}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(pollUrl, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      const raw = (await res.json()) as unknown;

      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const data = raw as Record<string, unknown>;

        if (data.state !== undefined && data.state !== state) {
          throw new DeviceAuthTerminalError("Device authorization state mismatch.");
        }
        if (data.status === "authorized") {
          const code = nonEmptyString(data.code);
          if (!code) {
            throw new DeviceAuthTerminalError("Device authorization response did not include an authorization code.");
          }
          return {
            code,
            tokenEndpoint: nonEmptyString(data.token_endpoint),
            revocationEndpoint: nonEmptyString(data.revocation_endpoint),
            orgId: nonEmptyString(data.org_id),
            accountId: nonEmptyString(data.account_id),
            grantId: nonEmptyString(data.grant_id),
            apiBaseUrl: nonEmptyString(data.api_base_url),
          };
        }
        if (data.status === "expired" || data.error === "expired_token") {
          throw new DeviceAuthTerminalError("Device authorization session expired. Please try again.");
        }
        if (data.status === "denied" || data.error === "access_denied") {
          throw new DeviceAuthTerminalError("Device authorization was denied.");
        }
        if (data.status === "claimed") {
          throw new DeviceAuthTerminalError("Device authorization session already used. Please try again.");
        }
      }
    } catch (error: unknown) {
      if (error instanceof DeviceAuthTerminalError || error instanceof EvalLoopbackError) {
        throw error;
      }
      // Transient network or parse error — keep polling until timeout.
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  throw new Error("Timed out waiting for authorization.");
}

/**
 * Runs the OAuth 2.0 PKCE (RFC 7636) device authorization flow in the browser
 * and returns a validated `DeviceAuthRecord` ready for `saveDeviceAuth`.
 */
export async function browserDeviceSignIn(
  opts: BrowserDeviceSignInOptions = {},
): Promise<DeviceAuthRecord> {
  const env = opts.env ?? process.env;
  const out = opts.out ?? (() => {});
  const fetchFn = opts.fetchFn ?? fetch;
  const openUrl = opts.openUrl ?? openBrowser;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT;
  const now = opts.now ?? (() => Date.now());
  const clientId = nonEmptyString(opts.clientId) ?? DEFAULT_DEVICE_CLIENT_ID;
  const scopes = opts.scopes && opts.scopes.length > 0 ? [...opts.scopes] : [...DEFAULT_DEVICE_SCOPES];

  const dashboard = stripTrailingSlashes(
    assertHttpUrl(
      assertEvalBaseUrl(opts.dashboard || env.MINDGRAPH_DASHBOARD_URL || DEFAULT_CLOUD_DASHBOARD, env),
      "dashboard",
    ),
  );
  if (opts.apiBaseUrl) {
    assertHttpUrl(assertEvalBaseUrl(opts.apiBaseUrl, env), "API base");
  }

  const verifier = generatePkceVerifier();
  const challenge = pkceChallengeS256(verifier);
  const state = crypto.randomBytes(24).toString("base64url");

  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: scopes.join(" "),
  });
  const authorizeUrl = `${dashboard}/dashboard/connect/device?${authorizeParams.toString()}`;

  out("Sign in to MindGraph in your browser. If it did not open, visit:");
  out(authorizeUrl);
  openUrl(authorizeUrl);

  const poll = await pollForDeviceCode(dashboard, state, fetchFn, pollIntervalMs, timeoutMs);

  const resolvedBaseUrl = stripTrailingSlashes(
    assertHttpUrl(
      assertEvalBaseUrl(
        poll.apiBaseUrl ||
          opts.apiBaseUrl ||
          env.MINDGRAPH_API_URL ||
          (isLoopbackUrl(dashboard) ? dashboard : DEFAULT_CLOUD_API),
        env,
      ),
      "API base",
    ),
  );
  const tokenEndpoint = assertHttpUrl(
    assertEvalBaseUrl(poll.tokenEndpoint || `${resolvedBaseUrl}/oauth/token`, env),
    "token endpoint",
  );

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code: poll.code,
    code_verifier: verifier,
  });

  const tokenRes = await fetchFn(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: tokenBody,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  let parsedTokenBody: Record<string, unknown> | undefined;
  try {
    const raw = (await tokenRes.json()) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      parsedTokenBody = raw as Record<string, unknown>;
    }
  } catch {
    // Non-JSON error body; handled below without echoing raw response text.
  }

  if (!tokenRes.ok) {
    const oauthErr =
      parsedTokenBody &&
      typeof parsedTokenBody.error === "string" &&
      /^[A-Za-z0-9_.-]+$/.test(parsedTokenBody.error)
        ? `: ${parsedTokenBody.error}`
        : "";
    throw new Error(`Device token exchange failed (HTTP ${tokenRes.status}${oauthErr}).`);
  }

  if (!parsedTokenBody) {
    throw new Error("Token endpoint returned an invalid JSON payload.");
  }

  const accessToken = nonEmptyString(parsedTokenBody.access_token);
  if (!accessToken) {
    throw new Error("Token endpoint did not return an access_token.");
  }

  const refreshToken = nonEmptyString(parsedTokenBody.refresh_token);
  const expiresIn =
    typeof parsedTokenBody.expires_in === "number" &&
    Number.isFinite(parsedTokenBody.expires_in) &&
    parsedTokenBody.expires_in > 0
      ? parsedTokenBody.expires_in
      : 3600;
  const nowMs = now();
  const expiresAt = nowMs + expiresIn * 1000;

  const grantedScopes =
    typeof parsedTokenBody.scope === "string"
      ? parsedTokenBody.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(parsedTokenBody.scopes) &&
          parsedTokenBody.scopes.every((s) => typeof s === "string")
        ? (parsedTokenBody.scopes as string[])
        : scopes;

  const finalBaseUrl = stripTrailingSlashes(
    assertHttpUrl(
      assertEvalBaseUrl(nonEmptyString(parsedTokenBody.api_base_url) || resolvedBaseUrl, env),
      "API base",
    ),
  );
  const finalTokenEndpoint = assertHttpUrl(
    assertEvalBaseUrl(nonEmptyString(parsedTokenBody.token_endpoint) || tokenEndpoint, env),
    "token endpoint",
  );
  const rawRevocationEndpoint =
    nonEmptyString(parsedTokenBody.revocation_endpoint) ?? poll.revocationEndpoint;
  const revocationEndpoint = rawRevocationEndpoint
    ? assertHttpUrl(assertEvalBaseUrl(rawRevocationEndpoint, env), "revocation endpoint")
    : undefined;

  const orgId = nonEmptyString(parsedTokenBody.org_id) ?? poll.orgId;
  const accountId = nonEmptyString(parsedTokenBody.account_id) ?? poll.accountId;
  const grantId = nonEmptyString(parsedTokenBody.grant_id) ?? poll.grantId;

  return {
    v: 1,
    baseUrl: finalBaseUrl,
    dashboardUrl: dashboard,
    ...(orgId ? { orgId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(grantId ? { grantId } : {}),
    clientId,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt,
    scopes: grantedScopes,
    tokenEndpoint: finalTokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    updatedAt: new Date(nowMs).toISOString(),
  };
}
