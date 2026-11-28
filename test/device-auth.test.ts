import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDeviceAuth,
  desktopConnectionStatus,
  deviceAuthPath,
  getValidDesktopToken,
  loadDeviceAuth,
  revokeDeviceAuth,
  saveDeviceAuth,
  type DeviceAuthRecord,
} from "../src/device-auth.js";
import { mindgraphRuntimeDir } from "../src/hook-env.js";
import { tempDir } from "./fixtures/consent.js";

let tmp: string;
let env: NodeJS.ProcessEnv;

function makeRecord(overrides: Partial<DeviceAuthRecord> = {}): DeviceAuthRecord {
  return {
    v: 1,
    baseUrl: "http://127.0.0.1:18900",
    dashboardUrl: "http://127.0.0.1:18901",
    orgId: "org_demo",
    accountId: "usr_123",
    grantId: "grant_abc",
    clientId: "mindgraph-omarchy",
    accessToken: "atk_initial",
    refreshToken: "rtk_initial",
    expiresAt: Date.now() + 3_600_000,
    scopes: ["graph:read", "graph:write", "board:read"],
    tokenEndpoint: "http://127.0.0.1:18900/oauth/token",
    revocationEndpoint: "http://127.0.0.1:18900/oauth/revoke",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  tmp = tempDir("mg-device-auth-");
  const store = path.join(tmp, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  env = { MINDGRAPH_HOME: store, MINDGRAPH_EVAL: "1" };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Multi-process device auth store", () => {
  it("writes device-auth.json with 0600 permissions and reports connected status", () => {
    expect(desktopConnectionStatus(env)).toEqual({ connected: false, authMode: "none" });
    const record = makeRecord();
    saveDeviceAuth(record, env);

    const stat = fs.statSync(deviceAuthPath(env));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(loadDeviceAuth(env)).toMatchObject({
      accessToken: "atk_initial",
      orgId: "org_demo",
      accountId: "usr_123",
    });
    expect(desktopConnectionStatus(env)).toMatchObject({
      connected: true,
      authMode: "device_grant",
      orgId: "org_demo",
      accountId: "usr_123",
    });
  });

  it("serializes concurrent token refresh so five callers trigger exactly one rotation", async () => {
    const expired = makeRecord({ expiresAt: Date.now() - 1_000 });
    saveDeviceAuth(expired, env);

    let refreshCalls = 0;
    const refresh = async (current: DeviceAuthRecord) => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        accessToken: `atk_rotated_${refreshCalls}`,
        refreshToken: `rtk_rotated_${refreshCalls}`,
        expiresAt: Date.now() + 3_600_000,
        scopes: current.scopes,
      };
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => getValidDesktopToken(env, { refresh })),
    );

    expect(refreshCalls).toBe(1);
    for (const res of results) {
      expect(res?.token).toBe("atk_rotated_1");
      expect(res?.authMode).toBe("device_grant");
    }
    expect(loadDeviceAuth(env)?.refreshToken).toBe("rtk_rotated_1");
  });

  it("recovers from a stale lock file left behind by a crashed process", async () => {
    saveDeviceAuth(makeRecord({ expiresAt: Date.now() - 1_000 }), env);
    const runtimeDir = mindgraphRuntimeDir(env);
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(runtimeDir, "token.lock");
    fs.writeFileSync(lockFile, "999999:crashed\n", { mode: 0o600 });
    const oldTime = new Date(Date.now() - 120_000);
    fs.utimesSync(lockFile, oldTime, oldTime);

    const token = await getValidDesktopToken(env, {
      staleLockMs: 5_000,
      refresh: async () => ({
        accessToken: "atk_recovered",
        refreshToken: "rtk_recovered",
        expiresAt: Date.now() + 3_600_000,
      }),
    });

    expect(token?.token).toBe("atk_recovered");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("falls back seamlessly to legacy hooks.json apiKey when device-auth.json is absent", async () => {
    fs.writeFileSync(
      path.join(env.MINDGRAPH_HOME!, "hooks.json"),
      JSON.stringify({ baseUrl: "http://127.0.0.1:18900", apiKey: "mg_legacy_key", orgId: "org_legacy" }),
      { mode: 0o600 },
    );
    expect(desktopConnectionStatus(env)).toMatchObject({
      connected: true,
      authMode: "api_key",
      orgId: "org_legacy",
    });
    const res = await getValidDesktopToken(env);
    expect(res).toEqual({
      token: "mg_legacy_key",
      authMode: "api_key",
      baseUrl: "http://127.0.0.1:18900",
      orgId: "org_legacy",
    });
  });

  it("revokes remotely via RFC 7009 and clears locally, or clears locally when offline", async () => {
    saveDeviceAuth(makeRecord(), env);
    const seenBodies: string[] = [];
    const okRevoke = await revokeDeviceAuth(env, async (_url, init) => {
      seenBodies.push(String(init?.body));
      return new Response("", { status: 200 });
    });
    expect(okRevoke).toEqual({
      localCleared: true,
      remoteRevoked: true,
      pendingRemoteRevocation: false,
    });
    expect(seenBodies[0]).toContain("token=rtk_initial");
    expect(loadDeviceAuth(env)).toBeUndefined();

    // Offline failure still clears local token immediately.
    saveDeviceAuth(makeRecord(), env);
    const offlineRevoke = await revokeDeviceAuth(env, async () => {
      throw new Error("network offline");
    });
    expect(offlineRevoke.localCleared).toBe(true);
    expect(offlineRevoke.remoteRevoked).toBe(false);
    expect(offlineRevoke.pendingRemoteRevocation).toBe(true);
    expect(loadDeviceAuth(env)).toBeUndefined();
    expect(clearDeviceAuth(env)).toBe(false);
  });
});
