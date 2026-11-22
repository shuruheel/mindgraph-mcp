/**
 * Bounded wait on an ingestion or synthesis job.
 *
 * Ingest and synthesis return a job id at once; without this the model has to
 * guess when to poll. `job_status` with `wait_seconds` holds the call open,
 * polling the job, and reports progress to hosts that asked for it. The wait
 * is capped below the tool-call timeouts hosts apply, so a long job comes back
 * as "still running" with its counts, never as a timeout.
 */
import { MindGraphError } from "mindgraph";
import type { OnDecision } from "./consent.js";

export const MAX_JOB_WAIT_SECONDS = 50;
const POLL_INTERVAL_MS = 2_000;
const TERMINAL = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);

export interface JobProgressUpdate {
  progress: number;
  total?: number;
  message: string;
}

export interface ToolRuntime {
  /** Present when the caller asked for progress and the transport can carry it. */
  progress?: (update: JobProgressUpdate) => Promise<void>;
  /** Aborts when the caller cancels the request. */
  signal?: AbortSignal;
  /** Upper bound on `wait_seconds` for this transport. */
  maxWaitSeconds?: number;
  /** The server's profile, from its wiring. `mindgraph_code` and
   * `mindgraph_sync` run only when this is "coding" and `hosted` is not set. */
  profile?: string;
  /** Set in hosted mode: no tool may touch the host's filesystem or run git. */
  hosted?: boolean;
  /** The coding server's consent decision for this call: every local
   * repository path runs from its pinned set. */
  consent?: OnDecision;
}

export interface JobWaitResult {
  job: unknown;
  waited_seconds: number;
  still_running: boolean;
}

export type ReadinessDimension = "lexical" | "vector" | "extraction";
export type DimensionState = "ready" | "not_ready" | "unknown" | "not_requested";

export interface DocumentStatusPayload {
  contract: "document-status.v1";
  document_uid: string;
  document_version: number;
  generation_id: string | null;
  attempt_id: string | null;
  job_id: string | null;
  job_available: boolean;
  processing_status: string;
  attempt_state: string | null;
  content_revision: string | null;
  pipeline_digest: string | null;
  readiness: {
    lexical: DimensionState;
    vector: DimensionState;
    extraction: DimensionState;
  };
  observed_at: string;
  error: { code: string; message: string; retriable: boolean } | null;
}

export type DocumentStatusWaitOutcome =
  | {
      kind: "ready";
      status: DocumentStatusPayload;
      waited_seconds: number;
    }
  | {
      kind: "still_running";
      status: DocumentStatusPayload;
      waited_seconds: number;
    }
  | {
      kind: "error";
      code:
        | "document_superseded"
        | "readiness_unknown"
        | "readiness_not_requested"
        | "document_incomplete";
      message: string;
      document_uid: string;
      expected_attempt_id?: string;
      observed_attempt_id?: string;
      dimension?: ReadinessDimension;
      last_status: DocumentStatusPayload;
      waited_seconds: number;
    };

const VALID_DIMENSION_STATES = new Set(["ready", "not_ready", "unknown", "not_requested"]);
const TERMINAL_503_CODES = new Set([
  "query_memory_budget_exceeded",
  "query_timeout",
  "query_cancelled",
  "vector_index_rebuilding",
]);

export interface RawDocumentStatusResponse {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

export function isDocumentStatusPayload(value: unknown): value is DocumentStatusPayload {
  const obj = rec(value);
  const readiness = rec(obj?.readiness);
  const hasValidAttemptId =
    !!obj &&
    Object.prototype.hasOwnProperty.call(obj, "attempt_id") &&
    (obj.attempt_id === null || typeof obj.attempt_id === "string");
  const hasValidAttemptState =
    !!obj &&
    Object.prototype.hasOwnProperty.call(obj, "attempt_state") &&
    (obj.attempt_state === null || typeof obj.attempt_state === "string");
  return (
    obj?.contract === "document-status.v1" &&
    typeof obj.document_uid === "string" &&
    hasValidAttemptId &&
    hasValidAttemptState &&
    !!readiness &&
    typeof readiness.lexical === "string" &&
    VALID_DIMENSION_STATES.has(readiness.lexical) &&
    typeof readiness.vector === "string" &&
    VALID_DIMENSION_STATES.has(readiness.vector) &&
    typeof readiness.extraction === "string" &&
    VALID_DIMENSION_STATES.has(readiness.extraction)
  );
}

/** Parse RFC 9110 Retry-After (integer seconds or HTTP-date) into ms. */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) ? secs * 1000 : null;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return Math.max(0, parsed - nowMs);
  }
  return null;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function documentStatusProgress(status: DocumentStatusPayload): JobProgressUpdate {
  const r = status.readiness;
  const readyCount = [r.lexical, r.vector, r.extraction].filter((s) => s === "ready").length;
  const requestedCount = [r.lexical, r.vector, r.extraction].filter((s) => s !== "not_requested").length;
  return {
    progress: readyCount,
    ...(requestedCount > 0 ? { total: requestedCount } : {}),
    message: `${status.attempt_state ?? "unknown"}: lexical=${r.lexical}, vector=${r.vector}, extraction=${r.extraction}`,
  };
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;

export function jobIsTerminal(job: unknown): boolean {
  const status = rec(job)?.status;
  // An unknown shape is treated as terminal: waiting on it would only burn
  // the caller's time.
  return typeof status !== "string" || TERMINAL.has(status);
}

export function jobProgress(job: unknown): JobProgressUpdate | undefined {
  const payload = rec(job);
  const progress = rec(payload?.progress);
  if (!payload || !progress) return undefined;
  const processed = typeof progress.processed_chunks === "number" ? progress.processed_chunks : 0;
  const total = typeof progress.total_chunks === "number" ? progress.total_chunks : undefined;
  const nodes = typeof progress.nodes_created === "number" ? progress.nodes_created : undefined;
  const queued =
    typeof payload.queue_position === "number" && payload.status === "pending"
      ? `queued at position ${payload.queue_position}`
      : undefined;
  const parts = [
    queued ?? `${processed}${total !== undefined ? ` of ${total}` : ""} chunks`,
    nodes !== undefined ? `${nodes} nodes` : undefined,
  ].filter(Boolean);
  return {
    progress: processed,
    ...(total !== undefined && total > 0 ? { total } : {}),
    message: `${String(payload.status)}: ${parts.join(", ")}`,
  };
}

export function clampWaitSeconds(value: unknown, max = MAX_JOB_WAIT_SECONDS): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), max);
}

export async function waitForJob(
  getJob: () => Promise<unknown>,
  waitSeconds: number,
  runtime: ToolRuntime = {},
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<JobWaitResult> {
  const started = clock.now();
  const deadline = started + waitSeconds * 1_000;
  let job = await getJob();
  let lastMessage: string | undefined;
  const report = async () => {
    const update = jobProgress(job);
    if (!update || !runtime.progress || update.message === lastMessage) return;
    lastMessage = update.message;
    try {
      await runtime.progress(update);
    } catch {
      // Progress is a courtesy; a host that drops it must not fail the call.
    }
  };
  await report();
  while (!jobIsTerminal(job) && !runtime.signal?.aborted) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    await clock.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    if (runtime.signal?.aborted) break;
    job = await getJob();
    await report();
  }
  return {
    job,
    waited_seconds: Math.round((clock.now() - started) / 1_000),
    still_running: !jobIsTerminal(job),
  };
}

function isRawDocumentStatusResponse(value: unknown): value is RawDocumentStatusResponse {
  const obj = rec(value);
  return (
    !!obj &&
    typeof obj.status === "number" &&
    Object.prototype.hasOwnProperty.call(obj, "body") &&
    Object.prototype.hasOwnProperty.call(obj, "retryAfter")
  );
}

function errorStatusCode(err: unknown): {
  status?: number;
  code?: string;
  retriable?: boolean;
  retryAfter?: string | null;
} {
  if (!err || typeof err !== "object") return {};
  const obj = err as {
    status?: unknown;
    code?: unknown;
    retriable?: unknown;
    body?: unknown;
    retryAfter?: unknown;
  };
  const body = rec(obj.body);
  const code =
    typeof obj.code === "string"
      ? obj.code
      : typeof body?.code === "string"
        ? body.code
        : undefined;
  const retriable =
    typeof obj.retriable === "boolean"
      ? obj.retriable
      : typeof body?.retriable === "boolean"
        ? body.retriable
        : undefined;
  const retryAfter = typeof obj.retryAfter === "string" ? obj.retryAfter : null;
  return {
    ...(typeof obj.status === "number" ? { status: obj.status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(retriable !== undefined ? { retriable } : {}),
    retryAfter,
  };
}

function permits503Retry(info: { code?: string; retriable?: boolean }): boolean {
  if (info.retriable === false) return false;
  if (info.code !== undefined && TERMINAL_503_CODES.has(info.code)) return false;
  return true;
}

/**
 * Bounded read-only wait on `GET /ingest/document/{uid}/status` (`document-status.v1`).
 *
 * Follows §5.2 semantics: checks `AbortSignal` before every poll and sleep,
 * pins explicit or first non-null `attempt_id`, classifies active vs terminal
 * strictly via `attempt_state === "running"`, retries `409 status_changed` and
 * retriable `429`/`503` with RFC 9110 `Retry-After` clamped to the bounded
 * `waitSeconds` deadline, reports progress when available, and never cancels
 * or mutates server state.
 */
export async function waitForDocumentStatus(
  documentUid: string,
  fetchStatus: (
    remainingMs: number,
    signal?: AbortSignal,
  ) => Promise<RawDocumentStatusResponse | DocumentStatusPayload>,
  waitSeconds: number,
  opts: { attemptId?: string; until?: ReadinessDimension } = {},
  runtime: ToolRuntime = {},
  clock: { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> } = {
    now: Date.now,
    sleep: abortableSleep,
  },
): Promise<DocumentStatusWaitOutcome> {
  const started = clock.now();
  const deadline = started + waitSeconds * 1_000;
  const until: ReadinessDimension = opts.until ?? "extraction";
  let pinnedAttemptId: string | null = opts.attemptId ?? null;
  let lastStatus: DocumentStatusPayload | undefined;
  let lastMessage: string | undefined;

  const elapsedSeconds = () => Math.round((clock.now() - started) / 1_000);

  const report = async (status: DocumentStatusPayload) => {
    if (!runtime.progress) return;
    const update = documentStatusProgress(status);
    if (update.message === lastMessage) return;
    lastMessage = update.message;
    try {
      await runtime.progress(update);
    } catch {
      // Progress is a courtesy; a host that drops it must not fail the call.
    }
  };

  while (true) {
    if (runtime.signal?.aborted) {
      if (lastStatus) {
        return { kind: "still_running", status: lastStatus, waited_seconds: elapsedSeconds() };
      }
      throw new MindGraphError(`Cancelled waiting for document ${documentUid}`, 0, {
        code: "document_wait_cancelled",
        retriable: false,
      });
    }

    const remainingBefore = deadline - clock.now();
    if (remainingBefore <= 0 && lastStatus) {
      return { kind: "still_running", status: lastStatus, waited_seconds: elapsedSeconds() };
    }

    let raw: RawDocumentStatusResponse;
    try {
      const response = await fetchStatus(Math.max(1, remainingBefore), runtime.signal);
      raw = isRawDocumentStatusResponse(response)
        ? response
        : { status: 200, body: response, retryAfter: null };
    } catch (err) {
      if (runtime.signal?.aborted) {
        if (lastStatus) {
          return { kind: "still_running", status: lastStatus, waited_seconds: elapsedSeconds() };
        }
        throw new MindGraphError(`Cancelled waiting for document ${documentUid}`, 0, {
          code: "document_wait_cancelled",
          retriable: false,
        });
      }
      const info = errorStatusCode(err);
      if (info.code === "timeout" && lastStatus) {
        return { kind: "still_running", status: lastStatus, waited_seconds: elapsedSeconds() };
      }
      const retryableConflict = info.status === 409 && info.code === "status_changed";
      const retryableThrottle =
        info.status === 429 || (info.status === 503 && permits503Retry(info));
      if (retryableConflict || retryableThrottle) {
        const nowMs = clock.now();
        const remaining = deadline - nowMs;
        const retryAfterMs = retryableThrottle ? parseRetryAfterMs(info.retryAfter, nowMs) : null;
        if (
          remaining > 0 &&
          !runtime.signal?.aborted &&
          (retryAfterMs === null || retryAfterMs < remaining)
        ) {
          const delayMs = Math.min(Math.max(POLL_INTERVAL_MS, retryAfterMs ?? 0), remaining);
          await clock.sleep(delayMs, runtime.signal);
          if (!runtime.signal?.aborted) continue;
        }
        if (lastStatus) {
          return { kind: "still_running", status: lastStatus, waited_seconds: elapsedSeconds() };
        }
      }
      throw err;
    }

    if (runtime.signal?.aborted) {
      if (lastStatus) {
        return { kind: "still_running", status: lastStatus, waited_seconds: elapsedSeconds() };
      }
      throw new MindGraphError(`Cancelled waiting for document ${documentUid}`, 0, {
        code: "document_wait_cancelled",
        retriable: false,
      });
    }

    if (raw.status !== 200) {
      const info = errorStatusCode({ status: raw.status, body: raw.body, retryAfter: raw.retryAfter });
      const retryableConflict = raw.status === 409 && info.code === "status_changed";
      const retryableThrottle =
        raw.status === 429 || (raw.status === 503 && permits503Retry(info));
      if (retryableConflict || retryableThrottle) {
        const nowMs = clock.now();
        const remaining = deadline - nowMs;
        const retryAfterMs = retryableThrottle ? parseRetryAfterMs(raw.retryAfter, nowMs) : null;
        if (
          remaining > 0 &&
          !runtime.signal?.aborted &&
          (retryAfterMs === null || retryAfterMs < remaining)
        ) {
          const delayMs = Math.min(Math.max(POLL_INTERVAL_MS, retryAfterMs ?? 0), remaining);
          await clock.sleep(delayMs, runtime.signal);
          if (!runtime.signal?.aborted) continue;
        }
        if (lastStatus) {
          return { kind: "still_running", status: lastStatus, waited_seconds: elapsedSeconds() };
        }
      }
      throw new MindGraphError(
        `GET /ingest/document/${encodeURIComponent(documentUid)}/status failed: ${raw.status}`,
        raw.status,
        raw.body,
      );
    }

    if (!isDocumentStatusPayload(raw.body)) {
      throw new MindGraphError("Incompatible document status response", 200, {
        code: "incompatible_response",
        retriable: false,
      });
    }
    const status = raw.body;
    lastStatus = status;
    await report(status);

    // Attempt pinning (§5.2 rule 2)
    if (status.attempt_id === null) {
      return {
        kind: "error",
        code: "readiness_unknown",
        message: `Document ${documentUid} is not lifecycle-tracked (attempt_id is null)`,
        document_uid: documentUid,
        last_status: status,
        waited_seconds: elapsedSeconds(),
      };
    }
    if (pinnedAttemptId === null) {
      pinnedAttemptId = status.attempt_id;
    } else if (status.attempt_id !== pinnedAttemptId) {
      return {
        kind: "error",
        code: "document_superseded",
        message: `Document ${documentUid} attempt ${pinnedAttemptId} was superseded by ${status.attempt_id}`,
        document_uid: documentUid,
        expected_attempt_id: pinnedAttemptId,
        observed_attempt_id: status.attempt_id,
        last_status: status,
        waited_seconds: elapsedSeconds(),
      };
    }

    // Target dimension evaluation (§5.2 rule 3)
    const dimState = status.readiness[until];
    if (dimState === "ready") {
      return {
        kind: "ready",
        status,
        waited_seconds: elapsedSeconds(),
      };
    }
    if (dimState === "not_requested") {
      return {
        kind: "error",
        code: "readiness_not_requested",
        message: `Readiness dimension "${until}" was not requested for document ${documentUid}`,
        document_uid: documentUid,
        dimension: until,
        last_status: status,
        waited_seconds: elapsedSeconds(),
      };
    }

    // Active vs terminal strictly by attempt_state (never processing_status).
    if (status.attempt_state !== "running") {
      if (dimState === "unknown") {
        return {
          kind: "error",
          code: "readiness_unknown",
          message: `Readiness is unknown for document ${documentUid}`,
          document_uid: documentUid,
          last_status: status,
          waited_seconds: elapsedSeconds(),
        };
      }
      return {
        kind: "error",
        code: "document_incomplete",
        message: `Document ${documentUid} ended in state "${status.attempt_state}" without "${until}" readiness`,
        document_uid: documentUid,
        dimension: until,
        last_status: status,
        waited_seconds: elapsedSeconds(),
      };
    }

    if (runtime.signal?.aborted) {
      return {
        kind: "still_running",
        status,
        waited_seconds: elapsedSeconds(),
      };
    }
    const nowMs = clock.now();
    const remaining = deadline - nowMs;
    if (remaining <= 0) {
      return {
        kind: "still_running",
        status,
        waited_seconds: elapsedSeconds(),
      };
    }
    const retryAfterMs = parseRetryAfterMs(raw.retryAfter, nowMs);
    if (retryAfterMs !== null && retryAfterMs >= remaining) {
      return {
        kind: "still_running",
        status,
        waited_seconds: elapsedSeconds(),
      };
    }
    const delayMs = Math.min(Math.max(POLL_INTERVAL_MS, retryAfterMs ?? 0), remaining);
    await clock.sleep(delayMs, runtime.signal);
    if (runtime.signal?.aborted) {
      return {
        kind: "still_running",
        status,
        waited_seconds: elapsedSeconds(),
      };
    }
  }
}
