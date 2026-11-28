import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserDeviceSignIn } from "../src/browser-connect.js";
import { runDesktop } from "../src/desktop.js";
import { getValidDesktopToken, loadDeviceAuth, saveDeviceAuth } from "../src/device-auth.js";
import { createShellDaemon, queryShellDaemon, shellSocketPath } from "../src/shell-daemon.js";
import type { DesktopIo } from "../src/desktop-setup.js";
import { tempDir } from "./fixtures/consent.js";

interface ActiveGrant {
  accountId: string;
  orgId: string;
  accessToken: string;
  refreshToken: string;
  revoked: boolean;
}

/**
 * Live loopback OAuth PKCE + RFC 7009 Revoke + Work Dashboard Widgets server
 * exercising the full Omarchy desktop connect -> refresh -> widget sync ->
 * disconnect/revoke -> account-switch isolation loop over real HTTP & Unix sockets.
 */
function startMockCloudOAuthServer() {
  let currentAccount = { accountId: "usr_alice", orgId: "org_alpha", blockerQ: "Alice: which fixture?" };
  const pendingCodes = new Map<string, { code: string; challenge: string; clientId: string; account: typeof currentAccount }>();
  const grantsByAccess = new Map<string, ActiveGrant>();
  const grantsByRefresh = new Map<string, ActiveGrant>();
  let tokenCounter = 0;
  let refreshCount = 0;
  let revokeCount = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");

    // 1. Browser authorization simulation (triggered by openUrl in test)
    if (req.method === "GET" && url.pathname === "/dashboard/connect/device") {
      const state = url.searchParams.get("state")!;
      const challenge = url.searchParams.get("code_challenge")!;
      const clientId = url.searchParams.get("client_id")!;
      pendingCodes.set(state, {
        code: `code_${++tokenCounter}`,
        challenge,
        clientId,
        account: { ...currentAccount },
      });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("approved");
      return;
    }

    // 2. Device polling endpoint
    if (req.method === "GET" && url.pathname === "/api/connect/device") {
      const state = url.searchParams.get("state") || "";
      const entry = pendingCodes.get(state);
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (!entry) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "authorized",
        state,
        code: entry.code,
        org_id: entry.account.orgId,
        account_id: entry.account.accountId,
        grant_id: `grant_${entry.account.accountId}`,
        api_base_url: origin,
        token_endpoint: `${origin}/oauth/token`,
        revocation_endpoint: `${origin}/oauth/revoke`,
      }));
      return;
    }

    // 3. RFC 6749 + PKCE S256 token endpoint (authorization_code & rotating refresh_token)
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const form = new URLSearchParams(bodyText);
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") {
        const code = form.get("code");
        const verifier = form.get("code_verifier") || "";
        const entry = [...pendingCodes.values()].find((p) => p.code === code);
        const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
        if (!entry || entry.challenge !== expected) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const grant: ActiveGrant = {
          accountId: entry.account.accountId,
          orgId: entry.account.orgId,
          accessToken: `atk_${++tokenCounter}_${entry.account.accountId}`,
          refreshToken: `rtk_${++tokenCounter}_${entry.account.accountId}`,
          revoked: false,
        };
        grantsByAccess.set(grant.accessToken, grant);
        grantsByRefresh.set(grant.refreshToken, grant);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          access_token: grant.accessToken,
          refresh_token: grant.refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "graph:read graph:write board:read",
        }));
        return;
      }

      if (grantType === "refresh_token") {
        refreshCount += 1;
        const rtk = form.get("refresh_token") || "";
        const grant = grantsByRefresh.get(rtk);
        if (!grant || grant.revoked) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        // Simulate real rotating refresh family: old refresh token is consumed immediately!
        grantsByRefresh.delete(rtk);
        grantsByAccess.delete(grant.accessToken);
        await new Promise((r) => setTimeout(r, 40));
        grant.accessToken = `atk_rot_${++tokenCounter}_${grant.accountId}`;
        grant.refreshToken = `rtk_rot_${++tokenCounter}_${grant.accountId}`;
        grantsByAccess.set(grant.accessToken, grant);
        grantsByRefresh.set(grant.refreshToken, grant);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          access_token: grant.accessToken,
          refresh_token: grant.refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
        }));
        return;
      }
    }

    // 4. RFC 7009 revocation endpoint
    if (req.method === "POST" && url.pathname === "/oauth/revoke") {
      revokeCount += 1;
      const form = new URLSearchParams(bodyText);
      const token = form.get("token") || "";
      const grant = grantsByRefresh.get(token) || grantsByAccess.get(token);
      if (grant) grant.revoked = true;
      res.writeHead(200);
      res.end();
      return;
    }

    // 5. Protected Work Dashboard Widgets endpoint
    if (req.method === "GET" && url.pathname === "/v1/work-dashboard/widgets") {
      const auth = req.headers.authorization || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const grant = grantsByAccess.get(token);
      if (!grant || grant.revoked) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        cursor: `cur_${grant.accountId}_1`,
        syncedAt: new Date().toISOString(),
        memberId: grant.accountId,
        objectives: [],
        blockers: [
          {
            org_id: grant.orgId,
            blocker_id: `blk_${grant.accountId}`,
            blocking_episode: "ep_1",
            story_uid: `story_${grant.accountId}`,
            lane_id: "memory-quality",
            lane_state: "active",
            work_state: "stopped",
            required_responder_id: grant.accountId,
            question: grant.accountId === "usr_alice" ? "Alice: which fixture?" : "Bob: confirm schema?",
            thread_url: "http://127.0.0.1/dashboard",
          },
        ],
        decisions: [],
        updates: [],
        tasks: [],
        lanes: [{ lane_id: "memory-quality", name: "Memory quality", state: "active" }],
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    setAccount(accountId: string, orgId: string, blockerQ: string) {
      currentAccount = { accountId, orgId, blockerQ };
    },
    stats: () => ({ refreshCount, revokeCount }),
  };
}

let tmp: string;
let env: NodeJS.ProcessEnv;
let mock: ReturnType<typeof startMockCloudOAuthServer>;
let baseUrl: string;

beforeEach(async () => {
  tmp = tempDir("mg-connect-revoke-e2e-");
  const store = path.join(tmp, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  env = { MINDGRAPH_HOME: store, MINDGRAPH_EVAL: "1" };
  mock = startMockCloudOAuthServer();
  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const addr = mock.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Live Omarchy PKCE connect -> concurrent refresh -> shell sync -> revoke -> account switch E2E", () => {
  it("completes the full connect, multi-process refresh, shell widget sync, remote revoke, and account-isolation cycle", async () => {
    const shown: string[] = [];
    const makeIo = (answers: string[], tty = true): DesktopIo => ({
      env,
      stdin: { isTTY: tty },
      stdout: { isTTY: tty },
      out: (line) => shown.push(line),
      ask: async () => answers.shift() ?? "",
    });

    // 1. Connect Account A (Alice) via real HTTP PKCE S256 device authorization.
    const aliceGrant = await browserDeviceSignIn({
      dashboard: baseUrl,
      apiBaseUrl: baseUrl,
      env,
      out: (l) => shown.push(l),
      pollIntervalMs: 10,
      openUrl: (authUrl) => {
        void fetch(authUrl);
      },
    });
    saveDeviceAuth(aliceGrant, env);

    // Zero-network local status reports connected device_grant for Alice.
    shown.length = 0;
    await runDesktop(["status", "--json"], makeIo([], false));
    expect(JSON.parse(shown[0])).toMatchObject({
      connected: true,
      authMode: "device_grant",
      accountId: "usr_alice",
      orgId: "org_alpha",
    });

    // 2. Concurrent refresh race test: expire access token and fire 5 simultaneous callers.
    saveDeviceAuth({ ...aliceGrant, expiresAt: Date.now() - 5_000 }, env);
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => getValidDesktopToken(env)),
    );
    expect(mock.stats().refreshCount).toBe(1);
    const rotatedToken = tokens[0]!.token;
    expect(rotatedToken).toContain("atk_rot_");
    for (const t of tokens) expect(t?.token).toBe(rotatedToken);

    // 3. Live Unix-socket shell daemon fetches widgets with the rotated token & alerts once.
    const notified: string[] = [];
    const daemon = createShellDaemon({
      env,
      notify: (alert) => {
        notified.push(alert.blocker.question);
      },
      fetchFeed: async () => {
        const tok = await getValidDesktopToken(env);
        const res = await fetch(`${baseUrl}/v1/work-dashboard/widgets`, {
          headers: { Authorization: `Bearer ${tok!.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as never;
      },
    });
    await daemon.start();
    try {
      await daemon.syncNow();
      await daemon.syncNow(); // Replay must not double-notify!
      expect(notified).toEqual(["Alice: which fixture?"]);

      const summary = await queryShellDaemon(shellSocketPath(env), { id: "1", method: "get_summary" });
      expect(summary.ok).toBe(true);
      expect((summary.result as { widgets: { blockers: Array<{ question: string }> } }).widgets.blockers[0].question).toBe(
        "Alice: which fixture?",
      );

      // 4. Disconnect mid-session -> revokes remotely via RFC 7009 + wipes live shell daemon!
      shown.length = 0;
      await runDesktop(["disconnect"], makeIo(["y"], true));
      expect(mock.stats().revokeCount).toBe(1);
      expect(shown.join("\n")).toContain("revoked device access remotely");
      expect(loadDeviceAuth(env)).toBeUndefined();

      // Old rotated token is now rejected with 401 by the cloud server!
      const afterRevoke = await fetch(`${baseUrl}/v1/work-dashboard/widgets`, {
        headers: { Authorization: `Bearer ${rotatedToken}` },
      });
      expect(afterRevoke.status).toBe(401);

      // Live shell daemon immediately reports signed_out with empty widgets!
      const cleared = await queryShellDaemon(shellSocketPath(env), { id: "2", method: "get_summary" });
      expect((cleared.result as { connected: boolean; state: string; widgets: { blockers: unknown[] } })).toMatchObject({
        connected: false,
        state: "signed_out",
        widgets: { blockers: [] },
      });

      // 5. Reconnect as Account B (Bob) -> complete account/cache isolation!
      mock.setAccount("usr_bob", "org_beta", "Bob: confirm schema?");
      const bobGrant = await browserDeviceSignIn({
        dashboard: baseUrl,
        apiBaseUrl: baseUrl,
        env,
        out: () => {},
        pollIntervalMs: 10,
        openUrl: (authUrl) => {
          void fetch(authUrl);
        },
      });
      saveDeviceAuth(bobGrant, env);
      await daemon.syncNow();

      const bobSummary = await queryShellDaemon(shellSocketPath(env), { id: "3", method: "get_summary" });
      const bobBlockers = (bobSummary.result as { widgets: { blockers: Array<{ question: string; org_id: string }> } }).widgets.blockers;
      expect(bobBlockers).toHaveLength(1);
      expect(bobBlockers[0]).toMatchObject({
        org_id: "org_beta",
        question: "Bob: confirm schema?",
      });
      expect(notified).toEqual(["Alice: which fixture?", "Bob: confirm schema?"]);
    } finally {
      await daemon.stop();
    }
  });
});
