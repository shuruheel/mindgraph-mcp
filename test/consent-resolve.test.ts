import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consentFor,
  eventDirectory,
  loadConsentStore,
  resolveConsent,
  type ConsentDecision,
} from "../src/consent.js";
import {
  countingFs,
  git,
  makeRepo,
  makeWorkspace,
  makeWorktree,
  pinned,
  repoEntry,
  tempDir,
  workspaceEntry,
  writeStore,
} from "./fixtures/consent.js";

let base: string;
let home: string;
const cleanup: string[] = [];

beforeEach(() => {
  base = tempDir("mindgraph-resolve-");
  home = path.join(base, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  cleanup.push(base);
});
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const at = (...parts: string[]) => path.join(base, ...parts);

/**
 * Resolve through a counting filesystem and hold every resolution to the
 * bound: at most 2 whole-file reads, 3 head reads, and 2 × depth + 8 stats
 * or realpaths, where depth counts the directory's path segments.
 */
function decide(cwd: unknown, env: NodeJS.ProcessEnv = {}): ConsentDecision {
  const counter = countingFs();
  const decision = consentFor(cwd, { fs: counter.fs, env: { MINDGRAPH_HOME: home, ...env } });
  const directory = decision.directory ?? (typeof cwd === "string" && cwd ? cwd : "/");
  const depth = directory.split(path.sep).filter(Boolean).length;
  const { reads, heads, stats, realpaths } = counter.counts;
  expect(reads, "whole-file reads").toBeLessThanOrEqual(2);
  expect(heads, "head reads").toBeLessThanOrEqual(3);
  expect(stats + realpaths, "stats and realpaths").toBeLessThanOrEqual(2 * depth + 8);
  return decision;
}

describe("a consented repository", () => {
  it("is on at its root and in subdirectories, with its pinned identity", () => {
    const repo = makeRepo(at("repo"));
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    writeStore(home, [repoEntry(repo, "github.com/acme/repo")]);
    for (const cwd of [repo, path.join(repo, "src"), path.join(repo, "src", "deep")]) {
      const decision = decide(cwd);
      expect(decision).toMatchObject({
        state: "on",
        reason: "consented",
        directory: cwd,
        root: repo,
        kind: "repo",
        repo: { root: repo, repo_id: "github.com/acme/repo", space_uid: null },
        space_uid: null,
        storeAcknowledged: true,
      });
      expect(decision.state === "on" && decision.repositories).toEqual([
        { root: repo, repo_id: "github.com/acme/repo", space_uid: null },
      ]);
    }
  });

  it("does not cover a sibling whose name shares its prefix", () => {
    const repo = makeRepo(at("repo"));
    const sibling = makeRepo(at("repo-other"));
    const longer = makeRepo(at("repobc"));
    writeStore(home, [repoEntry(repo)]);
    expect(decide(sibling)).toMatchObject({ state: "off", reason: "not_consented", inRepository: true });
    expect(decide(longer)).toMatchObject({ state: "off", reason: "not_consented" });
  });

  it("follows symlinks: a link into the repository is on, a link out of it is off", () => {
    const repo = makeRepo(at("repo"));
    const outside = makeRepo(at("outside"));
    writeStore(home, [repoEntry(repo)]);
    fs.symlinkSync(repo, at("link-in"));
    fs.symlinkSync(outside, path.join(repo, "link-out"));
    expect(decide(at("link-in"))).toMatchObject({ state: "on", directory: repo });
    expect(decide(path.join(repo, "link-out"))).toMatchObject({
      state: "off",
      reason: "not_consented",
      directory: outside,
    });
  });

  it("resolves .. in the event's directory before matching", () => {
    const repo = makeRepo(at("repo"));
    fs.mkdirSync(path.join(repo, "src"));
    const other = makeRepo(at("other"));
    writeStore(home, [repoEntry(repo)]);
    expect(decide(`${repo}/src/..`)).toMatchObject({ state: "on", directory: repo });
    expect(decide(`${repo}/../other`)).toMatchObject({ state: "off", directory: other });
  });

  it.runIf(process.platform === "darwin")("matches a differently cased path on a case-insensitive disk", () => {
    const repo = makeRepo(at("repo"));
    writeStore(home, [repoEntry(repo)]);
    const upper = at("REPO");
    if (!fs.existsSync(upper)) return; // case-sensitive volume: nothing to prove
    expect(decide(upper)).toMatchObject({ state: "on", directory: repo });
  });

  it("stays on after a re-clone at the same path, and turns off when .git is removed", () => {
    const repo = makeRepo(at("repo"));
    writeStore(home, [repoEntry(repo)]);
    fs.rmSync(path.join(repo, ".git"), { recursive: true });
    expect(decide(repo)).toMatchObject({ state: "off", reason: "not_consented", root: repo });
    makeRepo(repo);
    expect(decide(repo)).toMatchObject({ state: "on", reason: "consented" });
  });

  it("is off when the pinned directory was swapped for a symlink", () => {
    const repo = makeRepo(at("repo"));
    const elsewhere = makeRepo(at("elsewhere"));
    writeStore(home, [repoEntry(repo)]);
    fs.rmSync(repo, { recursive: true });
    fs.symlinkSync(elsewhere, repo);
    expect(decide(repo)).toMatchObject({ state: "off", directory: elsewhere });
  });

  it("treats a nested clone inside the repository as undeclared", () => {
    const repo = makeRepo(at("repo"));
    const nested = makeRepo(path.join(repo, "vendor", "lib"));
    writeStore(home, [repoEntry(repo)]);
    expect(decide(nested)).toMatchObject({
      state: "off",
      reason: "undeclared_repository",
      root: repo,
    });
  });
});

describe("the four cases that must stay off", () => {
  it("(a) an unconsented repository while another is consented", () => {
    const repoA = makeRepo(at("repoA"));
    const repoB = makeRepo(at("repoB"));
    writeStore(home, [repoEntry(repoB)]);
    expect(decide(repoA)).toMatchObject({ state: "off", reason: "not_consented" });
    expect(decide(repoB)).toMatchObject({ state: "on" });
  });

  it("(b) a fresh clone carrying a workspace file that lists . and ..", () => {
    const clone = makeRepo(at("clone"));
    fs.mkdirSync(path.join(clone, ".mindgraph"));
    fs.writeFileSync(
      path.join(clone, ".mindgraph", "workspace.json"),
      JSON.stringify({ v: 1, repositories: [{ root: "." }, { root: ".." }] }),
    );
    writeStore(home, []);
    expect(decide(clone)).toMatchObject({ state: "off", reason: "not_consented" });
    expect(decide(base)).toMatchObject({ state: "off", reason: "not_consented" });
    // With no store at all the answer is the same.
    fs.rmSync(path.join(home, "hooks.json"));
    expect(decide(clone)).toMatchObject({ state: "off", reason: "store_missing" });
  });

  function workspaceWithA(): { ws: string; a: string; b: string } {
    const ws = makeRepo(at("ws"));
    const a = makeRepo(path.join(ws, "a"));
    const b = makeRepo(path.join(ws, "b"));
    const file = makeWorkspace(ws, [{ root: "a", space_uid: "space:project:a" }]);
    writeStore(home, [
      workspaceEntry(ws, file, [pinned(a, "space:project:a")], {
        root_enabled: true,
        root_space_uid: "space:workspace:ws",
      }),
    ]);
    return { ws, a, b };
  }

  it("(c) an undeclared sibling under a consented workspace", () => {
    const { ws, a, b } = workspaceWithA();
    expect(decide(b)).toMatchObject({ state: "off", reason: "undeclared_repository", root: ws });
    expect(decide(a)).toMatchObject({
      state: "on",
      kind: "workspace",
      root: ws,
      repo: { root: a },
      space_uid: "space:project:a",
    });
    expect(decide(ws)).toMatchObject({
      state: "on",
      root: ws,
      space_uid: "space:workspace:ws",
    });
    expect(decide(ws)).not.toHaveProperty("repo");
  });

  it("(d) a consented workspace whose file was edited afterwards", () => {
    const { ws, a } = workspaceWithA();
    makeWorkspace(ws, [{ root: "a", space_uid: "space:project:a" }, { root: "b" }]);
    for (const cwd of [a, ws, path.join(ws, "b")]) {
      expect(decide(cwd)).toMatchObject({
        state: "needs_reapproval",
        reason: "workspace_changed",
        root: ws,
      });
    }
  });

  it("a deleted workspace file pauses the whole root", () => {
    const { ws, a } = workspaceWithA();
    fs.rmSync(path.join(ws, ".mindgraph", "workspace.json"));
    expect(decide(a)).toMatchObject({ state: "needs_reapproval", reason: "workspace_missing" });
  });

  it.skipIf(process.platform === "win32")(
    "a workspace file swapped for a link to a FIFO or a device pauses the root at once",
    () => {
      const { a, ws } = workspaceWithA();
      const file = path.join(ws, ".mindgraph", "workspace.json");
      const fifo = at("fifo");
      execFileSync("mkfifo", [fifo]);
      for (const target of [fifo, "/dev/zero"]) {
        fs.rmSync(file);
        fs.symlinkSync(target, file);
        expect(decide(a), target).toMatchObject({
          state: "needs_reapproval",
          reason: "workspace_changed",
          root: ws,
        });
      }
    },
  );

  it("a workspace root that was not turned on stays off at the root", () => {
    const ws = at("plain");
    fs.mkdirSync(ws);
    const a = makeRepo(path.join(ws, "a"));
    const file = makeWorkspace(ws, [{ root: "a" }]);
    writeStore(home, [workspaceEntry(ws, file, [pinned(a)], { root_enabled: false })]);
    expect(decide(ws)).toMatchObject({ state: "off", reason: "root_not_enabled" });
    expect(decide(a)).toMatchObject({ state: "on", repo: { root: a } });
  });

  it("an event that moves from a consented root into an undeclared repository is off for that event", () => {
    const { ws, b } = workspaceWithA();
    expect(decide(ws).state).toBe("on");
    expect(decide(b)).toMatchObject({ state: "off", reason: "undeclared_repository" });
    expect(decide(ws).state).toBe("on");
  });

  it("child workspace files never turn a parent on", () => {
    const parent = at("parent");
    const child = makeRepo(path.join(parent, "child"));
    const sub = makeRepo(path.join(child, "sub"));
    // The child's file names its parent; only `sub` was ever turned on.
    const file = makeWorkspace(child, [{ root: ".." }, { root: "sub" }]);
    writeStore(home, [workspaceEntry(child, file, [pinned(sub)], { root_enabled: false })]);
    expect(decide(parent)).toMatchObject({ state: "off", reason: "not_consented" });
    expect(decide(sub).state).toBe("on");
    expect(decide(child)).toMatchObject({ state: "off", reason: "root_not_enabled" });
  });
});

describe("the environment can only turn MindGraph off", () => {
  it("ignores variables that would route or widen discovery", () => {
    const consented = makeRepo(at("consented"));
    const other = makeRepo(at("other"));
    const ws = at("ws");
    const wsFile = makeWorkspace(ws, [{ root: "../other" }]);
    writeStore(home, [repoEntry(consented)]);
    const env = {
      MINDGRAPH_WORKSPACE_FILE: wsFile.file,
      MINDGRAPH_CODE_REPOS: other,
      MINDGRAPH_REPO_ROOT: other,
      CLAUDE_PROJECT_DIR: consented,
      HOME: consented,
    };
    expect(decide(other, env)).toMatchObject({ state: "off", reason: "not_consented" });
    expect(decide(consented, env).state).toBe("on");
  });

  it("MINDGRAPH_HOOKS=off turns a consented directory off", () => {
    const repo = makeRepo(at("repo"));
    writeStore(home, [repoEntry(repo)]);
    expect(decide(repo, { MINDGRAPH_HOOKS: "off" })).toMatchObject({
      state: "off",
      reason: "hooks_paused",
    });
    expect(decide(repo, { MINDGRAPH_HOOKS: "on" }).state).toBe("on");
  });
});

describe("the event's directory", () => {
  it("is off when missing, empty, relative or gone; never the process's directory", () => {
    const repo = makeRepo(at("repo"));
    writeStore(home, [repoEntry(repo)]);
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      expect(decide(undefined)).toMatchObject({ state: "off", reason: "cwd_missing" });
      expect(decide("")).toMatchObject({ state: "off", reason: "cwd_missing" });
      // A cwd taken from tool-call arguments can be any JSON value.
      for (const value of [null, 123, {}, ["/"]]) {
        expect(decide(value)).toMatchObject({ state: "off", reason: "cwd_missing" });
      }
      expect(decide(".")).toMatchObject({ state: "off", reason: "cwd_unresolvable" });
    } finally {
      process.chdir(cwd);
    }
    expect(decide(path.join(repo, "gone"))).toMatchObject({
      state: "off",
      reason: "cwd_unresolvable",
    });
    expect(eventDirectory({})).toBeUndefined();
    expect(eventDirectory({ cwd: "" })).toBeUndefined();
    expect(eventDirectory({ cwd: 7 })).toBeUndefined();
    expect(eventDirectory({ cwd: repo })).toBe(repo);
  });

  it("maps each store problem to off with a store reason", () => {
    const repo = makeRepo(at("repo"));
    fs.writeFileSync(path.join(home, "hooks.json"), "{ nope", { mode: 0o600 });
    expect(decide(repo)).toMatchObject({ state: "off", reason: "store_unreadable" });
    const loaded = loadConsentStore({ MINDGRAPH_HOME: home });
    expect(resolveConsent(repo, { ...loaded, status: "unsupported_version" })).toMatchObject({
      reason: "store_unsupported_version",
    });
  });
});

describe("linked worktrees", () => {
  it("a worktree of a consented repository is on as that repository", () => {
    const repo = makeRepo(at("repo"));
    const wt = makeWorktree(repo, "feature", at("trees", "feature"));
    writeStore(home, [repoEntry(repo, "github.com/acme/repo")]);
    expect(decide(wt)).toMatchObject({
      state: "on",
      reason: "consented_worktree",
      directory: wt,
      root: repo,
      repo: { repo_id: "github.com/acme/repo" },
    });
  });

  it("a worktree of a pinned workspace repository, placed under the workspace root, is on as that repository", () => {
    const ws = makeRepo(at("ws"));
    const a = makeRepo(path.join(ws, "a"));
    const file = makeWorkspace(ws, [{ root: "a" }]);
    writeStore(home, [workspaceEntry(ws, file, [pinned(a, "space:project:a")])]);
    const wt = makeWorktree(a, "wt-a", path.join(ws, ".worktrees", "wt-a"));
    expect(decide(wt)).toMatchObject({
      state: "on",
      reason: "consented_worktree",
      root: ws,
      repo: { root: a },
      space_uid: "space:project:a",
    });
  });

  it("a worktree of a workspace root that is turned on resolves to the root", () => {
    const ws = makeRepo(at("ws"));
    const a = makeRepo(path.join(ws, "a"));
    const file = makeWorkspace(ws, [{ root: "a" }]);
    writeStore(home, [
      workspaceEntry(ws, file, [pinned(a)], { root_enabled: true, root_space_uid: "space:workspace:ws" }),
    ]);
    const wt = makeWorktree(ws, "overlay", at("overlay-trees", "overlay"));
    const decision = decide(wt);
    expect(decision).toMatchObject({
      state: "on",
      reason: "consented_worktree",
      root: ws,
      space_uid: "space:workspace:ws",
    });
    expect(decision).not.toHaveProperty("repo");
    expect(decision.state === "on" && decision.repositories.map((r) => r.root)).toEqual([a]);
  });

  it("a worktree of a workspace root that is not turned on is off", () => {
    const ws = makeRepo(at("ws"));
    const a = makeRepo(path.join(ws, "a"));
    const file = makeWorkspace(ws, [{ root: "a" }]);
    writeStore(home, [workspaceEntry(ws, file, [pinned(a)], { root_enabled: false })]);
    const wt = makeWorktree(ws, "overlay", at("overlay-trees", "overlay"));
    expect(decide(wt)).toMatchObject({ state: "off", reason: "not_consented" });
  });

  it("a worktree of an unpinned repository is off", () => {
    const repo = makeRepo(at("repo"));
    const unpinned = makeRepo(at("unpinned"));
    writeStore(home, [repoEntry(repo)]);
    const wt = makeWorktree(unpinned, "x", at("trees", "x"));
    expect(decide(wt)).toMatchObject({ state: "off", reason: "not_consented" });
    // Placed inside the consented repository it is an undeclared checkout.
    const inside = makeWorktree(unpinned, "y", path.join(repo, ".worktrees", "y"));
    expect(decide(inside)).toMatchObject({ state: "off", reason: "undeclared_repository" });
  });

  it("a .git file whose admin directory points back elsewhere is off", () => {
    const repo = makeRepo(at("repo"));
    const real = makeWorktree(repo, "real", at("trees", "real"));
    writeStore(home, [repoEntry(repo)]);
    // A copied checkout carrying the same .git file: git's back-pointer still
    // names the real worktree, so the copy is not accepted.
    const copy = at("trees", "copy");
    fs.mkdirSync(copy);
    fs.copyFileSync(path.join(real, ".git"), path.join(copy, ".git"));
    expect(decide(copy)).toMatchObject({ state: "off", reason: "not_consented" });
    expect(decide(real).state).toBe("on");
    // A forged .git file naming an admin directory outside any .git/worktrees.
    const forged = at("forged");
    fs.mkdirSync(path.join(forged, "admin"), { recursive: true });
    fs.writeFileSync(path.join(forged, "admin", "commondir"), path.join(repo, ".git"));
    fs.writeFileSync(path.join(forged, "admin", "gitdir"), path.join(forged, ".git"));
    fs.writeFileSync(path.join(forged, ".git"), `gitdir: ${path.join(forged, "admin")}\n`);
    expect(decide(forged)).toMatchObject({ state: "off", reason: "not_consented" });
  });

  it("is resolved from git's own records, matching what git reports", () => {
    const repo = makeRepo(at("repo"));
    const wt = makeWorktree(repo, "check", at("trees", "check"));
    writeStore(home, [repoEntry(repo)]);
    const common = git(["-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    expect(decide(wt)).toMatchObject({
      state: "on",
      reason: "consented_worktree",
      root: path.dirname(fs.realpathSync.native(common)),
    });
  });

  it("an admin directory whose commondir names another repository is off", () => {
    const repo = makeRepo(at("repo"));
    const other = makeRepo(at("other"));
    const wt = makeWorktree(repo, "check", at("trees", "check"));
    writeStore(home, [repoEntry(repo)]);
    expect(decide(wt).state).toBe("on");
    // The admin directory sits in the consented repository's .git/worktrees
    // and its back-pointer still names the checkout, but git would treat the
    // checkout as belonging to the other repository.
    const commondir = path.join(repo, ".git", "worktrees", "check", "commondir");
    fs.writeFileSync(commondir, `${path.join(other, ".git")}\n`);
    expect(decide(wt)).toMatchObject({ state: "off", reason: "not_consented" });
    fs.rmSync(commondir);
    expect(decide(wt)).toMatchObject({ state: "off", reason: "not_consented" });
  });
});

describe("what consent.ts may import", () => {
  it("imports neither node:child_process nor the CodeGraph adapter", () => {
    const sources = ["consent.ts", "hook-env.ts"].map((name) =>
      fs.readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8"),
    );
    for (const source of sources) {
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(imports.some((m) => m.includes("child_process"))).toBe(false);
      expect(imports.some((m) => m.includes("codegraph"))).toBe(false);
      expect(source).not.toMatch(/require\(|import\(/);
    }
    const consentImports = [...sources[0].matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(consentImports.sort()).toEqual(["./hook-env.js", "node:crypto", "node:fs", "node:path"]);
  });
});
