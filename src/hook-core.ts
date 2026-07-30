import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  CodegraphAdapter,
  repositoryIdentityKey,
} from "./codegraph.js";
import { stableAgentId } from "./hook-env.js";

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
}

export interface HookClient {
  session(request: Record<string, unknown>): Promise<unknown>;
  plan(request: Record<string, unknown>): Promise<unknown>;
  entity?(request: Record<string, unknown>): Promise<unknown>;
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
  /** Per-cwd repository identity cache: resolving every configured workspace
   * repo on EVERY PreToolUse blew the hook's time budget on large overlays. */
  repoContextCwd?: string;
  repoContextRepoId?: string;
  repoContextAt?: number;
  updatedAt: number;
}

export interface HookRuntimeOptions {
  runtimeDir?: string;
  agentId?: string;
  now?: () => number;
  workspaceFile?: string;
}

interface CoreHookRuntimeOptions extends HookRuntimeOptions {
  harness: HookHarness;
  reinjectUnchangedCompact: boolean;
}

export type HookCoreOutput =
  | { kind: "noop" }
  | { kind: "context"; context: string }
  | { kind: "rewrite"; updatedInput: Record<string, unknown> }
  | { kind: "block"; reason: string };

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

function ledgerPath(sessionId: string, options: HookRuntimeOptions): string {
  const harness =
    "harness" in options ? (options as CoreHookRuntimeOptions).harness : "claude-code";
  const key = crypto
    .createHash("sha256")
    .update(`${harness}\0${sessionId}`)
    .digest("hex");
  return path.join(runtimeDir(options), `${key}.json`);
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
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      lockFd = fs.openSync(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock);
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
      lines.push(
        `Active execution: [${string(active.uid) || "?"}] iteration ${number(object(active.props)?.iteration) ?? "?"} still running from a prior session — checkpoint or abandon it.`,
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
    if (used + section.length + 1 > BRIEF_CHAR_BUDGET) {
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
  return rendered.length <= BRIEF_CHAR_BUDGET
    ? rendered
    : `${rendered.slice(0, BRIEF_CHAR_BUDGET - 40)}\n…[bounded work brief truncated]`;
}

interface RepositoryScope {
  uids: string[];
  /** Repo ids whose identity resolution ERRORED (as opposed to resolving to
   * "absent", which just means no tasks can target them yet). A failure
   * silently narrowing — or entirely removing — the scope was the amplifier
   * in the 2026-07-29 auto-claim incident: the cloud identity 403 emptied the
   * scope and resume ran against the global pool with no signal anywhere. */
  failures: string[];
}

async function repositoryScopeUids(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
  agentId: string,
): Promise<RepositoryScope> {
  if (!client.entity) return { uids: [], failures: [] };
  const adapter = new CodegraphAdapter({
    cwd: input.cwd,
    workspaceFile: options.workspaceFile,
  });
  const configured = await adapter.resolveRepositories();
  const repositories =
    configured.length > 0
      ? configured
      : [await adapter.resolveRepository()];
  const failures: string[] = [];
  const resolved = await Promise.all(
    repositories.map(async (repository) => {
      try {
        const payload = object(
          await client.entity!({
            action: "resolve_identity",
            identity: {
              namespace: "external.code",
              key_version: 1,
              key: repositoryIdentityKey(repository),
            },
            agent_id: agentId,
          }),
        );
        if (payload?.status === "existing" && string(payload.uid)) {
          return string(payload.uid);
        }
        if (payload?.status !== "absent") {
          failures.push(
            `${repository.repoId}: ${string(payload?.status) || "unresolved"}`,
          );
        }
        return undefined;
      } catch (error) {
        failures.push(
          `${repository.repoId}: ${(error as Error)?.message || "resolve failed"}`,
        );
        return undefined;
      }
    }),
  );
  return {
    uids: [...new Set(resolved.filter((uid): uid is string => Boolean(uid)))],
    failures,
  };
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
): boolean {
  const reason = string(brief?.selection_reason);
  if (reason === "owned_live_lease" || reason === "same_agent_session_rebind") {
    return true;
  }
  const owner = string(object(brief?.lease)?.lease_owner_agent_id);
  // Legacy compatibility: before the stable per-user default, agent_id fell
  // back to the harness name, so existing leases are owned by "claude-code"
  // or "codex". Treating those as own work is what lets a pre-upgrade lease
  // rebind after the identity change — and is exactly the cross-harness
  // handoff the harness-name default made impossible.
  return owner === agentId || owner === "claude-code" || owner === "codex";
}

async function sessionStart(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
): Promise<HookCoreOutput> {
  const agentId = resolveAgentId(options);
  const harnessLabel = options.harness === "claude-code" ? "Claude Code" : "Codex";
  const nowSeconds = (options.now || (() => Date.now() / 1000))();
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
  if (sessionUid) {
    withLedger(input.session_id, options, (ledger) => {
      ledger.sessionUid = sessionUid;
      ledger.baselineWorktree = worktreeState(input.cwd);
      return undefined;
    });
  }
  const scope = await repositoryScopeUids(input, client, options, agentId);
  if (scope.failures.length > 0) {
    console.error(
      `mindgraph-hook: ${scope.failures.length} repository scope(s) failed to resolve (${scope.failures.join("; ")}); resume runs ${scope.uids.length > 0 ? "narrowed" : "UNSCOPED"}`,
    );
  }
  const scopeUids = scope.uids;
  let brief = object(
    await client.plan({
      action: "resume_work",
      session_uid: sessionUid,
      ...(scopeUids.length > 0 ? { scope_uids: scopeUids } : {}),
      agent_id: agentId,
    }),
  );
  const task = object(brief?.task);
  const lease = object(brief?.lease);
  let claimed: Record<string, unknown> | undefined;
  let claimFailed = false;
  if (
    sessionUid &&
    string(task?.uid) &&
    number(task?.version) &&
    isOwnPriorWork(brief, agentId)
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
      brief = object(
        await client.plan({
          action: "resume_work",
          task_uid: task!.uid,
          session_uid: sessionUid,
          ...(scopeUids.length > 0 ? { scope_uids: scopeUids } : {}),
          agent_id: agentId,
        }),
      );
      if (brief && claimed) brief.claim = claimed;
    } catch {
      // Resume still supplies a useful bounded explanation on a claim race.
      claimFailed = true;
      claimed = undefined;
    }
  }
  const scopeNote =
    scope.failures.length > 0
      ? `Scope: ${scopeUids.length} repositories resolved, ${scope.failures.length} FAILED — durable-work selection ran ${scopeUids.length > 0 ? "narrowed" : "unscoped"}; tasks in the failed repositories may be missing.`
      : undefined;
  const briefText = renderBrief(brief || { status: "no_eligible_work" }, {
    claimed: Boolean(claimed),
    claimFailed,
    scopeNote,
  });
  const briefHash = crypto.createHash("sha256").update(briefText).digest("hex");
  const shouldInject = withLedger(input.session_id, options, (ledger) => {
    const changed = ledger.lastBriefHash !== briefHash;
    const reinjectCompact =
      options.reinjectUnchangedCompact && input.source === "compact";
    ledger.sessionUid = sessionUid;
    ledger.baselineWorktree = worktreeState(input.cwd);
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
    } else {
      ledger.taskUid = undefined;
      ledger.taskVersion = undefined;
      ledger.leaseEpoch = undefined;
      ledger.leaseExpiresAt = undefined;
      ledger.executionUid = undefined;
      ledger.lastLeaseRenewalAt = undefined;
    }
    ledger.lastBriefHash = briefHash;
    return changed || reinjectCompact;
  });
  return shouldInject ? { kind: "context", context: briefText } : NOOP;
}

async function preTool(
  input: HookInput,
  options: CoreHookRuntimeOptions,
): Promise<HookCoreOutput> {
  const original = { ...(input.tool_input || {}) };
  const ledger = readLedger(input.session_id, options);
  let repoId =
    ledger.repoContextCwd === input.cwd &&
    ledger.repoContextAt !== undefined &&
    Date.now() - ledger.repoContextAt < 300_000
      ? ledger.repoContextRepoId
      : undefined;
  if (!repoId) {
    repoId = (
      await new CodegraphAdapter({
        cwd: input.cwd,
        workspaceFile: options.workspaceFile,
      }).resolveRepository()
    ).repoId;
    withLedger(input.session_id, options, (fresh) => {
      fresh.repoContextCwd = input.cwd;
      fresh.repoContextRepoId = repoId;
      fresh.repoContextAt = Date.now();
      return undefined;
    });
  }
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
  const targetsLedgerTask =
    ledger.taskUid !== undefined && updatedInput.task_uid === ledger.taskUid;
  if (
    ledger.taskUid &&
    input.tool_name?.includes("mindgraph_capture") &&
    updatedInput.work_uid === undefined
  ) {
    updatedInput.work_uid = ledger.taskUid;
  }
  if (
    targetsLedgerTask &&
    ledger.executionUid &&
    updatedInput.execution_uid === undefined
  ) {
    updatedInput.execution_uid = ledger.executionUid;
  }
  if (
    targetsLedgerTask &&
    ledger.leaseEpoch !== undefined &&
    updatedInput.lease_epoch === undefined
  ) {
    updatedInput.lease_epoch = ledger.leaseEpoch;
  }
  if (
    targetsLedgerTask &&
    ledger.taskVersion !== undefined &&
    updatedInput.expected_version === undefined
  ) {
    updatedInput.expected_version = ledger.taskVersion;
  }
  return { kind: "rewrite", updatedInput };
}

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
    // Only reflective captures satisfy the Stop nudge's "capture one durable
    // lesson/decision/risk" — creating an Entity or Source is not memory of
    // the work.
    if (
      name.includes("mindgraph_capture") &&
      !payload?.error &&
      ["lesson", "journal"].includes(action || "")
    ) {
      ledger.memoryWritten = true;
    }
    if (name.includes("mindgraph_plan")) {
      const targetTask = string(args.task_uid) || ledger.taskUid;
      const aboutLedgerTask =
        targetTask !== undefined && targetTask === ledger.taskUid;
      if (!payload?.error) {
        if (action === "claim_task" && targetTask) {
          // A successful claim is the model deliberately (re)binding work —
          // the ledger follows the model, including onto a different task.
          ledger.taskUid = targetTask;
          ledger.taskVersion =
            number(payload?.task_version) ??
            number(payload?.version) ??
            ledger.taskVersion;
          ledger.leaseEpoch = number(payload?.lease_epoch) ?? ledger.leaseEpoch;
          ledger.leaseExpiresAt =
            number(payload?.lease_expires_at) ?? ledger.leaseExpiresAt;
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
          ledger.leaseExpiresAt =
            number(payload?.lease_expires_at) ?? ledger.leaseExpiresAt;
        }
      } else if (aboutLedgerTask) {
        // Structured conflict payloads (server ≥1.11.3) carry the current
        // fencing state; adopting it lets the next call succeed instead of
        // replaying the stale fence forever.
        ledger.taskVersion =
          number(payload?.current_version) ?? ledger.taskVersion;
        ledger.leaseEpoch = number(payload?.current_epoch) ?? ledger.leaseEpoch;
        ledger.leaseExpiresAt =
          number(payload?.lease_expires_at) ?? ledger.leaseExpiresAt;
      }
    }
    if (
      ledger.taskUid &&
      ledger.sessionUid &&
      ledger.taskVersion !== undefined &&
      ledger.leaseEpoch !== undefined &&
      ledger.leaseExpiresAt !== undefined
    ) {
      const expiresIn = ledger.leaseExpiresAt - nowSeconds;
      const sinceRenewal = nowSeconds - (ledger.lastLeaseRenewalAt ?? 0);
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
        if (payloadIsError(response)) return undefined;
        ledger.taskVersion =
          number(response?.task_version) ?? ledger.taskVersion;
        ledger.leaseEpoch = number(response?.lease_epoch) ?? ledger.leaseEpoch;
        ledger.leaseExpiresAt =
          number(response?.lease_expires_at) ?? ledger.leaseExpiresAt;
        ledger.lastLeaseRenewalAt = nowSeconds;
        return undefined;
      });
    } catch {
      // Renewal is advisory; authoritative fencing remains server-side.
    }
  }
  return NOOP;
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
  if (ledger.sessionUid) {
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

export async function runHookCore(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
): Promise<HookCoreOutput> {
  switch (input.hook_event_name) {
    case "SessionStart":
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
}
