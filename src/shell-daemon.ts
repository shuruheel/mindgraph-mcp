import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  desktopConnectionStatus,
  getValidDesktopToken,
  type DesktopConnectionStatus,
} from "./device-auth.js";
import { assertEvalBaseUrl, evalMode } from "./eval-guard.js";
import { mindgraphRuntimeDir } from "./hook-env.js";
import {
  WIDGET_KINDS,
  blockerEpisodeKey,
  clearShellRuntimeState,
  dismissBlockerAlert,
  evaluateBlockerInterruptions,
  loadShellRuntimeState,
  loadWidgetPreferences,
  saveShellRuntimeState,
  saveWidgetPreferences,
  type BlockerAlert,
  type BlockerSummary,
  type ShellRuntimeState,
  type WidgetKind,
  type WidgetPreferences,
} from "./shell-widgets.js";

/**
 * Omarchy Shell Plugin — User-level Unix domain socket daemon.
 *
 * Holds a single device-authorized summary feed per desktop user and serves
 * all six shell widgets over an owner-only Unix domain socket (mode 0600).
 * Never binds any TCP port (including 18790).
 */

const SOCKET_FILENAME = "shell.sock";
const MAX_RPC_LINE_BYTES = 1024 * 1024;

export interface ObjectiveSummary {
  objective_id: string;
  title: string;
  latest_measure?: string;
  measured_at?: string;
  detail_url: string;
}

export interface DecisionSummary {
  decision_id: string;
  story_uid: string;
  prompt: string;
  requested_by: string;
  decision_url: string;
}

export interface UpdateSummary {
  event_id: string;
  story_uid: string;
  summary: string;
  occurred_at: string;
  evidence_url: string;
}

export interface TaskSummary {
  task_uid: string;
  title: string;
  worker_or_checkout?: string;
  next_step?: string;
  destination_url?: string;
  local_handoff?: boolean;
}

export interface LaneSummary {
  lane_id: string;
  objective_id?: string;
  name: string;
  state: "active" | "suspended";
  latest_delivery?: string;
  blocker_count?: number;
  lane_url: string;
}

export interface ShellSummarySnapshot {
  cursor?: string;
  syncedAt: string;
  memberId: string;
  objectives: ObjectiveSummary[];
  blockers: BlockerSummary[];
  decisions: DecisionSummary[];
  updates: UpdateSummary[];
  tasks: TaskSummary[];
  lanes: LaneSummary[];
}

export interface ShellFeedReset {
  reset: true;
  snapshot?: ShellSummarySnapshot;
}

export type ShellFeedResult = ShellSummarySnapshot | ShellFeedReset;

export type ShellFeedFetcher = (cursor?: string) => Promise<ShellFeedResult>;
export type BlockerNotifier = (alert: BlockerAlert) => void | Promise<void>;
export type QuietModeCheck = () => boolean | Promise<boolean>;

export interface ShellSummaryWidgets {
  objectives: ObjectiveSummary[];
  blockers: BlockerSummary[];
  decisions: DecisionSummary[];
  updates: UpdateSummary[];
  tasks: TaskSummary[];
  lanes: LaneSummary[];
}

export interface ShellSummaryResponse {
  connected: boolean;
  state: "connected" | "signed_out";
  authMode: DesktopConnectionStatus["authMode"];
  syncedAt: string | null;
  cursor: string | null;
  memberId: string | null;
  enabledWidgets: WidgetKind[];
  notifyBlockers: boolean;
  dismissedEpisodes: string[];
  widgets: ShellSummaryWidgets;
  counts: Record<WidgetKind, number>;
}

export interface ShellPingResponse {
  connected: boolean;
  authMode: DesktopConnectionStatus["authMode"];
  syncedAt: string | null;
  cursor: string | null;
}

export interface ShellSyncResult {
  synced: boolean;
  connected: boolean;
  resynced: boolean;
  cursor: string | null;
  syncedAt: string | null;
  alertsDelivered: number;
  openBlockers: number;
}

export interface ShellDaemonState {
  running: boolean;
  socketPath: string;
  connected: boolean;
  authMode: DesktopConnectionStatus["authMode"];
  cursor?: string;
  syncedAt?: string;
  snapshot?: ShellSummarySnapshot;
  runtime: ShellRuntimeState;
  pollingActive: boolean;
}

export type ShellRpcMethod =
  | "ping"
  | "get_summary"
  | "get_preferences"
  | "set_preferences"
  | "dismiss_blocker"
  | "sync"
  | "disconnect";

export interface ShellRpcRequest {
  id: string | number;
  method: ShellRpcMethod | string;
  params?: Record<string, unknown>;
}

export interface ShellRpcSuccess<T = unknown> {
  id: string | number | null;
  ok: true;
  result: T;
}

export interface ShellRpcError {
  id: string | number | null;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ShellRpcResponse<T = unknown> = ShellRpcSuccess<T> | ShellRpcError;

export interface ShellDaemonOptions {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  fetchFeed?: ShellFeedFetcher;
  notify?: BlockerNotifier;
  quietMode?: QuietModeCheck;
  pollIntervalMs?: number;
  getConnectionStatus?: () => DesktopConnectionStatus;
}

export interface ShellDaemon {
  readonly socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  syncNow(): Promise<ShellSyncResult>;
  clearOnDisconnect(): void;
  getState(): ShellDaemonState;
}

/**
 * Resolves the user-private Unix domain socket path.
 * Uses `$XDG_RUNTIME_DIR/mindgraph/shell.sock` outside eval mode when
 * `XDG_RUNTIME_DIR` is set, otherwise falls back to `mindgraphRuntimeDir(env)/shell.sock`.
 */
export function shellSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_RUNTIME_DIR;
  if (!evalMode(env) && xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, "mindgraph", SOCKET_FILENAME);
  }
  return path.join(mindgraphRuntimeDir(env), SOCKET_FILENAME);
}

/**
 * Default desktop notification sender using argv-safe `execFileSync` with
 * explicit `--` argument termination (never invokes a shell).
 */
export function defaultNotifyBlocker(alert: BlockerAlert): void {
  const clean = (s: string) => s.replace(/\0/g, "");
  const title = clean(`MindGraph blocker: ${alert.blocker.story_uid}`);
  const body = clean(`${alert.blocker.question}\n${alert.blocker.thread_url}`);
  execFileSync(
    "notify-send",
    ["--app-name=MindGraph", "--urgency=normal", "--", title, body],
    {
      stdio: "ignore",
      timeout: 5_000,
    },
  );
}

function emptyWidgets(): ShellSummaryWidgets {
  return {
    objectives: [],
    blockers: [],
    decisions: [],
    updates: [],
    tasks: [],
    lanes: [],
  };
}

function emptyCounts(): Record<WidgetKind, number> {
  return {
    objectives: 0,
    blockers: 0,
    decisions: 0,
    updates: 0,
    tasks: 0,
    lanes: 0,
  };
}

function isFeedReset(value: ShellFeedResult): value is ShellFeedReset {
  return (
    typeof value === "object" &&
    value !== null &&
    "reset" in value &&
    value.reset === true
  );
}

function cloneSnapshot(snapshot: ShellSummarySnapshot): ShellSummarySnapshot {
  return {
    cursor: snapshot.cursor,
    syncedAt: snapshot.syncedAt,
    memberId: snapshot.memberId,
    objectives: snapshot.objectives.map((item) => ({ ...item })),
    blockers: snapshot.blockers.map((item) => ({ ...item })),
    decisions: snapshot.decisions.map((item) => ({ ...item })),
    updates: snapshot.updates.map((item) => ({ ...item })),
    tasks: snapshot.tasks.map((item) => ({ ...item })),
    lanes: snapshot.lanes.map((item) => ({ ...item })),
  };
}

function cloneRuntime(runtime: ShellRuntimeState): ShellRuntimeState {
  return {
    v: 1,
    cursor: runtime.cursor,
    notifiedEpisodes: [...runtime.notifiedEpisodes],
    dismissedEpisodes: [...runtime.dismissedEpisodes],
    updatedAt: runtime.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultFetchFeed(
  env: NodeJS.ProcessEnv,
  cursor?: string,
): Promise<ShellFeedResult> {
  const auth = await getValidDesktopToken(env);
  if (!auth) {
    throw new Error("MindGraph is not connected.");
  }
  const base = assertEvalBaseUrl(auth.baseUrl, env).replace(/\/+$/, "");
  const url = new URL(`${base}/v1/desktop/feed`);
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 410) {
    return { reset: true };
  }
  if (!response.ok) {
    throw new Error(`Shell feed sync failed (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as ShellFeedResult;
  return payload;
}

async function isSocketAlive(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection({ path: sockPath });
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), 150);
    probe.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    probe.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function removeStaleSocket(sockPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to bind over symlink at ${sockPath}`);
  }
  if (stat.isSocket()) {
    if (await isSocketAlive(sockPath)) {
      throw new Error(`Another MindGraph shell daemon is already listening on ${sockPath}`);
    }
    fs.rmSync(sockPath, { force: true });
    return;
  }
  if (stat.isFile()) {
    fs.rmSync(sockPath, { force: true });
    return;
  }
  throw new Error(`Cannot bind Unix socket at non-socket path ${sockPath}`);
}

export function createShellDaemon(opts: ShellDaemonOptions = {}): ShellDaemon {
  const env = opts.env ?? process.env;
  const sockPath = opts.socketPath ?? shellSocketPath(env);
  if (!path.isAbsolute(sockPath)) {
    throw new Error(`Shell daemon requires an absolute Unix socket path, got: ${sockPath}`);
  }

  const fetchFeed: ShellFeedFetcher =
    opts.fetchFeed ?? ((cursor) => defaultFetchFeed(env, cursor));
  const notify: BlockerNotifier = opts.notify ?? defaultNotifyBlocker;
  const checkQuietMode: QuietModeCheck = opts.quietMode ?? (() => false);
  const readConnectionStatus =
    opts.getConnectionStatus ?? (() => desktopConnectionStatus(env));
  const pollIntervalMs = opts.pollIntervalMs ?? 0;

  let server: net.Server | undefined;
  const activeSockets = new Set<net.Socket>();
  let pollTimer: NodeJS.Timeout | undefined;
  let running = false;
  let disconnected = false;
  let snapshot: ShellSummarySnapshot | undefined;
  let runtime: ShellRuntimeState = loadShellRuntimeState(env);
  let syncQueue: Promise<unknown> = Promise.resolve();

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function startPolling(): void {
    stopPolling();
    if (pollIntervalMs > 0 && running && !disconnected) {
      pollTimer = setInterval(() => {
        void syncNow().catch(() => {
          // Background poll errors are retried on the next interval.
        });
      }, pollIntervalMs);
      pollTimer.unref();
    }
  }

  function currentConnection(): DesktopConnectionStatus {
    if (disconnected) {
      return { connected: false, authMode: "none" };
    }
    const status = readConnectionStatus();
    if (!status.connected) {
      // Credentials were removed externally; clear cached in-memory snapshot immediately.
      snapshot = undefined;
    }
    return status;
  }

  function clearOnDisconnect(): void {
    disconnected = true;
    snapshot = undefined;
    stopPolling();
    clearShellRuntimeState(env);
    runtime = { v: 1, notifiedEpisodes: [], dismissedEpisodes: [] };
  }

  function filterBlockersForConnection(
    blockers: BlockerSummary[],
    status: DesktopConnectionStatus,
  ): BlockerSummary[] {
    return blockers.filter((b) => {
      if (b.work_state === "resolved") return false;
      if (status.orgId && b.org_id !== status.orgId) return false;
      return true;
    });
  }

  function buildSummary(): ShellSummaryResponse {
    const prefs = loadWidgetPreferences(env);
    const status = currentConnection();

    if (!status.connected) {
      return {
        connected: false,
        state: "signed_out",
        authMode: "none",
        syncedAt: null,
        cursor: null,
        memberId: null,
        enabledWidgets: [...prefs.enabledWidgets],
        notifyBlockers: prefs.notifyBlockers,
        dismissedEpisodes: [],
        widgets: emptyWidgets(),
        counts: emptyCounts(),
      };
    }

    const enabled = new Set<WidgetKind>(prefs.enabledWidgets);
    const widgets = emptyWidgets();
    const counts = emptyCounts();

    if (snapshot) {
      if (enabled.has("objectives")) {
        widgets.objectives = snapshot.objectives.map((item) => ({ ...item }));
      }
      if (enabled.has("blockers")) {
        widgets.blockers = filterBlockersForConnection(snapshot.blockers, status).map(
          (item) => ({ ...item }),
        );
      }
      if (enabled.has("decisions")) {
        widgets.decisions = snapshot.decisions.map((item) => ({ ...item }));
      }
      if (enabled.has("updates")) {
        widgets.updates = snapshot.updates.map((item) => ({ ...item }));
      }
      if (enabled.has("tasks")) {
        widgets.tasks = snapshot.tasks.map((item) => ({ ...item }));
      }
      if (enabled.has("lanes")) {
        widgets.lanes = snapshot.lanes.map((item) => ({ ...item }));
      }
    }

    for (const kind of WIDGET_KINDS) {
      counts[kind] = widgets[kind].length;
    }

    const latestRuntime = loadShellRuntimeState(env);
    runtime = latestRuntime;

    return {
      connected: true,
      state: "connected",
      authMode: status.authMode,
      syncedAt: snapshot?.syncedAt ?? null,
      cursor: snapshot?.cursor ?? runtime.cursor ?? null,
      memberId: snapshot?.memberId ?? status.accountId ?? null,
      enabledWidgets: [...prefs.enabledWidgets],
      notifyBlockers: prefs.notifyBlockers,
      dismissedEpisodes: [...runtime.dismissedEpisodes],
      widgets,
      counts,
    };
  }

  async function runSyncOnce(): Promise<ShellSyncResult> {
    const liveStatus = readConnectionStatus();
    if (!liveStatus.connected) {
      clearOnDisconnect();
      return {
        synced: false,
        connected: false,
        resynced: false,
        cursor: null,
        syncedAt: null,
        alertsDelivered: 0,
        openBlockers: 0,
      };
    }

    disconnected = false;
    runtime = loadShellRuntimeState(env);
    const previousCursor = snapshot?.cursor ?? runtime.cursor;

    let resynced = false;
    let feedResult = await fetchFeed(previousCursor);
    let nextSnapshot: ShellSummarySnapshot;

    if (isFeedReset(feedResult)) {
      resynced = true;
      if (feedResult.snapshot) {
        nextSnapshot = cloneSnapshot(feedResult.snapshot);
      } else {
        const fresh = await fetchFeed(undefined);
        if (isFeedReset(fresh)) {
          if (!fresh.snapshot) {
            throw new Error("Shell feed returned reset without a resync snapshot.");
          }
          nextSnapshot = cloneSnapshot(fresh.snapshot);
        } else {
          nextSnapshot = cloneSnapshot(fresh);
        }
      }
    } else {
      nextSnapshot = cloneSnapshot(feedResult);
    }

    // If disconnect happened while fetchFeed was awaiting, discard the stale response.
    if (disconnected) {
      return {
        synced: false,
        connected: false,
        resynced,
        cursor: null,
        syncedAt: null,
        alertsDelivered: 0,
        openBlockers: 0,
      };
    }

    snapshot = nextSnapshot;

    const prefs = loadWidgetPreferences(env);
    const quiet = Boolean(await checkQuietMode());
    const scopedBlockers = liveStatus.orgId
      ? nextSnapshot.blockers.filter((b) => b.org_id === liveStatus.orgId)
      : nextSnapshot.blockers;

    const evaluation = evaluateBlockerInterruptions({
      blockers: scopedBlockers,
      currentMemberId: nextSnapshot.memberId || liveStatus.accountId || "",
      prefs,
      runtime: {
        ...runtime,
        cursor: nextSnapshot.cursor,
      },
      quietMode: quiet,
    });

    runtime = {
      ...evaluation.nextRuntime,
      cursor: nextSnapshot.cursor,
    };
    saveShellRuntimeState(runtime, env);

    for (const alert of evaluation.alerts) {
      await notify(alert);
    }

    return {
      synced: true,
      connected: true,
      resynced,
      cursor: nextSnapshot.cursor ?? null,
      syncedAt: nextSnapshot.syncedAt,
      alertsDelivered: evaluation.alerts.length,
      openBlockers: evaluation.openBlockers.length,
    };
  }

  function syncNow(): Promise<ShellSyncResult> {
    const task = syncQueue.then(() => runSyncOnce());
    syncQueue = task.catch(() => undefined);
    return task;
  }

  async function handleRpcRequest(raw: unknown): Promise<ShellRpcResponse> {
    if (!isRecord(raw)) {
      return {
        id: null,
        ok: false,
        error: { code: "invalid_request", message: "Request must be a JSON object." },
      };
    }

    const id =
      typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null;
    const method = typeof raw.method === "string" ? raw.method : "";
    const params = isRecord(raw.params) ? raw.params : {};

    try {
      switch (method) {
        case "ping": {
          const status = currentConnection();
          const result: ShellPingResponse = {
            connected: status.connected,
            authMode: status.authMode,
            syncedAt: status.connected ? (snapshot?.syncedAt ?? null) : null,
            cursor: status.connected ? (snapshot?.cursor ?? runtime.cursor ?? null) : null,
          };
          return { id, ok: true, result };
        }

        case "get_summary": {
          return { id, ok: true, result: buildSummary() };
        }

        case "get_preferences": {
          return { id, ok: true, result: loadWidgetPreferences(env) };
        }

        case "set_preferences": {
          const current = loadWidgetPreferences(env);
          let enabledWidgets = current.enabledWidgets;
          let notifyBlockers = current.notifyBlockers;

          if ("enabledWidgets" in params) {
            if (
              !Array.isArray(params.enabledWidgets) ||
              !params.enabledWidgets.every((w) => typeof w === "string")
            ) {
              return {
                id,
                ok: false,
                error: {
                  code: "invalid_params",
                  message: "enabledWidgets must be an array of widget names.",
                },
              };
            }
            enabledWidgets = params.enabledWidgets as WidgetKind[];
          }

          if ("notifyBlockers" in params) {
            if (typeof params.notifyBlockers !== "boolean") {
              return {
                id,
                ok: false,
                error: {
                  code: "invalid_params",
                  message: "notifyBlockers must be a boolean.",
                },
              };
            }
            notifyBlockers = params.notifyBlockers;
          }

          const saved = saveWidgetPreferences({ enabledWidgets, notifyBlockers }, env);
          return { id, ok: true, result: saved };
        }

        case "dismiss_blocker": {
          const org_id = typeof params.org_id === "string" ? params.org_id : "";
          const blocker_id = typeof params.blocker_id === "string" ? params.blocker_id : "";
          const blocking_episode =
            typeof params.blocking_episode === "string" ? params.blocking_episode : "";

          if (!org_id || !blocker_id || !blocking_episode) {
            return {
              id,
              ok: false,
              error: {
                code: "invalid_params",
                message: "dismiss_blocker requires org_id, blocker_id, and blocking_episode.",
              },
            };
          }

          const target = { org_id, blocker_id, blocking_episode };
          const latest = loadShellRuntimeState(env);
          runtime = dismissBlockerAlert(latest, target);
          saveShellRuntimeState(runtime, env);
          return {
            id,
            ok: true,
            result: {
              dismissed: true,
              dedupeKey: blockerEpisodeKey(target),
              dismissedEpisodes: [...runtime.dismissedEpisodes],
            },
          };
        }

        case "sync": {
          const result = await syncNow();
          return { id, ok: true, result };
        }

        case "disconnect": {
          clearOnDisconnect();
          return { id, ok: true, result: { disconnected: true } };
        }

        default:
          return {
            id,
            ok: false,
            error: {
              code: "method_not_found",
              message: `Unknown method: ${method || "(empty)"}`,
            },
          };
      }
    } catch (error) {
      return {
        id,
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  function handleConnection(socket: net.Socket): void {
    activeSockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let chain: Promise<void> = Promise.resolve();

    const writeResponse = (response: ShellRpcResponse) => {
      if (!socket.destroyed && socket.writable) {
        socket.write(`${JSON.stringify(response)}\n`);
      }
    };

    const processLine = (line: string) => {
      chain = chain.then(async () => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          writeResponse({
            id: null,
            ok: false,
            error: { code: "parse_error", message: "Malformed JSON request." },
          });
          return;
        }
        const response = await handleRpcRequest(parsed);
        writeResponse(response);
      });
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RPC_LINE_BYTES) {
        writeResponse({
          id: null,
          ok: false,
          error: { code: "invalid_request", message: "Request exceeds maximum size." },
        });
        socket.destroy();
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("end", () => {
      if (buffer.trim().length > 0) {
        processLine(buffer);
        buffer = "";
      }
    });

    socket.on("close", () => {
      activeSockets.delete(socket);
    });

    socket.on("error", () => {
      activeSockets.delete(socket);
    });
  }

  async function start(): Promise<void> {
    if (running) return;

    const dir = path.dirname(sockPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await removeStaleSocket(sockPath);

    const srv = net.createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        srv.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        srv.removeListener("error", onError);
        try {
          fs.chmodSync(sockPath, 0o600);
          resolve();
        } catch (err) {
          srv.close(() => reject(err));
        }
      };
      srv.once("error", onError);
      srv.once("listening", onListening);
      // Unix domain socket path ONLY — never bind any TCP port.
      srv.listen(sockPath);
    });

    server = srv;
    running = true;
    runtime = loadShellRuntimeState(env);
    startPolling();
  }

  async function stop(): Promise<void> {
    stopPolling();
    const srv = server;
    server = undefined;
    running = false;

    for (const sock of activeSockets) {
      sock.destroy();
    }
    activeSockets.clear();

    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    }
    fs.rmSync(sockPath, { force: true });
  }

  function getState(): ShellDaemonState {
    const status = currentConnection();
    return {
      running,
      socketPath: sockPath,
      connected: status.connected,
      authMode: status.authMode,
      cursor: status.connected ? (snapshot?.cursor ?? runtime.cursor) : undefined,
      syncedAt: status.connected ? snapshot?.syncedAt : undefined,
      snapshot: status.connected && snapshot ? cloneSnapshot(snapshot) : undefined,
      runtime: cloneRuntime(runtime),
      pollingActive: pollTimer !== undefined,
    };
  }

  return {
    socketPath: sockPath,
    start,
    stop,
    syncNow,
    clearOnDisconnect,
    getState,
  };
}

/**
 * Lightweight client helper for Omarchy widgets and CLI commands to query
 * the user-level shell daemon over its Unix domain socket.
 */
export async function queryShellDaemon<T = unknown>(
  socketPath: string,
  request: ShellRpcRequest,
  timeoutMs = 5_000,
): Promise<ShellRpcResponse<T>> {
  if (!path.isAbsolute(socketPath)) {
    throw new Error(`queryShellDaemon requires an absolute Unix socket path, got: ${socketPath}`);
  }

  return new Promise<ShellRpcResponse<T>>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");

    let settled = false;
    let buffer = "";

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };

    const succeed = (response: ShellRpcResponse<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.end();
      resolve(response);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for shell daemon response after ${timeoutMs}ms.`));
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx).trim();
      try {
        const parsed = JSON.parse(line) as ShellRpcResponse<T>;
        succeed(parsed);
      } catch {
        fail(new Error("Received invalid JSON response from shell daemon."));
      }
    });

    socket.once("error", (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    socket.once("close", () => {
      if (!settled) {
        const trimmed = buffer.trim();
        if (trimmed) {
          try {
            const parsed = JSON.parse(trimmed) as ShellRpcResponse<T>;
            succeed(parsed);
            return;
          } catch {
            // Fall through to premature close error.
          }
        }
        fail(new Error("Shell daemon closed connection before sending a response."));
      }
    });
  });
}
