import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MindGraphError, type MindGraph } from "mindgraph";
import { handleTool, TOOLS } from "../src/tools.js";
import { runClaudeHook, type HookClient } from "../src/claude-hooks.js";
import {
  installClaudeHooks,
  installCodexHooks,
  installHookRunner,
  uninstallHookRunner,
} from "../src/hook-installer.js";
import { errorDetail } from "../src/error-detail.js";
import { handleSyncTool } from "../src/sync-tool.js";
import { classifyMcpAddFailure, parseArgs } from "../src/cli-args.js";
import { loadHookEnv, saveHookEnv } from "../src/hook-env.js";

// ─────────────────────────────────────────────────────────────────────────
// Regression tests for the four defects found in the 2026-07-28 L4/L5 live
// dogfood, plus the hook-env persistence added alongside them. Each test
// documents the failure it pins; none may be weakened without re-running the
// live scenario.
// ─────────────────────────────────────────────────────────────────────────

const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("R1 — the installed hook command line parses (owner-flag drift)", () => {
  it("every command the installer writes resolves to the hook command", () => {
    // Failure pinned: the installer embedded `--owner mindgraph`, parseArgs
    // had no arm for it, and the flag VALUE became the command — every
    // installed hook died with "Unknown command: mindgraph" on first run.
    const root = tempDir("mindgraph-r1-");
    fs.mkdirSync(path.join(root, ".git"));
    installClaudeHooks("project", root);
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands = Object.values(settings.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      // Command form: node "$HOME/.mindgraph/bin/mindgraph-hook.cjs" hook …
      // parseArgs sees argv[2:], i.e. everything after the runner path.
      expect(command).toContain('node "$HOME/.mindgraph/bin/mindgraph-hook.cjs"');
      expect(command).not.toContain("npx");
      const tokens = command.split(/\s+/);
      const argv = ["node", "cli.js", ...tokens.slice(2)];
      const parsed = parseArgs(argv);
      expect(parsed.command).toBe("hook");
    }
  });
});

describe("R2 — server error bodies reach the model (typed-error swallowing)", () => {
  it("includes the server's code and field detail in the tool error", async () => {
    // Failure pinned: MindGraphError bodies (code/missing field) were dropped,
    // leaving only "POST /agent/plan failed: 400" — the model burned 30 turns
    // source-diving instead of adding the named field.
    const client = {
      plan: vi.fn().mockRejectedValue(
        new MindGraphError("POST /agent/plan failed: 400", 400, {
          error: "session_uid required for checkpoint_iteration",
          code: "missing_field",
        })
      ),
    } as unknown as MindGraph;
    const result = await handleTool(client, "mindgraph_plan", {
      action: "checkpoint_iteration",
      task_uid: "task-1",
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("missing_field");
    expect(text).toContain("session_uid required for checkpoint_iteration");
  });
});

describe("R3 — composite actions forward execution_uid (field drift)", () => {
  it.each(["checkpoint_iteration", "abandon_iteration"])(
    "%s forwards execution_uid to the server",
    async (action) => {
      // Failure pinned: execution_uid was destructured but missing from the
      // composite-case spread, so the server answered "execution_uid required"
      // to calls that visibly included it.
      const plan = vi.fn().mockResolvedValue({ ok: true });
      const client = { plan } as unknown as MindGraph;
      await handleTool(client, "mindgraph_plan", {
        action,
        task_uid: "task-1",
        session_uid: "sess-1",
        execution_uid: "exec-9",
        expected_version: 3,
        lease_epoch: 1,
        idempotency_key: "k-1",
      });
      expect(plan).toHaveBeenCalledWith(
        expect.objectContaining({ action, execution_uid: "exec-9" })
      );
    }
  );
});

describe("R18 — created Tasks carry the repository topology SessionStart filters on", () => {
  it("materializes the hook-owned repository and adds its UID to create_task scope_uids", async () => {
    // Failure pinned: create_task accepted repo/scope fields but persisted no
    // Task→repository TARGETS edge. Unscoped resume_work found the handoff,
    // while the next SessionStart correctly returned no eligible work.
    const entity = vi.fn().mockResolvedValue({
      uid: "repository-entity-1",
      status: "created",
    });
    const plan = vi.fn().mockResolvedValue({ uid: "task-1" });
    const client = { entity, plan } as unknown as MindGraph;

    await handleTool(client, "mindgraph_plan", {
      action: "create_task",
      label: "Repository-scoped handoff",
      scope_uids: ["explicit-target-1"],
      agent_id: "codex-release-test",
      invocation_context: {
        cwd: process.cwd(),
        repoId: "github.com/example/repository",
        harness: "codex",
        harnessSessionId: "session-1",
        injectedBy: "hook",
      },
    });

    expect(entity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create",
        label: "github.com/example/repository",
        identity_space_uid: "space:agent:codex-release-test",
        identity: {
          namespace: "external.code",
          key_version: 1,
          key: {
            v: 1,
            kind: "repository",
            repo_id: "github.com/example/repository",
          },
        },
      }),
    );
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create_task",
        scope_uids: ["explicit-target-1", "repository-entity-1"],
      }),
    );
  });

  it("does not create an unscoped Task when the repository identity is inaccessible", async () => {
    const entity = vi.fn().mockResolvedValue({
      status: "exists_but_inaccessible",
    });
    const plan = vi.fn();
    const client = { entity, plan } as unknown as MindGraph;

    const result = await handleTool(client, "mindgraph_plan", {
      action: "create_task",
      label: "Must not become an invisible handoff",
      invocation_context: {
        cwd: process.cwd(),
        repoId: "github.com/example/repository",
        injectedBy: "hook",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exists_but_inaccessible");
    expect(plan).not.toHaveBeenCalled();
  });
});

describe("R4 — the ledger fills, never overwrites, model work-targeting args", () => {
  function client(): HookClient {
    return {
      async session() {
        return { uid: "session-graph" };
      },
      async plan(request: Record<string, unknown>) {
        if (request.action === "claim_task") {
          return {
            task_version: 2,
            lease_epoch: 4,
            lease_expires_at: 9_999_999_999,
          };
        }
        if (request.action === "resume_work") {
          // The post-claim resume (identified by an explicit task_uid) reports
          // the advanced version — mirroring the live server, where claiming
          // bumps the task version (the fencing rule).
          const version = request.task_uid ? 2 : 1;
          return {
            task: { uid: "ledger-task", version },
            // This agent's own prior lease, long expired — the sanctioned
            // SessionStart re-claim path. A backlog brief (selection_reason
            // "pending", no lease) would no longer be claimed at all.
            lease: {
              lease_owner_agent_id: "r4-agent",
              lease_epoch: 3,
              lease_expires_at: 1,
            },
            selection_reason: "claimed",
          };
        }
        return {};
      },
    } as unknown as HookClient;
  }

  async function ledgerWithClaim(runtime: string, root: string, c: HookClient) {
    await runClaudeHook(
      {
        hook_event_name: "SessionStart",
        session_id: "r4-session",
        cwd: root,
        source: "startup",
      },
      c,
      { agentId: "r4-agent", runtimeDir: runtime }
    );
  }

  it("preserves the model's task_uid and expected_version when present", async () => {
    // Failure pinned: the PreToolUse hook unconditionally overwrote
    // task_uid/expected_version from the ledger — the model could never
    // address a second task, and every mutation 409'd against the cached
    // version ("version_conflict; current is 4" loop in the live dogfood).
    const runtime = tempDir("mindgraph-r4-runtime-");
    const root = tempDir("mindgraph-r4-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const c = client();
    await ledgerWithClaim(runtime, root, c);
    const out = (await runClaudeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "r4-session",
        cwd: root,
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: {
          action: "block_task",
          task_uid: "model-chosen-task",
          expected_version: 7,
          lease_epoch: 9,
          execution_uid: "model-exec",
        },
      },
      c,
      { agentId: "r4-agent", runtimeDir: runtime }
    )) as {
      hookSpecificOutput: { updatedInput: Record<string, unknown> };
    };
    const updated = out.hookSpecificOutput.updatedInput;
    expect(updated.task_uid).toBe("model-chosen-task");
    expect(updated.expected_version).toBe(7);
    expect(updated.lease_epoch).toBe(9);
    expect(updated.execution_uid).toBe("model-exec");
    // Session identity stays adapter-authoritative.
    expect(updated.session_uid).toBe("session-graph");
  });

  it("fills task_uid and expected_version from the ledger when absent", async () => {
    const runtime = tempDir("mindgraph-r4b-runtime-");
    const root = tempDir("mindgraph-r4b-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const c = client();
    await ledgerWithClaim(runtime, root, c);
    const out = (await runClaudeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "r4-session",
        cwd: root,
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: { action: "heartbeat" },
      },
      c,
      { agentId: "r4-agent", runtimeDir: runtime }
    )) as {
      hookSpecificOutput: { updatedInput: Record<string, unknown> };
    };
    const updated = out.hookSpecificOutput.updatedInput;
    expect(updated.task_uid).toBe("ledger-task");
    expect(updated.expected_version).toBe(2);
  });
});

describe("R5 — hook connection settings persist user-level, mode 600", () => {
  it("saves, merges, and loads outside the environment", () => {
    // Failure pinned: install-hooks accepted --api-key/--base-url but stored
    // them nowhere; hooks only worked when Claude's process env happened to
    // carry MINDGRAPH_* — a silent permanent no-op for everyone else.
    const dir = tempDir("mindgraph-r5-");
    const file = saveHookEnv(
      { apiKey: "k-1", baseUrl: "http://127.0.0.1:18795" },
      dir
    );
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadHookEnv(dir)).toEqual({
      apiKey: "k-1",
      baseUrl: "http://127.0.0.1:18795",
    });
    // Partial update merges rather than clobbering.
    saveHookEnv({ baseUrl: "http://other:1" }, dir);
    expect(loadHookEnv(dir)).toEqual({
      apiKey: "k-1",
      baseUrl: "http://other:1",
    });
  });
});

describe("R6 — install-code --hooks single-command path", () => {
  it("parseArgs accepts --hooks and keeps the command", () => {
    const parsed = parseArgs([
      "node", "cli.js", "install-code",
      "--api-key", "mg_k", "--hooks", "--base-url", "http://x",
    ]);
    expect(parsed.command).toBe("install-code");
    expect(parsed.hooks).toBe(true);
    expect(parsed.apiKey).toBe("mg_k");
  });
  it("defaults hooks to false", () => {
    expect(parseArgs(["node", "cli.js", "install-code"]).hooks).toBe(false);
  });
});

describe("R7 — pinned hook runner replaces per-invocation npx", () => {
  it("copies the executing bundle to ~/.mindgraph/bin and raises SessionStart timeout", () => {
    // Failure pinned: `npx -y mindgraph-mcp@latest` per hook invocation cost
    // ~10s of package re-resolution; SessionStart produced a correct brief in
    // 12.7s against an 8s timeout and was silently killed in both live-test
    // sessions.
    const home = tempDir("mindgraph-r7-home-");
    const source = path.join(home, "fake-cli.cjs");
    fs.writeFileSync(source, "// bundle");
    const target = installHookRunner(source, home);
    expect(fs.readFileSync(target, "utf8")).toBe("// bundle");
    expect(target).toContain(".mindgraph/bin/mindgraph-hook.cjs");
    uninstallHookRunner(home);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("the built bundle executes from an isolated directory (no node_modules)", () => {
    // Failure pinned (bug #7): tsup externalizes `dependencies` by default, so
    // the copied runner still required "mindgraph" from a node_modules that
    // does not exist in ~/.mindgraph/bin — SessionStart crashed with a
    // cjs/loader error. Every earlier test executed the bundle from the repo
    // directory, where the require resolves; this one copies it away first.
    const bundle = path.join(__dirname, "..", "dist", "cli.js");
    if (!fs.existsSync(bundle)) return; // unit runs without a prior build
    const iso = tempDir("mindgraph-r7-iso-");
    const runner = path.join(iso, "runner.cjs");
    fs.copyFileSync(bundle, runner);
    const out = execFileSync("node", [runner, "hook", "--harness", "claude-code", "--owner", "mindgraph"], {
      cwd: iso,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "iso", cwd: iso, stop_hook_active: true }),
      env: { ...process.env, MINDGRAPH_API_KEY: "", MINDGRAPH_RUNTIME_DIR: iso },
    });
    expect(out.toString().trim()).toBe("{}");

    const root = tempDir("mindgraph-r7-root-");
    fs.mkdirSync(path.join(root, ".git"));
    installClaudeHooks("project", root);
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
    };
    const sessionStart = settings.hooks.SessionStart[0].hooks[0];
    expect(sessionStart.timeout).toBeGreaterThanOrEqual(20);
  });
});

describe("R8 — sync tool surfaces server error bodies", () => {
  it("includes the typed body in sync_failed errors", async () => {
    // Failure pinned: the live import saw bare "failed: 403" and had to curl
    // to discover identity_namespace_forbidden.
    const boom = new MindGraphError("POST /memory/sync failed: 403", 403, {
      error: "missing capability identity:write:coding.memory-file",
      code: "identity_namespace_forbidden",
    });
    expect(errorDetail(boom)).toContain("identity_namespace_forbidden");
    const client = {
      memorySync: vi.fn().mockRejectedValue(boom),
    } as unknown as MindGraph;
    const root = tempDir("mindgraph-r8-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const result = await handleSyncTool(client, {
      action: "status",
      repo: root,
    });
    const text = result.content[0].text;
    expect(result.isError).toBe(true);
    expect(text).toContain("identity_namespace_forbidden");
  });
});

describe("R9 — reason maps prose into props (server wire contract)", () => {
  it("forwards claim.content, warrant.content, evidence.description via props", async () => {
    // Failure pinned: ArgumentRequest carries prose in props; a top-level
    // `content` key is silently dropped by serde — the live import's claims
    // landed with empty content and were backfilled by hand.
    const argue = vi.fn().mockResolvedValue({ ok: true });
    const client = { argue } as unknown as MindGraph;
    await handleTool(client, "mindgraph_reason", {
      action: "claim",
      claim: { label: "L7 resolver is fragile", content: "detailed prose", confidence: 0.9 },
      evidence: [{ label: "audit", description: "seen in prod" }],
      warrant: { label: "warrant", content: "because" },
    });
    expect(argue).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: expect.objectContaining({ props: { content: "detailed prose" } }),
        evidence: [expect.objectContaining({ props: { description: "seen in prod" } })],
        warrant: expect.objectContaining({ props: { content: "because" } }),
      })
    );
  });
});

describe("R10 — re-install continues past an existing MCP registration", () => {
  it("classifies already-exists, missing CLI, and real failures distinctly", () => {
    // Failure pinned: on re-install, `claude mcp add` refuses the duplicate,
    // the old catch printed "Is Claude Code CLI installed?" and exited BEFORE
    // --hooks ran — upgrades never received new hook entries.
    const exists = Object.assign(new Error("exit 1"), {
      status: 1,
      stderr: Buffer.from("MCP server mindgraph already exists in local config"),
    });
    expect(classifyMcpAddFailure(exists)).toBe("already-exists");
    const enoent = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    });
    expect(classifyMcpAddFailure(enoent)).toBe("missing-cli");
    const real = Object.assign(new Error("exit 1"), {
      status: 1,
      stderr: Buffer.from("invalid flag"),
    });
    expect(classifyMcpAddFailure(real)).toBe("other");
  });
});

describe("R11 — install-hooks upserts owned entries", () => {
  it("refreshes stale owned entries and preserves foreign hooks", () => {
    // Failure pinned: skip-if-present reported "Installed 0" on upgrade while
    // leaving the old npx command and 8s timeout in place.
    const root = tempDir("mindgraph-r11-");
    fs.mkdirSync(path.join(root, ".git"));
    const first = installClaudeHooks("project", root);
    expect(first.added).toBeGreaterThan(0);
    const file = path.join(root, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    // Simulate a 0.14.0-era stale entry + a user's own hook alongside.
    settings.hooks.SessionStart[0].hooks[0].command =
      "npx -y mindgraph-mcp@latest hook --harness claude-code --owner mindgraph";
    settings.hooks.SessionStart[0].hooks[0].timeout = 8;
    settings.hooks.SessionStart.push({
      matcher: "startup",
      hooks: [{ type: "command", command: "echo user-hook", timeout: 5 }],
    });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));

    const second = installClaudeHooks("project", root);
    expect(second.updated).toBeGreaterThan(0);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    const owned = after.hooks.SessionStart.filter((e: { hooks: Array<{ command: string }> }) =>
      e.hooks.some((h) => h.command.includes("--owner mindgraph"))
    );
    expect(owned).toHaveLength(1);
    expect(owned[0].hooks[0].command).toContain("$HOME/.mindgraph/bin/mindgraph-hook.cjs");
    expect(owned[0].hooks[0].timeout).toBeGreaterThanOrEqual(20);
    const foreign = after.hooks.SessionStart.filter((e: { hooks: Array<{ command: string }> }) =>
      e.hooks.some((h) => h.command === "echo user-hook")
    );
    expect(foreign).toHaveLength(1);
  });
});

describe("R12 — per-member agent identity", () => {
  it("parses --agent-id and persists it for hooks", () => {
    // Two teammates defaulting to agent_id "claude-code" are ONE logical
    // agent: resume selection and lease recovery cross-claim each other's
    // tasks (the L4 same-agent takeover, but between humans). --agent-id
    // gives each member a distinct identity, persisted where hooks read it.
    const parsed = parseArgs([
      "node", "cli.js", "install-code",
      "--api-key", "mg_k", "--hooks", "--agent-id", "claude-code:shan",
    ]);
    expect(parsed.agentId).toBe("claude-code:shan");
    const dir = tempDir("mindgraph-r12-");
    saveHookEnv({ apiKey: "k", agentId: "claude-code:shan" }, dir);
    expect(loadHookEnv(dir).agentId).toBe("claude-code:shan");
    // Partial re-save preserves it.
    saveHookEnv({ baseUrl: "http://x" }, dir);
    expect(loadHookEnv(dir).agentId).toBe("claude-code:shan");
  });
});

describe("R13 — absent codegraph carries a self-serve install hint", () => {
  it("the unavailable caveats tell the model how to enable code intelligence", async () => {
    const { unavailabilityCaveats } = await import("../src/codegraph.js");
    const absent = unavailabilityCaveats("absent", "codegraph executable not found");
    expect(absent.join(" ")).toContain("codegraph init");
    expect(absent.join(" ")).toContain("Memory and work tools are unaffected");
    const timeout = unavailabilityCaveats("timeout", "timed out");
    expect(timeout.join(" ")).not.toContain("codegraph init");
  });
});

describe("R14 — recall steering for work-state questions", () => {
  it("the retrieve description redirects work-state questions to resume_work", () => {
    const retrieve = TOOLS.find((t) => t.name === "mindgraph_retrieve");
    expect(retrieve?.description).toContain("resume_work");
    expect(retrieve?.description).toContain("NOT for work state");
  });
});

describe("R15 — coding profile scopes documents out of context by default", () => {
  it("drops the article leg unless include_documents is passed", async () => {
    const retrieveContext = vi.fn().mockResolvedValue({ nodes: [] });
    const client = { retrieveContext } as unknown as MindGraph;
    const prior = process.env.MINDGRAPH_PROFILE;
    process.env.MINDGRAPH_PROFILE = "coding";
    try {
      await handleTool(client, "mindgraph_retrieve", { action: "context", query: "greet" });
      expect(retrieveContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ article_limit: 0 })
      );
      await handleTool(client, "mindgraph_retrieve", {
        action: "context", query: "PRD greet", include_documents: true,
      });
      expect(retrieveContext).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ article_limit: 0 })
      );
      process.env.MINDGRAPH_PROFILE = "general";
      await handleTool(client, "mindgraph_retrieve", { action: "context", query: "greet" });
      expect(retrieveContext).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ article_limit: 0 })
      );
    } finally {
      process.env.MINDGRAPH_PROFILE = prior;
    }
  });
});

describe("R16 — the verbatim Codex hook command is self-contained", () => {
  it("parses and executes every Codex event from an isolated directory", () => {
    // Failure pinned: R1 and R7 each killed every installed Claude hook once.
    // The Codex adapter must prove both properties on the exact command it
    // writes: --owner is consumed, and the copied bundle needs no node_modules.
    const bundle = path.join(__dirname, "..", "dist", "cli.js");
    if (!fs.existsSync(bundle)) return; // exercised when the release build exists
    const root = tempDir("mindgraph-r16-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const home = tempDir("mindgraph-r16-home-");
    const isolated = tempDir("mindgraph-r16-iso-");
    installHookRunner(bundle, home);
    installCodexHooks("project", root);
    const settings = JSON.parse(
      fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8")
    ) as {
      hooks: Record<
        string,
        Array<{
          hooks: Array<{ command: string; commandWindows?: string }>;
        }>
      >;
    };

    const events: Array<Record<string, unknown>> = [
      {
        hook_event_name: "SessionStart",
        session_id: "r16",
        cwd: isolated,
        source: "startup",
        model: "gpt-test",
      },
      {
        hook_event_name: "PreToolUse",
        session_id: "r16",
        turn_id: "turn-1",
        cwd: isolated,
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: { action: "resume_work" },
      },
      {
        hook_event_name: "PostToolUse",
        session_id: "r16",
        turn_id: "turn-1",
        cwd: isolated,
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: { action: "resume_work" },
        tool_response: { ok: true },
      },
      {
        hook_event_name: "Stop",
        session_id: "r16",
        turn_id: "turn-1",
        cwd: isolated,
        stop_hook_active: false,
      },
      {
        hook_event_name: "SessionEnd",
        session_id: "r16",
        cwd: isolated,
        reason: "other",
      },
    ];

    for (const event of events) {
      const configured =
        settings.hooks[event.hook_event_name as string][0].hooks[0];
      expect(configured.command).not.toContain("npx");
      const tokens = configured.command.split(/\s+/);
      const parsed = parseArgs(["node", "cli.js", ...tokens.slice(2)]);
      expect(parsed).toMatchObject({ command: "hook", harness: "codex" });

      const command =
        process.platform === "win32"
          ? configured.commandWindows!
          : configured.command;
      const executable = process.platform === "win32" ? "cmd" : "/bin/sh";
      const args =
        process.platform === "win32"
          ? ["/d", "/s", "/c", command]
          : ["-c", command];
      const out = execFileSync(executable, args, {
        cwd: isolated,
        input: JSON.stringify(event),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          MINDGRAPH_API_KEY: "",
          MINDGRAPH_RUNTIME_DIR: path.join(home, "runtime"),
        },
      });
      // Missing connection settings are the harness no-op, never a crash.
      expect(out.toString().trim()).toBe("{}");
    }
  });
});

describe("R17 — cold SessionStart has cross-harness cloud margin", () => {
  it("gives both harnesses 30 seconds for the shared resume path", () => {
    // Failure pinned: the canonical B7 live run crossed Claude's inherited
    // 20-second edge at 20.034s. The hook correctly failed open, but Claude
    // received no brief while Codex received one from the same shared runner.
    const root = tempDir("mindgraph-r17-root-");
    fs.mkdirSync(path.join(root, ".git"));
    installClaudeHooks("project", root);
    installCodexHooks("project", root);
    const claude = JSON.parse(
      fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"),
    );
    const codex = JSON.parse(
      fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"),
    );
    expect(claude.hooks.SessionStart[0].hooks[0].timeout).toBe(30);
    expect(codex.hooks.SessionStart[0].hooks[0].timeout).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// R19–R24 pin the session-continuity audit findings (2026-07-29): ledger
// lifecycle drift, cross-task field pairing, unclaimed-task adoption, lease
// renewal, and conflict re-sync.
// ─────────────────────────────────────────────────────────────────────────

function continuityClient(overrides?: {
  resume?: Record<string, unknown>;
  plans?: Array<Record<string, unknown>>;
}): HookClient {
  const plans = overrides?.plans ?? [];
  return {
    async session() {
      return { uid: "session-graph" };
    },
    async plan(request: Record<string, unknown>) {
      plans.push(request);
      if (request.action === "claim_task") {
        return {
          task_version: 2,
          lease_epoch: 4,
          lease_expires_at: 9_999_999_999,
        };
      }
      if (request.action === "resume_work") {
        return (
          overrides?.resume ?? {
            task: { uid: "ledger-task", version: request.task_uid ? 2 : 1 },
            lease: {
              lease_owner_agent_id: "continuity-agent",
              lease_epoch: 3,
              lease_expires_at: 1,
            },
            selection_reason: "claimed",
            active_execution: { uid: "exec-running", status: "running" },
          }
        );
      }
      return {};
    },
  } as unknown as HookClient;
}

async function claimedLedger(
  runtime: string,
  root: string,
  c: HookClient,
  now?: () => number,
) {
  await runClaudeHook(
    {
      hook_event_name: "SessionStart",
      session_id: "continuity-session",
      cwd: root,
      source: "startup",
    },
    c,
    { agentId: "continuity-agent", runtimeDir: runtime, now },
  );
}

async function preToolFills(
  runtime: string,
  root: string,
  c: HookClient,
  toolInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out = (await runClaudeHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "continuity-session",
      cwd: root,
      tool_name: "mcp__mindgraph__mindgraph_plan",
      tool_input: toolInput,
    },
    c,
    { agentId: "continuity-agent", runtimeDir: runtime },
  )) as { hookSpecificOutput: { updatedInput: Record<string, unknown> } };
  return out.hookSpecificOutput.updatedInput;
}

describe("R19 — completing the task clears the ledger's work-targeting state", () => {
  it("stops filling task fields after a successful complete_task", async () => {
    // Failure pinned: the ledger kept taskUid/version/epoch after
    // complete_task, so the model's next implicit resume_work was rewritten
    // into an EXPLICIT resume of the COMPLETED task — no_eligible_work for
    // the rest of the session, and the explicit path bypasses the
    // extraction-provenance guard shipped for the 2026-07-29 incident.
    const runtime = tempDir("mindgraph-r19-runtime-");
    const root = tempDir("mindgraph-r19-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const c = continuityClient();
    await claimedLedger(runtime, root, c);
    await runClaudeHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "continuity-session",
        cwd: root,
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: { action: "complete_task" },
        tool_response: { uid: "ledger-task", version: 3, lease_released: true },
      },
      c,
      { agentId: "continuity-agent", runtimeDir: runtime },
    );
    const updated = await preToolFills(runtime, root, c, {
      action: "resume_work",
    });
    expect(updated.session_uid).toBe("session-graph");
    expect(updated.task_uid).toBeUndefined();
    expect(updated.expected_version).toBeUndefined();
    expect(updated.lease_epoch).toBeUndefined();
    expect(updated.execution_uid).toBeUndefined();
  });
});

describe("R20 — ledger fencing state never pairs with a different model task", () => {
  it("injects nothing but session identity when the model targets task B", async () => {
    // Failure pinned: fills were gated only on each field's own absence, so
    // a model call naming task B received task A's expected_version,
    // lease_epoch and execution_uid — guaranteed version_conflict /
    // lease_fenced 409s and cross-task execution attribution (both observed
    // in live runtime ledgers).
    const runtime = tempDir("mindgraph-r20-runtime-");
    const root = tempDir("mindgraph-r20-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const c = continuityClient();
    await claimedLedger(runtime, root, c);
    const other = await preToolFills(runtime, root, c, {
      action: "claim_task",
      task_uid: "model-chosen-task",
    });
    expect(other.task_uid).toBe("model-chosen-task");
    expect(other.expected_version).toBeUndefined();
    expect(other.lease_epoch).toBeUndefined();
    expect(other.execution_uid).toBeUndefined();
    // Control: the ledger task still receives the full fencing fill.
    const own = await preToolFills(runtime, root, c, {
      action: "checkpoint_iteration",
    });
    expect(own.task_uid).toBe("ledger-task");
    expect(own.expected_version).toBe(2);
    expect(own.lease_epoch).toBe(4);
    expect(own.execution_uid).toBe("exec-running");
  });
});

describe("R21 — an unclaimed surfaced task is context, not bookkeeping", () => {
  it("adopts nothing into the ledger for a foreign backlog task", async () => {
    // Failure pinned: SessionStart wrote the surfaced task into the ledger
    // even when the claim gate declined it, so every capture was stamped
    // with a task the agent never owned — and the ledger copied ANOTHER
    // AGENT'S lease epoch as its own fencing token.
    const runtime = tempDir("mindgraph-r21-runtime-");
    const root = tempDir("mindgraph-r21-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const c = continuityClient({
      resume: {
        task: { uid: "someone-elses-task", version: 5 },
        lease: {
          lease_owner_agent_id: "another-user",
          lease_epoch: 11,
          lease_expires_at: 1,
        },
        selection_reason: "in_progress",
      },
    });
    await claimedLedger(runtime, root, c);
    const updated = await preToolFills(runtime, root, c, {
      action: "resume_work",
    });
    expect(updated.session_uid).toBe("session-graph");
    expect(updated.task_uid).toBeUndefined();
    expect(updated.lease_epoch).toBeUndefined();
    expect(updated.expected_version).toBeUndefined();
  });
});

describe("R22 — an expired lease is re-claimed, not heartbeaten", () => {
  it("issues claim_task when the lease lapsed mid-session", async () => {
    // Failure pinned: heartbeats only fired within 60s of expiry per the
    // SERVER clock; any >TTL quiet stretch (long build, user away) expired
    // the lease and every later heartbeat 409'd silently — durable tracking
    // was off for the rest of the session with no recovery path.
    const runtime = tempDir("mindgraph-r22-runtime-");
    const root = tempDir("mindgraph-r22-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const plans: Array<Record<string, unknown>> = [];
    let clock = 50;
    const c = continuityClient({
      plans,
      resume: {
        task: { uid: "ledger-task", version: 1 },
        lease: {
          lease_owner_agent_id: "continuity-agent",
          lease_epoch: 3,
          // Expired at clock 50 — the rebind path SessionStart may claim.
          lease_expires_at: 40,
        },
        selection_reason: "claimed",
      },
    });
    // Make claim return the soon-expiring lease too.
    const base = c.plan.bind(c);
    c.plan = async (request: Record<string, unknown>) => {
      const response = (await base(request)) as Record<string, unknown>;
      if (request.action === "claim_task" && clock < 100) {
        return { ...response, lease_expires_at: 100 };
      }
      return response;
    };
    await claimedLedger(runtime, root, c, () => clock);
    clock = 500; // Well past expiry, far beyond any heartbeat window.
    await runClaudeHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "continuity-session",
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_response: {},
      },
      c,
      { agentId: "continuity-agent", runtimeDir: runtime, now: () => clock },
    );
    const reclaim = plans.find(
      (request) =>
        request.action === "claim_task" &&
        String(request.idempotency_key || "").startsWith("hook-reclaim:"),
    );
    expect(reclaim).toBeDefined();
    expect(reclaim).toMatchObject({ task_uid: "ledger-task" });
  });
});

describe("R23 — structured conflict payloads re-sync the ledger", () => {
  it("adopts current_version/current_epoch from a 409 body", async () => {
    // Failure pinned: a fenced ledger replayed its stale epoch forever —
    // error bodies carried the current state only in prose, so the hook
    // could never self-heal and every subsequent call 409'd.
    const runtime = tempDir("mindgraph-r23-runtime-");
    const root = tempDir("mindgraph-r23-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const c = continuityClient();
    await claimedLedger(runtime, root, c);
    await runClaudeHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "continuity-session",
        cwd: root,
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: { action: "checkpoint_iteration" },
        tool_response: {
          error: "version_conflict",
          current_version: 9,
          current_epoch: 6,
        },
      },
      c,
      { agentId: "continuity-agent", runtimeDir: runtime },
    );
    const updated = await preToolFills(runtime, root, c, {
      action: "checkpoint_iteration",
    });
    expect(updated.expected_version).toBe(9);
    expect(updated.lease_epoch).toBe(6);
  });
});

describe("R24 — a PlanStep's version never clobbers the task version", () => {
  it("ignores a bare version whose uid is not the ledger task", async () => {
    // Failure pinned: update_status on a Plan/PlanStep returns the STEP's
    // version at the top level; the ledger adopted it as the task version
    // and the next fenced write 409'd against a number belonging to a
    // different node.
    const runtime = tempDir("mindgraph-r24-runtime-");
    const root = tempDir("mindgraph-r24-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const c = continuityClient();
    await claimedLedger(runtime, root, c);
    await runClaudeHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "continuity-session",
        cwd: root,
        tool_name: "mcp__mindgraph__mindgraph_plan",
        tool_input: { action: "update_status" },
        tool_response: { uid: "plan-step-7", status: "completed", version: 41 },
      },
      c,
      { agentId: "continuity-agent", runtimeDir: runtime },
    );
    const updated = await preToolFills(runtime, root, c, {
      action: "checkpoint_iteration",
    });
    expect(updated.expected_version).toBe(2);
  });
});

describe("R25 — structured conflict state survives the tool error envelope", () => {
  it("spreads 409 fencing fields as JSON siblings of `error`", async () => {
    // Failure pinned: errorDetail() flattened the server's structured 409
    // body INTO the error string, so the hooks' ledger re-sync (which reads
    // current_version/current_epoch as top-level keys of the parsed tool
    // text) could never see them — a fenced session replayed its stale
    // epoch forever even against a server that reported the fresh state.
    const client = {
      plan: vi.fn().mockRejectedValue(
        new MindGraphError("POST /agent/plan failed: 409", 409, {
          error: "version_conflict",
          code: "version_conflict",
          current_version: 9,
          current_epoch: 6,
          lease_expires_at: 1_234,
        })
      ),
    } as unknown as MindGraph;
    const result = await handleTool(client, "mindgraph_plan", {
      action: "checkpoint_iteration",
      task_uid: "task-1",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(typeof payload.error).toBe("string");
    expect(payload.current_version).toBe(9);
    expect(payload.current_epoch).toBe(6);
    expect(payload.lease_expires_at).toBe(1_234);
    // The prose keeps the full body for the model.
    expect(payload.error).toContain("version_conflict");
  });
});

describe("R26 — an unanchored repository is anchored at SessionStart, not skipped", () => {
  it("creates the repository identity and scopes resume with its uid", async () => {
    // Failure pinned (caught by the local E2E): resolve_identity returning
    // "absent" was silently skipped, so a repo whose identity had never
    // been anchored ran every session UNSCOPED — a task scoped to repo B
    // surfaced in repo A's sessions.
    const root = tempDir("mindgraph-r26-root-");
    fs.mkdirSync(path.join(root, ".git"));
    const plans: Array<Record<string, unknown>> = [];
    const entityCalls: Array<Record<string, unknown>> = [];
    const client = {
      async session() {
        return { uid: "session-graph" };
      },
      async plan(request: Record<string, unknown>) {
        plans.push(request);
        return {};
      },
      async entity(request: Record<string, unknown>) {
        entityCalls.push(request);
        if (request.action === "resolve_identity") {
          return { status: "absent" };
        }
        return { uid: "anchored-repo-uid", status: "created" };
      },
    } as unknown as HookClient;
    await runClaudeHook(
      {
        hook_event_name: "SessionStart",
        session_id: "r26-session",
        cwd: root,
        source: "startup",
      },
      client,
      { agentId: "r26-agent", runtimeDir: tempDir("mindgraph-r26-runtime-") },
    );
    const anchor = entityCalls.find((call) => call.action === "create");
    expect(anchor).toBeDefined();
    expect(anchor).toMatchObject({
      identity: expect.objectContaining({ namespace: "external.code" }),
    });
    expect(plans.find((request) => request.action === "resume_work")).toMatchObject({
      scope_uids: ["anchored-repo-uid"],
    });
  });
});
