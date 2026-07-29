import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runClaudeHook, type HookClient } from "../src/claude-hooks.js";
import {
  installClaudeHooks,
  uninstallClaudeHooks,
} from "../src/hook-installer.js";

const cleanup: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindgraph-hooks-"));
  cleanup.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakeClient() {
  const sessions: Array<Record<string, unknown>> = [];
  const plans: Array<Record<string, unknown>> = [];
  const client: HookClient = {
    async session(request) {
      sessions.push(request);
      return { uid: "session-graph", created: sessions.length === 1 };
    },
    async plan(request) {
      plans.push(request);
      if (request.action === "claim_task") {
        return {
          task_version: 2,
          lease_epoch: 4,
          lease_expires_at: 9_999_999_999,
        };
      }
      if (request.action === "resume_work") {
        return {
          task: { uid: "task-1", version: plans.length > 1 ? 2 : 1 },
          lease: {
            lease_owner_agent_id: "claude-code",
            lease_epoch: 4,
            lease_expires_at: 9_999_999_999,
          },
          recent_executions: [{ uid: "execution-1", props: { status: "running" } }],
        };
      }
      return {};
    },
  };
  return { client, sessions, plans };
}

describe("Claude Code normalized hook adapter", () => {
  it("scopes resume across the repository entities declared by a parent overlay", async () => {
    const workspace = tempRoot();
    const engine = path.join(workspace, "engine");
    const core = path.join(workspace, "core");
    fs.mkdirSync(engine);
    fs.mkdirSync(core);
    fs.mkdirSync(path.join(workspace, ".mindgraph"));
    fs.writeFileSync(
      path.join(workspace, ".mindgraph", "workspace.json"),
      JSON.stringify({
        v: 1,
        repositories: [
          { repo_id: "engine", root: "engine" },
          { repo_id: "core", root: "core" },
        ],
      }),
    );
    const { client, plans } = fakeClient();
    client.entity = async (request) => {
      const key = (
        (request.identity as Record<string, unknown>).key as Record<
          string,
          unknown
        >
      );
      return {
        uid: `repository-${key.repo_id}`,
        status: "existing",
      };
    };

    await runClaudeHook(
      {
        session_id: "workspace-session",
        cwd: engine,
        hook_event_name: "SessionStart",
      },
      client,
      { runtimeDir: path.join(workspace, "runtime") },
    );
    expect(plans.find((request) => request.action === "resume_work")).toMatchObject({
      scope_uids: ["repository-engine", "repository-core"],
    });
  });

  it("reinjects compact briefs and replaces forged invocation context", async () => {
    const cwd = tempRoot();
    const runtimeDir = path.join(cwd, "runtime");
    const { client, sessions } = fakeClient();
    const start = {
      session_id: "claude-session",
      cwd,
      hook_event_name: "SessionStart",
      source: "compact",
      model: "claude-test",
    };
    const first = await runClaudeHook(start, client, { runtimeDir });
    const second = await runClaudeHook(start, client, { runtimeDir });
    expect(
      (first.hookSpecificOutput as Record<string, unknown>).additionalContext,
    ).toContain("task-1");
    expect(
      (second.hookSpecificOutput as Record<string, unknown>).additionalContext,
    ).toContain("task-1");
    expect(sessions[0]).toMatchObject({
      harness: "claude-code",
      harness_session_id: "claude-session",
    });

    const pre = await runClaudeHook(
      {
        session_id: "claude-session",
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: {
          action: "checkpoint_iteration",
          summary: "preserved",
          invocation_context: { harness: "forged", cwd: "/tmp/forged" },
        },
      },
      client,
      { runtimeDir },
    );
    const output = pre.hookSpecificOutput as Record<string, unknown>;
    const updated = output.updatedInput as Record<string, unknown>;
    expect(updated.summary).toBe("preserved");
    expect(updated.session_uid).toBe("session-graph");
    expect(updated.task_uid).toBe("task-1");
    expect(updated.execution_uid).toBe("execution-1");
    expect(updated.lease_epoch).toBe(4);
    expect(updated.invocation_context).toMatchObject({
      harness: "claude-code",
      harnessSessionId: "claude-session",
      cwd,
      injectedBy: "hook",
    });
  });

  it("bounds an oversized SessionStart work brief before injection", async () => {
    const cwd = tempRoot();
    const runtimeDir = path.join(cwd, "runtime");
    const { client } = fakeClient();
    client.plan = async (request) => {
      if (request.action === "claim_task") {
        return {
          task_version: 2,
          lease_epoch: 1,
          lease_expires_at: 9_999_999_999,
        };
      }
      return {
        task: { uid: "task-large", version: 1 },
        knowledge: [{ summary: "x".repeat(50_000) }],
      };
    };

    const output = await runClaudeHook(
      {
        session_id: "large-brief-session",
        cwd,
        hook_event_name: "SessionStart",
      },
      client,
      { runtimeDir },
    );
    const context = (
      output.hookSpecificOutput as Record<string, unknown>
    ).additionalContext as string;
    expect(context).toContain("[bounded work brief truncated]");
    expect(context.length).toBeLessThan(9_200);
  });

  it("nudges substantial work once and never reads transcript content", async () => {
    const cwd = tempRoot();
    const runtimeDir = path.join(cwd, "runtime");
    const { client } = fakeClient();
    await runClaudeHook(
      {
        session_id: "s",
        cwd,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "a.ts", transcript: "must-not-persist" },
        tool_response: { ok: true },
      },
      client,
      { runtimeDir },
    );
    await runClaudeHook(
      {
        session_id: "s",
        cwd,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: "b.ts" },
        tool_response: { ok: true },
      },
      client,
      { runtimeDir },
    );
    const first = await runClaudeHook(
      { session_id: "s", cwd, hook_event_name: "Stop" },
      client,
      { runtimeDir },
    );
    const second = await runClaudeHook(
      { session_id: "s", cwd, hook_event_name: "Stop" },
      client,
      { runtimeDir },
    );
    expect(first.decision).toBe("block");
    expect(second).toEqual({});
    const ledger = fs
      .readdirSync(runtimeDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => fs.readFileSync(path.join(runtimeDir, name), "utf8"))
      .join("");
    expect(ledger).not.toContain("must-not-persist");
    expect(ledger).not.toContain("a.ts");
  });

  it("records advisory task counts without task content", async () => {
    const cwd = tempRoot();
    const runtimeDir = path.join(cwd, "runtime");
    const { client } = fakeClient();
    await runClaudeHook(
      {
        session_id: "tasks",
        cwd,
        hook_event_name: "TaskCreated",
        tool_input: { subject: "secret local subject" },
      },
      client,
      { runtimeDir },
    );
    const ledger = fs
      .readdirSync(runtimeDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => fs.readFileSync(path.join(runtimeDir, name), "utf8"))
      .join("");
    expect(ledger).toContain('"nativeTasksCreated":1');
    expect(ledger).not.toContain("secret local subject");
  });
});

describe("Claude hook installer", () => {
  it("merges and uninstalls only owned hooks", () => {
    const root = tempRoot();
    const settingsDir = path.join(root, ".claude");
    fs.mkdirSync(settingsDir);
    fs.writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "echo existing" }],
            },
          ],
        },
      }),
    );
    const first = installClaudeHooks("project", root);
    const second = installClaudeHooks("project", root);
    expect(first.added).toBe(7);
    expect(second.added).toBe(0);
    const removed = uninstallClaudeHooks("project", root);
    expect(removed.removed).toBe(7);
    const settings = JSON.parse(
      fs.readFileSync(path.join(settingsDir, "settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo existing");
  });
});
