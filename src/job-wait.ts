/**
 * Bounded wait on an ingestion or synthesis job.
 *
 * Ingest and synthesis return a job id at once; without this the model has to
 * guess when to poll. `job_status` with `wait_seconds` holds the call open,
 * polling the job, and reports progress to hosts that asked for it. The wait
 * is capped below the tool-call timeouts hosts apply, so a long job comes back
 * as "still running" with its counts, never as a timeout.
 */
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
}

export interface JobWaitResult {
  job: unknown;
  waited_seconds: number;
  still_running: boolean;
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
