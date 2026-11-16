import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsentIo } from "../src/consent-cli.js";
import { loadConsentStore, resolveConsent } from "../src/consent.js";
import { nodeGit, resolveRepositoryId } from "../src/consent-plan.js";
import { findResidue, runOffAll } from "../src/consent-residue.js";
import {
  built,
  makeRepo,
  makeWorkspace,
  makeWorktree,
  pinned,
  repoEntry,
  snapshotTree,
  tempDir,
  workspaceEntry,
  writeStore,
} from "./fixtures/consent.js";

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const ready = built(CLI);

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const hex = (seed: string, length = 64) =>
  crypto.createHash("sha256").update(seed).digest("hex").slice(0, length);

function identityFile(repo: string): string {
  return path.join(repo, ".git", "mindgraph", "repository-id");
}

function writeIdentity(repo: string): string {
  const file = identityFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${crypto.randomUUID()}\n`, { mode: 0o600 });
  return file;
}

function writeJson(file: string, value: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** Everything off --all can see, all under one temporary directory: a store
 * consenting `consented`, a fake ~/.claude.json, a runtime directory with
 * session records, pending calls and the scope cache. */
function machine() {
  const base = tempDir("mindgraph-residue-");
  cleanup.push(base);
  const store = path.join(base, "store");
  const runtime = path.join(base, "runtime");
  const claudeConfig = path.join(base, "claude.json");
  const repos = {
    never: makeRepo(path.join(base, "code", "never")),
    fromLedger: makeRepo(path.join(base, "code", "from-ledger")),
    fromCall: makeRepo(path.join(base, "code", "from-call")),
    consented: makeRepo(path.join(base, "code", "consented")),
    unlisted: makeRepo(path.join(base, "code", "unlisted")),
  };
  const ids = Object.fromEntries(
    Object.entries(repos).map(([name, repo]) => [name, writeIdentity(repo)]),
  ) as Record<keyof typeof repos, string>;
  writeStore(store, [repoEntry(repos.consented)]);
  fs.mkdirSync(path.join(repos.consented, "src"));

  // A link into the consented repository, and a worktree of it, are not
  // places that were never turned on.
  const link = path.join(base, "code", "link-to-consented");
  fs.symlinkSync(repos.consented, link);
  const worktree = makeWorktree(repos.consented, "wt", path.join(base, "code", "consented-wt"));
  writeJson(claudeConfig, {
    projects: {
      [repos.never]: {},
      [path.join(repos.consented, "src")]: {},
      [link]: {},
      [worktree]: {},
      "relative/path": {},
      [path.join(base, "code", "gone")]: {},
    },
  });

  const ledgers = {
    never: writeJson(path.join(runtime, `${hex("a")}.json`), {
      repoContextCwd: repos.fromLedger,
      repoContextRepoId: "local:from-ledger",
    }),
    consented: writeJson(path.join(runtime, `${hex("b")}.json`), {
      repoContextCwd: repos.consented,
    }),
    current: writeJson(path.join(runtime, `${hex("c")}.json`), { sessionUid: "s" }),
    other: writeJson(path.join(runtime, "notes.json"), { repoContextCwd: repos.never }),
  };
  const calls = {
    never: writeJson(path.join(runtime, "calls", `${hex("d")}.${hex("e", 16)}.json`), {
      projectDir: repos.fromCall,
      fills: {},
      createdAt: 1,
    }),
    consented: writeJson(path.join(runtime, "calls", `${hex("f")}.${hex("g", 16)}.json`), {
      projectDir: path.join(repos.consented, "src"),
      fills: {},
      createdAt: 1,
    }),
  };
  const scopeFile = writeJson(path.join(runtime, "repository-scopes.json"), {
    v: 1,
    tenant: "t",
    entries: {
      [`local/${path.basename(repos.consented)}`]: { uid: "u1", at: 1 },
      "github.com/acme/never": { uid: "u2", at: 1 },
    },
  });
  // A session's memory title table and a temporary left by a killed write;
  // a file in the anchors folder that is not one is left alone.
  const anchors = {
    table: writeJson(path.join(runtime, "anchors", `${hex("h")}.json`), {
      v: 1,
      repositories: { [repos.consented]: { [path.join(repos.consented, "src", "a.ts")]: [{ handle: "l:abcdef", title: "A lesson" }] } },
    }),
    temporary: writeJson(path.join(runtime, "anchors", `${hex("i")}.json.123.${crypto.randomUUID()}.tmp`), {}),
    other: writeJson(path.join(runtime, "anchors", "notes.json"), {}),
  };
  return { base, store, runtime, claudeConfig, repos, ids, ledgers, calls, scopeFile, anchors };
}

function person(
  m: ReturnType<typeof machine>,
  answers: string[],
  env: Record<string, string> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const fullEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    MINDGRAPH_HOME: m.store,
    MINDGRAPH_RUNTIME_DIR: m.runtime,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...env,
  };
  const io: ConsentIo = {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    env: fullEnv,
    cwd: m.base,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? "";
    },
    git: nodeGit(fullEnv),
    now: () => new Date("2026-11-16T12:00:00.000Z"),
    version: "0.0.0-test",
  };
  return { io, out, err, asked };
}

const exists = (file: string) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

describe("off --all", () => {
  it("removes only what MindGraph left in places never turned on, then clears consent", async () => {
    const m = machine();
    // A paused shell must not make the consented repository look never on.
    const p = person(m, ["1"], { MINDGRAPH_HOOKS: "off" });
    expect(await runOffAll(p.io, { claudeConfig: m.claudeConfig })).toBe(0);
    const text = p.out.join("\n");
    expect(text).toContain("Only directories Claude Code or MindGraph's own records remember were checked.");
    expect(text).toContain("Memory title tables of sessions, from any place (2)");
    expect(text).toContain(
      "Removed: 3 repository identity files, 1 session record, 1 pending tool call, 1 cached repository lookup, 2 memory title tables.",
    );
    // Titles from a place that was on go too: off --all leaves nothing on.
    expect(exists(m.anchors.table)).toBe(false);
    expect(exists(m.anchors.temporary)).toBe(false);
    expect(exists(m.anchors.other)).toBe(true);

    // Found through ~/.claude.json, a session record and a pending call.
    expect(exists(m.ids.never)).toBe(false);
    expect(exists(path.dirname(m.ids.never))).toBe(false);
    expect(exists(m.ids.fromLedger)).toBe(false);
    expect(exists(m.ids.fromCall)).toBe(false);
    // Consented (also reached through a link and a worktree) and never seen.
    expect(exists(m.ids.consented)).toBe(true);
    expect(exists(m.ids.unlisted)).toBe(true);

    expect(exists(m.ledgers.never)).toBe(false);
    expect(exists(m.ledgers.consented)).toBe(true);
    expect(exists(m.ledgers.current)).toBe(true);
    expect(exists(m.ledgers.other)).toBe(true);
    expect(exists(m.calls.never)).toBe(false);
    expect(exists(m.calls.consented)).toBe(true);

    const cache = JSON.parse(fs.readFileSync(m.scopeFile, "utf8"));
    expect(cache).toMatchObject({ v: 1, tenant: "t" });
    expect(Object.keys(cache.entries)).toEqual([`local/${path.basename(m.repos.consented)}`]);
    expect(fs.statSync(m.scopeFile).mode & 0o777).toBe(0o600);

    const stored = JSON.parse(fs.readFileSync(path.join(m.store, "hooks.json"), "utf8"));
    expect(stored.consent.roots).toEqual([]);
    expect(stored.consent.acknowledged_at).toBe("2026-11-16T12:00:00.000Z");
    expect(stored.agentId).toBe("u-test");
  });

  it("--dry-run lists the residue and changes nothing", async () => {
    const m = machine();
    const before = snapshotTree(m.base);
    const p = person(m, ["1"], { CLAUDECODE: "1" });
    p.io.stdin.isTTY = false;
    expect(await runOffAll(p.io, { dryRun: true, claudeConfig: m.claudeConfig })).toBe(0);
    expect(p.asked).toEqual([]);
    const text = p.out.join("\n");
    expect(text).toContain("Repository identity files (3):");
    expect(text).toContain(m.ids.never);
    expect(text).not.toContain(m.ids.consented);
    expect(text).toContain("Dry run: nothing was removed or changed.");
    expect(snapshotTree(m.base)).toEqual(before);
  });

  it("Not now changes nothing", async () => {
    const m = machine();
    const before = snapshotTree(m.base);
    const p = person(m, [""]);
    expect(await runOffAll(p.io, { claudeConfig: m.claudeConfig })).toBe(0);
    expect(p.out.join("\n")).toContain("Not now: nothing was changed.");
    expect(snapshotTree(m.base)).toEqual(before);
  });

  it("refuses without a terminal, and with a store it cannot read", async () => {
    const m = machine();
    const before = snapshotTree(m.base);
    const p = person(m, ["1"]);
    p.io.stdout.isTTY = false;
    expect(await runOffAll(p.io, { claudeConfig: m.claudeConfig })).toBe(2);
    fs.writeFileSync(path.join(m.store, "hooks.json"), "{not json", { mode: 0o600 });
    const unread = snapshotTree(m.base);
    const q = person(m, ["1"]);
    expect(await runOffAll(q.io, { claudeConfig: m.claudeConfig })).toBe(1);
    expect(snapshotTree(m.base)).toEqual(unread);
    expect(Object.keys(unread)).toEqual(Object.keys(before));
  });

  it("never follows a planted link: the target outside stays untouched", async () => {
    const m = machine();
    const outside = path.join(m.base, "outside");
    fs.mkdirSync(outside);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "keep me\n");
    const outsideDir = path.join(m.base, "outside-dir");
    fs.mkdirSync(outsideDir);
    const outsideId = path.join(outsideDir, "repository-id");
    fs.writeFileSync(outsideId, "keep me too\n");

    // repository-id is a link to a file outside.
    const linkedFile = makeRepo(path.join(m.base, "code", "linked-file"));
    fs.mkdirSync(path.join(linkedFile, ".git", "mindgraph"));
    fs.symlinkSync(secret, identityFile(linkedFile));
    // .git/mindgraph is a link to a folder outside.
    const linkedDir = makeRepo(path.join(m.base, "code", "linked-dir"));
    fs.symlinkSync(outsideDir, path.join(linkedDir, ".git", "mindgraph"));
    // A pending call that is a link to a file outside.
    const linkedCall = path.join(m.runtime, "calls", `${hex("h")}.${hex("i", 16)}.json`);
    const outsideCall = writeJson(path.join(outside, "call.json"), { projectDir: m.repos.never });
    fs.symlinkSync(outsideCall, linkedCall);

    const config = JSON.parse(fs.readFileSync(m.claudeConfig, "utf8"));
    config.projects[linkedFile] = {};
    config.projects[linkedDir] = {};
    writeJson(m.claudeConfig, config);
    const outsideBefore = snapshotTree(outside);
    const outsideDirBefore = snapshotTree(outsideDir);

    const p = person(m, ["1"]);
    expect(await runOffAll(p.io, { claudeConfig: m.claudeConfig })).toBe(0);
    expect(snapshotTree(outside)).toEqual(outsideBefore);
    expect(snapshotTree(outsideDir)).toEqual(outsideDirBefore);
    expect(fs.readFileSync(secret, "utf8")).toBe("keep me\n");
    expect(fs.readFileSync(outsideId, "utf8")).toBe("keep me too\n");
    // The ordinary residue still went.
    expect(exists(m.ids.never)).toBe(false);
  });

  it("keeps the identity of a repository turned on from a linked worktree, or turned on and then moved", async () => {
    const m = machine();
    const git = nodeGit(person(m, []).io.env);
    // Turned on inside a linked worktree: the store names the worktree, and
    // pins the id kept in the main checkout's .git/mindgraph.
    const main = makeRepo(path.join(m.base, "code", "main"));
    const wt = makeWorktree(main, "wt", path.join(m.base, "code", "main-wt"));
    const wtId = resolveRepositoryId(wt, undefined, git);
    // Turned on, then renamed.
    const old = makeRepo(path.join(m.base, "code", "old"));
    const movedId = resolveRepositoryId(old, undefined, git);
    const moved = path.join(m.base, "code", "moved");
    fs.renameSync(old, moved);
    writeStore(m.store, [
      repoEntry(m.repos.consented),
      repoEntry(wt, wtId),
      repoEntry(old, movedId),
    ]);
    writeJson(m.claudeConfig, { projects: { [main]: {}, [wt]: {}, [moved]: {}, [m.repos.never]: {} } });

    const p = person(m, ["1"]);
    expect(await runOffAll(p.io, { claudeConfig: m.claudeConfig })).toBe(0);
    expect(p.out.join("\n")).toContain("Removed: 3 repository identity files");
    expect(fs.readFileSync(identityFile(main), "utf8").trim()).toBe(wtId);
    expect(fs.readFileSync(identityFile(moved), "utf8").trim()).toBe(movedId);
    expect(exists(m.ids.never)).toBe(false);
  });

  it("keeps the identity of a pinned repository while its workspace is paused", () => {
    const m = machine();
    const ws = path.join(m.base, "code", "ws");
    const rs = makeRepo(path.join(ws, "rs"));
    const rsId = writeIdentity(rs);
    const wt = makeWorktree(rs, "wt", path.join(m.base, "code", "rs-wt"));
    const workspace = makeWorkspace(ws, [{ root: "rs" }]);
    writeStore(m.store, [workspaceEntry(ws, workspace, [pinned(rs)])]);
    // Editing workspace.json pauses MindGraph under the workspace.
    fs.appendFileSync(workspace.file, "\n");
    writeJson(m.claudeConfig, { projects: { [rs]: {}, [wt]: {} } });

    const env = person(m, []).io.env;
    const loaded = loadConsentStore(env);
    expect(resolveConsent(rs, loaded, { env }).state).not.toBe("on");
    const residue = findResidue(loaded, { env, git: nodeGit(env), claudeConfig: m.claudeConfig });
    // Reached both directly and through its linked worktree.
    expect(residue.identityFiles).not.toContain(rsId);
    expect(residue.identityFiles).toContain(m.ids.fromLedger);
  });

  it("under MINDGRAPH_HOME also clears the runtime files earlier installs left under $HOME/.mindgraph", async () => {
    const m = machine();
    const home = path.join(m.base, "home");
    const legacy = path.join(home, ".mindgraph", "runtime");
    const oldLedger = writeJson(path.join(legacy, `${hex("old-ledger")}.json`), { repoContextCwd: m.repos.never });
    const oldCall = writeJson(path.join(legacy, "calls", `${hex("old-call")}.${hex("old-call-2", 16)}.json`), {
      projectDir: m.repos.never,
      fills: {},
      createdAt: 1,
    });
    const oldTable = writeJson(path.join(legacy, "anchors", `${hex("old-table")}.json`), { v: 1 });
    const oldScopes = writeJson(path.join(legacy, "repository-scopes.json"), {
      v: 1,
      tenant: "t",
      entries: { "github.com/acme/old": { uid: "u3", at: 1 } },
    });
    vi.stubEnv("HOME", home);
    try {
      // MINDGRAPH_RUNTIME_DIR unset: the runtime is MINDGRAPH_HOME's, and the
      // one under $HOME is searched too.
      const p = person(m, ["1"], { MINDGRAPH_RUNTIME_DIR: "" });
      const current = path.join(m.store, "runtime");
      const currentLedger = writeJson(path.join(current, `${hex("current")}.json`), { repoContextCwd: m.repos.never });
      expect(await runOffAll(p.io, { claudeConfig: m.claudeConfig })).toBe(0);
      for (const file of [oldLedger, oldCall, oldTable, currentLedger]) expect(exists(file), file).toBe(false);
      expect(JSON.parse(fs.readFileSync(oldScopes, "utf8")).entries).toEqual({});
      // The --runtime-dir residue of the test machine is not part of this run.
      expect(exists(m.ledgers.never)).toBe(true);

      // An evaluation run never looks at $HOME's runtime directory.
      const kept = writeJson(path.join(legacy, `${hex("kept")}.json`), { repoContextCwd: m.repos.never });
      const trial = person(m, ["1"], {
        MINDGRAPH_RUNTIME_DIR: "",
        MINDGRAPH_EVAL: "1",
        CLAUDE_CONFIG_DIR: path.join(m.base, "trial-claude"),
      });
      expect(await runOffAll(trial.io)).toBe(0);
      expect(exists(kept)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("in an evaluation run, refuses without the trial's MINDGRAPH_HOME or CLAUDE_CONFIG_DIR and changes nothing", async () => {
    const m = machine();
    const before = snapshotTree(m.base);
    const noHome = person(m, ["1"], { MINDGRAPH_EVAL: "1", MINDGRAPH_HOME: path.join(m.repos.never, "store") });
    expect(await runOffAll(noHome.io, { claudeConfig: m.claudeConfig })).toBe(1);
    expect(noHome.err.join("\n")).toContain("eval_requires_home");
    // Without CLAUDE_CONFIG_DIR the project list would be the person's real one.
    const noConfig = person(m, ["1"], { MINDGRAPH_EVAL: "1", CLAUDE_CONFIG_DIR: "" });
    expect(await runOffAll(noConfig.io, { dryRun: true })).toBe(1);
    expect(noConfig.err.join("\n")).toContain("eval_requires_config_dir");
    expect(noConfig.asked).toEqual([]);
    expect(snapshotTree(m.base)).toEqual(before);
  });

  it("reads Claude Code's project list from CLAUDE_CONFIG_DIR", async () => {
    const m = machine();
    const configDir = path.join(m.base, "claude-config");
    fs.mkdirSync(configDir);
    fs.copyFileSync(m.claudeConfig, path.join(configDir, ".claude.json"));
    const p = person(m, [], { CLAUDE_CONFIG_DIR: configDir });
    expect(await runOffAll(p.io, { dryRun: true })).toBe(0);
    expect(p.out.join("\n")).toContain(m.ids.never);
  });
});

function runCli(args: string[], env: Record<string, string>, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    // An empty answer is Not now, so even a broken terminal check removes nothing.
    child.stdin.end("");
  });
}

describe.runIf(ready)("spawned off --all", () => {
  it("exits 2 from an agent's shell and leaves every file byte-identical", async () => {
    const m = machine();
    const home = path.join(m.base, "home");
    fs.mkdirSync(home);
    fs.copyFileSync(m.claudeConfig, path.join(home, ".claude.json"));
    const before = snapshotTree(m.base);
    const result = await runCli(
      ["off", "--all"],
      {
        HOME: home,
        CLAUDE_CONFIG_DIR: home,
        MINDGRAPH_HOME: m.store,
        MINDGRAPH_RUNTIME_DIR: m.runtime,
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
      },
      m.repos.never,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Detected: CLAUDECODE=1");
    expect(snapshotTree(m.base)).toEqual(before);
  });
});
