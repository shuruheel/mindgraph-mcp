import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  consentFor,
  eventDirectory,
  type ConsentDecision,
  type OffDecision,
  type OnDecision,
} from "./consent.js";
import { renderOtherEligibleWork } from "./render.js";
import {
  resolveRepositoryScope,
  WORKSPACE_RESUME_LIMIT,
} from "./workspace-scope.js";
import { recordPendingCall } from "./call-ledger.js";
import { conflictState } from "./error-detail.js";
import { stableAgentId } from "./hook-env.js";
import {
  buildCaptureRequest,
  promptRecallQuery,
  promptRecallRequest,
  renderPromptRecall,
} from "./hook-memory.js";
import { nodeGit } from "./consent-plan.js";
import {
  anchorTable,
  CHARS_PER_TOKEN,
  DEFAULT_BUDGET_TOKENS,
  localNotes,
  memoryListOf,
  placeName,
  readSpace,
  renderSessionBlock,
  selectIndex,
  workChars,
  writePrivateJson,
  type IndexState,
} from "./session-block.js";

export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  source?: string;
  model?: string;
  turn_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
  reason?: string;
  /** UserPromptSubmit: the submitted prompt text. */
  prompt?: string;
  /** PreCompact: "manual" | "auto". */
  trigger?: string;
  transcript_path?: string;
  /** Set on events from inside a subagent. */
  agent_id?: string;
}

export interface HookClient {
  session(request: Record<string, unknown>): Promise<unknown>;
  plan(request: Record<string, unknown>): Promise<unknown>;
  entity?(request: Record<string, unknown>): Promise<unknown>;
  retrieveContext?(request: Record<string, unknown>): Promise<unknown>;
  ingestSession?(request: Record<string, unknown>): Promise<unknown>;
  /** `POST /memory/v1/list`; the SDK client is read through its request
   * helper when this is absent. */
  memoryList?(request: Record<string, unknown>): Promise<unknown>;
}

export type HookHarness = "claude-code" | "codex";

interface RuntimeLedger {
  harness: HookHarness;
  harnessSessionId: string;
  sessionUid?: string;
  taskUid?: string;
  executionUid?: string;
  taskVersion?: number;
  leaseEpoch?: number;
  leaseExpiresAt?: number;
  materialToolCalls: number;
  mutatingOperations: number;
  memoryWritten: boolean;
  iterationCheckpointed: boolean;
  stopNudged: boolean;
  nativeTasksCreated: number;
  nativeTasksTerminal: number;
  baselineWorktree: "clean" | "dirty" | "unknown";
  lastBriefHash?: string;
  /** Unix seconds of the last successful lease renewal (claim or heartbeat).
   * Drives time-based renewal so a lease survives quiet stretches and client
   * clock skew — the expiry comparison alone misses both. */
  lastLeaseRenewalAt?: number;
  /** Hash of the last UserPromptSubmit recall block injected (dedup). */
  lastRecallHash?: string;
  /** Byte offset in the transcript up to which turns were captured. */
  captureOffset?: number;
  /** Per-event cost of the hooks in this session (roadmap H8): how often each
   * fired, time spent inside the hook, and characters injected into context. */
  hookStats?: Record<string, HookEventStats>;
  /** Context boundaries seen (compaction, clear); each context has its own
   * budget. */
  contextEpoch?: number;
  /** Tokens injected per `<agent>#<epoch>` against the session budget. */
  /** Per-context token budgets. `spentNoted`: prompt recall has already said
   * once in this context that the budget is spent. */
  budgets?: Record<string, { limit: number; used: number; spentNoted?: boolean }>;
  /** The last session block injected. */
  block?: { titles: number; leftOut: number; tokens: number; budget: number; handles: string[] };
  /** Handles the model opened with mindgraph_memory action=open. */
  handlesOpened?: string[];
  /** Times a hook failed open (injected nothing extra), and the last one. */
  failOpen?: { count: number; last?: { event: string; reason: string; at: number } };
  updatedAt: number;
}

export interface HookRuntimeOptions {
  runtimeDir?: string;
  agentId?: string;
  now?: () => number;
  /** Whether MindGraph is on for this event's directory. Defaults to the
   * user's consent store (`consentFor`). Tests pass a decision here; there is
   * no environment variable that turns MindGraph on. */
  consent?: ConsentDecision | ((cwd: string | undefined) => ConsentDecision);
  /** Identifies the API key, base URL and organization the hook talks to.
   * When set, resolved repository uids are remembered in the runtime
   * directory for that tenant only; unset means no cache. */
  scopeCacheTenant?: string;
  /** Claude Code's config file (default ~/.claude.json), used only by the
   * SessionStart registration diagnostic. Injectable for tests. */
  claudeConfigPath?: string;
  /** UserPromptSubmit recall; runs unless false. The event is installed only
   * on opt-in (`--prompt-recall`) and the CLI runner passes false without
   * one. MINDGRAPH_HOOK_PROMPT_RECALL=off disables at runtime. */
  promptRecall?: boolean;
  /** PreCompact/SessionEnd transcript capture; default OFF. */
  capture?: boolean;
  /** UserPromptSubmit recall deadline (default 4s; fail open). */
  promptRecallTimeoutMs?: number;
  /** Tokens per context for injected memory (default 2,000). */
  budgetTokens?: number;
  /** Deadline for the session block's memory read (default 3s; fail open). */
  memoryListTimeoutMs?: number;
  /** One line for the developer at session start (`systemMessage`). Off
   * unless set, or MINDGRAPH_HOOK_SESSION_NOTICE=on. */
  sessionNotice?: boolean;
}

interface CoreHookRuntimeOptions extends HookRuntimeOptions {
  harness: HookHarness;
  reinjectUnchangedCompact: boolean;
}

/** Options inside a consented root: the decision is always an on decision. */
interface GatedHookRuntimeOptions extends CoreHookRuntimeOptions {
  decision: OnDecision;
}

export interface HookEventStats {
  count: number;
  totalMs: number;
  maxMs: number;
  injectedChars: number;
  /** The most recent in-process times (ms), for percentiles. */
  samplesMs?: number[];
}

const SAMPLES_KEPT = 256;

export type HookCoreOutput =
  | { kind: "noop" }
  /** `notice` is shown to the developer beside the context, never the model. */
  | { kind: "context"; context: string; event?: string; notice?: string }
  | { kind: "rewrite"; updatedInput: Record<string, unknown> }
  | { kind: "block"; reason: string }
  /** Fixed local text for the user; never model context. */
  | { kind: "notice"; message: string };

const NOOP: HookCoreOutput = { kind: "noop" };

function defaultLedger(
  sessionId: string,
  options: CoreHookRuntimeOptions,
): RuntimeLedger {
  return {
    harness: options.harness,
    harnessSessionId: sessionId,
    materialToolCalls: 0,
    mutatingOperations: 0,
    memoryWritten: false,
    iterationCheckpointed: false,
    stopNudged: false,
    nativeTasksCreated: 0,
    nativeTasksTerminal: 0,
    baselineWorktree: "unknown",
    updatedAt: Date.now(),
  };
}

function runtimeDir(options: HookRuntimeOptions): string {
  return (
    options.runtimeDir ||
    process.env.MINDGRAPH_RUNTIME_DIR ||
    path.join(os.homedir(), ".mindgraph", "runtime")
  );
}

function ledgerKey(sessionId: string, options: HookRuntimeOptions): string {
  const harness =
    "harness" in options ? (options as CoreHookRuntimeOptions).harness : "claude-code";
  return crypto.createHash("sha256").update(`${harness}\0${sessionId}`).digest("hex");
}

function ledgerPath(sessionId: string, options: HookRuntimeOptions): string {
  return path.join(runtimeDir(options), `${ledgerKey(sessionId, options)}.json`);
}

/** The session's anchor table (repository → real file path → handles and
 * titles), written at SessionStart and removed at SessionEnd. */
export function anchorTablePath(sessionId: string, options: HookRuntimeOptions): string {
  return path.join(runtimeDir(options), "anchors", `${ledgerKey(sessionId, options)}.json`);
}

/** Counts a fail-open path in the session ledger (`hooks stats` shows it).
 * Never throws. */
export function recordFailOpen(
  sessionId: string,
  event: string,
  reason: string,
  options: HookRuntimeOptions & { harness?: HookHarness } = {},
): void {
  if (!sessionId) return;
  try {
    withLedger(
      sessionId,
      { reinjectUnchangedCompact: false, ...options, harness: options.harness ?? "claude-code" },
      (ledger) => {
        const failOpen = (ledger.failOpen ??= { count: 0 });
        failOpen.count += 1;
        failOpen.last = { event, reason: reason.slice(0, 200), at: Date.now() };
        return undefined;
      },
    );
  } catch {
    // Counting is bookkeeping; it never changes what a hook returns.
  }
}

const STALE_TEMPORARY_MS = 60 * 60_000;
/** Anchor tables of sessions that never reached SessionEnd (a killed harness). */
const STALE_ANCHOR_TABLE_MS = 7 * 24 * 60 * 60_000;

/** Removes ledger temporaries left by a hook that was killed between its
 * write and its rename (the harness enforces hook timeouts). Only files
 * older than an hour are touched, so a write in flight is never removed. */
export function sweepStaleTemporaries(dir: string, now = Date.now()): number {
  let removed = 0;
  // Ledger temporaries in the runtime folder, then old anchor tables (and
  // their temporaries) in its anchors folder.
  for (const [where, maxAge, pattern] of [
    [dir, STALE_TEMPORARY_MS, /\.json\.\d+\.[0-9a-f-]+\.tmp$/],
    [path.join(dir, "anchors"), STALE_ANCHOR_TABLE_MS, /\.json(?:\.\d+\.[0-9a-f-]+\.tmp)?$/],
  ] as const) {
    let names: string[];
    try {
      names = fs.readdirSync(where);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const file = path.join(where, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAge) {
          fs.unlinkSync(file);
          removed += 1;
        }
      } catch {
        // Another hook removed it first.
      }
    }
  }
  return removed;
}

function waitBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLedger<T>(
  sessionId: string,
  options: CoreHookRuntimeOptions,
  update: (ledger: RuntimeLedger) => T,
): T {
  const file = ledgerPath(sessionId, options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  const lock = `${file}.lock`;
  let lockFd: number | undefined;
  // Holders only ever perform in-memory JSON updates (no subprocess or
  // network inside the callback), so a live hold is sub-millisecond. The
  // waiter window must exceed the stale threshold, or a lock orphaned by a
  // harness kill blanks every hook for seconds — waiters gave up at 500ms
  // against a 10s reclaim and silently ran on a throwaway default ledger.
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      lockFd = fs.openSync(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 3_000) fs.unlinkSync(lock);
      } catch {
        // Another hook won the race.
      }
      waitBriefly(10);
    }
  }
  if (lockFd === undefined) {
    return update(defaultLedger(sessionId, options));
  }
  try {
    let ledger = defaultLedger(sessionId, options);
    try {
      ledger = {
        ...ledger,
        ...JSON.parse(fs.readFileSync(file, "utf8")),
      };
    } catch {
      // Missing/corrupt disposable bookkeeping starts fresh.
    }
    const result = update(ledger);
    ledger.updatedAt = Date.now();
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    return result;
  } finally {
    fs.closeSync(lockFd);
    try {
      fs.unlinkSync(lock);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

function readLedger(
  sessionId: string,
  options: CoreHookRuntimeOptions,
): RuntimeLedger {
  return withLedger(sessionId, options, (ledger) => ({ ...ledger }));
}

function gitValue(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 750,
    }).trim();
  } catch {
    return undefined;
  }
}

function worktreeState(cwd: string): "clean" | "dirty" | "unknown" {
  const status = gitValue(cwd, ["status", "--porcelain"]);
  return status === undefined ? "unknown" : status ? "dirty" : "clean";
}

function invocationContext(
  input: HookInput,
  options: CoreHookRuntimeOptions,
  repoId: string | undefined,
) {
  return {
    harness: options.harness,
    harnessSessionId: input.session_id,
    harnessTurnId: input.turn_id,
    cwd: input.cwd,
    repoId,
    branch: gitValue(input.cwd, ["branch", "--show-current"]),
    commit: gitValue(input.cwd, ["rev-parse", "HEAD"]),
    worktreeState: worktreeState(input.cwd),
    model: input.model,
    injectedBy: "hook",
  };
}

function resolveAgentId(options: CoreHookRuntimeOptions): string {
  return options.agentId || process.env.MINDGRAPH_AGENT_ID || stableAgentId();
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responsePayload(value: unknown): Record<string, unknown> | undefined {
  const direct = object(value);
  if (!direct) return undefined;
  if (Array.isArray(direct.content)) {
    for (const item of direct.content) {
      const block = object(item);
      if (block?.type === "text" && typeof block.text === "string") {
        try {
          const parsed = JSON.parse(block.text);
          const payload = object(parsed);
          if (payload) return payload;
        } catch {
          // Non-JSON tool text is not lifecycle bookkeeping.
        }
      }
    }
  }
  return direct;
}

/** The first text of a tool result, in any of the shapes hooks receive. */
function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  const blocks = Array.isArray(value) ? value : object(value)?.content;
  const first = Array.isArray(blocks) ? object(blocks[0]) : undefined;
  return typeof first?.text === "string" ? first.text : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const BRIEF_CHAR_BUDGET = 9_000;

function clip(value: unknown, max: number): string | undefined {
  const text = string(value);
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function nodeSummaryLine(value: unknown, summaryMax: number): string | undefined {
  const node = object(value);
  if (!node) return undefined;
  const label = clip(node.label, 160) || "(unlabeled)";
  const summary = clip(node.summary, summaryMax);
  const uid = string(node.uid);
  return `- ${label}${uid ? ` [${uid}]` : ""}${summary && summary !== label ? ` — ${summary}` : ""}`;
}

interface BriefRenderMeta {
  claimed: boolean;
  claimFailed: boolean;
  scopeNote?: string;
  /** Scope uid → repository id; groups the other eligible work. */
  repositoryNames?: Record<string, string>;
}

/**
 * Render the resume brief as a compact, ordered briefing instead of raw JSON.
 *
 * The previous implementation dumped `JSON.stringify(brief, null, 2)` capped
 * at 8,900 chars. The server serializes keys alphabetically (serde BTreeMap),
 * which puts `lease`, `selection_reason`, and `task` LAST — so a populated
 * brief truncated away the identity of the work while boilerplate full-node
 * JSON survived (observed live 2026-07-29: the injected brief lost `task`
 * entirely, and what remained was cut mid-string into unparseable JSON). Here
 * the task always renders first and bounding drops whole optional sections,
 * never mid-item bytes.
 */
function renderBrief(
  brief: Record<string, unknown> | undefined,
  meta: BriefRenderMeta,
  maxChars = BRIEF_CHAR_BUDGET,
): string {
  // Truthful bounding: whenever any item is clipped or any section dropped,
  // the brief says so — the model can then fetch full content by uid instead
  // of assuming it saw everything.
  let bounded = false;
  const clipTracked = (value: unknown, max: number): string | undefined => {
    const text = string(value);
    if (!text) return undefined;
    if (text.length <= max) return text;
    bounded = true;
    return `${text.slice(0, max - 1)}…`;
  };
  const nodeLine = (value: unknown, summaryMax: number): string | undefined => {
    const node = object(value);
    if (!node) return undefined;
    const label = clipTracked(node.label, 160) || "(unlabeled)";
    const summary = clipTracked(node.summary, summaryMax);
    const uid = string(node.uid);
    return `- ${label}${uid ? ` [${uid}]` : ""}${summary && summary !== label ? ` — ${summary}` : ""}`;
  };
  const lines: string[] = [
    "MindGraph durable work brief (authoritative across sessions/harnesses):",
  ];
  if (meta.scopeNote) lines.push(meta.scopeNote);
  // No selection ran: say why, and claim nothing about what is eligible.
  if (brief?.status === "scope_unresolved") return lines.join("\n");
  const task = object(brief?.task);
  const scopedOut = number(brief?.scoped_out_tasks);
  if (!task) {
    lines.push("No durable task is eligible for this session's scope.");
    if (scopedOut) {
      lines.push(
        `${scopedOut} durable task(s) exist outside this repository scope — resume one explicitly by task_uid if that is intended.`,
      );
    }
  } else {
    const props = object(task.props);
    const details = [
      `status ${string(props?.status) || "unknown"}`,
      string(props?.priority) ? `priority ${string(props?.priority)}` : undefined,
      number(task.version) !== undefined ? `v${number(task.version)}` : undefined,
    ].filter(Boolean);
    lines.push(
      `Task: ${clipTracked(task.label, 200) || "(unlabeled)"} [${string(task.uid) || "?"}] — ${details.join(", ")}`,
    );
    const description = clipTracked(props?.description, 400);
    if (description) lines.push(`  ${description}`);
    const taskScopes = Array.isArray(brief?.task_scope_uids)
      ? brief!.task_scope_uids.map(String)
      : [];
    const taskRepository = taskScopes
      .map((uid) => meta.repositoryNames?.[uid])
      .find(Boolean);
    if (taskRepository && Object.keys(meta.repositoryNames ?? {}).length > 1) {
      lines.push(`Repository: ${taskRepository}`);
    }
    const reason = string(brief?.selection_reason);
    if (reason) lines.push(`Selection: ${reason}`);
    const lease = object(brief?.claim) || object(brief?.lease);
    if (meta.claimed) {
      const epoch = number(lease?.lease_epoch);
      lines.push(
        `Claimed: yes${epoch !== undefined ? ` (lease epoch ${epoch})` : ""} — this session holds the lease.`,
      );
    } else if (meta.claimFailed) {
      lines.push(
        "Claimed: no — the claim attempt failed (another session may hold the lease). Treat as context; claim_task explicitly before mutating it.",
      );
    } else {
      lines.push(
        "Claimed: no — backlog context, not owned. claim_task deliberately before starting this work.",
      );
    }
    const goal = nodeLine(brief?.goal, 200);
    if (goal) lines.push(`Goal:\n${goal}`);
    const steps = Array.isArray(brief?.next_steps) ? brief!.next_steps : [];
    if (steps.length > 5) bounded = true;
    const stepLines = steps
      .slice(0, 5)
      .map((step) => nodeLine(step, 160))
      .filter(Boolean);
    if (stepLines.length) lines.push(`Next steps:\n${stepLines.join("\n")}`);
    const blockers = Array.isArray(brief?.blockers) ? brief!.blockers : [];
    if (blockers.length > 5) bounded = true;
    const blockerLines = blockers
      .slice(0, 5)
      .map((blocker) => nodeLine(blocker, 200))
      .filter(Boolean);
    if (blockerLines.length) lines.push(`Blockers:\n${blockerLines.join("\n")}`);
    const active = object(brief?.active_execution);
    if (active) {
      const iteration =
        number(active.iteration) ?? number(object(active.props)?.iteration);
      lines.push(
        `Active execution: [${string(active.uid) || "?"}] iteration ${iteration ?? "?"} still running from a prior session — checkpoint or abandon it.`,
      );
    }
    const poison = object(brief?.poison_task) || string(brief?.warning);
    if (poison) {
      lines.push(
        `Warning: ${typeof poison === "string" ? clipTracked(poison, 300) : "recent executions of this task repeatedly failed — investigate before retrying."}`,
      );
    }
  }
  // Optional context sections append only while the budget holds; each is
  // dropped whole rather than cut mid-item.
  const optional: string[] = [];
  // First among the optional sections: at a workspace root the other
  // repositories' work is the reason the brief exists.
  const otherWork = renderOtherEligibleWork(brief, meta.repositoryNames);
  if (otherWork) optional.push(otherWork);
  const knowledge = Array.isArray(brief?.knowledge) ? brief!.knowledge : [];
  if (knowledge.length > 5) bounded = true;
  const knowledgeLines = knowledge
    .slice(0, 5)
    .map((item) => nodeLine(item, 350))
    .filter(Boolean);
  if (knowledgeLines.length) {
    optional.push(`Relevant knowledge:\n${knowledgeLines.join("\n")}`);
  }
  const targets = Array.isArray(brief?.code_targets) ? brief!.code_targets : [];
  const targetLabels = targets
    .slice(0, 10)
    .map((target) => clipTracked(object(target)?.label, 120))
    .filter(Boolean);
  if (targetLabels.length) {
    const extra = targets.length - targetLabels.length;
    if (extra > 0) bounded = true;
    optional.push(
      `Code targets: ${targetLabels.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`,
    );
  }
  const footer = task
    ? "Use the harness todo list only for local execution details; do not duplicate this durable Task there."
    : undefined;
  let used = lines.join("\n").length + (footer ? footer.length + 1 : 0);
  for (const section of optional) {
    if (used + section.length + 1 > maxChars) {
      bounded = true;
      break;
    }
    lines.push(section);
    used += section.length + 1;
  }
  if (bounded) {
    lines.push(
      "…[bounded work brief truncated — fetch full node content by uid if needed]",
    );
  }
  if (footer) lines.push(footer);
  const rendered = lines.join("\n");
  return rendered.length <= maxChars
    ? rendered
    : `${rendered.slice(0, maxChars - 40)}\n…[bounded work brief truncated]`;
}

// SessionStart may only RE-claim this agent's own durable work. The lease
// record names its owner even after the TTL lapsed (sessions are usually
// further apart than any lease lifetime), so cross-session rebind works on
// expired leases too. A task with no lease history for this agent belongs to
// the global backlog: the brief still surfaces it as context, but claiming it
// is a deliberate act the model takes when it starts the work. Unconditional
// auto-claim converted one bad selection into sticky owned_live_lease state
// that every subsequent session re-selected (live incident 2026-07-29: a Task
// extracted from an ingested document, priority "critical", was auto-claimed
// by each new session on two harnesses).
function isOwnPriorWork(
  brief: Record<string, unknown> | undefined,
  agentId: string,
  harness: HookHarness,
): boolean {
  const reason = string(brief?.selection_reason);
  if (reason === "owned_live_lease" || reason === "same_agent_session_rebind") {
    return true;
  }
  const owner = string(object(brief?.lease)?.lease_owner_agent_id);
  // Transition compatibility, REMOVE in 0.16: before the stable per-user
  // default, agent_id fell back to the harness name, so pre-upgrade leases
  // are owned by "claude-code"/"codex". Accept only THIS harness's legacy
  // name — accepting both would let any teammate's expired legacy lease
  // (org-wide, both harnesses) rebind here, a cross-user seizure. New claims
  // use the stable id, so this window drains itself.
  return owner === agentId || owner === harness;
}

function hasMindgraphServer(servers: unknown): boolean {
  if (!servers || typeof servers !== "object") return false;
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (name === "mindgraph") return true;
    const cfg =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : undefined;
    const text = [
      String(cfg?.command ?? ""),
      Array.isArray(cfg?.args) ? (cfg!.args as unknown[]).join(" ") : "",
      String(cfg?.url ?? ""),
    ].join(" ");
    if (text.includes("mindgraph-mcp")) return true;
  }
  return false;
}

function pathIsWithin(ancestor: string, descendant: string): boolean {
  const base = path.resolve(ancestor);
  const target = path.resolve(descendant);
  return target === base || target.startsWith(base + path.sep);
}

/** SessionStart diagnostic for the half-installed state observed live
 * 2026-08-12: hooks delivering briefs and Stop nudges into sessions that had
 * no registered MindGraph MCP server — weeks of ledgers with stopNudged set
 * and memoryWritten never true, because the requested actions had no tools
 * to run through. Checks only the layouts the installer writes (user scope
 * and cwd-project scope in ~/.claude.json, plus .mcp.json up the tree);
 * absence anywhere else is deliberately not guessed at, and exotic setups
 * can silence the check with MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK=1.
 * Never throws — a broken diagnostic must not cost the session its brief. */
function claudeMcpRegistrationNote(
  input: HookInput,
  options: CoreHookRuntimeOptions,
): string | undefined {
  if (options.harness !== "claude-code") return undefined;
  if (process.env.MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK === "1") return undefined;
  try {
    const configPath =
      options.claudeConfigPath || path.join(os.homedir(), ".claude.json");
    // No config file means a layout this check does not understand — stay
    // quiet rather than warn on unknowns.
    if (!fs.existsSync(configPath)) return undefined;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcpServers?: unknown;
      projects?: Record<string, { mcpServers?: unknown }>;
    };
    if (hasMindgraphServer(config.mcpServers)) return undefined;
    const cwd = path.resolve(input.cwd || ".");
    for (const [projectDir, project] of Object.entries(config.projects || {})) {
      // Local-scope registrations bind only to their own project directory.
      if (!pathIsWithin(projectDir, cwd)) continue;
      if (hasMindgraphServer(project?.mcpServers)) return undefined;
    }
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, ".mcp.json");
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          mcpServers?: unknown;
        };
        if (hasMindgraphServer(parsed.mcpServers)) return undefined;
      }
      if (dir === path.dirname(dir)) break;
    }
  } catch {
    return undefined;
  }
  return (
    "NOTE: no MindGraph MCP server appears to be registered for Claude Code, " +
    "so this brief's continuity actions (claim, checkpoint, capture) have no " +
    "mcp__mindgraph__* tools to run through and durable memory cannot be " +
    "written this session. Tell the user to run: " +
    "npx -y mindgraph-mcp@latest install-code — then start a new session."
  );
}

/** Why durable work cannot be selected for this session, or undefined when
 * the scope fully resolved. */
function scopeUnloadedReason(
  client: HookClient,
  scope: { uids: string[]; failures: string[] },
): string | undefined {
  if (!client.entity) {
    return "this connection cannot resolve repositories";
  }
  if (scope.failures.length > 0) {
    return `the repository scope could not be resolved (${scope.failures.join("; ")})`;
  }
  if (scope.uids.length === 0) {
    return "no repository is turned on here";
  }
  return undefined;
}

async function sessionStart(
  input: HookInput,
  client: HookClient,
  options: GatedHookRuntimeOptions,
): Promise<HookCoreOutput> {
  const agentId = resolveAgentId(options);
  const harnessLabel = options.harness === "claude-code" ? "Claude Code" : "Codex";
  const nowSeconds = (options.now || (() => Date.now() / 1000))();
  // The one bounded memory read runs beside the session and work requests.
  const indexRead = readIndex(input, client, options);
  const opened = object(
    await client.session({
      action: "open",
      label: `${harnessLabel} ${input.session_id}`,
      harness: options.harness,
      harness_session_id: input.session_id,
      model: input.model,
      agent_id: agentId,
    }),
  );
  const sessionUid = string(opened?.uid);
  // Persist session identity BEFORE the slow resume/claim round-trips: a
  // harness timeout later in this flow must not leave a session that
  // PreToolUse cannot tag and SessionEnd cannot close (observed live:
  // ledgers with real activity and sessionUid null — every capture in those
  // sessions was orphaned).
  // Subprocess work stays OUTSIDE the ledger lock — a harness kill landing
  // inside a long-held lock blanks every hook for the stale-lock window.
  const baselineWorktree = worktreeState(input.cwd);
  if (sessionUid) {
    withLedger(input.session_id, options, (ledger) => {
      ledger.sessionUid = sessionUid;
      ledger.baselineWorktree = baselineWorktree;
      return undefined;
    });
  }
  // Scope is exactly the repositories the user turned on: no discovery, so a
  // workspace file inside a repository can never widen it.
  const scope = await resolveRepositoryScope(input.cwd, client, agentId, {
    repositories: options.decision.repositories,
    cache: options.scopeCacheTenant
      ? { dir: runtimeDir(options), tenant: options.scopeCacheTenant }
      : undefined,
  });
  const scopeUids = scope.uids;
  // Durable work is selected only within a scope that fully resolved. An
  // empty scope would select from the whole organization, and a partial one
  // would silently miss the failed repositories' work.
  const unloaded = scopeUnloadedReason(client, scope);
  if (unloaded) {
    console.error(`mindgraph-hook: durable work not loaded (${unloaded})`);
  }
  let brief = unloaded
    ? undefined
    : object(
        await client.plan({
          action: "resume_work",
          session_uid: sessionUid,
          scope_uids: scopeUids,
          // Above several repositories one task is not the picture: ask for
          // the work ranked behind it too. An older server ignores the field.
          ...(scopeUids.length > 1 ? { limit: WORKSPACE_RESUME_LIMIT } : {}),
          agent_id: agentId,
        }),
      );
  const workspaceList = {
    task_scope_uids: brief?.task_scope_uids,
    other_eligible: brief?.other_eligible,
    eligible_total: brief?.eligible_total,
  };
  const task = object(brief?.task);
  const lease = object(brief?.lease);
  // Prior ledger state — on compact/resume re-entry (same harness session
  // id) this is evidence that THIS session already holds the surfaced lease.
  const prior = readLedger(input.session_id, options);
  const leaseExpiry = number(lease?.lease_expires_at);
  const leaseLive = leaseExpiry !== undefined && leaseExpiry > nowSeconds;
  const heldByThisSession =
    leaseLive &&
    prior.taskUid !== undefined &&
    prior.taskUid === string(task?.uid) &&
    prior.leaseEpoch === number(lease?.lease_epoch);
  let claimed: Record<string, unknown> | undefined;
  let claimFailed = false;
  if (
    sessionUid &&
    string(task?.uid) &&
    number(task?.version) &&
    isOwnPriorWork(brief, agentId, options.harness) &&
    // A LIVE lease belongs to whichever session claimed it — claiming from
    // here would fence that session out mid-work (the released server
    // rebinds same-owner live leases without allow_takeover). Re-claim live
    // leases only when this very session already holds them (re-entry).
    (!leaseLive || heldByThisSession)
  ) {
    try {
      claimed = object(
        await client.plan({
          action: "claim_task",
          task_uid: task!.uid,
          session_uid: sessionUid,
          expected_version: task!.version,
          idempotency_key: `session-start:${input.session_id}:${task!.uid}:${lease?.lease_epoch || 0}`,
          agent_id: agentId,
        }),
      );
    } catch {
      // A race is possible; a transient failure is indistinguishable here.
      // The ledger write below decides what survives.
      claimFailed = true;
    }
    if (claimed) {
      // The claim stands even if the enriched re-resume fails — conflating
      // the two orphaned a HELD lease (no heartbeats, no fills, SessionEnd
      // skip) while telling the model the claim failed.
      try {
        const reResumed = object(
          await client.plan({
            action: "resume_work",
            task_uid: task!.uid,
            session_uid: sessionUid,
            scope_uids: scopeUids,
            agent_id: agentId,
          }),
        );
        // A resume by task_uid lists nothing beside the task; keep the list
        // the scoped selection returned.
        if (reResumed) brief = { ...reResumed, ...workspaceList };
      } catch {
        // Pre-claim brief still renders; the claim is what matters.
      }
      if (brief) brief.claim = claimed;
    }
  }
  // A transiently-failed re-claim of a lease this session already tracks is
  // NOT a lost claim — the session still holds it server-side.
  const stillHeld = !claimed && claimFailed && heldByThisSession;
  const briefText = (maxChars: number) =>
    unloaded
      ? renderBrief(
          { status: "scope_unresolved" },
          {
            claimed: false,
            claimFailed: false,
            scopeNote: `Durable work was not loaded: ${unloaded}. Nothing outside the repositories turned on here was searched.`,
          },
          maxChars,
        )
      : renderBrief(
          brief || { status: "no_eligible_work" },
          {
            claimed: Boolean(claimed) || stillHeld,
            claimFailed: claimFailed && !stillHeld,
            repositoryNames: scope.names,
          },
          maxChars,
        );
  const registrationNote = claudeMcpRegistrationNote(input, options);
  if (registrationNote) {
    console.error(`mindgraph-hook: ${registrationNote}`);
  }
  // The note leads the work state: a model that reads the task first will
  // try to act on it with tools it does not have.
  const workText = (maxChars: number) =>
    registrationNote
      ? `${registrationNote}\n\n${briefText(maxChars - registrationNote.length - 2)}`
      : briefText(maxChars);
  // A compaction or clear starts a new context with its own budget; so does
  // each subagent.
  const newContext = input.source === "compact" || input.source === "clear";
  const epoch = (prior.contextEpoch ?? 0) + (newContext && prior.lastBriefHash !== undefined ? 1 : 0);
  const budgetKey = `${input.agent_id || "main"}#${epoch}`;
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const usedTokens = prior.budgets?.[budgetKey]?.used ?? 0;
  const index = await indexRead;
  let block: ReturnType<typeof renderSessionBlock>;
  try {
    block = renderSessionBlock({
      place: placeName(options.decision),
      afterCompaction: input.source === "compact",
      work: workText,
      index: index.state,
      budgetTokens,
      usedTokens,
    });
  } catch (error) {
    // Fail open to the work state alone.
    recordFailOpen(input.session_id, "SessionStart", `session block: ${(error as Error)?.message}`, options);
    const text = workText(workChars(budgetTokens, usedTokens));
    block = { text, titles: 0, leftOut: 0, tokens: Math.ceil(text.length / CHARS_PER_TOKEN), handles: [] };
  }
  const contextText = block.text;
  // The header counts tokens spent so far, so it is left out of the
  // unchanged-block check.
  const briefHash = crypto.createHash("sha256").update(contextText.slice(contextText.indexOf("\n") + 1)).digest("hex");
  const shouldInject = withLedger(input.session_id, options, (ledger) => {
    const changed = ledger.lastBriefHash !== briefHash;
    const reinjectCompact =
      options.reinjectUnchangedCompact && input.source === "compact";
    const inject = changed || reinjectCompact;
    ledger.contextEpoch = epoch;
    if (inject) {
      const budgets = (ledger.budgets ??= {});
      const entry = (budgets[budgetKey] ??= { limit: budgetTokens, used: 0 });
      entry.used += block.tokens;
      // Older contexts no longer matter.
      for (const key of Object.keys(budgets).slice(0, -8)) delete budgets[key];
      ledger.block = {
        titles: block.titles,
        leftOut: block.leftOut,
        tokens: block.tokens,
        budget: budgetTokens,
        handles: block.handles,
      };
    }
    ledger.sessionUid = sessionUid;
    ledger.baselineWorktree = baselineWorktree;
    // The ledger adopts work-targeting state ONLY when this session actually
    // holds the lease. Adopting a merely-surfaced task made the hook stamp
    // every capture with a task the agent never claimed, and copy a foreign
    // lease epoch as its own fencing token (both observed live). An
    // unclaimed brief is context, not bookkeeping.
    if (claimed) {
      const claimLease = object(brief?.claim) || object(brief?.lease);
      const selectedTask = object(brief?.task);
      ledger.taskUid = string(selectedTask?.uid);
      ledger.taskVersion =
        number(claimed.task_version) ??
        number(selectedTask?.version) ??
        undefined;
      ledger.leaseEpoch = number(claimLease?.lease_epoch);
      ledger.leaseExpiresAt = number(claimLease?.lease_expires_at);
      ledger.lastLeaseRenewalAt = nowSeconds;
      // Only a genuinely running execution is an "active iteration". The
      // brief's recent_executions are iteration-ordered with no status
      // filter; adopting a terminal one made SessionEnd try to abandon a
      // completed execution and Stop nudge sessions that did nothing.
      const running = [
        object(brief?.active_execution),
        ...(Array.isArray(brief?.recent_executions)
          ? brief!.recent_executions.map(object)
          : []),
      ].find(
        (execution) =>
          execution &&
          (string(object(execution.props)?.status) ?? string(execution.status)) ===
            "running",
      );
      ledger.executionUid = running ? string(running.uid) : undefined;
    } else if (
      claimFailed &&
      ledger.taskUid !== undefined &&
      ledger.taskUid === string(object(brief?.task)?.uid) &&
      ledger.lastLeaseRenewalAt !== undefined
    ) {
      // Transient re-claim failure on re-entry for a task this session
      // already tracks (compact/resume + maxRetries:0 network blip): keep
      // the live bookkeeping — wiping it orphans a lease the session still
      // holds server-side.
    } else if (unloaded) {
      // No selection ran, so nothing here says the session lost its work:
      // keep whatever it already holds.
    } else {
      ledger.taskUid = undefined;
      ledger.taskVersion = undefined;
      ledger.leaseEpoch = undefined;
      ledger.leaseExpiresAt = undefined;
      ledger.executionUid = undefined;
      ledger.lastLeaseRenewalAt = undefined;
    }
    ledger.lastBriefHash = briefHash;
    return inject;
  });
  if (index.state.state === "ok") {
    // A failed read keeps the table from the last successful start.
    try {
      const file = anchorTablePath(input.session_id, options);
      const table = anchorTable(index.root, index.state.selection.read.items);
      if (table) writePrivateJson(file, table);
      else fs.rmSync(file, { force: true });
    } catch (error) {
      recordFailOpen(input.session_id, "SessionStart", `anchor table: ${(error as Error)?.message}`, options);
    }
  }
  const notice =
    options.sessionNotice ?? process.env.MINDGRAPH_HOOK_SESSION_NOTICE === "on"
      ? sessionNotice(placeName(options.decision), index.state, block)
      : undefined;
  if (shouldInject) {
    return { kind: "context", context: contextText, ...(notice ? { notice } : {}) };
  }
  return notice ? { kind: "notice", message: notice } : NOOP;
}

/** The developer's one line at session start (shown only behind a switch:
 * whether Claude Code shows it is not yet confirmed). */
function sessionNotice(
  place: string,
  index: IndexState,
  block: { titles: number; tokens: number },
): string {
  if (index.state === "unavailable") {
    const why = {
      refused: "MindGraph refused the API key",
      timeout: "MindGraph did not respond",
      error: "MindGraph could not read this memory",
    }[index.reason];
    return `${why}; this session has no MindGraph memory titles. ${
      index.reason === "refused" ? "Fix: npx mindgraph-mcp install-code" : "Details: npx mindgraph-mcp hooks stats"
    }`;
  }
  if (index.state === "ok" && index.selection.read.read === 0) {
    return "MindGraph is on here; nothing stored yet.";
  }
  return `MindGraph: work state and ${block.titles} memory title${block.titles === 1 ? "" : "s"} for ${place} (${block.tokens} tokens). Details: npx mindgraph-mcp hooks stats`;
}

/**
 * The session block's one bounded `memory/v1` `list` read, in the consented
 * root's own space only. Never throws: a failure is counted and becomes the
 * block's one-line unavailable form.
 */
async function readIndex(
  input: HookInput,
  client: HookClient,
  options: GatedHookRuntimeOptions,
): Promise<{ state: IndexState; root: string }> {
  const decision = options.decision;
  const root = decision.repo?.root ?? decision.root;
  const space = decision.space_uid;
  if (!space) return { state: { state: "no_space" }, root };
  let read: Awaited<ReturnType<typeof readSpace>>;
  const deadline = options.memoryListTimeoutMs ?? 3_000;
  const started = Date.now();
  try {
    const list = memoryListOf(client);
    if (!list) throw new Error("this connection cannot read memory");
    // One `list` request (invariant 4): no recency windows at SessionStart.
    // A larger space is reported as a sample, with action=index for the newest.
    read = await withDeadline(readSpace(list, space, { windows: false }), deadline);
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    const reason =
      (error as Error)?.message === "deadline"
        ? "timeout"
        : status === 401 || status === 403
          ? "refused"
          : "error";
    recordFailOpen(input.session_id, "SessionStart", `memory read: ${reason}`, options);
    return { state: { state: "unavailable", reason }, root };
  }
  // The change check spends what is left of the read's deadline, at most 1 s;
  // a failure marks nothing and keeps the titles.
  const gitMs = Math.max(250, Math.min(1_000, deadline - (Date.now() - started)));
  const selection = selectIndex(root, read, localNotes({ root, space_uid: space }), nodeGit(process.env, gitMs), (message) =>
    recordFailOpen(input.session_id, "SessionStart", `code change check: ${message}`, options),
  );
  return { state: { state: "ok", selection }, root };
}

async function preTool(
  input: HookInput,
  options: GatedHookRuntimeOptions,
): Promise<HookCoreOutput> {
  const original = { ...(input.tool_input || {}) };
  const ledger = readLedger(input.session_id, options);
  // The repository comes from the consent decision: the one the user turned
  // on that contains this directory. At a workspace root there is none.
  const repoId = options.decision.repo?.repo_id;
  const updatedInput: Record<string, unknown> = {
    ...original,
    invocation_context: invocationContext(input, options, repoId),
  };
  // The hook owns SESSION identity (adapter-authoritative — always replaced),
  // but work-targeting fields belong to the model: the ledger only FILLS them
  // when absent. Overwriting task_uid/expected_version redirects mutations to
  // the cached task with a stale version — the model can never address a
  // second task, and the server's 409 teaching loop is defeated (found live
  // in the L5 dogfood: every block_task on a new task 409'd against the old
  // one). Ledger state is bookkeeping, never authority.
  //
  // The remaining fills are additionally gated on the call actually
  // targeting the ledger's task: pairing task B (model-supplied) with task
  // A's version/epoch/execution produced guaranteed 409s and cross-task
  // execution attribution (both observed live in runtime ledgers).
  if (ledger.sessionUid) updatedInput.session_uid = ledger.sessionUid;
  if (ledger.taskUid && updatedInput.task_uid === undefined) {
    updatedInput.task_uid = ledger.taskUid;
  }
  // Gate on the MODEL's own targeting (pre-fill), not the value the hook
  // just injected — comparing post-fill made the gate self-satisfying, so
  // non-task actions (update_status on a PlanStep) received the TASK's
  // expected_version and 409'd against the wrong node. Fencing fills apply
  // only to actions the server actually fences by task.
  const modelTask = string(original.task_uid);
  const targetsLedgerTask =
    ledger.taskUid !== undefined &&
    (modelTask === undefined || modelTask === ledger.taskUid);
  const isCapture = Boolean(input.tool_name?.includes("mindgraph_capture"));
  const fencedAction =
    Boolean(input.tool_name?.includes("mindgraph_plan")) &&
    FENCED_PLAN_ACTIONS.has(string(original.action) || "");
  if (ledger.taskUid && isCapture && updatedInput.work_uid === undefined) {
    updatedInput.work_uid = ledger.taskUid;
  }
  if (
    targetsLedgerTask &&
    (fencedAction || isCapture) &&
    ledger.executionUid &&
    updatedInput.execution_uid === undefined
  ) {
    updatedInput.execution_uid = ledger.executionUid;
  }
  if (
    targetsLedgerTask &&
    fencedAction &&
    ledger.leaseEpoch !== undefined &&
    updatedInput.lease_epoch === undefined
  ) {
    updatedInput.lease_epoch = ledger.leaseEpoch;
  }
  if (
    targetsLedgerTask &&
    fencedAction &&
    ledger.taskVersion !== undefined &&
    updatedInput.expected_version === undefined
  ) {
    updatedInput.expected_version = ledger.taskVersion;
  }
  if (options.harness === "claude-code") {
    // H1: Claude Code's auto mode refuses a call whose input a hook changed,
    // so the fields travel beside the call instead of inside it. The server
    // resolves them by tool name + the model's own arguments.
    const fills = Object.fromEntries(
      Object.entries(updatedInput).filter(
        ([key, value]) => key === "invocation_context" || original[key] !== value,
      ),
    );
    recordPendingCall(
      input.tool_name || "",
      original,
      input.session_id,
      fills,
      { runtimeDir: options.runtimeDir, now: options.now },
    );
  }
  return { kind: "rewrite", updatedInput };
}

// Plan actions the server fences by task version/lease — the only calls
// where injecting expected_version/lease_epoch is meaningful.
const FENCED_PLAN_ACTIONS = new Set([
  "claim_task",
  "heartbeat",
  "start_iteration",
  "checkpoint_iteration",
  "block_task",
  "complete_task",
  "abandon_iteration",
]);

async function postTool(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
): Promise<HookCoreOutput> {
  const name = input.tool_name || "";
  const args = input.tool_input || {};
  const action = string(args.action);
  const payload = responsePayload(input.tool_response);
  const nowSeconds = (options.now || (() => Date.now() / 1000))();
  let renewal:
    | {
        kind: "heartbeat" | "reclaim";
        taskUid: string;
        sessionUid: string;
        taskVersion: number;
        leaseEpoch: number;
      }
    | undefined;
  withLedger(input.session_id, options, (ledger) => {
    ledger.materialToolCalls += 1;
    // Shell commands are deliberately NOT counted: Bash tool input has no
    // MindGraph `action` field, so the old `action !== "read"` guard counted
    // every `git status` as a mutation (and Codex's shell tool, under a
    // different name, counted nothing). Worktree drift in stop() is the
    // signal that actually detects shell-driven changes on both harnesses.
    if (["Edit", "Write", "NotebookEdit", "apply_patch"].includes(name)) {
      ledger.mutatingOperations += 1;
    }
    // Only reflective writes satisfy the Stop nudge's "capture one durable
    // lesson/decision/risk" — creating an Entity or Source is not memory of
    // the work. The credited set mirrors the nudge text exactly: lessons/
    // journals/skills (capture), resolved decisions (commit), risk
    // assessments (plan).
    if (!payload?.error) {
      if (
        (name.includes("mindgraph_capture") &&
          (["lesson", "journal", "skill"].includes(action || "") ||
            (["observation", "entity"].includes(action || "") &&
              (Array.isArray(args.code_refs) ||
                typeof args.supersedes_uid === "string")))) ||
        (name.includes("mindgraph_commit") && action === "resolve_decision") ||
        (name.includes("mindgraph_plan") && action === "assess_risk")
      ) {
        ledger.memoryWritten = true;
      }
    }
    // An opened item's text starts with its handle; an error is JSON.
    const handle = string(args.handle);
    if (name.includes("mindgraph_memory") && action === "open" && handle && firstText(input.tool_response).startsWith("[")) {
      const opened = (ledger.handlesOpened ??= []);
      if (!opened.includes(handle) && opened.length < 200) opened.push(handle);
    }
    if (name.includes("mindgraph_plan")) {
      const targetTask = string(args.task_uid) || ledger.taskUid;
      const aboutLedgerTask =
        targetTask !== undefined && targetTask === ledger.taskUid;
      if (!payload?.error) {
        if (action === "claim_task" && targetTask) {
          // A successful claim is the model deliberately (re)binding work —
          // the ledger follows the model, including onto a different task.
          // On a rebind the OLD task's fence/execution must not survive as
          // fallbacks: pairing task B with task A's state was the exact
          // cross-task attribution class this audit closed.
          const rebindToOther = targetTask !== ledger.taskUid;
          ledger.taskUid = targetTask;
          ledger.taskVersion =
            number(payload?.task_version) ??
            number(payload?.version) ??
            (rebindToOther ? undefined : ledger.taskVersion);
          ledger.leaseEpoch =
            number(payload?.lease_epoch) ??
            (rebindToOther ? undefined : ledger.leaseEpoch);
          ledger.leaseExpiresAt =
            number(payload?.lease_expires_at) ??
            (rebindToOther ? undefined : ledger.leaseExpiresAt);
          if (rebindToOther) ledger.executionUid = undefined;
          ledger.lastLeaseRenewalAt = nowSeconds;
        }
        if (action === "start_iteration") {
          ledger.executionUid =
            string(payload?.execution_uid) || ledger.executionUid;
        }
        if (
          ["checkpoint_iteration", "block_task", "complete_task", "abandon_iteration"].includes(
            action || "",
          )
        ) {
          ledger.iterationCheckpointed = true;
          if (action !== "block_task") ledger.executionUid = undefined;
        }
        if (action === "complete_task" && aboutLedgerTask) {
          // The server released the lease with the completion. A retained
          // task_uid turned every later implicit resume_work into an
          // explicit resume of the COMPLETED task (permanent
          // no_eligible_work) and bypassed the extraction-provenance guard.
          ledger.taskUid = undefined;
          ledger.taskVersion = undefined;
          ledger.leaseEpoch = undefined;
          ledger.leaseExpiresAt = undefined;
          ledger.lastLeaseRenewalAt = undefined;
        } else if (aboutLedgerTask && action !== "claim_task") {
          // `task_version` always refers to the task; a bare `version` may
          // be a Plan/PlanStep's own version (update_status returns the
          // step) — accept it only when the response is the task itself.
          ledger.taskVersion =
            number(payload?.task_version) ??
            (string(payload?.uid) === ledger.taskUid
              ? number(payload?.version)
              : undefined) ??
            ledger.taskVersion;
          ledger.leaseEpoch = number(payload?.lease_epoch) ?? ledger.leaseEpoch;
          if (number(payload?.lease_expires_at) !== undefined) {
            ledger.leaseExpiresAt = number(payload?.lease_expires_at);
            // A fresh expiry (model-issued heartbeat/renewal) counts as a
            // renewal — otherwise the hook fires a redundant heartbeat
            // every 3 minutes on top of the model's own cadence.
            ledger.lastLeaseRenewalAt = nowSeconds;
          }
        }
      } else if (aboutLedgerTask) {
        // Structured conflict payloads (servers newer than 1.11.2) carry the
        // fencing state; adopting it lets the next call succeed instead of
        // replaying the stale fence forever.
        adoptConflictFence(ledger, payload);
      }
    }
    if (
      ledger.taskUid &&
      ledger.sessionUid &&
      ledger.taskVersion !== undefined &&
      ledger.leaseEpoch !== undefined &&
      ledger.leaseExpiresAt !== undefined &&
      // Only ledgers whose lease state was written by a claim THIS code made
      // may renew: 0.14.9 ledgers carry adopted-but-never-claimed fence
      // state, and a lapse-reclaim from one would auto-seize a task this
      // session never owned — the incident class all of this exists to kill.
      ledger.lastLeaseRenewalAt !== undefined
    ) {
      const expiresIn = ledger.leaseExpiresAt - nowSeconds;
      const sinceRenewal = nowSeconds - ledger.lastLeaseRenewalAt;
      // Renew on EITHER signal: imminent expiry per the server clock, or
      // elapsed local time since the last successful renewal. The second
      // covers client clock skew (a lagging clock made the expiry check
      // never fire) and keeps a lease alive across bursts of tool calls.
      if (expiresIn <= 0) {
        renewal = {
          kind: "reclaim",
          taskUid: ledger.taskUid,
          sessionUid: ledger.sessionUid,
          taskVersion: ledger.taskVersion,
          leaseEpoch: ledger.leaseEpoch,
        };
      } else if (expiresIn <= 60 || sinceRenewal >= 180) {
        renewal = {
          kind: "heartbeat",
          taskUid: ledger.taskUid,
          sessionUid: ledger.sessionUid,
          taskVersion: ledger.taskVersion,
          leaseEpoch: ledger.leaseEpoch,
        };
      }
    }
    return undefined;
  });
  if (renewal) {
    const active = renewal;
    try {
      const response = object(
        active.kind === "reclaim"
          ? // The lease already lapsed: a heartbeat can only 409. Re-claim
            // rebinds the same owner's expired lease (bumping the epoch) so
            // durable tracking survives a >TTL quiet stretch mid-session.
            await client.plan({
              action: "claim_task",
              task_uid: active.taskUid,
              session_uid: active.sessionUid,
              expected_version: active.taskVersion,
              idempotency_key: `hook-reclaim:${input.session_id}:${active.taskUid}:${active.leaseEpoch}:${Math.floor(nowSeconds / 60)}`,
              agent_id: resolveAgentId(options),
            })
          : await client.plan({
              action: "heartbeat",
              task_uid: active.taskUid,
              session_uid: active.sessionUid,
              expected_version: active.taskVersion,
              lease_epoch: active.leaseEpoch,
              idempotency_key: `hook-heartbeat:${input.session_id}:${active.taskUid}:${active.leaseEpoch}:${active.taskVersion}:${Math.floor(nowSeconds / 60)}`,
              agent_id: resolveAgentId(options),
            }),
      );
      withLedger(input.session_id, options, (ledger) => {
        // The model may have rebound (or completed) between scheduling this
        // renewal and its completion — a parallel tool batch runs hooks
        // concurrently. Stamping task A's fence onto a ledger now tracking
        // task B is the R20 bug on the async path.
        if (ledger.taskUid !== active.taskUid) return undefined;
        if (payloadIsError(response)) {
          // A 200-shaped error can still carry the current fence — adopt it
          // exactly like the model-call path, or every minute-bucketed
          // renewal replays the same stale epoch until the model itself
          // makes a plan call.
          adoptConflictFence(ledger, response);
          return undefined;
        }
        ledger.taskVersion =
          number(response?.task_version) ?? ledger.taskVersion;
        ledger.leaseEpoch = number(response?.lease_epoch) ?? ledger.leaseEpoch;
        ledger.leaseExpiresAt =
          number(response?.lease_expires_at) ?? ledger.leaseExpiresAt;
        ledger.lastLeaseRenewalAt = nowSeconds;
        return undefined;
      });
    } catch (cause) {
      // Renewal is advisory; authoritative fencing remains server-side. But
      // a thrown 409 carries the current fence in its typed body — without
      // adopting it here, the hook replays the stale epoch on every renewal
      // while the lease silently lapses, until the model happens to make a
      // plan call of its own (whose conflict payload IS adopted above).
      const conflict = conflictState(cause);
      if (Object.keys(conflict).length > 0) {
        withLedger(input.session_id, options, (ledger) => {
          if (ledger.taskUid !== active.taskUid) return undefined;
          adoptConflictFence(ledger, conflict);
          return undefined;
        });
      }
    }
  }
  return NOOP;
}

/** Adopt the server's current fencing state from a structured conflict
 * payload (top-level `current_*` keys — either a 409 body lifted by
 * conflictState() or a 200-shaped error payload). Shared by the model-call
 * and hook-renewal paths so both recover identically from a stale fence. */
function adoptConflictFence(
  ledger: RuntimeLedger,
  payload: Record<string, unknown> | undefined,
): void {
  ledger.taskVersion = number(payload?.current_version) ?? ledger.taskVersion;
  ledger.leaseEpoch = number(payload?.current_epoch) ?? ledger.leaseEpoch;
  ledger.leaseExpiresAt =
    number(payload?.lease_expires_at) ?? ledger.leaseExpiresAt;
}

function payloadIsError(payload: Record<string, unknown> | undefined): boolean {
  return Boolean(payload && payload.error);
}

function stop(
  input: HookInput,
  options: CoreHookRuntimeOptions,
): HookCoreOutput {
  if (input.stop_hook_active) return NOOP;
  return withLedger(input.session_id, options, (ledger) => {
    const changed =
      ledger.mutatingOperations >= 2 ||
      (ledger.baselineWorktree !== "unknown" &&
        worktreeState(input.cwd) !== ledger.baselineWorktree);
    const substantial = Boolean(ledger.executionUid) || changed;
    if (
      !substantial ||
      ledger.iterationCheckpointed ||
      ledger.memoryWritten ||
      ledger.stopNudged
    ) {
      return NOOP;
    }
    ledger.stopNudged = true;
    return {
      kind: "block",
      reason:
        "Substantial work is still uncheckpointed. Checkpoint the active iteration, capture one durable lesson/decision/risk, or explicitly state that nothing durable changed. If a local harness task should become authoritative outside this list, promote it once with a stable idempotency key; otherwise do not copy it.",
    };
  });
}

async function sessionEnd(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
): Promise<HookCoreOutput> {
  const harnessLabel = options.harness === "claude-code" ? "Claude Code" : "Codex";
  // The anchor table lives only as long as the session.
  try {
    fs.rmSync(anchorTablePath(input.session_id, options), { force: true });
  } catch {
    // Swept at a later SessionStart.
  }
  // Capture first, while the Session is still open (Claude only: Codex caps
  // SessionEnd at 3s, which the abandon/close calls already need).
  if (options.harness === "claude-code") {
    await captureTranscript(input, client, options);
  }
  const ledger = readLedger(input.session_id, options);
  if (
    ledger.executionUid &&
    ledger.taskUid &&
    ledger.sessionUid &&
    ledger.taskVersion !== undefined &&
    ledger.leaseEpoch !== undefined
  ) {
    try {
      await client.plan({
        action: "abandon_iteration",
        task_uid: ledger.taskUid,
        execution_uid: ledger.executionUid,
        session_uid: ledger.sessionUid,
        expected_version: ledger.taskVersion,
        lease_epoch: ledger.leaseEpoch,
        release_lease: true,
        summary: `${harnessLabel} SessionEnd: ${input.reason || "interrupted"}`,
        idempotency_key: `session-end:${input.session_id}:${ledger.executionUid}`,
        agent_id: resolveAgentId(options),
      });
    } catch {
      // A newer Session or stale fence wins; cleanup never overwrites it.
    }
  }
  // Codex caps SessionEnd hooks at 3 seconds (platform-side; the configured
  // timeout cannot raise it), which fits at most ONE cloud call. The
  // abandon above releases the lease — the part that blocks other sessions —
  // so when it ran, skip the close: session open is an identity-upsert, so a
  // stale-open Session node is benign.
  const abandonRan = Boolean(
    ledger.executionUid &&
      ledger.taskUid &&
      ledger.sessionUid &&
      ledger.taskVersion !== undefined &&
      ledger.leaseEpoch !== undefined,
  );
  if (ledger.sessionUid && (options.harness !== "codex" || !abandonRan)) {
    try {
      await client.session({
        action: "close",
        session_uid: ledger.sessionUid,
        agent_id: resolveAgentId(options),
      });
    } catch {
      // SessionEnd is best-effort cleanup.
    }
  }
  return NOOP;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** UserPromptSubmit: bounded topic recall for the prompt (Hermes
 * `prefetch` parity). Fails OPEN — any error or timeout injects nothing and
 * never blocks the prompt. An unchanged block is not re-injected. */
async function promptRecall(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
): Promise<HookCoreOutput> {
  if (
    options.promptRecall === false ||
    process.env.MINDGRAPH_HOOK_PROMPT_RECALL === "off" ||
    !client.retrieveContext
  ) {
    return NOOP;
  }
  const query = promptRecallQuery(input.prompt);
  if (!query) return NOOP;
  try {
    const response = await withDeadline(
      client.retrieveContext(promptRecallRequest(query)),
      options.promptRecallTimeoutMs ?? 4_000,
    );
    const recalled = renderPromptRecall(response, query);
    if (!recalled) return NOOP;
    const hash = crypto.createHash("sha256").update(recalled).digest("hex");
    // Recall spends the same per-context budget as the session block: lines
    // that do not fit are cut, and the block says so.
    const block = withLedger(input.session_id, options, (ledger) => {
      if (ledger.lastRecallHash === hash) return undefined;
      ledger.lastRecallHash = hash;
      const limit = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
      const entry = ((ledger.budgets ??= {})[`${input.agent_id || "main"}#${ledger.contextEpoch ?? 0}`] ??= { limit, used: 0 });
      const room = Math.max(0, entry.limit - entry.used) * CHARS_PER_TOKEN;
      const lines = recalled.split("\n");
      const kept = [lines[0]];
      let cut = 0;
      for (const line of lines.slice(1)) {
        if (cut || [...kept, line].join("\n").length + 120 > room) cut++;
        else kept.push(line);
      }
      // When no recalled line fits, the omission is stated once per context;
      // after that the prompt gets nothing and the budget is not charged.
      if (kept.length === 1) {
        if (entry.spentNoted) return undefined;
        entry.spentNoted = true;
      }
      if (cut) kept.push(`${cut} recalled line${cut === 1 ? "" : "s"} left out: this context's ${limit.toLocaleString("en-US")}-token memory budget is spent.`);
      const text = kept.join("\n");
      entry.used += Math.ceil(text.length / CHARS_PER_TOKEN);
      return text;
    });
    return block ? { kind: "context", context: block, event: "UserPromptSubmit" } : NOOP;
  } catch (error) {
    recordFailOpen(input.session_id, "UserPromptSubmit", `prompt recall: ${(error as Error)?.message}`, options);
    return NOOP;
  }
}

/** Ingest the user/assistant text turns appended since the last capture as
 * a session transcript (Hermes `on_pre_compress`/`on_session_end` parity).
 * Opt-in; tool calls and tool output are never sent; never throws. */
async function captureTranscript(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
): Promise<void> {
  // Only the user's stored choice turns capture on. The hook environment can
  // come from a project's settings file, so it may only turn capture off.
  const enabled =
    options.capture === true && process.env.MINDGRAPH_HOOK_CAPTURE !== "off";
  if (!enabled || !client.ingestSession || !input.transcript_path) return;
  try {
    const agentId = resolveAgentId(options);
    const ledger = readLedger(input.session_id, options);
    let sessionUid = ledger.sessionUid;
    const prepared = buildCaptureRequest(
      input.transcript_path,
      input.session_id,
      ledger.captureOffset ?? 0,
      { sessionUid, agentId },
    );
    if (prepared.body && !sessionUid) {
      // Session open is an identity upsert — same identifiers SessionStart uses.
      const opened = object(
        await client.session({
          action: "open",
          label: `Claude Code ${input.session_id}`,
          harness: options.harness,
          harness_session_id: input.session_id,
          model: input.model,
          agent_id: agentId,
        }),
      );
      sessionUid = string(opened?.uid);
      if (sessionUid) prepared.body.session_uid = sessionUid;
    }
    if (prepared.body) await client.ingestSession(prepared.body);
    withLedger(input.session_id, options, (current) => {
      if (sessionUid) current.sessionUid ??= sessionUid;
      // Only move forward: a concurrent capture may already be past us.
      current.captureOffset = Math.max(current.captureOffset ?? 0, prepared.nextOffset);
      return undefined;
    });
  } catch (error) {
    // Offset unchanged, so the same turns are retried at the next boundary.
    recordFailOpen(input.session_id, input.hook_event_name, "transcript capture", options);
    console.error(
      `mindgraph-hook: transcript capture failed (${(error as Error)?.message || "unknown error"})`,
    );
  }
}

const TURN_ON_COMMAND = "npx -y mindgraph-mcp@latest on";

/**
 * What a hook returns where MindGraph is not on: nothing, except for a short
 * notice at SessionStart in two cases. The text is fixed and local; producing
 * it makes no request and writes no file.
 */
export function offOutput(
  input: Pick<HookInput, "hook_event_name">,
  decision: OffDecision,
): HookCoreOutput {
  if (input.hook_event_name !== "SessionStart") return NOOP;
  if (
    decision.state === "needs_reapproval" &&
    (decision.reason === "workspace_changed" || decision.reason === "workspace_missing") &&
    decision.root
  ) {
    return {
      kind: "notice",
      message: `MindGraph is paused in ${decision.root}: .mindgraph/workspace.json changed since you turned it on. Review: ${TURN_ON_COMMAND} ${decision.root}`,
    };
  }
  // Until the user has run on or off once, sessions in a repository or a
  // workspace say why MindGraph went quiet after the upgrade.
  if (
    decision.reason === "not_consented" &&
    !decision.storeAcknowledged &&
    decision.directory &&
    (decision.inRepository === true ||
      holdsWorkspaceFile(decision.directory))
  ) {
    return {
      kind: "notice",
      message: `MindGraph hooks now run only where you turn them on; nothing was sent from this session. Turn on here: ${TURN_ON_COMMAND}`,
    };
  }
  return NOOP;
}

function holdsWorkspaceFile(directory: string): boolean {
  try {
    return fs.statSync(path.join(directory, ".mindgraph", "workspace.json")).isFile();
  } catch {
    return false;
  }
}

function decide(
  input: HookInput,
  consent: HookRuntimeOptions["consent"],
): ConsentDecision {
  const directory = eventDirectory(input);
  if (consent === undefined) return consentFor(directory);
  return typeof consent === "function" ? consent(directory) : consent;
}

export async function runHookCore(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
): Promise<HookCoreOutput> {
  // The gate comes first: outside a consented root a hook makes no request,
  // sweeps nothing and writes no ledger.
  const decision = decide(input, options.consent);
  if (decision.state !== "on") return offOutput(input, decision);
  const started = performance.now();
  const output = await dispatchHook(input, client, { ...options, decision });
  // A PreToolUse for another server's tool does no work and keeps no record.
  if (
    input.session_id &&
    !(input.hook_event_name === "PreToolUse" && output.kind === "noop")
  ) {
    try {
      const elapsed = Math.round(performance.now() - started);
      const injected = output.kind === "context" ? output.context.length : 0;
      withLedger(input.session_id, options, (ledger) => {
        const stats = (ledger.hookStats ??= {});
        const entry = (stats[input.hook_event_name] ??= {
          count: 0,
          totalMs: 0,
          maxMs: 0,
          injectedChars: 0,
        });
        entry.count += 1;
        entry.totalMs += elapsed;
        entry.maxMs = Math.max(entry.maxMs, elapsed);
        entry.injectedChars += injected;
        // In-process time on the injection path, kept for its percentiles.
        const samples = (entry.samplesMs ??= []);
        samples.push(elapsed);
        if (samples.length > SAMPLES_KEPT) samples.splice(0, samples.length - SAMPLES_KEPT);
        return undefined;
      });
    } catch {
      // Bookkeeping never changes what a hook returns.
    }
  }
  return output;
}

async function dispatchHook(
  input: HookInput,
  client: HookClient,
  options: GatedHookRuntimeOptions,
): Promise<HookCoreOutput> {
  switch (input.hook_event_name) {
    case "SessionStart":
      sweepStaleTemporaries(runtimeDir(options));
      return sessionStart(input, client, options);
    case "PreToolUse":
      if (!input.tool_name?.startsWith("mcp__mindgraph__")) return NOOP;
      return preTool(input, options);
    case "PostToolUse":
      return postTool(input, client, options);
    case "TaskCreated":
      withLedger(input.session_id, options, (ledger) => {
        ledger.nativeTasksCreated += 1;
        return undefined;
      });
      return NOOP;
    case "TaskCompleted":
      withLedger(input.session_id, options, (ledger) => {
        ledger.nativeTasksTerminal += 1;
        return undefined;
      });
      return NOOP;
    case "Stop":
      return stop(input, options);
    case "SessionEnd":
      return sessionEnd(input, client, options);
    case "UserPromptSubmit":
      return promptRecall(input, client, options);
    case "PreCompact":
      await captureTranscript(input, client, options);
      return NOOP;
    default:
      return NOOP;
  }
}

export async function readHookInput(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook input is not a JSON object");
  }
  return parsed as HookInput;
}

/** What transcript capture WOULD send for a Claude Code session right now,
 * starting at the stored capture offset. Reads only; sends nothing. */
export function previewCapture(
  transcriptPath: string,
  sessionId: string,
  options: HookRuntimeOptions = {},
): ReturnType<typeof buildCaptureRequest> & { offset: number } {
  let ledger: Partial<RuntimeLedger> = {};
  try {
    ledger = JSON.parse(
      fs.readFileSync(
        ledgerPath(sessionId, { ...options, harness: "claude-code" } as CoreHookRuntimeOptions),
        "utf8",
      ),
    ) as Partial<RuntimeLedger>;
  } catch {
    // No ledger: nothing captured yet.
  }
  const offset = ledger.captureOffset ?? 0;
  return {
    ...buildCaptureRequest(transcriptPath, sessionId, offset, {
      sessionUid: ledger.sessionUid,
      agentId: options.agentId || process.env.MINDGRAPH_AGENT_ID || stableAgentId(),
    }),
    offset,
  };
}

export interface HookSessionStats {
  harness: string;
  sessionId: string;
  updatedAt: number;
  events: Record<string, HookEventStats>;
  block?: RuntimeLedger["block"];
  handlesOpened: string[];
  failOpen: number;
  lastFailOpen?: { event: string; reason: string; at: number };
}

/** `hooks stats`: per-event calls and in-process times (with p99), what
 * was injected, the last session block, handles opened and fail-opens. */
export function formatHookStats(stats: HookSessionStats): string {
  const rows = Object.entries(stats.events).sort(([a], [b]) => a.localeCompare(b));
  const injected = rows.reduce((sum, [, row]) => sum + row.injectedChars, 0);
  const pad = (value: unknown, n: number) => String(value).padStart(n);
  const out = [
    `Session ${stats.sessionId} (${stats.harness}), last active ${new Date(stats.updatedAt).toISOString()}`,
    "event               calls   avg ms   p99 ms   max ms   injected chars",
  ];
  for (const [event, row] of rows) {
    const samples = [...(row.samplesMs ?? [])].sort((a, b) => a - b);
    const p99 = samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.99) - 1)] : "-";
    out.push(
      `${event.padEnd(18)} ${pad(row.count, 6)} ${pad(Math.round(row.totalMs / Math.max(row.count, 1)), 8)} ${pad(p99, 8)} ${pad(row.maxMs, 8)} ${pad(row.injectedChars, 16)}`,
    );
  }
  out.push(
    `Injected into context: ${injected} characters (about ${Math.round(injected / 4)} tokens). Times are measured inside the hook and exclude process start; p99 is over the last ${SAMPLES_KEPT} calls of each event.`,
  );
  if (stats.block) {
    out.push(
      `Session block: ${stats.block.titles} memory titles shown, ${stats.block.leftOut} left out; ${stats.block.tokens} of ${stats.block.budget} tokens.`,
    );
  }
  const opened = stats.handlesOpened;
  const shown = stats.block?.handles.length ?? 0;
  out.push(
    `Handles opened: ${opened.length}${shown ? ` (${shown} shown at the last session start)` : ""}${opened.length ? `: ${opened.join(", ")}` : ""}`,
    `Failed open: ${stats.failOpen}${stats.lastFailOpen ? ` (last: ${stats.lastFailOpen.event}, ${stats.lastFailOpen.reason}, ${new Date(stats.lastFailOpen.at).toISOString()})` : ""}. A hook that fails open injects nothing extra and never blocks the session.`,
  );
  return out.join("\n");
}

/** Hook cost for one session, or for the most recently active session when
 * no id is given. Reads the local runtime ledger only. */
export function readHookStats(
  sessionId?: string,
  options: HookRuntimeOptions = {},
): HookSessionStats | undefined {
  const dir = runtimeDir(options);
  let best: HookSessionStats | undefined;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const ledger = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Partial<RuntimeLedger>;
      if (!ledger.harnessSessionId || !ledger.hookStats) continue;
      if (sessionId && ledger.harnessSessionId !== sessionId) continue;
      const updatedAt = Number(ledger.updatedAt) || 0;
      if (!best || updatedAt > best.updatedAt) {
        best = {
          harness: String(ledger.harness ?? "unknown"),
          sessionId: ledger.harnessSessionId,
          updatedAt,
          events: ledger.hookStats,
          block: ledger.block,
          handlesOpened: ledger.handlesOpened ?? [],
          failOpen: ledger.failOpen?.count ?? 0,
          lastFailOpen: ledger.failOpen?.last,
        };
      }
    } catch {
      // Unreadable disposable bookkeeping is skipped.
    }
  }
  return best;
}
