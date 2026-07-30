import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  installCodexHooks,
  installHookRunner,
} from "../src/hook-installer.js";

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

function executeHook(
  command: string,
  input: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" ? "cmd" : "/bin/sh";
    const args =
      process.platform === "win32"
        ? ["/d", "/s", "/c", command]
        : ["-c", command];
    const child = spawn(executable, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`hook exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout || "{}") as Record<string, unknown>);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

describe("Codex installed-runner contract", () => {
  it("normalizes every lifecycle event through the verbatim installed command", async () => {
    // Failure pinned: codec-only tests cannot catch an installed runner that
    // parses but sends the wrong HTTP/wire output. This executes the copied
    // self-contained bundle for every Codex event against a synthetic tenant.
    const bundle = path.join(__dirname, "..", "dist", "cli.js");
    if (!fs.existsSync(bundle)) return;

    const root = tempDir("mindgraph-codex-runner-root-");
    const home = tempDir("mindgraph-codex-runner-home-");
    const isolated = tempDir("mindgraph-codex-runner-iso-");
    const requestLog = path.join(home, "requests.jsonl");
    const preload = path.join(home, "mock-fetch.cjs");
    fs.writeFileSync(
      preload,
      `
const fs = require("node:fs");
global.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || "{}");
  fs.appendFileSync(
    process.env.MINDGRAPH_TEST_REQUESTS,
    JSON.stringify({ path: String(url), ...body }) + "\\n",
  );
  let result = {};
  if (body.action === "open") {
    result = { uid: "runner-session" };
  } else if (body.action === "resume_work") {
    result = {
      task: {
        uid: "runner-task",
        label: "Runner contract task",
        version: body.task_uid ? 2 : 1,
      },
      // Expired own lease — the sanctioned cross-session rebind. A live
      // lease belongs to a concurrent session and is never claimed at
      // SessionStart.
      lease: {
        lease_epoch: 7,
        lease_expires_at: 1,
        lease_owner_agent_id: "runner-agent",
      },
      active_execution: {
        uid: "runner-execution",
        status: "running",
      },
      blockers: [{ summary: "synthetic blocker" }],
      next_action: "synthetic next action",
    };
  } else if (body.action === "claim_task") {
    result = {
      task_version: 2,
      lease_epoch: 7,
      lease_expires_at: 9999999999,
    };
  } else if (body.action === "abandon_iteration") {
    result = { task_version: 3, lease_released: true };
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
    );
    fs.mkdirSync(path.join(root, ".git"));
    installHookRunner(bundle, home);
    installCodexHooks("project", root);
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(root, ".codex", "hooks.json"),
        "utf8",
      ),
    );
    const configured = (event: string) => {
      const hook = settings.hooks[event][0].hooks[0];
      return process.platform === "win32"
        ? hook.commandWindows
        : hook.command;
    };
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NODE_OPTIONS: `--require=${preload}`,
      MINDGRAPH_API_KEY: "mg_runner_contract",
      MINDGRAPH_BASE_URL: "http://mindgraph.invalid",
      MINDGRAPH_AGENT_ID: "runner-agent",
      MINDGRAPH_RUNTIME_DIR: path.join(home, "runtime"),
      MINDGRAPH_TEST_REQUESTS: requestLog,
    };
    const start = {
      hook_event_name: "SessionStart",
      session_id: "runner-thread",
      cwd: isolated,
      source: "startup",
      model: "gpt-test",
    };
    const first = await executeHook(
      configured("SessionStart"),
      start,
      isolated,
      env,
    );
    const repeated = await executeHook(
      configured("SessionStart"),
      start,
      isolated,
      env,
    );
    expect(first).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
      },
    });
    expect(
      (
        first.hookSpecificOutput as Record<string, unknown>
      ).additionalContext,
    ).toContain("Runner contract task");
    expect(repeated).toEqual({});

    const pre = await executeHook(
      configured("PreToolUse"),
      {
        hook_event_name: "PreToolUse",
        session_id: "runner-thread",
        turn_id: "runner-turn",
        cwd: isolated,
        model: "gpt-test",
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
      isolated,
      env,
    );
    const specific = pre.hookSpecificOutput as Record<string, unknown>;
    expect(specific.permissionDecision).toBe("allow");
    expect(specific.updatedInput).toMatchObject({
      task_uid: "model-task",
      expected_version: 41,
      lease_epoch: 13,
      execution_uid: "model-execution",
      session_uid: "runner-session",
      invocation_context: {
        harness: "codex",
        harnessSessionId: "runner-thread",
        harnessTurnId: "runner-turn",
        injectedBy: "hook",
      },
    });

    for (let index = 0; index < 2; index += 1) {
      expect(
        await executeHook(
          configured("PostToolUse"),
          {
            hook_event_name: "PostToolUse",
            session_id: "runner-thread",
            turn_id: "runner-turn",
            cwd: isolated,
            tool_name: "apply_patch",
            tool_input: { patch: index },
            tool_response: { ok: true },
          },
          isolated,
          env,
        ),
      ).toEqual({});
    }
    const stop = await executeHook(
      configured("Stop"),
      {
        hook_event_name: "Stop",
        session_id: "runner-thread",
        turn_id: "runner-turn",
        cwd: isolated,
        stop_hook_active: false,
      },
      isolated,
      env,
    );
    expect(stop).toMatchObject({ decision: "block" });
    expect(
      await executeHook(
        configured("Stop"),
        {
          hook_event_name: "Stop",
          session_id: "runner-thread",
          turn_id: "runner-turn",
          cwd: isolated,
          stop_hook_active: true,
        },
        isolated,
        env,
      ),
    ).toEqual({});
    expect(
      await executeHook(
        configured("SessionEnd"),
        {
          hook_event_name: "SessionEnd",
          session_id: "runner-thread",
          cwd: isolated,
          reason: "other",
        },
        isolated,
        env,
      ),
    ).toEqual({});

    const requests = fs
      .readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "open",
          harness: "codex",
          harness_session_id: "runner-thread",
        }),
        expect.objectContaining({
          action: "claim_task",
          task_uid: "runner-task",
        }),
        expect.objectContaining({
          action: "abandon_iteration",
          execution_uid: "runner-execution",
        }),
      ]),
    );
    // Codex clamps SessionEnd to 3s — one call fits, and the abandon (which
    // releases the lease) wins over the close.
    expect(requests).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "close" })]),
    );
  });
});
