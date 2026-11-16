// Invariant: the coding-profile MCP server does nothing outside a directory
// the user turned MindGraph on for: no request of any kind, reads included.
// Spawns the built server over stdio, as a host does, with a preload that
// records every fetch and socket connect and answers fetch locally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { adapterFor, NotOptedInRepositoryError, pinnedScope } from "../src/codegraph.js";
import { notOptedIn } from "../src/consent-refusal.js";
import { homeIsAccountHome } from "../src/hook-env.js";
import { runnerRefreshScopes } from "../src/hook-installer.js";
import {
  built,
  consentOn,
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

const ENTRY = path.join(__dirname, "..", "dist", "index.js");
const RECORDER = path.join(__dirname, "fixtures", "fetch-recorder.cjs");
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const TURN_ON = "npx -y mindgraph-mcp@latest on";
const ready = built(ENTRY);

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
  store: string;
  home: string;
  runtime: string;
  log: string;
}

function machine(): Machine {
  const base = scratch("mindgraph-mcp-gate-");
  const m = {
    store: path.join(base, "store"),
    home: path.join(base, "home"),
    runtime: path.join(base, "runtime"),
    log: path.join(base, "requests.jsonl"),
  };
  fs.mkdirSync(m.store, { recursive: true, mode: 0o700 });
  fs.mkdirSync(m.home, { recursive: true });
  return m;
}

function requests(m: Machine): Array<Record<string, unknown>> {
  if (!fs.existsSync(m.log)) return [];
  return fs
    .readFileSync(m.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function serve(
  m: Machine,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ mcp: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: m.home,
      MINDGRAPH_HOME: m.store,
      MINDGRAPH_RUNTIME_DIR: m.runtime,
      MINDGRAPH_API_KEY: "mg_test_not_a_real_key",
      MINDGRAPH_BASE_URL: "http://server.mindgraph.invalid",
      MINDGRAPH_PROFILE: "coding",
      NODE_OPTIONS: `--require=${RECORDER}`,
      MINDGRAPH_TEST_REQUESTS: m.log,
      ...env,
    },
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const mcp = new Client({ name: "consent-gate-test", version: "0" });
  await mcp.connect(transport);
  return { mcp, stderr: () => err };
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function body(result: CallResult): Record<string, unknown> {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
    string,
    unknown
  >;
}

/** The four places the gate must hold. Each returns the session directory. */
const CASES: Record<string, (m: Machine) => string> = {
  "an unconsented repository while another is consented": (m) => {
    const base = scratch("mindgraph-case-a-");
    const repoA = makeRepo(path.join(base, "repoA"));
    const repoB = makeRepo(path.join(base, "repoB"));
    writeStore(m.store, [repoEntry(repoB)]);
    return repoA;
  },
  "a fresh clone whose workspace file declares itself and its parent": () => {
    const base = scratch("mindgraph-case-b-");
    const clone = makeRepo(path.join(base, "clone"));
    fs.mkdirSync(path.join(clone, ".mindgraph"));
    fs.writeFileSync(
      path.join(clone, ".mindgraph", "workspace.json"),
      JSON.stringify({ v: 1, repositories: [{ root: "." }, { root: ".." }] }),
    );
    return clone;
  },
  "an undeclared repository inside a consented workspace": (m) => {
    const ws = makeRepo(path.join(scratch("mindgraph-case-c-"), "ws"));
    const a = makeRepo(path.join(ws, "a"));
    makeRepo(path.join(ws, "b"));
    const workspace = makeWorkspace(ws, [{ root: "a" }]);
    writeStore(m.store, [workspaceEntry(ws, workspace, [pinned(a)])]);
    return path.join(ws, "b");
  },
  "a pinned repository after the workspace file changed": (m) => {
    const ws = makeRepo(path.join(scratch("mindgraph-case-d-"), "ws"));
    const a = makeRepo(path.join(ws, "a"));
    makeRepo(path.join(ws, "b"));
    const workspace = makeWorkspace(ws, [{ root: "a" }]);
    writeStore(m.store, [workspaceEntry(ws, workspace, [pinned(a)])]);
    makeWorkspace(ws, [{ root: "a" }, { root: "b" }]);
    return a;
  },
};

describe.runIf(ready)("the coding server outside consent", () => {
  for (const [name, setup] of Object.entries(CASES)) {
    it(`makes no request: ${name}`, async () => {
      const m = machine();
      const cwd = setup(m);
      const { mcp } = await serve(m, cwd);
      try {
        const { tools } = await mcp.listTools();
        expect(tools.map((tool) => tool.name)).toContain("mindgraph_code");
        const resume = await mcp.callTool({
          name: "mindgraph_memory",
          arguments: { action: "context", mode: "resume" },
        });
        const journal = await mcp.callTool({
          name: "mindgraph_capture",
          arguments: { action: "journal", content: "should not leave" },
        });
        for (const result of [resume, journal]) {
          expect(result.isError).toBe(true);
          expect(body(result)).toMatchObject({ code: "not_opted_in", retriable: false });
          expect(result.structuredContent).toMatchObject({ code: "not_opted_in" });
        }
        await expect(
          mcp.readResource({ uri: "mindgraph://memory/status" }),
        ).rejects.toThrow(/not_opted_in/);
      } finally {
        await mcp.close();
      }
      expect(requests(m)).toEqual([]);
    }, 30_000);
  }

  it("names the directory and the command, and is not retriable", async () => {
    const m = machine();
    const cwd = CASES["an unconsented repository while another is consented"](m);
    const { mcp } = await serve(m, cwd);
    try {
      const result = await mcp.callTool({
        name: "mindgraph_memory",
        arguments: { action: "context", mode: "resume" },
      });
      const payload = body(result);
      expect(payload).toEqual({
        error: expect.stringContaining(`MindGraph is off in ${cwd}.`),
        code: "not_opted_in",
        retriable: false,
        state: "off",
        reason: "not_consented",
        directory: cwd,
        command: `${TURN_ON} ${cwd}`,
      });
      expect(payload.error).toContain(TURN_ON);
      expect(payload.error).not.toMatch(/\bD1\b|B1[a-f]/);
      expect(result.structuredContent).toEqual(payload);
    } finally {
      await mcp.close();
    }
    expect(requests(m)).toEqual([]);
  }, 30_000);

  it("tells the model in its instructions that MindGraph is off here", async () => {
    const m = machine();
    const cwd = CASES["an unconsented repository while another is consented"](m);
    const { mcp } = await serve(m, cwd);
    try {
      expect(mcp.getInstructions()).toContain(
        "MindGraph is off in this directory: do not call its tools unless the user asks",
      );
    } finally {
      await mcp.close();
    }
  }, 30_000);
});

/** A consented repository carrying a committed workspace file that declares
 * a sibling it was never turned on for. */
function consentedWithSibling(m: Machine) {
  const base = scratch("mindgraph-pinned-");
  const repo = makeRepo(path.join(base, "repo"));
  const other = makeRepo(path.join(base, "other"));
  fs.mkdirSync(path.join(repo, "memory"));
  fs.writeFileSync(path.join(repo, "memory", "notes.md"), "# repo notes\n");
  fs.mkdirSync(path.join(other, "memory"));
  fs.writeFileSync(path.join(other, "memory", "secret.md"), "other-secret-91c2\n");
  makeWorkspace(repo, [{ root: "." }, { root: "../other" }]);
  writeStore(m.store, [repoEntry(repo)]);
  return { base, repo, other };
}

describe.runIf(ready)("inside consent, tools work only on the pinned repositories", () => {
  it("never reaches a repository the workspace file declares but consent does not", async () => {
    const m = machine();
    const { base, repo, other } = consentedWithSibling(m);
    const before = snapshotTree(base);
    const { mcp } = await serve(m, repo, {
      MINDGRAPH_GOVERNANCE: "off",
      MINDGRAPH_CODE_REPOS: JSON.stringify({ "local/other": "../other" }),
      MINDGRAPH_REPO_ROOT: other,
      MINDGRAPH_WORKSPACE_FILE: path.join(repo, ".mindgraph", "workspace.json"),
    });
    try {
      const scan = await mcp.callTool({
        name: "mindgraph_sync",
        arguments: { action: "scan", workspace: true },
      });
      expect(scan.isError, JSON.stringify(body(scan))).toBeFalsy();
      const scanned = body(scan) as { repositories: Array<{ repo_id: string }> };
      expect(scanned.repositories.map((r) => r.repo_id)).toEqual([`local/repo`]);

      for (const repoArg of ["/", "other", "local/other", other]) {
        const begin = await mcp.callTool({
          name: "mindgraph_sync",
          arguments: { action: "begin", repo: repoArg, logical_path: "memory/secret.md" },
        });
        expect(begin.isError, repoArg).toBe(true);
        expect(body(begin), repoArg).toMatchObject({
          code: "not_opted_in",
          reason: "outside_pinned_set",
          retriable: false,
        });
      }

      const code = await mcp.callTool({
        name: "mindgraph_code",
        arguments: {
          action: "recall",
          code_refs: [{ path: path.join(other, "memory", "secret.md") }],
        },
      });
      expect(code.isError).toBe(true);
      expect(body(code)).toMatchObject({ code: "not_opted_in", reason: "outside_pinned_set" });
    } finally {
      await mcp.close();
    }
    const sent = JSON.stringify(requests(m));
    expect(sent).not.toContain("other-secret-91c2");
    expect(sent).not.toContain("local/other");
    expect(sent).not.toContain(other);
    // The scan of the pinned repository did reach the server.
    expect(sent).toContain("notes.md");
    // Nothing was written anywhere: no repository-id in either checkout.
    expect(snapshotTree(base)).toEqual(before);
  }, 30_000);

  it("scope='workspace' resolves only the pinned set", async () => {
    const m = machine();
    const { base, repo, other } = consentedWithSibling(m);
    const before = snapshotTree(base);
    const { mcp } = await serve(m, repo, { MINDGRAPH_GOVERNANCE: "off" });
    try {
      await mcp.callTool({
        name: "mindgraph_memory",
        arguments: { action: "context", mode: "resume", scope: "workspace" },
      });
    } finally {
      await mcp.close();
    }
    const identities = requests(m)
      .map((r) => r.body as { action?: string; identity?: { key?: { repo_id?: string } } })
      .filter((b) => b?.action === "resolve_identity")
      .map((b) => b.identity?.key?.repo_id);
    expect(identities).toEqual(["local/repo"]);
    expect(JSON.stringify(requests(m))).not.toContain(other);
    expect(snapshotTree(base)).toEqual(before);
  }, 30_000);

  it("refuses a call whose own directory is off", async () => {
    const m = machine();
    const { repo, other } = consentedWithSibling(m);
    const { mcp } = await serve(m, repo);
    try {
      const result = await mcp.callTool({
        name: "mindgraph_memory",
        arguments: { action: "context", mode: "resume", invocation_context: { cwd: other } },
      });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        code: "not_opted_in",
        retriable: false,
        reason: "not_consented",
        directory: other,
      });
    } finally {
      await mcp.close();
    }
    expect(requests(m)).toEqual([]);
  }, 30_000);

  it("refuses a call whose own directory is on, but under another root than the session's", async () => {
    const m = machine();
    const { repo, other } = consentedWithSibling(m);
    writeStore(m.store, [repoEntry(repo), repoEntry(other)]);
    const { mcp } = await serve(m, repo);
    try {
      const result = await mcp.callTool({
        name: "mindgraph_capture",
        arguments: { action: "journal", content: "wrong root", invocation_context: { cwd: other } },
      });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        code: "not_opted_in",
        retriable: false,
        reason: "outside_root",
        directory: other,
      });
    } finally {
      await mcp.close();
    }
    expect(requests(m)).toEqual([]);
  }, 30_000);

  it("never echoes a call directory that does not resolve", async () => {
    const m = machine();
    const { repo } = consentedWithSibling(m);
    const { mcp } = await serve(m, repo);
    try {
      for (const cwd of ["~root", "=ls", "relative/dir", "", 5, null, { toString: "x" }]) {
        const label = JSON.stringify(cwd);
        const result = await mcp.callTool({
          name: "mindgraph_capture",
          arguments: { action: "journal", content: "x", invocation_context: { cwd } },
        });
        expect(result.isError, label).toBe(true);
        const payload = body(result);
        expect(payload, label).toMatchObject({
          code: "not_opted_in",
          retriable: false,
          directory: "",
          command: TURN_ON,
        });
        expect(["cwd_missing", "cwd_unresolvable"], label).toContain(payload.reason);
        expect(payload.error, label).toContain("could not be resolved");
        if (typeof cwd === "string" && cwd !== "") {
          expect(payload.error, label).not.toContain(cwd);
        }
      }
    } finally {
      await mcp.close();
    }
    expect(requests(m)).toEqual([]);
  }, 30_000);

  it("positive control: a consented server lists the ontology's tools and serves a call", async () => {
    const m = machine();
    const { repo } = consentedWithSibling(m);
    const { mcp } = await serve(m, repo, { MINDGRAPH_GOVERNANCE: "off" });
    try {
      expect(mcp.getInstructions() ?? "").not.toContain("MindGraph is off in this directory");
      await mcp.listTools();
      const afterList = requests(m);
      expect(afterList.length).toBeGreaterThan(0);
      expect(JSON.stringify(afterList)).toContain("/ontology");
      const result = await mcp.callTool({
        name: "mindgraph_capture",
        arguments: { action: "journal", content: "allowed here" },
      });
      expect(body(result).code, JSON.stringify(body(result))).not.toBe("not_opted_in");
      expect(JSON.stringify(requests(m)), JSON.stringify(body(result))).toContain("allowed here");
    } finally {
      await mcp.close();
    }
  }, 30_000);
});

describe.runIf(ready)("the general profile is not gated", () => {
  it("lists the ontology's tools with no consent store, and has no workspace scope", async () => {
    const m = machine();
    const cwd = makeRepo(path.join(scratch("mindgraph-general-"), "repo"));
    const { mcp } = await serve(m, cwd, {
      MINDGRAPH_PROFILE: "general",
      MINDGRAPH_GOVERNANCE: "off",
    });
    try {
      await mcp.listTools();
      expect(JSON.stringify(requests(m))).toContain("/ontology");
      const result = await mcp.callTool({
        name: "mindgraph_memory",
        arguments: { action: "context", mode: "resume", scope: "workspace" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(body(result))).toContain("scope='workspace' works only in the local coding setup");
    } finally {
      await mcp.close();
    }
  }, 30_000);
});

const OWNED_COMMAND =
  'node "$HOME/.mindgraph/bin/mindgraph-hook.cjs" hook --harness claude-code --owner mindgraph';
/** Settings carrying an owned hook entry with a stale timeout, which a
 * refresh rewrites. */
const STALE_SETTINGS = `${JSON.stringify(
  {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: OWNED_COMMAND, timeout: 1 }] }],
    },
  },
  null,
  2,
)}\n`;

// The runner lives beside hooks.json, in MINDGRAPH_HOME's bin/.
function installRunner(m: Machine, version: string) {
  const bin = path.join(m.store, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "mindgraph-hook.cjs"), `// runner ${version}\n`);
  fs.writeFileSync(path.join(bin, "mindgraph-hook.cjs.version"), `${version}\n`);
  fs.mkdirSync(path.join(m.home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(m.home, ".claude", "settings.json"), STALE_SETTINGS);
}

function projectWithOwnedHooks(): string {
  const repo = makeRepo(path.join(scratch("mindgraph-refresh-"), "repo"));
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), STALE_SETTINGS);
  return repo;
}

// Which entries the server refreshes at start, decided before any write.
describe("runnerRefreshScopes", () => {
  it("inside consent refreshes the user and project entries", () => {
    expect(runnerRefreshScopes(true, false, true)).toEqual(["user", "project"]);
  });
  it("outside consent refreshes only a runner that predates consent, and only the user entries", () => {
    expect(runnerRefreshScopes(false, true, true)).toEqual(["user"]);
    expect(runnerRefreshScopes(false, false, true)).toBeUndefined();
  });
  it("never refreshes when $HOME is not the account's home", () => {
    expect(runnerRefreshScopes(true, false, false)).toBeUndefined();
    expect(runnerRefreshScopes(false, true, false)).toBeUndefined();
  });
  it("homeIsAccountHome compares $HOME with the password database by real path", () => {
    expect(homeIsAccountHome(scratch("mindgraph-not-home-"))).toBe(false);
    expect(homeIsAccountHome(os.userInfo().homedir)).toBe(true);
    expect(homeIsAccountHome("")).toBe(false);
  });
});

// The spawned servers below run with a temporary HOME, which is never the
// account's home, so they never refresh: the positive path is the
// runnerRefreshScopes cases above (and refreshHookRunner's own tests).
describe.runIf(ready)("runner refresh at server start, outside consent", () => {
  it("never writes into a repository that $HOME points at, even for a runner that predates consent", async () => {
    const m = machine();
    const consented = makeRepo(path.join(scratch("mindgraph-refresh-r-"), "r"));
    writeStore(m.store, [repoEntry(consented)]);
    // An unconsented repository committing a stale runner and owned hooks.
    const x = projectWithOwnedHooks();
    for (const bin of [path.join(x, ".mindgraph", "bin"), path.join(m.store, "bin")]) {
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "mindgraph-hook.cjs"), "// runner 0.20.0\n");
      fs.writeFileSync(path.join(bin, "mindgraph-hook.cjs.version"), "0.20.0\n");
    }
    const before = snapshotTree(x);
    const storeBefore = snapshotTree(m.store);
    for (const profile of ["coding", "general"]) {
      const { mcp, stderr } = await serve(m, x, { HOME: x, MINDGRAPH_PROFILE: profile });
      await mcp.listTools();
      await mcp.close();
      expect(snapshotTree(x), profile).toEqual(before);
      expect(snapshotTree(m.store), profile).toEqual(storeBefore);
      expect(stderr(), profile).not.toContain("refreshed");
      expect(stderr(), profile).toContain("predates consent and ignores it");
    }
  }, 30_000);

  it("leaves a runner that already checks consent alone", async () => {
    const m = machine();
    installRunner(m, "9.0.0");
    const repo = projectWithOwnedHooks();
    const before = snapshotTree(m.home);
    const { mcp, stderr } = await serve(m, repo);
    await mcp.close();
    expect(snapshotTree(m.home)).toEqual(before);
    expect(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8")).toBe(
      STALE_SETTINGS,
    );
    expect(stderr()).not.toContain("predates consent");
  }, 30_000);

  it("with MINDGRAPH_HOOK_AUTOUPDATE=off, warns on stderr and changes nothing", async () => {
    const m = machine();
    installRunner(m, "0.20.0");
    const repo = projectWithOwnedHooks();
    const before = snapshotTree(m.home);
    const storeBefore = snapshotTree(m.store);
    const { mcp, stderr } = await serve(m, repo, { MINDGRAPH_HOOK_AUTOUPDATE: "off" });
    await mcp.listTools();
    await mcp.close();
    expect(snapshotTree(m.home)).toEqual(before);
    expect(snapshotTree(m.store)).toEqual(storeBefore);
    expect(stderr()).toContain(
      "[mindgraph-mcp] the installed hook runner v0.20.0 predates consent and ignores it; run npx -y mindgraph-mcp@latest install-hooks",
    );
  }, 30_000);
});

describe("the pinned adapter", () => {
  function workspaceDecision() {
    const ws = makeRepo(path.join(scratch("mindgraph-pinned-ws-"), "ws"));
    const a = makeRepo(path.join(ws, "a"));
    const b = makeRepo(path.join(ws, "b"));
    const decision = consentOn(ws, [pinned(a), pinned(b)], {
      kind: "workspace",
      repo: undefined,
      space_uid: "space:workspace:ws",
    });
    delete decision.repo;
    return { ws, a, b, decision };
  }

  it("at a workspace root, asks for a repository and never falls back to discovery", async () => {
    const { a, decision } = workspaceDecision();
    const adapter = adapterFor({}, { profile: "coding", consent: decision });
    await expect(adapter.resolveRepository()).rejects.toThrow(/name a repository/);
    await expect(adapter.resolveRepository()).rejects.toBeInstanceOf(NotOptedInRepositoryError);
    expect(await adapter.resolveRepository("a")).toEqual({
      repoId: "local/a",
      repoRoot: a,
      spaceUid: "space:project:a",
    });
    await expect(adapter.resolveRepository("ws")).rejects.toBeInstanceOf(
      NotOptedInRepositoryError,
    );
  });

  it("returns the pinned identities as stored, skipping one that lost its .git", async () => {
    const { b, decision } = workspaceDecision();
    fs.rmSync(path.join(b, ".git"), { recursive: true, force: true });
    const adapter = adapterFor({}, { profile: "coding", consent: decision });
    expect((await adapter.resolveRepositories()).map((r) => r.repoId)).toEqual(["local/a"]);
    await expect(adapter.resolveRepository("b")).rejects.toBeInstanceOf(
      NotOptedInRepositoryError,
    );
  });

  it("in a linked worktree, reads the worktree's files under the pinned identity", async () => {
    const base = scratch("mindgraph-pinned-wt-");
    const repo = makeRepo(path.join(base, "repo"));
    const tree = makeWorktree(repo, "feature", path.join(base, "trees", "feature"));
    const decision = consentOn(repo, [pinned(repo)], {
      reason: "consented_worktree",
      directory: tree,
    });
    const scope = pinnedScope(decision);
    expect(scope.repo).toEqual({ ...pinned(repo), root: tree, pinned_root: repo });
    const adapter = adapterFor({}, { profile: "coding", consent: decision });
    const identity = { repoId: `local/${path.basename(repo)}`, repoRoot: tree };
    expect(await adapter.resolveRepository()).toMatchObject(identity);
    // The repository is still named by its id, its stored root or that root's name.
    for (const name of [identity.repoId, repo, path.basename(repo)]) {
      expect(await adapter.resolveRepository(name), name).toMatchObject(identity);
    }
    await expect(adapter.resolveRepository(base)).rejects.toBeInstanceOf(
      NotOptedInRepositoryError,
    );
  });

  it("in the local coding profile, refuses with no consent decision at all", () => {
    expect(() => adapterFor({}, { profile: "coding" })).toThrow(NotOptedInRepositoryError);
  });
});

describe("the refusal's command", () => {
  it("quotes a directory a shell would expand", () => {
    for (const dir of ["~root", "=ls"]) {
      expect(notOptedIn({ state: "off", reason: "not_consented" }, dir).command).toBe(
        `${TURN_ON} '${dir}'`,
      );
    }
    expect(notOptedIn({ state: "off", reason: "not_consented" }, "/a/b~c=d").command).toBe(
      `${TURN_ON} /a/b~c=d`,
    );
  });
});

describe("the server checks the directory the hook recorded for a call", () => {
  it("refuses when the hook's invocation_context.cwd is off, before governance", async () => {
    const { Client } = await import("@modelcontextprotocol/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/server");
    const { buildMindGraphServer } = await import("../src/server.js");
    const asked: unknown[] = [];
    const governed: string[] = [];
    const server = buildMindGraphServer({
      client: {} as never,
      serverVersion: "test",
      instructions: "",
      profile: "coding",
      agentId: "agent-1",
      governance: {
        baseUrl: "https://api.example.test",
        apiKey: "mg_live_test",
        agentId: "agent-1",
        fetchImpl: (async (_url: unknown, init?: { body?: unknown }) => {
          governed.push(String(init?.body ?? ""));
          throw new Error("offline");
        }) as unknown as typeof fetch,
      },
      memory: { profile: "coding" },
      // On for the session; off for any call that names a directory.
      consent: (callCwd?: unknown) => {
        asked.push(callCwd);
        return callCwd === undefined
          ? {
              allowed: true,
              decision: consentOn("/repo", [
                { root: "/repo", repo_id: "local/repo", space_uid: null },
              ]),
            }
          : {
              allowed: false,
              payload: notOptedIn({
                state: "off",
                reason: "not_consented",
                directory: String(callCwd),
              }),
            };
      },
      resolveHookFields: () => ({ invocation_context: { cwd: "/elsewhere" } }),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "hook-cwd", version: "0" });
    await mcp.connect(clientSide);
    const result = await mcp.callTool({
      name: "mindgraph_capture",
      arguments: { action: "journal", content: "x" },
    });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ code: "not_opted_in", directory: "/elsewhere" });
    expect(asked).toEqual([undefined, "/elsewhere"]);
    expect(governed).toEqual([]);
  });
});
