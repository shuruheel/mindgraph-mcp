// Invariant: outside a directory the user turned MindGraph on for, a hook
// makes no request and writes no file. Spawns the built hook runner the way
// Claude Code and Codex do, with a preload that records every fetch and
// socket connect.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  built,
  makeRepo,
  makeWorkspace,
  pinned,
  repoEntry,
  snapshotTree,
  tempDir,
  workspaceEntry,
  writeStore,
} from "./fixtures/consent.js";

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const RECORDER = path.join(__dirname, "fixtures", "fetch-recorder.cjs");
const TRANSCRIPT = path.join(__dirname, "fixtures", "claude-transcript.jsonl");
const ready = built(CLI);

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = tempDir(prefix);
  cleanup.push(dir);
  return dir;
}

interface Machine {
  /** The MINDGRAPH_HOME holding hooks.json. */
  store: string;
  /** HOME for the spawned runner, so nothing reaches the real one. */
  home: string;
  runtime: string;
  log: string;
  transcript: string;
}

function machine(): Machine {
  const base = scratch("mindgraph-gate-");
  const store = path.join(base, "store");
  const home = path.join(base, "home");
  const runtime = path.join(base, "runtime");
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: true });
  const transcript = path.join(base, "transcript.jsonl");
  fs.copyFileSync(TRANSCRIPT, transcript);
  return { store, home, runtime, log: path.join(base, "requests.jsonl"), transcript };
}

/** hooks.json with a key, every optional feature on, and `roots` consented. */
const CONNECTION = {
  apiKey: "mg_file_key",
  baseUrl: "http://file.mindgraph.invalid",
  promptRecallOptIn: true,
  capture: true,
};

function runHook(
  m: Machine,
  harness: "claude-code" | "codex",
  input: Record<string, unknown>,
  options: { env?: Record<string, string>; stdin?: string; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "hook", "--harness", harness], {
      cwd: options.cwd ?? String(input.cwd),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: m.home,
        MINDGRAPH_HOME: m.store,
        MINDGRAPH_RUNTIME_DIR: m.runtime,
        NODE_OPTIONS: `--require=${RECORDER}`,
        MINDGRAPH_TEST_REQUESTS: m.log,
        // A project's settings could set these for hooks; the runner must
        // ignore them and use hooks.json.
        MINDGRAPH_API_KEY: "mg_env_key",
        MINDGRAPH_BASE_URL: "http://env.mindgraph.invalid",
        MINDGRAPH_ORG_ID: "org_env",
        MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK: "1",
        ...options.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin ?? JSON.stringify(input));
  });
}

function requests(m: Machine): Array<Record<string, unknown>> {
  if (!fs.existsSync(m.log)) return [];
  return fs
    .readFileSync(m.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "PreCompact",
  "TaskCreated",
] as const;

function eventInput(m: Machine, event: string, cwd: string): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: "gate-session",
    cwd,
    source: "startup",
    model: "claude-test",
    prompt: "how do we deploy the release plan",
    tool_name: event === "PreToolUse" ? "mcp__mindgraph__mindgraph_capture" : "Edit",
    tool_input: { action: "journal", content: "x", file_path: "a.ts" },
    tool_response: { ok: true },
    stop_hook_active: false,
    reason: "exit",
    trigger: "auto",
    transcript_path: m.transcript,
  };
}

interface Case {
  name: string;
  /** Builds the case under `base`; returns the event directory and the trees
   * that must not change. */
  setup(base: string, m: Machine): { cwd: string; watched: string[] };
}

// The four cases the consent decision names.
const CASES: Case[] = [
  {
    name: "(a) an unconsented repository while another is consented",
    setup(base, m) {
      const a = makeRepo(path.join(base, "repoA"));
      const b = makeRepo(path.join(base, "repoB"));
      writeStore(m.store, [repoEntry(b)], CONNECTION);
      return { cwd: a, watched: [a, b] };
    },
  },
  {
    name: "(b) a fresh clone carrying a workspace file that names itself and its parent",
    setup(base, m) {
      const clone = makeRepo(path.join(base, "clone"));
      fs.mkdirSync(path.join(clone, ".mindgraph"));
      fs.writeFileSync(
        path.join(clone, ".mindgraph", "workspace.json"),
        JSON.stringify({ v: 1, repositories: [{ root: "." }, { root: ".." }] }),
      );
      writeStore(m.store, [], CONNECTION);
      return { cwd: clone, watched: [base] };
    },
  },
  {
    name: "(c) an undeclared repository inside a consented workspace",
    setup(base, m) {
      const ws = makeRepo(path.join(base, "ws"));
      const a = makeRepo(path.join(ws, "a"));
      const b = makeRepo(path.join(ws, "b"));
      const file = makeWorkspace(ws, [{ root: "a" }]);
      writeStore(m.store, [workspaceEntry(ws, file, [pinned(a)])], CONNECTION);
      return { cwd: b, watched: [ws] };
    },
  },
  {
    name: "(d) a pinned repository after the workspace file gained a repository",
    setup(base, m) {
      const ws = makeRepo(path.join(base, "ws"));
      const a = makeRepo(path.join(ws, "a"));
      makeRepo(path.join(ws, "b"));
      const file = makeWorkspace(ws, [{ root: "a" }]);
      writeStore(m.store, [workspaceEntry(ws, file, [pinned(a)])], CONNECTION);
      makeWorkspace(ws, [{ root: "a" }, { root: "b" }]);
      return { cwd: a, watched: [ws] };
    },
  },
];

describe.runIf(ready)("hooks outside consent", () => {
  beforeAll(() => {
    // The recorder must load in the spawned runner, or an empty log proves
    // nothing (the positive controls below also cover this).
    expect(fs.existsSync(RECORDER)).toBe(true);
  });

  for (const testCase of CASES) {
    it(`${testCase.name}: no request, no file, for every event and both harnesses`, async () => {
      const base = scratch("mindgraph-gate-case-");
      const m = machine();
      const { cwd, watched } = testCase.setup(base, m);
      const storeBefore = snapshotTree(m.store);
      const before = watched.map((dir) => snapshotTree(dir));
      const runs: Array<["claude-code" | "codex", string]> = [
        ...EVENTS.map((event) => ["claude-code", event] as ["claude-code", string]),
        ["codex", "SessionStart"],
        ["codex", "PostToolUse"],
      ];
      for (const [harness, event] of runs) {
        const result = await runHook(m, harness, eventInput(m, event, cwd));
        const label = `${harness} ${event}`;
        expect(result.code, `${label}: ${result.stderr}`).toBe(0);
        const out = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(out.hookSpecificOutput, label).toBeUndefined();
        const keys = Object.keys(out);
        expect(keys.length === 0 || (keys.length === 1 && keys[0] === "systemMessage"), label).toBe(
          true,
        );
        if (harness === "codex" || event !== "SessionStart") expect(out, label).toEqual({});
      }
      expect(requests(m)).toEqual([]);
      expect(watched.map((dir) => snapshotTree(dir))).toEqual(before);
      expect(snapshotTree(m.store)).toEqual(storeBefore);
      expect(snapshotTree(m.runtime)).toEqual({});
      expect(snapshotTree(m.home)).toEqual({});
    }, 60_000);
  }

  it("a workspace file changed since consent shows a paused notice, as a system message only", async () => {
    const base = scratch("mindgraph-gate-paused-");
    const m = machine();
    const { cwd } = CASES[3].setup(base, m);
    const out = JSON.parse(
      (await runHook(m, "claude-code", eventInput(m, "SessionStart", cwd))).stdout,
    );
    expect(Object.keys(out)).toEqual(["systemMessage"]);
    expect(out.systemMessage).toContain("MindGraph is paused in");
    expect(out.systemMessage).toContain("npx -y mindgraph-mcp@latest on ");
    expect(requests(m)).toEqual([]);
  });

  it("after the upgrade, a SessionStart in a repository says why nothing ran", async () => {
    const base = scratch("mindgraph-gate-upgrade-");
    const m = machine();
    const repo = makeRepo(path.join(base, "repo"));
    // hooks.json from before consent existed: a key, no consent block.
    fs.writeFileSync(path.join(m.store, "hooks.json"), JSON.stringify(CONNECTION), {
      mode: 0o600,
    });
    const claude = JSON.parse(
      (await runHook(m, "claude-code", eventInput(m, "SessionStart", repo))).stdout,
    );
    expect(claude).toEqual({
      systemMessage: expect.stringContaining("only where you turn them on"),
    });
    expect(claude.systemMessage).toContain("npx -y mindgraph-mcp@latest on");
    // Codex gets nothing: how it shows a system message is unverified.
    const codex = JSON.parse((await runHook(m, "codex", eventInput(m, "SessionStart", repo))).stdout);
    expect(codex).toEqual({});
    // Outside any repository or workspace there is nothing to say.
    const plain = scratch("mindgraph-gate-plain-");
    expect(
      JSON.parse((await runHook(m, "claude-code", eventInput(m, "SessionStart", plain))).stdout),
    ).toEqual({});
    expect(requests(m)).toEqual([]);
  });

  it("stdin that is JSON but not an object exits 0 with {} and sends nothing", async () => {
    const base = scratch("mindgraph-gate-null-");
    const m = machine();
    const repo = makeRepo(path.join(base, "repo"));
    writeStore(m.store, [repoEntry(repo)], CONNECTION);
    for (const harness of ["claude-code", "codex"] as const) {
      for (const stdin of ["null", "[]", "42", '"text"']) {
        const result = await runHook(m, harness, {}, { stdin, cwd: repo });
        expect(result.code, `${harness} ${stdin}: ${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout), `${harness} ${stdin}`).toEqual({});
      }
    }
    expect(requests(m)).toEqual([]);
  });
});

describe.runIf(ready)("hooks inside consent", () => {
  it("a consented SessionStart opens a session and resolves its pinned repository, at hooks.json's destination", async () => {
    const base = scratch("mindgraph-gate-on-");
    const m = machine();
    const repo = makeRepo(path.join(base, "repo"));
    writeStore(m.store, [repoEntry(repo, "github.com/acme/repo")], CONNECTION);
    const result = await runHook(m, "claude-code", eventInput(m, "SessionStart", repo));
    expect(result.code, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("MindGraph durable work brief");

    const sent = requests(m).filter((r) => r.kind === "fetch");
    expect(sent.find((r) => (r.body as Record<string, unknown>)?.action === "open")).toBeDefined();
    const identity = sent.find(
      (r) => (r.body as Record<string, unknown>)?.action === "resolve_identity",
    );
    expect(identity?.body).toMatchObject({
      identity: { key: { repo_id: "github.com/acme/repo" } },
    });
    expect(sent.find((r) => (r.body as Record<string, unknown>)?.action === "resume_work")).toBeDefined();
    // Every request goes to the file's destination with the file's key.
    for (const request of sent) {
      expect(String(request.url).startsWith("http://file.mindgraph.invalid/")).toBe(true);
    }
    const all = JSON.stringify(requests(m));
    expect(all).not.toContain("env.mindgraph.invalid");
    expect(all).not.toContain("mg_env_key");
    expect(all).not.toContain("org_env");
    expect(all).toContain("mg_file_key");
  });

  it("a workspace file nested in a pinned repository cannot widen the scope to a sibling", async () => {
    const base = scratch("mindgraph-gate-nested-");
    const m = machine();
    const repo = makeRepo(path.join(base, "repo"));
    const sibling = makeRepo(path.join(base, "private-sibling"));
    fs.mkdirSync(path.join(repo, ".mindgraph"));
    fs.writeFileSync(
      path.join(repo, ".mindgraph", "workspace.json"),
      JSON.stringify({
        v: 1,
        repositories: [{ root: "." }, { root: "../private-sibling", repo_id: "private-sibling" }],
      }),
    );
    writeStore(m.store, [repoEntry(repo, "github.com/acme/repo")], CONNECTION);
    const siblingBefore = snapshotTree(sibling);
    await runHook(m, "claude-code", eventInput(m, "SessionStart", repo));
    await runHook(m, "claude-code", eventInput(m, "PreToolUse", repo));
    const sent = requests(m);
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent)).not.toContain("private-sibling");
    const identities = sent
      .map((r) => (r.body as Record<string, unknown> | undefined)?.identity)
      .filter(Boolean);
    expect(identities).toEqual([
      expect.objectContaining({ key: expect.objectContaining({ repo_id: "github.com/acme/repo" }) }),
    ]);
    expect(snapshotTree(sibling)).toEqual(siblingBefore);
  });

  it("the hook environment cannot turn on transcript capture the user left off", async () => {
    const base = scratch("mindgraph-gate-capture-");
    const m = machine();
    const repo = makeRepo(path.join(base, "repo"));
    writeStore(m.store, [repoEntry(repo, "github.com/acme/repo")], { ...CONNECTION, capture: false });
    const env = { MINDGRAPH_HOOK_CAPTURE: "on" };
    for (const event of ["PreCompact", "SessionEnd"]) {
      const result = await runHook(m, "claude-code", eventInput(m, event, repo), { env });
      expect(result.code, `${event}: ${result.stderr}`).toBe(0);
    }
    const ingests = (machineUsed: Machine) =>
      requests(machineUsed).filter((r) => String(r.url).includes("/ingest/session"));
    expect(ingests(m)).toEqual([]);
    // Control: the same session with capture stored on does send.
    const control = machine();
    writeStore(control.store, [repoEntry(repo, "github.com/acme/repo")], CONNECTION);
    await runHook(control, "claude-code", eventInput(control, "PreCompact", repo));
    expect(ingests(control).length).toBeGreaterThan(0);
  });
});
