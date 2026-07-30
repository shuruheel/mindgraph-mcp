import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runCodexHook,
  type HookClient,
} from "../src/codex-hooks.js";
import {
  installCodexHooks,
  uninstallCodexHooks,
} from "../src/hook-installer.js";

const cleanup: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindgraph-codex-hooks-"));
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
  let revision = "first";
  const client: HookClient = {
    async session(request) {
      sessions.push(request);
      return { uid: "codex-session-graph" };
    },
    async plan(request) {
      plans.push(request);
      if (request.action === "claim_task") {
        return {
          task_version: 2,
          lease_epoch: 7,
          lease_expires_at: 9_999_999_999,
        };
      }
      if (request.action === "resume_work") {
        return {
          task: {
            uid: "codex-task",
            label: `Ship the adapter (${revision})`,
            version: request.task_uid ? 2 : 1,
          },
          // Expired own lease — the sanctioned cross-session rebind path.
          lease: {
            lease_owner_agent_id: "codex-b7",
            lease_epoch: 7,
            lease_expires_at: 1,
          },
          active_execution: { uid: "codex-execution", status: "running" },
          next_action: revision,
        };
      }
      return {};
    },
  };
  return {
    client,
    sessions,
    plans,
    changeBrief() {
      revision = "changed";
    },
  };
}

describe("Codex normalized hook adapter", () => {
  it("opens/rebinds and injects only a new or changed bounded work brief", async () => {
    // Failure prevented: treating every SessionStart as a fresh injection
    // duplicates unchanged developer context on resume/clear/compact.
    const cwd = tempRoot();
    const runtimeDir = path.join(cwd, "runtime");
    const fixture = fakeClient();
    const input = {
      session_id: "thr_b7",
      cwd,
      hook_event_name: "SessionStart",
      source: "resume",
      model: "gpt-test",
    };

    const first = await runCodexHook(input, fixture.client, {
      agentId: "codex-b7",
      runtimeDir,
    });
    const repeated = await runCodexHook(input, fixture.client, {
      agentId: "codex-b7",
      runtimeDir,
    });
    fixture.changeBrief();
    const changed = await runCodexHook(input, fixture.client, {
      agentId: "codex-b7",
      runtimeDir,
    });

    expect(
      (first.hookSpecificOutput as Record<string, unknown>).additionalContext,
    ).toContain("codex-task");
    expect(repeated).toEqual({});
    expect(
      (changed.hookSpecificOutput as Record<string, unknown>).additionalContext,
    ).toContain("Ship the adapter (changed)");
    expect(fixture.sessions[0]).toMatchObject({
      harness: "codex",
      harness_session_id: "thr_b7",
      agent_id: "codex-b7",
    });
  });

  it("rewrites MindGraph input with Codex's allow shape and fill-only work fields", async () => {
    // Failure prevented: Codex rejects updatedInput unless the hook explicitly
    // returns permissionDecision=allow; overwriting model task fields repeats R4.
    const cwd = tempRoot();
    const runtimeDir = path.join(cwd, "runtime");
    const fixture = fakeClient();
    await runCodexHook(
      {
        session_id: "thr_pre",
        cwd,
        hook_event_name: "SessionStart",
        source: "startup",
      },
      fixture.client,
      { agentId: "codex-b7", runtimeDir },
    );

    const output = await runCodexHook(
      {
        session_id: "thr_pre",
        turn_id: "turn_9",
        cwd,
        model: "gpt-test",
        hook_event_name: "PreToolUse",
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: {
          action: "block_task",
          task_uid: "model-task",
          expected_version: 41,
          lease_epoch: 13,
          execution_uid: "model-execution",
          invocation_context: { harness: "forged" },
        },
      },
      fixture.client,
      { agentId: "codex-b7", runtimeDir },
    );
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    const updated = hookOutput.updatedInput as Record<string, unknown>;

    expect(hookOutput.permissionDecision).toBe("allow");
    expect(updated).toMatchObject({
      task_uid: "model-task",
      expected_version: 41,
      lease_epoch: 13,
      execution_uid: "model-execution",
      session_uid: "codex-session-graph",
    });
    expect(updated.invocation_context).toMatchObject({
      harness: "codex",
      harnessSessionId: "thr_pre",
      harnessTurnId: "turn_9",
      cwd,
      injectedBy: "hook",
    });
  });

  it("counts Codex tool events, blocks Stop once, and treats SessionEnd as cleanup", async () => {
    // Failure prevented: translating only the context/rewrite events leaves
    // the disposable ledger empty, so reflection never fires and cleanup leaks.
    const cwd = tempRoot();
    const runtimeDir = path.join(cwd, "runtime");
    const fixture = fakeClient();
    await runCodexHook(
      {
        session_id: "thr_lifecycle",
        cwd,
        hook_event_name: "SessionStart",
        source: "startup",
      },
      fixture.client,
      { agentId: "codex-b7", runtimeDir },
    );
    for (const toolUseId of ["tool_1", "tool_2"]) {
      await runCodexHook(
        {
          session_id: "thr_lifecycle",
          turn_id: "turn_lifecycle",
          cwd,
          hook_event_name: "PostToolUse",
          tool_name: "apply_patch",
          tool_input: { command: `patch ${toolUseId}` },
          tool_response: { ok: true },
        },
        fixture.client,
        { agentId: "codex-b7", runtimeDir },
      );
    }

    const firstStop = await runCodexHook(
      {
        session_id: "thr_lifecycle",
        cwd,
        hook_event_name: "Stop",
        stop_hook_active: false,
      },
      fixture.client,
      { agentId: "codex-b7", runtimeDir },
    );
    const reentry = await runCodexHook(
      {
        session_id: "thr_lifecycle",
        cwd,
        hook_event_name: "Stop",
        stop_hook_active: true,
      },
      fixture.client,
      { agentId: "codex-b7", runtimeDir },
    );
    await runCodexHook(
      {
        session_id: "thr_lifecycle",
        cwd,
        hook_event_name: "SessionEnd",
        reason: "other",
      },
      fixture.client,
      { agentId: "codex-b7", runtimeDir },
    );

    expect(firstStop).toMatchObject({ decision: "block" });
    expect(reentry).toEqual({});
    expect(fixture.plans).toContainEqual(
      expect.objectContaining({
        action: "abandon_iteration",
        execution_uid: "codex-execution",
      }),
    );
    // Codex clamps SessionEnd to 3s — one cloud call fits. The abandon
    // (which releases the lease, the part that blocks other sessions) wins;
    // the close is skipped, and the next session-open identity-upsert makes
    // a stale-open Session benign.
    expect(fixture.sessions).not.toContainEqual(
      expect.objectContaining({ action: "close" }),
    );
  });
});

describe("Codex hook installer", () => {
  it("upserts owned entries, preserves foreign hooks, and uses Codex timeouts", () => {
    // Failure prevented: append-only installers leave stale owned commands in
    // place on upgrades, while replace-all installers destroy user hooks.
    const root = tempRoot();
    const hooksDir = path.join(root, ".codex");
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify({
        description: "foreign metadata stays",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }],
        },
      }),
    );

    const first = installCodexHooks("project", root);
    const second = installCodexHooks("project", root);
    expect(first.added).toBe(5);
    expect(second).toEqual(
      expect.objectContaining({ added: 0, updated: 5 }),
    );

    const file = path.join(hooksDir, "hooks.json");
    const settings = JSON.parse(fs.readFileSync(file, "utf8")) as {
      description: string;
      hooks: Record<
        string,
        Array<{
          matcher?: string;
          hooks: Array<{
            command: string;
            timeout: number;
            additionalContextLimit?: number;
          }>;
        }>
      >;
    };
    expect(settings.description).toBe("foreign metadata stays");
    expect(settings.hooks.Stop).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hooks: [expect.objectContaining({ command: "echo foreign" })],
        }),
      ]),
    );
    const owned = Object.values(settings.hooks)
      .flat()
      .flatMap((entry) => entry.hooks)
      .filter((hook) => hook.command.includes("--owner mindgraph"));
    expect(owned).toHaveLength(5);
    expect(owned.every((hook) => hook.command.includes("--harness codex"))).toBe(
      true,
    );
    expect(owned.every((hook) => !hook.command.includes("npx"))).toBe(true);
    expect(settings.hooks.SessionStart[0].hooks[0]).toMatchObject({
      timeout: 30,
      additionalContextLimit: 10_000,
    });
    // Codex clamps SessionEnd to a 3s platform cap — writing more would be
    // a no-op; the codex adapter compensates by making at most ONE call.
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);

    const removed = uninstallCodexHooks("project", root);
    expect(removed.removed).toBe(5);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.hooks.Stop[0].hooks[0].command).toBe("echo foreign");
  });

  it("uses CODEX_HOME/hooks.json for user scope", () => {
    // Failure prevented: writing ~/.codex directly ignores users and
    // automation profiles that relocate Codex state with CODEX_HOME.
    const root = tempRoot();
    const codexHome = path.join(root, "custom-codex-home");
    const result = installCodexHooks("user", root, codexHome);
    expect(result.path).toBe(path.join(codexHome, "hooks.json"));
    expect(fs.existsSync(result.path)).toBe(true);
  });
});
