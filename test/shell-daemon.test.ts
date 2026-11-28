import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeviceAuth,
  saveDeviceAuth,
  type DeviceAuthRecord,
} from "../src/device-auth.js";
import {
  createShellDaemon,
  queryShellDaemon,
  shellSocketPath,
  type ShellDaemon,
  type ShellPingResponse,
  type ShellSummaryResponse,
  type ShellSummarySnapshot,
  type ShellSyncResult,
} from "../src/shell-daemon.js";
import {
  loadShellRuntimeState,
  loadWidgetPreferences,
  shellRuntimeStatePath,
  type BlockerAlert,
  type BlockerSummary,
  type WidgetPreferences,
} from "../src/shell-widgets.js";
import { tempDir } from "./fixtures/consent.js";

let tmp: string;
let env: NodeJS.ProcessEnv;
const runningDaemons: ShellDaemon[] = [];

function track(daemon: ShellDaemon): ShellDaemon {
  runningDaemons.push(daemon);
  return daemon;
}

function makeDeviceAuth(overrides: Partial<DeviceAuthRecord> = {}): DeviceAuthRecord {
  return {
    v: 1,
    baseUrl: "http://127.0.0.1:18900",
    dashboardUrl: "http://127.0.0.1:18901",
    orgId: "org_demo",
    accountId: "usr_me",
    grantId: "grant_1",
    clientId: "mindgraph-omarchy",
    accessToken: "atk_demo",
    refreshToken: "rtk_demo",
    expiresAt: Date.now() + 3_600_000,
    scopes: ["graph:read", "board:read"],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBlocker(overrides: Partial<BlockerSummary> = {}): BlockerSummary {
  return {
    org_id: "org_demo",
    blocker_id: "blk_1",
    blocking_episode: "ep_1",
    story_uid: "story_renamed_citation",
    lane_id: "memory-quality",
    lane_state: "active",
    work_state: "stopped",
    required_responder_id: "usr_me",
    question: "Which renamed-file fixture should the worker use?",
    thread_url: "https://mindgraph.cloud/dashboard/stories/story_renamed_citation#blk_1",
    ...overrides,
  };
}

function makeFullSnapshot(overrides: Partial<ShellSummarySnapshot> = {}): ShellSummarySnapshot {
  return {
    cursor: "cur_1",
    syncedAt: "2026-11-27T18:00:00.000Z",
    memberId: "usr_me",
    objectives: [
      {
        objective_id: "obj_trust",
        title: "Help engineers trust recalled decisions",
        latest_measure: "3/3 citation cases passing",
        measured_at: "2026-11-27T17:30:00.000Z",
        detail_url: "https://mindgraph.cloud/dashboard/objectives/obj_trust",
      },
    ],
    blockers: [makeBlocker()],
    decisions: [
      {
        decision_id: "dec_1",
        story_uid: "story_citation_source",
        prompt: "Approve revision r2 for unavailable citation fallback",
        requested_by: "planner-agent",
        decision_url: "https://mindgraph.cloud/dashboard/stories/story_citation_source?rev=r2",
      },
    ],
    updates: [
      {
        event_id: "evt_1",
        story_uid: "story_citation_source",
        summary: "Measured 3/3 fixture cases passed on commit abc123",
        occurred_at: "2026-11-27T17:45:00.000Z",
        evidence_url: "https://mindgraph.cloud/dashboard/stories/story_citation_source#evidence",
      },
    ],
    tasks: [
      {
        task_uid: "task_local_1",
        title: "Verify renamed file citation recovery",
        worker_or_checkout: "~/Code/mindgraph-fixture",
        next_step: "Run acceptance fixture suite",
        destination_url: "https://mindgraph.cloud/dashboard/tasks/task_local_1",
        local_handoff: true,
      },
    ],
    lanes: [
      {
        lane_id: "memory-quality",
        objective_id: "obj_trust",
        name: "Memory quality",
        state: "active",
        latest_delivery: "Citation source preview",
        blocker_count: 1,
        lane_url: "https://mindgraph.cloud/dashboard/objectives/obj_trust/lanes/memory-quality",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  tmp = tempDir("mg-daemon-");
  const store = path.join(tmp, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  env = { MINDGRAPH_HOME: store, MINDGRAPH_EVAL: "1" };
});

afterEach(async () => {
  while (runningDaemons.length > 0) {
    const d = runningDaemons.pop()!;
    await d.stop();
  }
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Omarchy shell plugin Unix domain socket daemon", () => {
  it("resolves shellSocketPath using XDG_RUNTIME_DIR outside eval mode and runtime dir in eval mode", () => {
    const prodEnv: NodeJS.ProcessEnv = {
      XDG_RUNTIME_DIR: "/run/user/1000",
      MINDGRAPH_HOME: env.MINDGRAPH_HOME,
    };
    expect(shellSocketPath(prodEnv)).toBe("/run/user/1000/mindgraph/shell.sock");

    const evalEnvWithXdg: NodeJS.ProcessEnv = {
      XDG_RUNTIME_DIR: "/run/user/1000",
      MINDGRAPH_HOME: env.MINDGRAPH_HOME,
      MINDGRAPH_EVAL: "1",
    };
    expect(shellSocketPath(evalEnvWithXdg)).toBe(
      path.join(env.MINDGRAPH_HOME!, "runtime", "shell.sock"),
    );

    const noXdgEnv: NodeJS.ProcessEnv = {
      MINDGRAPH_HOME: env.MINDGRAPH_HOME,
    };
    expect(shellSocketPath(noXdgEnv)).toBe(
      path.join(env.MINDGRAPH_HOME!, "runtime", "shell.sock"),
    );
  });

  it("binds a mode 0600 Unix domain socket with zero TCP listeners and cleans stale sockets", async () => {
    saveDeviceAuth(makeDeviceAuth(), env);
    const createdServers: net.Server[] = [];
    const origCreateServer = net.createServer.bind(net);
    vi.spyOn(net, "createServer").mockImplementation(((...args: unknown[]) => {
      const srv = (origCreateServer as (...a: unknown[]) => net.Server)(...args);
      createdServers.push(srv);
      return srv;
    }) as typeof net.createServer);

    const expectedSock = shellSocketPath(env);
    fs.mkdirSync(path.dirname(expectedSock), { recursive: true, mode: 0o700 });
    // Leave a stale socket/file behind before start.
    fs.writeFileSync(expectedSock, "stale", { mode: 0o600 });

    const daemon = track(
      createShellDaemon({
        env,
        fetchFeed: async () => makeFullSnapshot(),
        notify: () => {},
      }),
    );

    await daemon.start();

    // Mode 0600 on the Unix domain socket.
    const stat = fs.lstatSync(daemon.socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);

    // Server bound strictly to the Unix socket path (string), never a TCP port object.
    expect(createdServers).toHaveLength(1);
    const addr = createdServers[0].address();
    expect(typeof addr).toBe("string");
    expect(addr).toBe(daemon.socketPath);

    // Ping over the real Unix socket works.
    const ping = await queryShellDaemon<ShellPingResponse>(daemon.socketPath, {
      id: 1,
      method: "ping",
    });
    expect(ping).toEqual({
      id: 1,
      ok: true,
      result: {
        connected: true,
        authMode: "device_grant",
        syncedAt: null,
        cursor: null,
      },
    });

    await daemon.stop();
    expect(fs.existsSync(daemon.socketPath)).toBe(false);
  });

  it("serves get_summary across all 6 widget categories and respects persisted WidgetPreferences", async () => {
    saveDeviceAuth(makeDeviceAuth(), env);
    const alerts: BlockerAlert[] = [];

    const daemon = track(
      createShellDaemon({
        env,
        fetchFeed: async () =>
          makeFullSnapshot({
            blockers: [
              makeBlocker({ blocker_id: "blk_open" }),
              makeBlocker({ blocker_id: "blk_done", work_state: "resolved" }),
              // Foreign org blocker must be permission-filtered out.
              makeBlocker({ blocker_id: "blk_foreign", org_id: "org_other" }),
            ],
          }),
        notify: (alert) => {
          alerts.push(alert);
        },
      }),
    );

    await daemon.start();

    // Default preferences enable only ["blockers"] with notifyBlockers: true.
    const defaultPrefs = await queryShellDaemon<WidgetPreferences>(daemon.socketPath, {
      id: "prefs-1",
      method: "get_preferences",
    });
    expect(defaultPrefs).toEqual({
      id: "prefs-1",
      ok: true,
      result: { v: 1, enabledWidgets: ["blockers"], notifyBlockers: true },
    });

    // Enable all 6 widgets via set_preferences and verify persistence.
    const allSix = await queryShellDaemon<WidgetPreferences>(daemon.socketPath, {
      id: "prefs-2",
      method: "set_preferences",
      params: {
        enabledWidgets: ["objectives", "blockers", "decisions", "updates", "tasks", "lanes"],
        notifyBlockers: true,
      },
    });
    expect(allSix.ok).toBe(true);
    expect(loadWidgetPreferences(env).enabledWidgets).toEqual([
      "objectives",
      "blockers",
      "decisions",
      "updates",
      "tasks",
      "lanes",
    ]);

    const syncRes = await queryShellDaemon<ShellSyncResult>(daemon.socketPath, {
      id: "sync-1",
      method: "sync",
    });
    expect(syncRes).toMatchObject({
      id: "sync-1",
      ok: true,
      result: {
        synced: true,
        connected: true,
        resynced: false,
        cursor: "cur_1",
        alertsDelivered: 1,
        openBlockers: 1,
      },
    });

    const summary = await queryShellDaemon<ShellSummaryResponse>(daemon.socketPath, {
      id: "sum-1",
      method: "get_summary",
    });
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error("expected ok");
    expect(summary.result.connected).toBe(true);
    expect(summary.result.state).toBe("connected");
    expect(summary.result.authMode).toBe("device_grant");
    expect(summary.result.cursor).toBe("cur_1");
    expect(summary.result.widgets.objectives).toHaveLength(1);
    expect(summary.result.widgets.blockers.map((b) => b.blocker_id)).toEqual(["blk_open"]);
    expect(summary.result.widgets.decisions).toHaveLength(1);
    expect(summary.result.widgets.updates).toHaveLength(1);
    expect(summary.result.widgets.tasks).toHaveLength(1);
    expect(summary.result.widgets.lanes).toHaveLength(1);
    expect(summary.result.counts).toEqual({
      objectives: 1,
      blockers: 1,
      decisions: 1,
      updates: 1,
      tasks: 1,
      lanes: 1,
    });

    // Restricting enabledWidgets hides disabled widgets from get_summary while preserving notifyBlockers.
    await queryShellDaemon(daemon.socketPath, {
      id: "prefs-3",
      method: "set_preferences",
      params: { enabledWidgets: ["objectives", "lanes"], notifyBlockers: true },
    });

    const filtered = await queryShellDaemon<ShellSummaryResponse>(daemon.socketPath, {
      id: "sum-2",
      method: "get_summary",
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) throw new Error("expected ok");
    expect(filtered.result.enabledWidgets).toEqual(["objectives", "lanes"]);
    expect(filtered.result.widgets.objectives).toHaveLength(1);
    expect(filtered.result.widgets.lanes).toHaveLength(1);
    expect(filtered.result.widgets.blockers).toEqual([]);
    expect(filtered.result.widgets.decisions).toEqual([]);
    expect(filtered.result.widgets.updates).toEqual([]);
    expect(filtered.result.widgets.tasks).toEqual([]);
    expect(alerts).toHaveLength(1);
  });

  it("resumes from cursor and performs clean snapshot resync on expired cursor without duplicate alerts", async () => {
    saveDeviceAuth(makeDeviceAuth(), env);
    const seenCursors: Array<string | undefined> = [];
    const delivered: BlockerAlert[] = [];

    let phase = 0;
    const daemon = track(
      createShellDaemon({
        env,
        notify: (alert) => {
          delivered.push(alert);
        },
        fetchFeed: async (cursor) => {
          seenCursors.push(cursor);
          phase += 1;
          if (phase === 1) {
            return makeFullSnapshot({
              cursor: "cur_1",
              blockers: [makeBlocker({ blocker_id: "blk_1", blocking_episode: "ep_1" })],
            });
          }
          if (phase === 2) {
            // Normal cursor resume.
            return makeFullSnapshot({
              cursor: "cur_expired",
              syncedAt: "2026-11-27T18:05:00.000Z",
              blockers: [makeBlocker({ blocker_id: "blk_1", blocking_episode: "ep_1" })],
            });
          }
          if (cursor === "cur_expired") {
            // Simulate server reporting expired cursor.
            return { reset: true };
          }
          // Fresh snapshot resync (cursor === undefined) replays blk_1:ep_1 and introduces blk_2:ep_1.
          return makeFullSnapshot({
            cursor: "cur_fresh_1",
            syncedAt: "2026-11-27T18:10:00.000Z",
            blockers: [
              makeBlocker({ blocker_id: "blk_1", blocking_episode: "ep_1" }),
              makeBlocker({ blocker_id: "blk_2", blocking_episode: "ep_1" }),
            ],
          });
        },
      }),
    );

    await daemon.start();

    const s1 = await daemon.syncNow();
    expect(s1.cursor).toBe("cur_1");
    expect(s1.resynced).toBe(false);
    expect(s1.alertsDelivered).toBe(1);

    const s2 = await daemon.syncNow();
    expect(s2.cursor).toBe("cur_expired");
    expect(s2.resynced).toBe(false);
    expect(s2.alertsDelivered).toBe(0);

    // Third sync hits expired cursor -> triggers { reset: true } -> calls fetchFeed(undefined).
    const s3 = await daemon.syncNow();
    expect(s3.resynced).toBe(true);
    expect(s3.cursor).toBe("cur_fresh_1");
    expect(s3.alertsDelivered).toBe(1);
    expect(seenCursors).toEqual([undefined, "cur_1", "cur_expired", undefined]);

    // blk_1:ep_1 was NOT re-notified; only blk_2:ep_1 fired once.
    expect(delivered.map((a) => a.dedupeKey)).toEqual([
      "org_demo:blk_1:ep_1",
      "org_demo:blk_2:ep_1",
    ]);
    expect(loadShellRuntimeState(env).cursor).toBe("cur_fresh_1");
  });

  it("delivers blocker notifications once per episode, defers in quiet mode, and keeps dismissed blockers open", async () => {
    saveDeviceAuth(makeDeviceAuth(), env);
    let quiet = true;
    const delivered: BlockerAlert[] = [];
    let currentBlockers: BlockerSummary[] = [
      makeBlocker({ blocker_id: "blk_mine", blocking_episode: "ep_1" }),
      makeBlocker({ blocker_id: "blk_suspended", lane_state: "suspended" }),
      makeBlocker({ blocker_id: "blk_teammate", required_responder_id: "usr_other" }),
    ];

    const daemon = track(
      createShellDaemon({
        env,
        quietMode: () => quiet,
        notify: (alert) => {
          delivered.push(alert);
        },
        fetchFeed: async () =>
          makeFullSnapshot({
            cursor: "cur_q",
            blockers: currentBlockers,
          }),
      }),
    );

    await daemon.start();

    // Quiet mode defers notification without marking notified.
    const quietSync = await daemon.syncNow();
    expect(quietSync.alertsDelivered).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(loadShellRuntimeState(env).notifiedEpisodes).toEqual([]);

    // Lift quiet mode -> eligible stopped active-lane blocker fires exactly once.
    quiet = false;
    const activeSync = await daemon.syncNow();
    expect(activeSync.alertsDelivered).toBe(1);
    expect(delivered.map((a) => a.dedupeKey)).toEqual(["org_demo:blk_mine:ep_1"]);

    // Subsequent sync with same episode produces zero duplicates.
    const replaySync = await daemon.syncNow();
    expect(replaySync.alertsDelivered).toBe(0);
    expect(delivered).toHaveLength(1);

    // Dismissing blocker records dismiss in runtime state, leaving blocker OPEN in get_summary.
    const dismissRes = await queryShellDaemon<{
      dismissed: boolean;
      dedupeKey: string;
      dismissedEpisodes: string[];
    }>(daemon.socketPath, {
      id: "dismiss-1",
      method: "dismiss_blocker",
      params: {
        org_id: "org_demo",
        blocker_id: "blk_mine",
        blocking_episode: "ep_1",
      },
    });
    expect(dismissRes).toEqual({
      id: "dismiss-1",
      ok: true,
      result: {
        dismissed: true,
        dedupeKey: "org_demo:blk_mine:ep_1",
        dismissedEpisodes: ["org_demo:blk_mine:ep_1"],
      },
    });

    const summary = await queryShellDaemon<ShellSummaryResponse>(daemon.socketPath, {
      id: "sum-open",
      method: "get_summary",
    });
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error("expected ok");
    expect(summary.result.widgets.blockers.map((b) => b.blocker_id)).toContain("blk_mine");
    expect(summary.result.dismissedEpisodes).toContain("org_demo:blk_mine:ep_1");

    // Reopening the blocker under a new blocking_episode fires a fresh alert once.
    currentBlockers = [makeBlocker({ blocker_id: "blk_mine", blocking_episode: "ep_2" })];
    const reopenedSync = await daemon.syncNow();
    expect(reopenedSync.alertsDelivered).toBe(1);
    expect(delivered.map((a) => a.dedupeKey)).toEqual([
      "org_demo:blk_mine:ep_1",
      "org_demo:blk_mine:ep_2",
    ]);
  });

  it("clears in-memory snapshot, on-disk runtime state, and polling timer on disconnect", async () => {
    saveDeviceAuth(makeDeviceAuth(), env);
    let fetchCount = 0;

    const daemon = track(
      createShellDaemon({
        env,
        pollIntervalMs: 60_000,
        notify: () => {},
        fetchFeed: async () => {
          fetchCount += 1;
          return makeFullSnapshot({ cursor: `cur_${fetchCount}` });
        },
      }),
    );

    await daemon.start();
    expect(daemon.getState().pollingActive).toBe(true);

    await queryShellDaemon(daemon.socketPath, { id: "sync-pre", method: "sync" });
    expect(fs.existsSync(shellRuntimeStatePath(env))).toBe(true);
    expect(daemon.getState().snapshot?.blockers).toHaveLength(1);

    // Disconnect via RPC wipes in-memory snapshot, stops polling, removes runtime file.
    const disc = await queryShellDaemon<{ disconnected: boolean }>(daemon.socketPath, {
      id: "disc-1",
      method: "disconnect",
    });
    expect(disc).toEqual({
      id: "disc-1",
      ok: true,
      result: { disconnected: true },
    });

    const stateAfter = daemon.getState();
    expect(stateAfter.connected).toBe(false);
    expect(stateAfter.pollingActive).toBe(false);
    expect(stateAfter.snapshot).toBeUndefined();
    expect(fs.existsSync(shellRuntimeStatePath(env))).toBe(false);

    // get_summary and ping reflect signed_out / empty state immediately.
    const summaryAfter = await queryShellDaemon<ShellSummaryResponse>(daemon.socketPath, {
      id: "sum-after",
      method: "get_summary",
    });
    expect(summaryAfter.ok).toBe(true);
    if (!summaryAfter.ok) throw new Error("expected ok");
    expect(summaryAfter.result.connected).toBe(false);
    expect(summaryAfter.result.state).toBe("signed_out");
    expect(summaryAfter.result.widgets).toEqual({
      objectives: [],
      blockers: [],
      decisions: [],
      updates: [],
      tasks: [],
      lanes: [],
    });

    const pingAfter = await queryShellDaemon<ShellPingResponse>(daemon.socketPath, {
      id: "ping-after",
      method: "ping",
    });
    expect(pingAfter).toEqual({
      id: "ping-after",
      ok: true,
      result: {
        connected: false,
        authMode: "none",
        syncedAt: null,
        cursor: null,
      },
    });
  });

  it("reflects external credential removal in get_summary and handles malformed RPCs gracefully", async () => {
    saveDeviceAuth(makeDeviceAuth(), env);
    const daemon = track(
      createShellDaemon({
        env,
        notify: () => {},
        fetchFeed: async () => makeFullSnapshot(),
      }),
    );

    await daemon.start();
    await daemon.syncNow();

    // Remove device-auth.json externally (as `mindgraph-mcp desktop disconnect` does).
    clearDeviceAuth(env);

    const summary = await queryShellDaemon<ShellSummaryResponse>(daemon.socketPath, {
      id: "ext-1",
      method: "get_summary",
    });
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error("expected ok");
    expect(summary.result.connected).toBe(false);
    expect(summary.result.state).toBe("signed_out");
    expect(summary.result.widgets.blockers).toEqual([]);

    // Unknown method returns structured RPC error without crashing the daemon.
    const unknown = await queryShellDaemon(daemon.socketPath, {
      id: "bad-1",
      method: "no_such_method",
    });
    expect(unknown).toEqual({
      id: "bad-1",
      ok: false,
      error: {
        code: "method_not_found",
        message: "Unknown method: no_such_method",
      },
    });

    // Invalid params on dismiss_blocker return invalid_params error.
    const invalidDismiss = await queryShellDaemon(daemon.socketPath, {
      id: "bad-2",
      method: "dismiss_blocker",
      params: { org_id: "org_demo" },
    });
    expect(invalidDismiss.ok).toBe(false);
    if (!invalidDismiss.ok) {
      expect(invalidDismiss.error.code).toBe("invalid_params");
    }
  });
});
