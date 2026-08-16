import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runClaudeHook, type HookClient } from "../src/claude-hooks.js";
import {
  installClaudeHooks,
  installHookRunner,
  installedHookRunnerVersion,
  refreshHookRunner,
  refreshOwnedClaudeHooks,
  uninstallClaudeHooks,
  uninstallHookRunner,
  versionSkewNote,
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
          // Own prior lease, EXPIRED — the sanctioned cross-session rebind.
          // A live lease belongs to a concurrent session and is deliberately
          // not re-claimed at SessionStart.
          lease: {
            lease_owner_agent_id: "claude-code",
            lease_epoch: 4,
            lease_expires_at: 1,
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

  it("does not auto-claim backlog work the agent never owned", async () => {
    const cwd = tempRoot();
    const plans: Array<Record<string, unknown>> = [];
    const client: HookClient = {
      async session() {
        return { uid: "session-graph" };
      },
      async plan(request) {
        plans.push(request);
        if (request.action === "resume_work") {
          return {
            selection_reason: "pending",
            task: { uid: "task-backlog", version: 1 },
            lease: null,
          };
        }
        return {};
      },
    };
    const out = await runClaudeHook(
      { session_id: "s-backlog", cwd, hook_event_name: "SessionStart" },
      client,
      { runtimeDir: path.join(cwd, "runtime") },
    );
    expect(plans.filter((r) => r.action === "claim_task")).toHaveLength(0);
    // No claim also means no redundant second resume_work round-trip.
    expect(plans.filter((r) => r.action === "resume_work")).toHaveLength(1);
    // The backlog task is still surfaced as orienting context.
    expect(
      (out.hookSpecificOutput as Record<string, unknown>).additionalContext,
    ).toContain("task-backlog");
  });

  it("rebinds across an expired lease this agent owns", async () => {
    const cwd = tempRoot();
    const plans: Array<Record<string, unknown>> = [];
    const client: HookClient = {
      async session() {
        return { uid: "session-graph" };
      },
      async plan(request) {
        plans.push(request);
        if (request.action === "claim_task") {
          return { task_version: 3, lease_epoch: 5, lease_expires_at: 9e9 };
        }
        if (request.action === "resume_work") {
          return {
            selection_reason: "claimed",
            task: { uid: "task-mine", version: 2 },
            // Expired long ago — sessions are further apart than any lease
            // TTL, so rebind must key off ownership, not liveness.
            lease: {
              lease_owner_agent_id: "claude-code",
              lease_epoch: 4,
              lease_expires_at: 1,
            },
          };
        }
        return {};
      },
    };
    await runClaudeHook(
      { session_id: "s-rebind", cwd, hook_event_name: "SessionStart" },
      client,
      { runtimeDir: path.join(cwd, "runtime") },
    );
    expect(plans.filter((r) => r.action === "claim_task")).toHaveLength(1);
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

  it("bounds an oversized SessionStart work brief and keeps the task in it", async () => {
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
        task: { uid: "task-large", label: "Ship the fix", version: 1 },
        knowledge: [{ label: "Huge lesson", summary: "x".repeat(50_000) }],
        code_targets: Array.from({ length: 20 }, (_, index) => ({
          uid: `target-${index}`,
          label: `repo-${index}`,
        })),
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
    expect(context).toContain("bounded work brief truncated");
    expect(context).toContain("Task: Ship the fix [task-large]");
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

describe("SessionStart MCP registration diagnostic", () => {
  // The half-installed state observed live 2026-08-12: user-scope hooks
  // delivering briefs and Stop nudges into sessions with no registered
  // MindGraph MCP server — the model was asked to checkpoint with tools it
  // did not have, silently, for two weeks.
  const NOTE = "no MindGraph MCP server appears to be registered";

  function configFile(root: string, config: unknown): string {
    const file = path.join(root, "claude.json");
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  }

  async function startContext(
    root: string,
    claudeConfigPath: string,
    sessionId: string,
  ): Promise<string> {
    const { client } = fakeClient();
    const out = await runClaudeHook(
      { session_id: sessionId, cwd: root, hook_event_name: "SessionStart" },
      client,
      { runtimeDir: path.join(root, "runtime"), claudeConfigPath },
    );
    return String(
      (out.hookSpecificOutput as Record<string, unknown>).additionalContext,
    );
  }

  it("leads the brief with a warning when nothing in scope registers the server", async () => {
    const root = tempRoot();
    const file = configFile(root, {
      mcpServers: { context7: { command: "npx", args: ["context7"] } },
      projects: {
        // A registration scoped to an UNRELATED project must not count.
        "/somewhere/else": {
          mcpServers: { mindgraph: { command: "npx", args: ["-y", "mindgraph-mcp@latest"] } },
        },
      },
    });
    const context = await startContext(root, file, "reg-missing");
    expect(context).toContain(NOTE);
    expect(context.indexOf(NOTE)).toBeLessThan(context.indexOf("Task"));
    expect(context).toContain("install-code");
  });

  it("stays quiet for a user-scope registration", async () => {
    const root = tempRoot();
    const file = configFile(root, {
      mcpServers: { mindgraph: { command: "npx", args: ["-y", "mindgraph-mcp@latest"] } },
    });
    expect(await startContext(root, file, "reg-user")).not.toContain(NOTE);
  });

  it("stays quiet for a project-scope registration on an ancestor of the cwd", async () => {
    const root = tempRoot();
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    const file = configFile(root, {
      projects: {
        [root]: {
          // Recognized by command text, not just the `mindgraph` key.
          mcpServers: { graph: { command: "npx", args: ["-y", "mindgraph-mcp@0.17.0"] } },
        },
      },
    });
    const { client } = fakeClient();
    const out = await runClaudeHook(
      { session_id: "reg-project", cwd: nested, hook_event_name: "SessionStart" },
      client,
      { runtimeDir: path.join(root, "runtime"), claudeConfigPath: file },
    );
    expect(
      String((out.hookSpecificOutput as Record<string, unknown>).additionalContext),
    ).not.toContain(NOTE);
  });

  it("stays quiet for a .mcp.json registration above the session cwd", async () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { mindgraph: { command: "mindgraph-mcp" } } }),
    );
    const file = configFile(root, { mcpServers: {} });
    expect(await startContext(root, file, "reg-mcpjson")).not.toContain(NOTE);
  });

  it("stays quiet when the harness config file does not exist, and when silenced by env", async () => {
    const root = tempRoot();
    expect(
      await startContext(root, path.join(root, "absent.json"), "reg-nofile"),
    ).not.toContain(NOTE);
    process.env.MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK = "1";
    try {
      const file = configFile(root, { mcpServers: {} });
      expect(await startContext(root, file, "reg-skip")).not.toContain(NOTE);
    } finally {
      delete process.env.MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK;
    }
  });
});

describe("hook runner version sidecar", () => {
  it("records the copied bundle's version and reports skew against the server", () => {
    const home = tempRoot();
    const source = path.join(home, "bundle.cjs");
    fs.writeFileSync(source, "// bundle");
    installHookRunner(source, home, "0.17.0");
    expect(installedHookRunnerVersion(home)).toBe("0.17.0");
    expect(versionSkewNote("0.17.0", home)).toBeUndefined();
    const note = versionSkewNote("0.18.0", home);
    expect(note).toContain("v0.17.0");
    expect(note).toContain("v0.18.0");
    expect(note).toContain("install-hooks");
    // A copy of unknown provenance must not inherit the stale record and
    // start claiming a skew that may not exist.
    installHookRunner(source, home);
    expect(installedHookRunnerVersion(home)).toBeUndefined();
    expect(versionSkewNote("0.18.0", home)).toBeUndefined();
    installHookRunner(source, home, "0.17.0");
    uninstallHookRunner(home);
    expect(installedHookRunnerVersion(home)).toBeUndefined();
  });
});

describe("self-healing hook runner", () => {
  const RUNNER = path.join(".mindgraph", "bin", "mindgraph-hook.cjs");

  function seedRunner(home: string, version?: string): string {
    const source = path.join(home, "old-bundle.cjs");
    fs.writeFileSync(source, "// old bundle");
    installHookRunner(source, home, version);
    return path.join(home, RUNNER);
  }

  function newBundle(home: string): string {
    const source = path.join(home, "new-bundle.cjs");
    fs.writeFileSync(source, "// new bundle");
    return source;
  }

  it("refreshes an older runner from the server's own bundle, upgrade-only", () => {
    const home = tempRoot();
    const runner = seedRunner(home, "0.17.0");
    const result = refreshHookRunner("0.18.0", newBundle(home), home);
    expect(result).toMatchObject({
      refreshed: true,
      reason: "updated",
      runnerVersion: "0.17.0",
    });
    expect(fs.readFileSync(runner, "utf8")).toBe("// new bundle");
    expect(installedHookRunnerVersion(home)).toBe("0.18.0");
  });

  it("never downgrades: an npx cache serving an older server leaves the runner alone", () => {
    const home = tempRoot();
    const runner = seedRunner(home, "0.19.0");
    const result = refreshHookRunner("0.18.0", newBundle(home), home);
    expect(result).toMatchObject({ refreshed: false, reason: "downgrade" });
    expect(fs.readFileSync(runner, "utf8")).toBe("// old bundle");
    expect(installedHookRunnerVersion(home)).toBe("0.19.0");
  });

  it("treats an equal version as current and does not rewrite", () => {
    const home = tempRoot();
    const runner = seedRunner(home, "0.18.0");
    const result = refreshHookRunner("0.18.0", newBundle(home), home);
    expect(result).toMatchObject({ refreshed: false, reason: "current" });
    expect(fs.readFileSync(runner, "utf8")).toBe("// old bundle");
  });

  it("refreshes a pre-sidecar runner (no version record predates 0.17.1 by construction)", () => {
    const home = tempRoot();
    const runner = seedRunner(home); // no sidecar
    const result = refreshHookRunner("0.18.0", newBundle(home), home);
    expect(result).toMatchObject({ refreshed: true, reason: "updated" });
    expect(result.runnerVersion).toBeUndefined();
    expect(fs.readFileSync(runner, "utf8")).toBe("// new bundle");
    expect(installedHookRunnerVersion(home)).toBe("0.18.0");
  });

  it("does not install hooks onto a machine that has none", () => {
    const home = tempRoot();
    const result = refreshHookRunner("0.18.0", newBundle(home), home);
    expect(result).toMatchObject({ refreshed: false, reason: "no_runner" });
    expect(fs.existsSync(path.join(home, RUNNER))).toBe(false);
  });

  it("respects the opt-out and guards unparseable versions", () => {
    const home = tempRoot();
    const runner = seedRunner(home, "0.17.0");
    process.env.MINDGRAPH_HOOK_AUTOUPDATE = "off";
    try {
      expect(refreshHookRunner("0.18.0", newBundle(home), home)).toMatchObject({
        refreshed: false,
        reason: "disabled",
      });
    } finally {
      delete process.env.MINDGRAPH_HOOK_AUTOUPDATE;
    }
    // A hand-edited sidecar must not be interpreted as older-than-anything.
    fs.writeFileSync(path.join(home, `${RUNNER}.version`), "nightly\n");
    expect(refreshHookRunner("0.18.0", newBundle(home), home)).toMatchObject({
      refreshed: false,
      reason: "unparseable",
    });
    expect(fs.readFileSync(runner, "utf8")).toBe("// old bundle");
    // A missing source bundle (dev/test import of index.ts) is a no-op.
    expect(
      refreshHookRunner("0.18.0", path.join(home, "absent.cjs"), home),
    ).toMatchObject({ refreshed: false, reason: "no_source" });
  });
});

describe("refreshOwnedClaudeHooks", () => {
  const OWNED_COMMAND =
    'node "$HOME/.mindgraph/bin/mindgraph-hook.cjs" hook --harness claude-code --owner mindgraph';

  it("re-writes owned entries in scopes that already carry them, preserving foreign hooks", () => {
    const home = tempRoot();
    const project = tempRoot();
    // User scope: an owned entry with a stale 8s timeout, plus a foreign hook.
    const userFile = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: OWNED_COMMAND, timeout: 8 }],
            },
            {
              matcher: ".*",
              hooks: [{ type: "command", command: "echo foreign", timeout: 1 }],
            },
          ],
        },
        permissions: { defaultMode: "auto" },
      }),
    );
    const refreshed = refreshOwnedClaudeHooks(project, home);
    expect(refreshed).toEqual([userFile]);
    const settings = JSON.parse(fs.readFileSync(userFile, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
      permissions: Record<string, unknown>;
    };
    const owned = settings.hooks.SessionStart.find((entry) =>
      entry.hooks.some((hook) => String(hook.command).includes("--owner mindgraph")),
    );
    expect(owned?.hooks[0].timeout).toBe(30);
    expect(owned?.matcher).toBe("startup|resume|clear|compact|fork");
    // New events materialize; foreign content and unrelated settings survive.
    expect(settings.hooks.SessionEnd).toBeDefined();
    expect(
      settings.hooks.SessionStart.some((entry) =>
        entry.hooks.some((hook) => hook.command === "echo foreign"),
      ),
    ).toBe(true);
    expect(settings.permissions).toEqual({ defaultMode: "auto" });
  });

  it("never expands scope: files without owned entries (or absent) are untouched", () => {
    const home = tempRoot();
    const project = tempRoot();
    const projectFile = path.join(project, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    const foreignOnly = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    });
    fs.writeFileSync(projectFile, foreignOnly);
    expect(refreshOwnedClaudeHooks(project, home)).toEqual([]);
    expect(fs.readFileSync(projectFile, "utf8")).toBe(foreignOnly);
    expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
  });
});
