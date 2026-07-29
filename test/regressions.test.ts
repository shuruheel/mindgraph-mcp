import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MindGraphError, type MindGraph } from "mindgraph";
import { handleTool } from "../src/tools.js";
import { runClaudeHook, type HookClient } from "../src/claude-hooks.js";
import {
  installClaudeHooks,
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
            lease: null,
            selection_reason: "pending",
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
