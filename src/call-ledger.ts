/*
 * Side channel between the Claude Code PreToolUse hook and the stdio MCP
 * server (roadmap H1).
 *
 * The hook used to return `updatedInput` carrying the session, task, lease
 * and invocation fields. Claude Code's auto permission mode reviews the input
 * the MODEL wrote and refuses a call whose input a hook changed afterwards
 * ("a hook changed this call's input after auto mode reviewed it"), so every
 * MindGraph tool was closed in the default mode of the host.
 *
 * Nothing documented carries a per-call id from the hook into the server
 * process, so the two sides correlate on what both can see: the tool name and
 * the arguments exactly as the model wrote them. The hook writes the fields it
 * would have injected under that key; the server reads them at call time.
 *
 * Fail closed: when records from more than one harness session match the same
 * call and the project directory cannot tell them apart, nothing is applied
 * and the call proceeds untagged, exactly as it does with no hook installed.
 * A fenced action without its lease fields is then refused by the server.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A hook runs before a permission prompt the person may take minutes to
 * answer, so the record must outlive the prompt. */
const TTL_MS = 10 * 60_000;

interface PendingCall {
  harnessSessionId: string;
  projectDir?: string;
  fills: Record<string, unknown>;
  createdAt: number;
}

export interface CallLedgerOptions {
  runtimeDir?: string;
  now?: () => number;
  projectDir?: string;
}

function callsDir(options: CallLedgerOptions): string {
  return path.join(
    options.runtimeDir ||
      process.env.MINDGRAPH_RUNTIME_DIR ||
      path.join(os.homedir(), ".mindgraph", "runtime"),
    "calls",
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** `mcp__mindgraph__mindgraph_plan` (hook) and `mindgraph_plan` (server) are
 * the same tool. */
function bareToolName(name: string): string {
  const cut = name.lastIndexOf("__");
  return cut === -1 ? name : name.slice(cut + 2);
}

function callKey(toolName: string, toolInput: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(`${bareToolName(toolName)}\0${stableJson(toolInput)}`)
    .digest("hex");
}

function sessionKey(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function prune(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > TTL_MS) fs.unlinkSync(file);
    } catch {
      // Another process pruned it first.
    }
  }
}

/** Hook side: record the fields this call should carry. Never throws — a
 * failed write leaves the call untagged, which is the fail-closed outcome. */
export function recordPendingCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  harnessSessionId: string,
  fills: Record<string, unknown>,
  options: CallLedgerOptions = {},
): void {
  const now = (options.now ?? Date.now)();
  const dir = callsDir(options);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    prune(dir, now);
    const record: PendingCall = {
      harnessSessionId,
      projectDir: options.projectDir ?? process.env.CLAUDE_PROJECT_DIR,
      fills,
      createdAt: now,
    };
    const file = path.join(
      dir,
      `${callKey(toolName, toolInput)}.${sessionKey(harnessSessionId)}.json`,
    );
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    // Disposable bookkeeping.
  }
}

/** Server side: the fields the hook recorded for this exact call, or
 * undefined when there is none or the match is ambiguous. The record is left
 * in place (parallel identical calls in one session share it) and expires. */
export function resolvePendingCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: CallLedgerOptions = {},
): Record<string, unknown> | undefined {
  const now = (options.now ?? Date.now)();
  const dir = callsDir(options);
  const prefix = `${callKey(toolName, toolInput)}.`;
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
  } catch {
    return undefined;
  }
  let matches: PendingCall[] = [];
  for (const name of names) {
    try {
      const record = JSON.parse(
        fs.readFileSync(path.join(dir, name), "utf8"),
      ) as PendingCall;
      if (
        typeof record.createdAt === "number" &&
        now - record.createdAt <= TTL_MS &&
        record.fills &&
        typeof record.fills === "object"
      ) {
        matches.push(record);
      }
    } catch {
      // Unreadable or mid-rename: not a match.
    }
  }
  if (matches.length > 1) {
    const projectDir = options.projectDir ?? process.env.CLAUDE_PROJECT_DIR;
    matches = projectDir
      ? matches.filter((record) => record.projectDir === projectDir)
      : [];
  }
  return matches.length === 1 ? matches[0].fills : undefined;
}
