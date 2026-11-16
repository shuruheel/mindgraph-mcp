// Invariant (plan §5 Protocol): with MINDGRAPH_EVAL=1 the MCP server, every
// hook and `import notes` talk only to a loopback MindGraph, and refuse any
// other base URL with `eval_requires_loopback` before a request is made.
// Also: one MINDGRAPH_HOME moves hooks.json, the hook runner and the runtime
// directory together, and MINDGRAPH_HOOK_AUTOUPDATE=off leaves the runner as
// it is.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  assertEvalBaseUrl,
  EVAL_REQUIRES_CONFIG_DIR,
  EVAL_REQUIRES_HOME,
  EVAL_REQUIRES_LOOPBACK,
  EvalLoopbackError,
  evalAppConfigRefusal,
  evalBaseUrlRefusal,
  evalClaudeReadRefusal,
  evalHomeRefusal,
  evalUserScopeRefusal,
  isLoopbackUrl,
} from "../src/eval-guard.js";
import { refreshRunnerForConsent } from "../src/consent-cli.js";
import { mindgraphDataDir, mindgraphRuntimeDir } from "../src/hook-env.js";
import {
  gateFloorWarning,
  installClaudeHooks,
  installedHookRunnerVersion,
  installHookRunner,
  refreshHookRunner,
  refreshOwnedClaudeHooks,
  refreshPortableRunnerBelowGate,
  runnerPredatesGate,
  uninstallClaudeHooks,
  uninstallCodexHooks,
  uninstallHookRunner,
} from "../src/hook-installer.js";
import { built, makeRepo, repoEntry, snapshotTree, tempDir, writeStore } from "./fixtures/consent.js";

const ENTRY = path.join(__dirname, "..", "dist", "index.js");
const CLI = path.join(__dirname, "..", "dist", "cli.js");
const RECORDER = path.join(__dirname, "fixtures", "fetch-recorder.cjs");

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix = "mindgraph-eval-"): string {
  const dir = tempDir(prefix);
  cleanup.push(dir);
  return dir;
}

function requests(log: string): unknown[] {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Like `run`, but writes one answer each time the process prints a prompt
 * (output ending in ": "), and closes stdin when the answers run out. */
function runAnswering(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  answers: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      const text = c.toString("utf8");
      stdout += text;
      // A prompt is written on its own and waits for the answer.
      if (!text.endsWith(": ")) return;
      const answer = answers.shift();
      if (answer === undefined) child.stdin.end();
      else child.stdin.write(`${answer}\n`);
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function run(
  args: string[],
  env: Record<string, string>,
  options: { cwd?: string; stdin?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}

describe("isLoopbackUrl", () => {
  it("accepts localhost, 127.0.0.0/8 and ::1 only", () => {
    for (const url of [
      "http://localhost:18790",
      "http://LOCALHOST",
      "https://127.0.0.1",
      "http://127.1.2.3:9/api",
      "http://127.1", // canonicalised to 127.0.0.1
      "http://0x7f.0.0.1",
      "http://[::1]:18790",
      "http://[0:0:0:0:0:0:0:1]",
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
    for (const url of [
      "https://api.mindgraph.cloud",
      "http://128.0.0.1",
      "http://10.0.0.1",
      "http://0.0.0.0",
      "http://[::]",
      "http://[::ffff:127.0.0.1]",
      "http://localhost.mindgraph.cloud",
      "http://127.0.0.1.nip.io",
      "http://127.0.0.1@api.mindgraph.cloud",
      "ftp://127.0.0.1",
      "file:///tmp/x",
      "not a url",
      "",
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });
});

describe("evalBaseUrlRefusal", () => {
  it("is off unless MINDGRAPH_EVAL is exactly 1", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      expect(evalBaseUrlRefusal("https://api.mindgraph.cloud", { MINDGRAPH_EVAL: value })).toBeUndefined();
    }
  });

  it("refuses a non-loopback URL with the code, naming the host only", () => {
    const refusal = evalBaseUrlRefusal("https://user:secret@api.mindgraph.cloud/v1?k=1", {
      MINDGRAPH_EVAL: "1",
    });
    expect(refusal).toMatch(new RegExp(`^${EVAL_REQUIRES_LOOPBACK}: `));
    expect(refusal).toContain("api.mindgraph.cloud");
    expect(refusal).not.toContain("secret");
    expect(refusal).not.toContain("/v1");
    expect(evalBaseUrlRefusal("http://127.0.0.1:18790", { MINDGRAPH_EVAL: "1" })).toBeUndefined();
  });

  it("assertEvalBaseUrl throws a typed error and passes loopback through", () => {
    const env = { MINDGRAPH_EVAL: "1" };
    expect(() => assertEvalBaseUrl("https://api.mindgraph.cloud", env)).toThrow(EvalLoopbackError);
    try {
      assertEvalBaseUrl("garbage", env);
    } catch (error) {
      expect((error as EvalLoopbackError).code).toBe(EVAL_REQUIRES_LOOPBACK);
    }
    expect(assertEvalBaseUrl("http://localhost:9", env)).toBe("http://localhost:9");
  });
});

describe.runIf(built(ENTRY))("the MCP server under MINDGRAPH_EVAL=1", () => {
  function env(base: string, baseUrl: string): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "",
      HOME: path.join(base, "home"),
      MINDGRAPH_HOME: path.join(base, "store"),
      MINDGRAPH_API_KEY: "mg_test_not_a_real_key",
      MINDGRAPH_BASE_URL: baseUrl,
      MINDGRAPH_GOVERNANCE: "off",
      MINDGRAPH_EVAL: "1",
      NODE_OPTIONS: `--require=${RECORDER}`,
      MINDGRAPH_TEST_REQUESTS: path.join(base, "requests.jsonl"),
    };
  }

  it("exits before building a client when the base URL is not loopback", async () => {
    const base = scratch();
    for (const url of ["https://api.mindgraph.cloud", "http://10.1.2.3:18790"]) {
      const result = await run([ENTRY], env(base, url), { cwd: base });
      expect(result.code, url).toBe(1);
      expect(result.stderr).toContain(EVAL_REQUIRES_LOOPBACK);
      expect(result.stdout).toBe("");
    }
    expect(requests(path.join(base, "requests.jsonl"))).toEqual([]);
  }, 20_000);

  it("exits before reading anything without an accepted MINDGRAPH_HOME", async () => {
    const base = scratch();
    const repo = makeRepo(path.join(base, "repo"));
    for (const home of [undefined, path.join(repo, "store"), "relative"]) {
      const e = env(base, "http://127.0.0.1:9");
      if (home === undefined) delete (e as Record<string, string | undefined>).MINDGRAPH_HOME;
      else e.MINDGRAPH_HOME = home;
      const result = await run([ENTRY], e, { cwd: base });
      expect(result.code, String(home)).toBe(1);
      expect(result.stderr).toContain(EVAL_REQUIRES_HOME);
      expect(result.stdout).toBe("");
    }
    expect(fs.existsSync(path.join(repo, "store"))).toBe(false);
    expect(requests(path.join(base, "requests.jsonl"))).toEqual([]);
  }, 30_000);

  it("serves as usual against a loopback server", async () => {
    const base = scratch();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      cwd: base,
      env: env(base, "http://127.0.0.1:9"),
      stderr: "ignore",
    });
    const mcp = new Client({ name: "eval-test", version: "0" });
    await mcp.connect(transport);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toContain("mindgraph_memory");
    await mcp.close();
  }, 20_000);
});

describe.runIf(built(CLI))("hooks under MINDGRAPH_EVAL=1", () => {
  function machine(baseUrl: string | undefined) {
    const base = scratch();
    const store = path.join(base, "store");
    const home = path.join(base, "home");
    fs.mkdirSync(home, { recursive: true });
    const repo = makeRepo(path.join(base, "repo"));
    writeStore(store, [repoEntry(repo)], { apiKey: "mg_file_key", ...(baseUrl ? { baseUrl } : {}) });
    const log = path.join(base, "requests.jsonl");
    // No MINDGRAPH_RUNTIME_DIR: the runtime directory follows MINDGRAPH_HOME.
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      MINDGRAPH_HOME: store,
      MINDGRAPH_EVAL: "1",
      NODE_OPTIONS: `--require=${RECORDER}`,
      MINDGRAPH_TEST_REQUESTS: log,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    return { base, store, home, repo, log, env };
  }

  const event = (repo: string, name: string) =>
    JSON.stringify({
      hook_event_name: name,
      session_id: "eval-session",
      cwd: repo,
      source: "startup",
      stop_hook_active: true,
      tool_name: "mcp__mindgraph__mindgraph_memory",
      tool_input: { action: "status" },
    });

  it("refuses a hosted base URL: fails open, sends nothing, and counts the refusal", async () => {
    const m = machine("https://api.mindgraph.cloud");
    for (const name of ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
      const result = await run([CLI, "hook", "--harness", "claude-code"], m.env, {
        cwd: m.repo,
        stdin: event(m.repo, name),
      });
      expect(result.code, name).toBe(0);
      expect(result.stdout.trim(), name).toBe("{}");
      expect(result.stderr, name).toContain(EVAL_REQUIRES_LOOPBACK);
    }
    expect(requests(m.log)).toEqual([]);
    // The runtime state sits in MINDGRAPH_HOME/runtime, nowhere under HOME.
    const runtime = path.join(m.store, "runtime");
    const health = JSON.parse(fs.readFileSync(path.join(runtime, "hook-health.json"), "utf8"));
    expect(health.lastError).toContain(EVAL_REQUIRES_LOOPBACK);
    // The per-session ledger `hooks stats` reads counts every refusal.
    const ledgers = fs
      .readdirSync(runtime)
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
      .map((name) => JSON.parse(fs.readFileSync(path.join(runtime, name), "utf8")));
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0].harnessSessionId).toBe("eval-session");
    expect(ledgers[0].failOpen.count).toBe(5);
    expect(ledgers[0].failOpen.last.reason).toBe(EVAL_REQUIRES_LOOPBACK);
    expect(snapshotTree(m.home)).toEqual({});
  }, 30_000);

  it("refuses the hosted default when hooks.json names no base URL", async () => {
    const m = machine(undefined);
    const result = await run([CLI, "hook", "--harness", "claude-code"], m.env, {
      cwd: m.repo,
      stdin: event(m.repo, "SessionStart"),
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    expect(result.stderr).toContain(EVAL_REQUIRES_LOOPBACK);
    expect(result.stderr).toContain("api.mindgraph.cloud");
    expect(requests(m.log)).toEqual([]);
  }, 30_000);

  it("hooks stats shows a session whose every hook was refused", async () => {
    const m = machine("https://api.mindgraph.cloud");
    for (const name of ["SessionStart", "Stop"]) {
      await run([CLI, "hook", "--harness", "claude-code"], m.env, { cwd: m.repo, stdin: event(m.repo, name) });
    }
    const stats = await run([CLI, "hooks", "stats", "--session-id", "eval-session"], m.env, { cwd: m.repo });
    expect(stats.code, stats.stderr).toBe(0);
    expect(stats.stdout).toContain("Session eval-session");
    expect(stats.stdout).toContain(`Failed open: 2 (last: Stop, ${EVAL_REQUIRES_LOOPBACK}`);
    expect(requests(m.log)).toEqual([]);
  }, 30_000);

  it("refuses without an accepted MINDGRAPH_HOME, before consent or hooks.json is read", async () => {
    const m = machine("http://127.0.0.1:18790");
    const runtime = path.join(m.base, "runtime");
    // Refused (inside a git work tree), relative, and missing.
    for (const home of [path.join(m.repo, "store"), "relative", undefined]) {
      const env: Record<string, string> = { ...m.env, MINDGRAPH_RUNTIME_DIR: runtime };
      if (home === undefined) delete env.MINDGRAPH_HOME;
      else env.MINDGRAPH_HOME = home;
      const result = await run([CLI, "hook", "--harness", "claude-code"], env, {
        cwd: m.repo,
        stdin: event(m.repo, "SessionStart"),
      });
      expect(result.code, String(home)).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
      expect(result.stderr).toContain(EVAL_REQUIRES_HOME);
    }
    expect(requests(m.log)).toEqual([]);
    expect(fs.existsSync(path.join(m.repo, "store"))).toBe(false);
    expect(snapshotTree(m.home)).toEqual({});
    // Recorded only in the runtime directory the environment named.
    const ledgers = fs.readdirSync(runtime).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
    expect(ledgers).toHaveLength(1);
    const ledger = JSON.parse(fs.readFileSync(path.join(runtime, ledgers[0]), "utf8"));
    expect(ledger.failOpen).toMatchObject({ count: 3, last: { reason: EVAL_REQUIRES_HOME } });
  }, 30_000);

  it("reaches a loopback base URL", async () => {
    const m = machine("http://127.0.0.1:18790");
    const result = await run([CLI, "hook", "--harness", "claude-code"], m.env, {
      cwd: m.repo,
      stdin: event(m.repo, "SessionStart"),
    });
    expect(result.stderr).not.toContain(EVAL_REQUIRES_LOOPBACK);
    const sent = requests(m.log) as Array<{ kind: string; url?: string }>;
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent.filter((r) => r.kind === "fetch")) {
      expect(new URL(r.url!).host).toBe("127.0.0.1:18790");
    }
  }, 30_000);
});

describe("MINDGRAPH_HOME moves the runner and the runtime directory with hooks.json", () => {
  const configured = () => process.env.MINDGRAPH_HOME!;

  it("an accepted override holds bin/ and runtime/", () => {
    expect(mindgraphDataDir()).toBe(configured());
    expect(mindgraphRuntimeDir()).toBe(path.join(configured(), "runtime"));
    expect(mindgraphRuntimeDir({ ...process.env, MINDGRAPH_RUNTIME_DIR: "/elsewhere" })).toBe("/elsewhere");
    // An explicit home wins over the override.
    expect(mindgraphDataDir(process.env, "/h")).toBe(path.join("/h", ".mindgraph"));
  });

  it("a refused or missing override falls back to ~/.mindgraph", () => {
    const repo = makeRepo(path.join(scratch(), "repo"));
    const fallback = path.join(os.homedir(), ".mindgraph");
    expect(mindgraphDataDir({ MINDGRAPH_HOME: path.join(repo, "store") })).toBe(fallback);
    expect(mindgraphDataDir({ MINDGRAPH_HOME: "relative" })).toBe(fallback);
    expect(mindgraphDataDir({})).toBe(fallback);
    expect(mindgraphRuntimeDir({})).toBe(path.join(fallback, "runtime"));
  });

  it("installs the runner under the override; only machine-local settings name it by absolute path", () => {
    const source = path.join(scratch(), "bundle.cjs");
    fs.writeFileSync(source, "// bundle\n");
    const runner = installHookRunner(source, undefined, "1.2.3");
    const sessionStart = (file: string): string =>
      JSON.parse(fs.readFileSync(file, "utf8")).hooks.SessionStart[0].hooks[0].command;
    try {
      expect(runner).toBe(path.join(configured(), "bin", "mindgraph-hook.cjs"));
      expect(installedHookRunnerVersion()).toBe("1.2.3");
      // User scope: the settings in CLAUDE_CONFIG_DIR are this machine's own.
      const user = installClaudeHooks("user");
      expect(user.path).toBe(path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"));
      expect(sessionStart(user.path)).toBe(`node '${runner}' hook --harness claude-code --owner mindgraph`);
      // Project scope is committed: the portable form, never a local path.
      const root = makeRepo(path.join(scratch(), "project"));
      const project = installClaudeHooks("project", root);
      expect(sessionStart(project.path)).toBe(
        'node "$HOME/.mindgraph/bin/mindgraph-hook.cjs" hook --harness claude-code --owner mindgraph',
      );
      // An evaluation run's checkout is the trial's own: the absolute path.
      process.env.MINDGRAPH_EVAL = "1";
      try {
        expect(sessionStart(installClaudeHooks("project", root).path)).toBe(
          `node '${runner}' hook --harness claude-code --owner mindgraph`,
        );
      } finally {
        delete process.env.MINDGRAPH_EVAL;
      }
    } finally {
      uninstallHookRunner();
      fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), { force: true });
    }
    expect(fs.existsSync(runner)).toBe(false);
  });

  it("MINDGRAPH_HOOK_AUTOUPDATE=off leaves the runner under the override untouched", () => {
    const source = path.join(scratch(), "bundle.cjs");
    fs.writeFileSync(source, "// newer bundle\n");
    const runner = installHookRunner(source, undefined, "0.1.0");
    const before = snapshotTree(configured());
    const previous = process.env.MINDGRAPH_HOOK_AUTOUPDATE;
    process.env.MINDGRAPH_HOOK_AUTOUPDATE = "off";
    try {
      expect(refreshHookRunner("9.9.9", source)).toEqual({ refreshed: false, reason: "disabled" });
      expect(snapshotTree(configured())).toEqual(before);
      expect(installedHookRunnerVersion()).toBe("0.1.0");
    } finally {
      if (previous === undefined) delete process.env.MINDGRAPH_HOOK_AUTOUPDATE;
      else process.env.MINDGRAPH_HOOK_AUTOUPDATE = previous;
    }
    // Without the opt-out the same call refreshes it, in the same place.
    expect(refreshHookRunner("9.9.9", source)).toMatchObject({ refreshed: true });
    expect(installedHookRunnerVersion()).toBe("9.9.9");
    uninstallHookRunner();
    expect(fs.existsSync(runner)).toBe(false);
  });
});

// A 0.27.x install put an ungated runner at $HOME/.mindgraph/bin and wrote
// portable "$HOME/..." entries. Setting MINDGRAPH_HOME afterwards moves this
// process's runner, but those entries still run the old one: the consent
// floor must keep seeing it and bring it up to date.
describe("the consent floor sees the portable runner under MINDGRAPH_HOME", () => {
  const PORTABLE = 'node "$HOME/.mindgraph/bin/mindgraph-hook.cjs" hook --harness claude-code --owner mindgraph';
  const settingsWith = (command: string) =>
    `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command, timeout: 1 }] }] } }, null, 2)}\n`;

  function upgradedMachine() {
    const home = scratch("mindgraph-floor-home-");
    const bin = path.join(home, ".mindgraph", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const legacy = path.join(bin, "mindgraph-hook.cjs");
    fs.writeFileSync(legacy, "// runner 0.27.1\n");
    fs.writeFileSync(`${legacy}.version`, "0.27.1\n");
    const userSettings = path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(userSettings, settingsWith(PORTABLE));
    const project = makeRepo(path.join(scratch(), "project"));
    fs.mkdirSync(path.join(project, ".claude"));
    const projectSettings = path.join(project, ".claude", "settings.json");
    fs.writeFileSync(projectSettings, settingsWith(PORTABLE));
    const bundle = path.join(scratch(), "cli.js");
    fs.writeFileSync(bundle, "// bundle 0.28.0\n");
    vi.stubEnv("HOME", home);
    return { home, legacy, userSettings, project, projectSettings, bundle };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), { force: true });
  });

  const commandsIn = (file: string) =>
    Object.values(
      JSON.parse(fs.readFileSync(file, "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>,
    ).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));

  it("predates the gate, warns with the portable runner's path, and a forced refresh updates it in place", () => {
    const m = upgradedMachine();
    // This process's own runner (under MINDGRAPH_HOME) does not exist.
    expect(fs.existsSync(path.join(process.env.MINDGRAPH_HOME!, "bin", "mindgraph-hook.cjs"))).toBe(false);
    expect(runnerPredatesGate()).toBe(true);
    expect(gateFloorWarning()).toBe(
      `the installed hook runner at ${m.legacy} v0.27.1 predates consent and ignores it; ` +
        "run npx -y mindgraph-mcp@latest install-hooks --scope user",
    );
    vi.stubEnv("MINDGRAPH_HOOK_AUTOUPDATE", "off");
    expect(refreshHookRunner("0.28.0", m.bundle, undefined, { force: true })).toEqual({
      refreshed: true,
      reason: "updated",
      runnerVersion: "0.27.1",
    });
    expect(fs.readFileSync(m.legacy, "utf8")).toBe("// bundle 0.28.0\n");
    expect(fs.readFileSync(`${m.legacy}.version`, "utf8")).toBe("0.28.0\n");
    expect(runnerPredatesGate()).toBe(false);
    expect(gateFloorWarning()).toBeUndefined();
    // The owned entries keep naming the runner they named, now gated.
    expect(refreshOwnedClaudeHooks(m.project, undefined, ["user", "project"])).toEqual([
      m.userSettings,
      m.projectSettings,
    ]);
    for (const file of [m.userSettings, m.projectSettings]) {
      for (const command of commandsIn(file)) expect(command).toBe(PORTABLE);
    }
  });

  it("on/off's refresh brings the portable runner up to the floor", () => {
    const m = upgradedMachine();
    expect(refreshRunnerForConsent("0.28.0", m.bundle)).toBe(
      "Updated the hook runner to v0.28.0 so it checks where MindGraph is on.",
    );
    expect(fs.readFileSync(`${m.legacy}.version`, "utf8")).toBe("0.28.0\n");
    for (const command of commandsIn(m.userSettings)) expect(command).toBe(PORTABLE);
  });

  it("install-hooks' portable refresh touches only a runner below the floor, and never in an evaluation run", () => {
    const m = upgradedMachine();
    vi.stubEnv("MINDGRAPH_EVAL", "1");
    expect(refreshPortableRunnerBelowGate(m.bundle, "0.28.0")).toBeUndefined();
    expect(fs.readFileSync(`${m.legacy}.version`, "utf8")).toBe("0.27.1\n");
    vi.stubEnv("MINDGRAPH_EVAL", "");
    expect(refreshPortableRunnerBelowGate(m.bundle, "0.28.0")).toBe(m.legacy);
    expect(fs.readFileSync(`${m.legacy}.version`, "utf8")).toBe("0.28.0\n");
    // Now at the floor: left alone.
    expect(refreshPortableRunnerBelowGate(m.bundle, "0.29.0")).toBeUndefined();
    expect(fs.readFileSync(`${m.legacy}.version`, "utf8")).toBe("0.28.0\n");
  });

  it("a portable runner already at the floor is not refreshed by the floor rule", () => {
    const m = upgradedMachine();
    fs.writeFileSync(`${m.legacy}.version`, "0.28.0\n");
    expect(runnerPredatesGate()).toBe(false);
    expect(refreshHookRunner("0.29.0", m.bundle)).toEqual({ refreshed: false, reason: "no_runner" });
    expect(fs.readFileSync(`${m.legacy}.version`, "utf8")).toBe("0.28.0\n");
  });
});

describe("eval refusal helpers", () => {
  it("evalHomeRefusal requires an accepted MINDGRAPH_HOME, only in eval mode", () => {
    const repo = makeRepo(path.join(scratch(), "repo"));
    expect(evalHomeRefusal({ MINDGRAPH_EVAL: "1", MINDGRAPH_HOME: process.env.MINDGRAPH_HOME })).toBeUndefined();
    for (const home of [undefined, "relative", path.join(repo, "store")]) {
      expect(evalHomeRefusal({ MINDGRAPH_EVAL: "1", MINDGRAPH_HOME: home }), String(home)).toMatch(
        new RegExp(`^${EVAL_REQUIRES_HOME}: `),
      );
      expect(evalHomeRefusal({ MINDGRAPH_HOME: home })).toBeUndefined();
    }
  });

  it("evalUserScopeRefusal allows user scope only under the harness's own config directory", () => {
    const on = { MINDGRAPH_EVAL: "1" };
    expect(evalUserScopeRefusal("claude-code", "user", on)).toMatch(new RegExp(`^${EVAL_REQUIRES_CONFIG_DIR}: `));
    expect(evalUserScopeRefusal("claude-code", "user", { ...on, CLAUDE_CONFIG_DIR: "rel" })).toContain("CLAUDE_CONFIG_DIR");
    expect(evalUserScopeRefusal("claude-code", "user", { ...on, CLAUDE_CONFIG_DIR: "/trial/claude" })).toBeUndefined();
    expect(evalUserScopeRefusal("codex", "user", { ...on, CLAUDE_CONFIG_DIR: "/trial/claude" })).toContain("CODEX_HOME");
    expect(evalUserScopeRefusal("codex", "user", { ...on, CODEX_HOME: "/trial/codex" })).toBeUndefined();
    expect(evalUserScopeRefusal("claude-code", "project", on)).toBeUndefined();
    expect(evalUserScopeRefusal("claude-code", "user", {})).toBeUndefined();
  });

  it("evalClaudeReadRefusal needs an absolute CLAUDE_CONFIG_DIR; evalAppConfigRefusal always refuses in eval mode", () => {
    const on = { MINDGRAPH_EVAL: "1" };
    expect(evalClaudeReadRefusal(on)).toMatch(new RegExp(`^${EVAL_REQUIRES_CONFIG_DIR}: `));
    expect(evalClaudeReadRefusal({ ...on, CLAUDE_CONFIG_DIR: "rel" })).toContain("CLAUDE_CONFIG_DIR");
    expect(evalClaudeReadRefusal({ ...on, CLAUDE_CONFIG_DIR: "/trial/claude" })).toBeUndefined();
    expect(evalClaudeReadRefusal({})).toBeUndefined();
    expect(evalAppConfigRefusal("Cursor", on)).toMatch(new RegExp(`^${EVAL_REQUIRES_CONFIG_DIR}: .*Cursor`));
    expect(evalAppConfigRefusal("Cursor", {})).toBeUndefined();
  });

  it("uninstall-hooks refuses user scope outside the trial's own config directory, and leaves the file alone", () => {
    const home = scratch("mindgraph-uninstall-home-");
    const claude = path.join(home, ".claude");
    const codex = path.join(home, ".codex");
    fs.mkdirSync(claude);
    fs.mkdirSync(codex);
    const owned = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "$HOME/.mindgraph/bin/mindgraph-hook.cjs" hook --harness claude-code --owner mindgraph' }] }] } }, null, 2)}\n`;
    fs.writeFileSync(path.join(claude, "settings.json"), owned);
    fs.writeFileSync(path.join(codex, "hooks.json"), owned);
    const before = snapshotTree(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("MINDGRAPH_EVAL", "1");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("CODEX_HOME", "");
    try {
      expect(() => uninstallClaudeHooks("user")).toThrow(EVAL_REQUIRES_CONFIG_DIR);
      expect(() => uninstallCodexHooks("user")).toThrow(EVAL_REQUIRES_CONFIG_DIR);
      expect(snapshotTree(home)).toEqual(before);
      // The trial's own directory is fine.
      vi.stubEnv("CLAUDE_CONFIG_DIR", claude);
      expect(uninstallClaudeHooks("user")).toEqual({ path: path.join(claude, "settings.json"), removed: 1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("no self-heal in an evaluation run", () => {
  const OWNED = `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: 'node "$HOME/.mindgraph/bin/mindgraph-hook.cjs" hook --harness claude-code --owner mindgraph',
                timeout: 5,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;

  function staleMachine() {
    const home = scratch();
    const bin = path.join(home, ".mindgraph", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "mindgraph-hook.cjs"), "// runner 0.20.0\n");
    fs.writeFileSync(path.join(bin, "mindgraph-hook.cjs.version"), "0.20.0\n");
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), OWNED);
    const bundle = path.join(scratch(), "cli.js");
    fs.writeFileSync(bundle, "// newer bundle\n");
    return { home, bundle };
  }

  function withEval<T>(fn: () => T): T {
    process.env.MINDGRAPH_EVAL = "1";
    try {
      return fn();
    } finally {
      delete process.env.MINDGRAPH_EVAL;
    }
  }

  it("on/off's forced refresh of a runner that predates consent leaves everything as it was", () => {
    const m = staleMachine();
    const before = snapshotTree(m.home);
    expect(withEval(() => refreshRunnerForConsent("9.9.9", m.bundle, m.home))).toBeUndefined();
    expect(withEval(() => refreshHookRunner("9.9.9", m.bundle, m.home, { force: true }))).toEqual({
      refreshed: false,
      reason: "disabled",
    });
    expect(withEval(() => refreshOwnedClaudeHooks(m.home, m.home, ["user"]))).toEqual([]);
    expect(snapshotTree(m.home)).toEqual(before);
    // Outside eval mode the same call does refresh, so the check above means something.
    expect(refreshRunnerForConsent("9.9.9", m.bundle, m.home)).toContain("9.9.9");
    expect(snapshotTree(m.home)).not.toEqual(before);
  });

  it("a refresh keeps the runner existing entries already name", () => {
    const m = staleMachine();
    // This process has an accepted MINDGRAPH_HOME whose runner is elsewhere.
    const file = path.join(m.home, ".claude", "settings.json");
    const absolute = `node '/opt/other/bin/mindgraph-hook.cjs' hook --harness claude-code --owner mindgraph`;
    const settings = JSON.parse(OWNED);
    settings.hooks.SessionStart[0].hooks[0].command = absolute;
    fs.writeFileSync(file, JSON.stringify(settings));
    expect(refreshOwnedClaudeHooks(m.home, undefined, ["project"])).toEqual([path.join(m.home, ".claude", "settings.json")]);
    const commands = Object.values(
      JSON.parse(fs.readFileSync(file, "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>,
    ).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));
    expect(commands.length).toBeGreaterThan(1);
    for (const command of commands) expect(command).toBe(absolute);
  });
});

describe.runIf(built(CLI))("installs and other commands under MINDGRAPH_EVAL=1", () => {
  // A fake `claude` and `open` first on PATH: nothing real is registered or
  // opened even if a refusal regressed.
  function machine() {
    const base = scratch();
    const home = path.join(base, "home");
    const store = path.join(base, "store");
    const fakeBin = path.join(base, "fake-bin");
    const marker = path.join(base, "external-calls");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(fakeBin);
    for (const name of ["claude", "open", "xdg-open"]) {
      const file = path.join(fakeBin, name);
      fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 1\n`);
      fs.chmodSync(file, 0o755);
    }
    const userSettings = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(
      userSettings,
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "$HOME/.mindgraph/bin/mindgraph-hook.cjs" hook --harness claude-code --owner mindgraph' }] }] } }, null, 2)}\n`,
    );
    const log = path.join(base, "requests.jsonl");
    const env: Record<string, string> = {
      PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      MINDGRAPH_HOME: store,
      MINDGRAPH_EVAL: "1",
      NODE_OPTIONS: `--require=${RECORDER}`,
      MINDGRAPH_TEST_REQUESTS: log,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    return { base, home, store, marker, log, env, userSettings, snapshot: () => snapshotTree(home) };
  }

  it("install-hooks --scope user and install-code need the trial's CLAUDE_CONFIG_DIR; HOME's settings stay byte-identical", async () => {
    const m = machine();
    const before = m.snapshot();
    for (const args of [
      ["install-hooks", "--harness", "claude-code", "--scope", "user", "--base-url", "http://127.0.0.1:9"],
      ["install-hooks", "--harness", "codex", "--scope", "user", "--base-url", "http://127.0.0.1:9"],
      ["install-code", "--hooks", "--api-key", "mg_test_not_real", "--base-url", "http://127.0.0.1:9"],
      ["install-code", "--api-key", "mg_test_not_real", "--base-url", "http://127.0.0.1:9"],
    ]) {
      const result = await run([CLI, ...args], m.env, { cwd: m.base });
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain(EVAL_REQUIRES_CONFIG_DIR);
    }
    expect(m.snapshot()).toEqual(before);
    expect(fs.existsSync(m.store)).toBe(false);
    expect(fs.existsSync(m.marker)).toBe(false);
    expect(requests(m.log)).toEqual([]);

    // With the trial's own config directory, user scope lands there.
    const config = path.join(m.base, "trial-claude");
    const ok = await run(
      [CLI, "install-hooks", "--harness", "claude-code", "--scope", "user", "--base-url", "http://127.0.0.1:9"],
      { ...m.env, CLAUDE_CONFIG_DIR: config },
      { cwd: m.base },
    );
    expect(ok.code, ok.stderr).toBe(0);
    expect(m.snapshot()).toEqual(before);
    const trial = JSON.parse(fs.readFileSync(path.join(config, "settings.json"), "utf8"));
    expect(trial.hooks.SessionStart[0].hooks[0].command).toBe(
      `node '${path.join(m.store, "bin", "mindgraph-hook.cjs")}' hook --harness claude-code --owner mindgraph`,
    );
    expect(requests(m.log)).toEqual([]);
  }, 30_000);

  it("uninstall-hooks, uninstall-code and the Claude Desktop and Cursor commands never change HOME's configuration", async () => {
    const m = machine();
    fs.mkdirSync(path.join(m.home, ".cursor"));
    fs.writeFileSync(path.join(m.home, ".cursor", "mcp.json"), `${JSON.stringify({ mcpServers: { mindgraph: {} } })}\n`);
    const before = m.snapshot();
    for (const args of [
      ["uninstall-hooks", "--harness", "claude-code", "--scope", "user"],
      ["uninstall-hooks", "--harness", "codex", "--scope", "user"],
      ["uninstall-code"],
      ["install", "--api-key", "mg_test_not_real", "--base-url", "http://127.0.0.1:9"],
      ["uninstall"],
      ["install-cursor", "--api-key", "mg_test_not_real", "--base-url", "http://127.0.0.1:9"],
      ["uninstall-cursor"],
    ]) {
      const result = await run([CLI, ...args], m.env, { cwd: m.base });
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain(EVAL_REQUIRES_CONFIG_DIR);
    }
    expect(m.snapshot()).toEqual(before);
    expect(fs.existsSync(m.store)).toBe(false);
    expect(fs.existsSync(m.marker)).toBe(false);
    expect(requests(m.log)).toEqual([]);
  }, 30_000);

  it("on, off and off --all stop without an accepted MINDGRAPH_HOME; off --all also needs CLAUDE_CONFIG_DIR", async () => {
    const m = machine();
    const repo = makeRepo(path.join(m.base, "repo"));
    const before = m.snapshot();
    const refused = { ...m.env, MINDGRAPH_HOME: path.join(repo, "store") };
    for (const args of [["off"], ["off", "--all", "--dry-run"]]) {
      const result = await run([CLI, ...args], refused, { cwd: repo });
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain(EVAL_REQUIRES_HOME);
    }
    const dryRun = await run([CLI, "off", "--all", "--dry-run"], m.env, { cwd: repo });
    expect(dryRun.code).toBe(1);
    expect(dryRun.stderr).toContain(EVAL_REQUIRES_CONFIG_DIR);
    expect(m.snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(repo, "store"))).toBe(false);
    expect(fs.existsSync(m.store)).toBe(false);
  }, 30_000);

  it("init's install step needs the trial's directories, and never writes Claude Desktop's configuration", async () => {
    const m = machine();
    const before = m.snapshot();
    for (const choice of ["1", "2", "3"]) {
      // One answer per prompt: readline drops lines that arrive before it asks.
      const result = await runAnswering([CLI, "init"], m.env, m.base, ["2", "mg_test_not_real", choice]);
      expect(result.code, choice).toBe(1);
      expect(result.stderr, choice).toContain(EVAL_REQUIRES_CONFIG_DIR);
    }
    expect(m.snapshot()).toEqual(before);
    expect(fs.existsSync(m.store)).toBe(false);
    expect(fs.existsSync(m.marker)).toBe(false);
  }, 30_000);

  it("install-hooks and install-code stop without an accepted MINDGRAPH_HOME", async () => {
    const m = machine();
    const repo = makeRepo(path.join(m.base, "repo"));
    const before = m.snapshot();
    const env = { ...m.env, MINDGRAPH_HOME: path.join(repo, "store"), CLAUDE_CONFIG_DIR: path.join(m.base, "trial") };
    for (const args of [
      ["install-hooks", "--harness", "claude-code", "--scope", "project", "--project-dir", repo],
      ["install-code", "--hooks", "--api-key", "mg_test_not_real"],
    ]) {
      const result = await run([CLI, ...args], env, { cwd: repo });
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain(EVAL_REQUIRES_HOME);
    }
    expect(m.snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(repo, "store"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(m.base, "trial"))).toBe(false);
    expect(fs.existsSync(m.marker)).toBe(false);
  }, 30_000);

  it("skills refuses a hosted base URL and sends nothing", async () => {
    const m = machine();
    for (const sub of ["list", "pull", "push"]) {
      const result = await run(
        [CLI, "skills", sub, "--base-url", "https://api.mindgraph.cloud", "--api-key", "mg_test_not_real"],
        m.env,
        { cwd: m.base },
      );
      expect(result.code, sub).toBe(1);
      expect(result.stderr, sub).toContain(EVAL_REQUIRES_LOOPBACK);
    }
    expect(requests(m.log)).toEqual([]);
  }, 30_000);

  it("init's browser sign-in refuses the hosted dashboard before opening anything", async () => {
    const m = machine();
    const result = await run([CLI, "init"], m.env, { cwd: m.base, stdin: "1\n" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(EVAL_REQUIRES_LOOPBACK);
    expect(result.stdout).not.toContain("Opening browser");
    expect(fs.existsSync(m.marker)).toBe(false);
    expect(requests(m.log)).toEqual([]);
  }, 30_000);
});
