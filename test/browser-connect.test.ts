import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserDeviceSignIn,
  browserSignIn,
  DEFAULT_DEVICE_CLIENT_ID,
  DEFAULT_DEVICE_SCOPES,
  generatePkceVerifier,
  openBrowser,
  pkceChallengeS256,
} from "../src/browser-connect.js";
import {
  desktopConnectionStatus,
  deviceAuthPath,
  loadDeviceAuth,
  saveDeviceAuth,
} from "../src/device-auth.js";
import { EVAL_REQUIRES_LOOPBACK, EvalLoopbackError } from "../src/eval-guard.js";
import { tempDir } from "./fixtures/consent.js";

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = tempDir("mg-browser-connect-");
  const store = path.join(tmp, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  env = { MINDGRAPH_HOME: store, MINDGRAPH_EVAL: "1" };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("RFC 7636 PKCE helpers", () => {
  it("matches the RFC 7636 Appendix B S256 test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(pkceChallengeS256(verifier)).toBe(expectedChallenge);
  });

  it("computes unpadded base64url S256 challenges for additional vectors", () => {
    // SHA-256("") = 47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU
    expect(pkceChallengeS256("")).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
    // Unpadded base64url alphabet only (no '+', '/', or '=').
    const challenge = pkceChallengeS256(generatePkceVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates RFC 7636 compliant base64url verifiers (43-128 chars) with high entropy", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      const verifier = generatePkceVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
      seen.add(verifier);
    }
    expect(seen.size).toBe(16);
  });
});

describe("browserDeviceSignIn", () => {
  it("completes PKCE device authorize + token exchange, persists via saveDeviceAuth, and never echoes secrets", async () => {
    const output: string[] = [];
    const openedUrls: string[] = [];
    const seenRequests: Array<{ url: string; method: string; body?: string }> = [];
    const fixedNow = 1_750_000_000_000;

    const authCode = "ac_secret_device_code_987654";
    const accessToken = "atk_super_secret_access_token";
    const refreshToken = "rtk_super_secret_refresh_token";

    let pollCount = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const body = init?.body ? String(init.body) : undefined;
      seenRequests.push({ url, method, body });

      if (url.startsWith("http://127.0.0.1:18901/api/connect/device")) {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
        }
        if (pollCount === 2) {
          throw new Error("transient socket reset");
        }
        return new Response(
          JSON.stringify({
            status: "authorized",
            code: authCode,
            api_base_url: "http://127.0.0.1:18900",
            token_endpoint: "http://127.0.0.1:18900/oauth/token",
            revocation_endpoint: "http://127.0.0.1:18900/oauth/revoke",
            org_id: "org_demo",
            account_id: "usr_42",
            grant_id: "grant_xyz",
          }),
          { status: 200 },
        );
      }

      if (url === "http://127.0.0.1:18900/oauth/token") {
        expect(method).toBe("POST");
        const form = new URLSearchParams(body);
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("client_id")).toBe(DEFAULT_DEVICE_CLIENT_ID);
        expect(form.get("code")).toBe(authCode);

        const sentVerifier = form.get("code_verifier") ?? "";
        expect(sentVerifier.length).toBeGreaterThanOrEqual(43);
        const browserParams = new URL(openedUrls[0]).searchParams;
        expect(pkceChallengeS256(sentVerifier)).toBe(browserParams.get("code_challenge"));

        return new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 1800,
            scope: "graph:read graph:write board:read",
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const record = await browserDeviceSignIn({
        out: (line) => output.push(line),
        dashboard: "http://127.0.0.1:18901/",
        env,
        fetchFn,
        openUrl: (url) => openedUrls.push(url),
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        now: () => fixedNow,
      });

      // Verify browser URL structure and PKCE challenge parameters.
      expect(openedUrls).toHaveLength(1);
      const parsedAuthUrl = new URL(openedUrls[0]);
      expect(parsedAuthUrl.origin).toBe("http://127.0.0.1:18901");
      expect(parsedAuthUrl.pathname).toBe("/dashboard/connect/device");
      expect(parsedAuthUrl.searchParams.get("client_id")).toBe(DEFAULT_DEVICE_CLIENT_ID);
      expect(parsedAuthUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(parsedAuthUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(parsedAuthUrl.searchParams.get("state")).toBeTruthy();
      expect(parsedAuthUrl.searchParams.get("scope")).toBe(DEFAULT_DEVICE_SCOPES.join(" "));

      // Verify poll URL carried the exact state from the authorize URL.
      const pollReq = seenRequests[0];
      expect(new URL(pollReq.url).searchParams.get("state")).toBe(parsedAuthUrl.searchParams.get("state"));

      // Verify returned DeviceAuthRecord.
      expect(record).toEqual({
        v: 1,
        baseUrl: "http://127.0.0.1:18900",
        dashboardUrl: "http://127.0.0.1:18901",
        orgId: "org_demo",
        accountId: "usr_42",
        grantId: "grant_xyz",
        clientId: DEFAULT_DEVICE_CLIENT_ID,
        accessToken,
        refreshToken,
        expiresAt: fixedNow + 1_800_000,
        scopes: ["graph:read", "graph:write", "board:read"],
        tokenEndpoint: "http://127.0.0.1:18900/oauth/token",
        revocationEndpoint: "http://127.0.0.1:18900/oauth/revoke",
        updatedAt: new Date(fixedNow).toISOString(),
      });

      // Verify the record saves cleanly via saveDeviceAuth and loads back intact.
      const savedPath = saveDeviceAuth(record, env);
      expect(savedPath).toBe(deviceAuthPath(env));
      expect(fs.statSync(savedPath).mode & 0o777).toBe(0o600);
      expect(loadDeviceAuth(env)).toEqual(record);
      expect(desktopConnectionStatus(env)).toMatchObject({
        connected: true,
        authMode: "device_grant",
        baseUrl: "http://127.0.0.1:18900",
        orgId: "org_demo",
        accountId: "usr_42",
      });

      // Verify NO secrets (verifier, auth code, access token, refresh token) were echoed.
      const tokenReq = seenRequests.find((r) => r.url === "http://127.0.0.1:18900/oauth/token");
      const verifier = new URLSearchParams(tokenReq?.body).get("code_verifier")!;
      const allOut = output.join("\n");
      expect(allOut).not.toContain(verifier);
      expect(allOut).not.toContain(authCode);
      expect(allOut).not.toContain(accessToken);
      expect(allOut).not.toContain(refreshToken);
      expect(openedUrls[0]).not.toContain(verifier);
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleErrSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      consoleErrSpy.mockRestore();
    }
  });

  it("rejects immediately on expired device sessions without calling the token endpoint", async () => {
    const calls: string[] = [];
    await expect(
      browserDeviceSignIn({
        out: () => {},
        dashboard: "http://127.0.0.1:18901",
        env,
        openUrl: () => {},
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        fetchFn: async (input) => {
          calls.push(String(input));
          return new Response(JSON.stringify({ status: "expired" }), { status: 410 });
        },
      }),
    ).rejects.toThrow(/expired/i);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/connect/device");
  });

  it("rejects immediately when the user denies authorization without calling the token endpoint", async () => {
    const calls: string[] = [];
    await expect(
      browserDeviceSignIn({
        out: () => {},
        dashboard: "http://127.0.0.1:18901",
        env,
        openUrl: () => {},
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        fetchFn: async (input) => {
          calls.push(String(input));
          return new Response(JSON.stringify({ status: "denied" }), { status: 200 });
        },
      }),
    ).rejects.toThrow(/denied/i);

    expect(calls).toHaveLength(1);
  });

  it("times out cleanly when polling remains pending past timeoutMs", async () => {
    await expect(
      browserDeviceSignIn({
        out: () => {},
        dashboard: "http://127.0.0.1:18901",
        env,
        openUrl: () => {},
        pollIntervalMs: 5,
        timeoutMs: 20,
        fetchFn: async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }),
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("rejects on state mismatch in poll response", async () => {
    await expect(
      browserDeviceSignIn({
        out: () => {},
        dashboard: "http://127.0.0.1:18901",
        env,
        openUrl: () => {},
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        fetchFn: async () =>
          new Response(
            JSON.stringify({ status: "authorized", state: "forged_state", code: "ac_123" }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it("does not leak secrets in error messages when token exchange fails", async () => {
    const secretCode = "ac_sensitive_code_do_not_echo";
    const secretBodyToken = "atk_should_not_appear_in_error";
    let sentVerifier = "";

    let err: unknown;
    try {
      await browserDeviceSignIn({
        out: () => {},
        dashboard: "http://127.0.0.1:18901",
        env,
        openUrl: () => {},
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        fetchFn: async (input, init) => {
          const url = String(input);
          if (url.includes("/api/connect/device")) {
            return new Response(
              JSON.stringify({
                status: "authorized",
                code: secretCode,
                token_endpoint: "http://127.0.0.1:18900/oauth/token",
              }),
              { status: 200 },
            );
          }
          sentVerifier = new URLSearchParams(String(init?.body)).get("code_verifier") ?? "";
          return new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: `leaked ${secretBodyToken} ${sentVerifier}`,
            }),
            { status: 400 },
          );
        },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("HTTP 400: invalid_grant");
    expect(msg).not.toContain(secretCode);
    expect(msg).not.toContain(sentVerifier);
    expect(msg).not.toContain(secretBodyToken);
  });

  it("enforces eval-guard loopback on dashboard URL before opening browser or fetching", async () => {
    const openUrl = vi.fn();
    const fetchFn = vi.fn();

    await expect(
      browserDeviceSignIn({
        out: () => {},
        dashboard: "https://mindgraph.cloud",
        env: { ...env, MINDGRAPH_EVAL: "1" },
        openUrl,
        fetchFn,
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "EvalLoopbackError",
      code: EVAL_REQUIRES_LOOPBACK,
    });

    expect(openUrl).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("enforces eval-guard loopback on token_endpoint returned by poll before exchanging the code", async () => {
    const fetchedUrls: string[] = [];

    const promise = browserDeviceSignIn({
      out: () => {},
      dashboard: "http://127.0.0.1:18901",
      env: { ...env, MINDGRAPH_EVAL: "1" },
      openUrl: () => {},
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      fetchFn: async (input) => {
        const url = String(input);
        fetchedUrls.push(url);
        return new Response(
          JSON.stringify({
            status: "authorized",
            code: "ac_eval_guard_test",
            token_endpoint: "https://api.mindgraph.cloud/oauth/token",
          }),
          { status: 200 },
        );
      },
    });

    await expect(promise).rejects.toBeInstanceOf(EvalLoopbackError);
    expect(fetchedUrls).toHaveLength(1);
    expect(fetchedUrls[0]).toContain("127.0.0.1:18901/api/connect/device");
  });

  it("enforces eval-guard loopback on api_base_url and revocation_endpoint returned by server", async () => {
    await expect(
      browserDeviceSignIn({
        out: () => {},
        dashboard: "http://127.0.0.1:18901",
        env: { ...env, MINDGRAPH_EVAL: "1" },
        openUrl: () => {},
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              status: "authorized",
              code: "ac_bad_api",
              api_base_url: "https://api.mindgraph.cloud",
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toBeInstanceOf(EvalLoopbackError);

    await expect(
      browserDeviceSignIn({
        out: () => {},
        dashboard: "http://127.0.0.1:18901",
        env: { ...env, MINDGRAPH_EVAL: "1" },
        openUrl: () => {},
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        fetchFn: async (input) => {
          if (String(input).includes("/api/connect/device")) {
            return new Response(
              JSON.stringify({
                status: "authorized",
                code: "ac_bad_revoke",
                token_endpoint: "http://127.0.0.1:18900/oauth/token",
                revocation_endpoint: "https://api.mindgraph.cloud/oauth/revoke",
              }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ access_token: "atk_ok", expires_in: 600 }), { status: 200 });
        },
      }),
    ).rejects.toBeInstanceOf(EvalLoopbackError);
  });
});

describe("Backward compatibility", () => {
  it("keeps browserSignIn and openBrowser exported with existing eval-guard behavior", async () => {
    expect(typeof openBrowser).toBe("function");
    expect(typeof browserSignIn).toBe("function");
    await expect(
      browserSignIn(() => {}, "https://mindgraph.cloud", { ...env, MINDGRAPH_EVAL: "1" }),
    ).rejects.toBeInstanceOf(EvalLoopbackError);
  });
});
