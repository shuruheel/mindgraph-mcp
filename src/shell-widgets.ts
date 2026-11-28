import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mindgraphConfigDir, mindgraphRuntimeDir } from "./hook-env.js";

/**
 * Omarchy Shell Plugin — Widget preferences, cached summary state, and
 * blocker interruption deduplication engine.
 *
 * Enforces the Work Dashboard interruption contract:
 * - Six independently selectable widgets: objectives, blockers, decisions,
 *   updates, tasks, lanes.
 * - Hiding the Blockers widget and muting interruptions are independent choices.
 * - Desktop notifications fire ONLY when work has actually stopped, the lane is
 *   active, the signed-in member is the required responder, notifications are
 *   enabled, and quiet mode is off.
 * - Deduplicated by (org_id, blocker_id, blocking_episode) across reconnects
 *   and widgets. Dismissing a notification never resolves the blocker.
 */

export const WIDGET_KINDS = [
  "objectives",
  "blockers",
  "decisions",
  "updates",
  "tasks",
  "lanes",
] as const;

export type WidgetKind = (typeof WIDGET_KINDS)[number];

export interface WidgetPreferences {
  v: 1;
  enabledWidgets: WidgetKind[];
  notifyBlockers: boolean;
}

export interface BlockerSummary {
  org_id: string;
  blocker_id: string;
  blocking_episode: string;
  story_uid: string;
  lane_id: string;
  lane_state: "active" | "suspended";
  work_state: "stopped" | "running" | "awaiting_acknowledgement" | "resolved";
  required_responder_id: string;
  question: string;
  thread_url: string;
}

export interface BlockerAlert {
  dedupeKey: string;
  blocker: BlockerSummary;
}

export interface ShellRuntimeState {
  v: 1;
  cursor?: string;
  /** Dedupe keys `(org_id:blocker_id:blocking_episode)` already notified. */
  notifiedEpisodes: string[];
  /** Dedupe keys dismissed by the user (blocker stays open in widgets/feed). */
  dismissedEpisodes: string[];
  updatedAt?: string;
}

export const DEFAULT_WIDGET_PREFERENCES: WidgetPreferences = {
  v: 1,
  enabledWidgets: ["blockers"],
  notifyBlockers: true,
};

const PREFS_FILENAME = "desktop-widgets.json";
const RUNTIME_STATE_FILENAME = "widget-cache.json";

export function widgetPreferencesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mindgraphConfigDir(env).dir, PREFS_FILENAME);
}

export function shellRuntimeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mindgraphRuntimeDir(env), RUNTIME_STATE_FILENAME);
}

function writeAtomicJson(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

export function loadWidgetPreferences(env: NodeJS.ProcessEnv = process.env): WidgetPreferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(widgetPreferencesPath(env), "utf8")) as Record<string, unknown>;
    const validSet = new Set<string>(WIDGET_KINDS);
    const enabled = Array.isArray(parsed.enabledWidgets)
      ? [...new Set(parsed.enabledWidgets.filter((w): w is WidgetKind => typeof w === "string" && validSet.has(w)))]
      : [...DEFAULT_WIDGET_PREFERENCES.enabledWidgets];
    return {
      v: 1,
      enabledWidgets: enabled,
      notifyBlockers: typeof parsed.notifyBlockers === "boolean" ? parsed.notifyBlockers : true,
    };
  } catch {
    return {
      v: 1,
      enabledWidgets: [...DEFAULT_WIDGET_PREFERENCES.enabledWidgets],
      notifyBlockers: DEFAULT_WIDGET_PREFERENCES.notifyBlockers,
    };
  }
}

export function saveWidgetPreferences(
  prefs: Omit<WidgetPreferences, "v">,
  env: NodeJS.ProcessEnv = process.env,
): WidgetPreferences {
  const validSet = new Set<string>(WIDGET_KINDS);
  const normalized: WidgetPreferences = {
    v: 1,
    enabledWidgets: [...new Set(prefs.enabledWidgets.filter((w) => validSet.has(w)))],
    notifyBlockers: Boolean(prefs.notifyBlockers),
  };
  writeAtomicJson(widgetPreferencesPath(env), normalized);
  return normalized;
}

export function loadShellRuntimeState(env: NodeJS.ProcessEnv = process.env): ShellRuntimeState {
  try {
    const parsed = JSON.parse(fs.readFileSync(shellRuntimeStatePath(env), "utf8")) as Record<string, unknown>;
    return {
      v: 1,
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : undefined,
      notifiedEpisodes: Array.isArray(parsed.notifiedEpisodes)
        ? parsed.notifiedEpisodes.filter((k): k is string => typeof k === "string")
        : [],
      dismissedEpisodes: Array.isArray(parsed.dismissedEpisodes)
        ? parsed.dismissedEpisodes.filter((k): k is string => typeof k === "string")
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return { v: 1, notifiedEpisodes: [], dismissedEpisodes: [] };
  }
}

export function saveShellRuntimeState(
  state: ShellRuntimeState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  writeAtomicJson(shellRuntimeStatePath(env), {
    ...state,
    v: 1,
    updatedAt: new Date().toISOString(),
  });
}

export function clearShellRuntimeState(env: NodeJS.ProcessEnv = process.env): void {
  fs.rmSync(shellRuntimeStatePath(env), { force: true });
}

export function blockerEpisodeKey(blocker: Pick<BlockerSummary, "org_id" | "blocker_id" | "blocking_episode">): string {
  return `${blocker.org_id}:${blocker.blocker_id}:${blocker.blocking_episode}`;
}

/**
 * Evaluates which open blockers should raise a desktop interruption right now,
 * updating the persisted dedupe set for every newly alerted episode.
 *
 * Notice that `prefs.enabledWidgets` (whether the Blockers widget is shown in
 * the bar) does NOT suppress or force notifications; `prefs.notifyBlockers`
 * controls interruptions independently.
 */
export function evaluateBlockerInterruptions(opts: {
  blockers: BlockerSummary[];
  currentMemberId: string;
  prefs: WidgetPreferences;
  runtime: ShellRuntimeState;
  quietMode?: boolean;
}): { alerts: BlockerAlert[]; nextRuntime: ShellRuntimeState; openBlockers: BlockerSummary[] } {
  const notified = new Set(opts.runtime.notifiedEpisodes);
  const alerts: BlockerAlert[] = [];

  // Open blockers remain visible in widgets/feed regardless of dismissal or mute.
  const openBlockers = opts.blockers.filter((b) => b.work_state !== "resolved");

  if (opts.prefs.notifyBlockers && !opts.quietMode) {
    for (const blocker of openBlockers) {
      if (blocker.work_state !== "stopped") continue;
      if (blocker.lane_state !== "active") continue;
      if (blocker.required_responder_id !== opts.currentMemberId) continue;
      const key = blockerEpisodeKey(blocker);
      if (notified.has(key)) continue;
      notified.add(key);
      alerts.push({ dedupeKey: key, blocker });
    }
  }

  return {
    alerts,
    openBlockers,
    nextRuntime: {
      ...opts.runtime,
      notifiedEpisodes: [...notified],
    },
  };
}

/**
 * Records that the user dismissed a desktop notification popup without
 * resolving the underlying blocker.
 */
export function dismissBlockerAlert(
  runtime: ShellRuntimeState,
  blocker: Pick<BlockerSummary, "org_id" | "blocker_id" | "blocking_episode">,
): ShellRuntimeState {
  const key = blockerEpisodeKey(blocker);
  const dismissed = new Set(runtime.dismissedEpisodes);
  dismissed.add(key);
  return {
    ...runtime,
    dismissedEpisodes: [...dismissed],
  };
}
