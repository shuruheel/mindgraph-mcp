import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearShellRuntimeState,
  dismissBlockerAlert,
  evaluateBlockerInterruptions,
  formatBarStatus,
  loadShellRuntimeState,
  loadWidgetPreferences,
  saveShellRuntimeState,
  saveWidgetPreferences,
  type BlockerSummary,
} from "../src/shell-widgets.js";
import { tempDir } from "./fixtures/consent.js";

let tmp: string;
let env: NodeJS.ProcessEnv;

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

beforeEach(() => {
  tmp = tempDir("mg-widgets-");
  const store = path.join(tmp, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  env = { MINDGRAPH_HOME: store, MINDGRAPH_EVAL: "1" };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Omarchy shell widgets & blocker interruption engine", () => {
  it("persists widget selections independently of notification preference", () => {
    expect(loadWidgetPreferences(env)).toEqual({
      v: 1,
      enabledWidgets: ["blockers"],
      notifyBlockers: true,
    });

    // Hiding the Blockers widget while keeping notifications enabled works independently.
    saveWidgetPreferences({ enabledWidgets: ["objectives", "lanes"], notifyBlockers: true }, env);
    const prefs = loadWidgetPreferences(env);
    expect(prefs.enabledWidgets).toEqual(["objectives", "lanes"]);
    expect(prefs.notifyBlockers).toBe(true);

    const evalResult = evaluateBlockerInterruptions({
      blockers: [makeBlocker()],
      currentMemberId: "usr_me",
      prefs,
      runtime: loadShellRuntimeState(env),
    });
    expect(evalResult.alerts).toHaveLength(1);
  });

  it("alerts only for stopped work in active lanes assigned to the signed-in responder and deduplicates across reconnects", () => {
    const prefs = loadWidgetPreferences(env);
    const blockers = [
      makeBlocker({ blocker_id: "blk_mine" }),
      makeBlocker({ blocker_id: "blk_paused", lane_state: "suspended" }),
      makeBlocker({ blocker_id: "blk_other_person", required_responder_id: "usr_teammate" }),
      makeBlocker({ blocker_id: "blk_awaiting", work_state: "awaiting_acknowledgement" }),
    ];

    const first = evaluateBlockerInterruptions({
      blockers,
      currentMemberId: "usr_me",
      prefs,
      runtime: loadShellRuntimeState(env),
    });
    expect(first.alerts.map((a) => a.blocker.blocker_id)).toEqual(["blk_mine"]);
    expect(first.openBlockers).toHaveLength(4);

    saveShellRuntimeState(first.nextRuntime, env);

    // Replaying the same episode after reconnect produces zero duplicate alerts.
    const replay = evaluateBlockerInterruptions({
      blockers,
      currentMemberId: "usr_me",
      prefs,
      runtime: loadShellRuntimeState(env),
    });
    expect(replay.alerts).toHaveLength(0);

    // A new blocking_episode on the same blocker triggers one fresh alert.
    const reopened = evaluateBlockerInterruptions({
      blockers: [makeBlocker({ blocker_id: "blk_mine", blocking_episode: "ep_2" })],
      currentMemberId: "usr_me",
      prefs,
      runtime: loadShellRuntimeState(env),
    });
    expect(reopened.alerts).toHaveLength(1);
    expect(reopened.alerts[0].dedupeKey).toBe("org_demo:blk_mine:ep_2");
  });

  it("respects quiet mode, separates dismiss from resolution, and clears runtime state on disconnect", () => {
    const prefs = loadWidgetPreferences(env);
    const blocker = makeBlocker();

    // Quiet mode defers notification without marking the episode as notified.
    const quiet = evaluateBlockerInterruptions({
      blockers: [blocker],
      currentMemberId: "usr_me",
      prefs,
      runtime: loadShellRuntimeState(env),
      quietMode: true,
    });
    expect(quiet.alerts).toHaveLength(0);
    expect(quiet.nextRuntime.notifiedEpisodes).toEqual([]);

    // Once quiet mode lifts, eligibility is rechecked and the alert fires.
    const active = evaluateBlockerInterruptions({
      blockers: [blocker],
      currentMemberId: "usr_me",
      prefs,
      runtime: quiet.nextRuntime,
      quietMode: false,
    });
    expect(active.alerts).toHaveLength(1);

    // Dismissing records the UI dismiss without removing the open blocker.
    const dismissed = dismissBlockerAlert(active.nextRuntime, blocker);
    saveShellRuntimeState(dismissed, env);
    expect(loadShellRuntimeState(env).dismissedEpisodes).toContain("org_demo:blk_1:ep_1");
    expect(active.openBlockers).toHaveLength(1);

    // Disconnect wipes runtime cache completely.
    clearShellRuntimeState(env);
    expect(loadShellRuntimeState(env).notifiedEpisodes).toEqual([]);
    expect(loadShellRuntimeState(env).dismissedEpisodes).toEqual([]);
  });

  it("formatBarStatus produces Waybar/omarchy-shell payloads without inflating paused-lane blockers", () => {
    expect(formatBarStatus({ connected: false }).class).toBe("signed-out");

    const pausedOnly = formatBarStatus({
      connected: true,
      blockers: [
        makeBlocker({ lane_state: "suspended", work_state: "stopped" }),
      ],
      decisionsCount: 0,
      lanesCount: 2,
    });
    expect(pausedOnly.class).toBe("idle");
    expect(pausedOnly.activeBlockers).toBe(0);
    expect(pausedOnly.pausedBlockers).toBe(1);

    const active = formatBarStatus({
      connected: true,
      blockers: [makeBlocker({ lane_state: "active", work_state: "stopped" })],
      decisionsCount: 2,
    });
    expect(active.class).toBe("blocker");
    expect(active.text).toBe("MindGraph · 1 blocked");
    expect(active.activeBlockers).toBe(1);
    expect(active.pendingDecisions).toBe(2);
  });
});
