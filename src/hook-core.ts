import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  CodegraphAdapter,
  repositoryIdentityKey,
} from "./codegraph.js";

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

async function invocationContext(
  input: HookInput,
  options: CoreHookRuntimeOptions,
) {
  const repository = await new CodegraphAdapter({
    cwd: input.cwd,
    workspaceFile: options.workspaceFile,
  }).resolveRepository();
  return {
    harness: options.harness,
    harnessSessionId: input.session_id,
    harnessTurnId: input.turn_id,
    cwd: input.cwd,
    repoId: repository.repoId,
    branch: gitValue(input.cwd, ["branch", "--show-current"]),
    commit: gitValue(input.cwd, ["rev-parse", "HEAD"]),
    worktreeState: worktreeState(input.cwd),
    model: input.model,
    injectedBy: "hook",
  };
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

function boundedBrief(brief: unknown): string {
  const encoded = JSON.stringify(brief, null, 2);
  const capped =
    encoded.length <= 9_000
      ? encoded
      : `${encoded.slice(0, 8_900)}\n…[bounded work brief truncated]`;
  return [
    "MindGraph durable work brief (authoritative across sessions/harnesses):",
    capped,
    "Use the harness todo list only for local execution details; do not duplicate this durable Task there.",
  ].join("\n");
}

async function repositoryScopeUids(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
  agentId: string,
): Promise<string[]> {
  if (!client.entity) return [];
  const adapter = new CodegraphAdapter({
    cwd: input.cwd,
    workspaceFile: options.workspaceFile,
  });
  const configured = await adapter.resolveRepositories();
  const repositories =
    configured.length > 0
      ? configured
      : [await adapter.resolveRepository()];
  const resolved = await Promise.all(
    repositories.map((repository) =>
      client
        .entity!({
          action: "resolve_identity",
          identity: {
            namespace: "external.code",
            key_version: 1,
            key: repositoryIdentityKey(repository),
          },
          agent_id: agentId,
        })
        .catch(() => undefined),
    ),
  );
  return [
    ...new Set(
      resolved.flatMap((response) => {
        const payload = object(response);
        return payload?.status === "existing" && string(payload.uid)
          ? [string(payload.uid)!]
          : [];
      }),
    ),
  ];
}

async function sessionStart(
  input: HookInput,
  client: HookClient,
  options: CoreHookRuntimeOptions,
): Promise<HookCoreOutput> {
  const agentId =
    options.agentId || process.env.MINDGRAPH_AGENT_ID || options.harness;
  const harnessLabel = options.harness === "claude-code" ? "Claude Code" : "Codex";
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
  const scopeUids = await repositoryScopeUids(input, client, options, agentId);
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
  if (sessionUid && string(task?.uid) && number(task?.version)) {
    try {
      const claimed = object(
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
    }
  }
  const briefText = boundedBrief(brief || { status: "no_eligible_work" });
  const briefHash = crypto.createHash("sha256").update(briefText).digest("hex");
  const shouldInject = withLedger(input.session_id, options, (ledger) => {
    const changed = ledger.lastBriefHash !== briefHash;
    const reinjectCompact =
      options.reinjectUnchangedCompact && input.source === "compact";
    ledger.sessionUid = sessionUid;
    ledger.baselineWorktree = worktreeState(input.cwd);
    const selectedTask = object(brief?.task);
    const selectedLease = object(brief?.lease) || object(brief?.claim);
    const executions = Array.isArray(brief?.recent_executions)
      ? brief?.recent_executions
      : [];
    const latest = object(executions[0]);
    ledger.taskUid = string(selectedTask?.uid);
    ledger.taskVersion = number(selectedTask?.version);
    ledger.leaseEpoch = number(selectedLease?.lease_epoch);
    ledger.leaseExpiresAt = number(selectedLease?.lease_expires_at);
    ledger.executionUid =
      string(object(brief?.active_execution)?.uid) || string(latest?.uid);
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
  const updatedInput: Record<string, unknown> = {
    ...original,
    invocation_context: await invocationContext(input, options),
  };
  // The hook owns SESSION identity (adapter-authoritative — always replaced),
  // but work-targeting fields belong to the model: the ledger only FILLS them
  // when absent. Overwriting task_uid/expected_version redirects mutations to
  // the cached task with a stale version — the model can never address a
  // second task, and the server's 409 teaching loop is defeated (found live
  // in the L5 dogfood: every block_task on a new task 409'd against the old
  // one). Ledger state is bookkeeping, never authority.
  if (ledger.sessionUid) updatedInput.session_uid = ledger.sessionUid;
  if (ledger.taskUid && updatedInput.task_uid === undefined) {
    updatedInput.task_uid = ledger.taskUid;
  }
  if (
    ledger.taskUid &&
    input.tool_name?.includes("mindgraph_capture") &&
    updatedInput.work_uid === undefined
  ) {
    updatedInput.work_uid = ledger.taskUid;
  }
  if (ledger.executionUid && updatedInput.execution_uid === undefined) {
    updatedInput.execution_uid = ledger.executionUid;
  }
  if (ledger.leaseEpoch !== undefined && updatedInput.lease_epoch === undefined) {
    updatedInput.lease_epoch = ledger.leaseEpoch;
  }
  if (
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
  let heartbeat:
    | {
        taskUid: string;
        sessionUid: string;
        taskVersion: number;
        leaseEpoch: number;
      }
    | undefined;
  withLedger(input.session_id, options, (ledger) => {
    ledger.materialToolCalls += 1;
    if (
      ["Edit", "Write", "NotebookEdit", "apply_patch"].includes(name) ||
      (name === "Bash" && action !== "read")
    ) {
      ledger.mutatingOperations += 1;
    }
    if (name.includes("mindgraph_capture") && !payload?.error) {
      ledger.memoryWritten = true;
    }
    if (name.includes("mindgraph_plan")) {
      if (action === "start_iteration" && !payload?.error) {
        ledger.executionUid = string(payload?.execution_uid) || ledger.executionUid;
      }
      if (
        ["checkpoint_iteration", "block_task", "complete_task", "abandon_iteration"].includes(
          action || "",
        ) &&
        !payload?.error
      ) {
        ledger.iterationCheckpointed = true;
        if (action !== "block_task") ledger.executionUid = undefined;
      }
      ledger.taskVersion =
        number(payload?.task_version) || number(payload?.version) || ledger.taskVersion;
      ledger.leaseEpoch = number(payload?.lease_epoch) || ledger.leaseEpoch;
      ledger.leaseExpiresAt =
        number(payload?.lease_expires_at) || ledger.leaseExpiresAt;
    }
    if (
      ledger.taskUid &&
      ledger.sessionUid &&
      ledger.taskVersion !== undefined &&
      ledger.leaseEpoch !== undefined &&
      ledger.leaseExpiresAt !== undefined &&
      ledger.leaseExpiresAt - nowSeconds <= 60
    ) {
      heartbeat = {
        taskUid: ledger.taskUid,
        sessionUid: ledger.sessionUid,
        taskVersion: ledger.taskVersion,
        leaseEpoch: ledger.leaseEpoch,
      };
    }
    return undefined;
  });
  if (heartbeat) {
    try {
      const response = object(
        await client.plan({
          action: "heartbeat",
          task_uid: heartbeat.taskUid,
          session_uid: heartbeat.sessionUid,
          expected_version: heartbeat.taskVersion,
          lease_epoch: heartbeat.leaseEpoch,
          idempotency_key: `hook-heartbeat:${input.session_id}:${heartbeat.taskUid}:${Math.floor(nowSeconds / 60)}`,
          agent_id: options.agentId || options.harness,
        }),
      );
      withLedger(input.session_id, options, (ledger) => {
        ledger.leaseExpiresAt =
          number(response?.lease_expires_at) || ledger.leaseExpiresAt;
        return undefined;
      });
    } catch {
      // Heartbeat is advisory; authoritative fencing remains server-side.
    }
  }
  return NOOP;
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
        agent_id: options.agentId || options.harness,
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
        agent_id: options.agentId || options.harness,
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
