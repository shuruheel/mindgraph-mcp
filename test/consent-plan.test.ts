import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsentPlanError,
  nodeGit,
  planConsent,
  resolveRepositoryId,
  validateWorkspaceEntry,
  type WorkspacePlan,
} from "../src/consent-plan.js";
import {
  git,
  makeRepo,
  makeWorkspace,
  ownerWorkspace,
  snapshotTree,
  tempDir,
} from "./fixtures/consent.js";

const GIT = nodeGit({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = tempDir("mindgraph-plan-");
  cleanup.push(dir);
  return dir;
}

function refusalFor(root: string, entry: unknown, seen = new Set<string>()): string | undefined {
  const result = validateWorkspaceEntry(root, entry, seen, GIT);
  return "refused" in result ? result.refused.reason : undefined;
}

describe("validateWorkspaceEntry", () => {
  it("refuses '..' and absolute roots", () => {
    const root = makeRepo(path.join(scratch(), "ws"));
    expect(refusalFor(root, { root: ".." })).toBe("\"..\" and absolute roots are not allowed");
    expect(refusalFor(root, { root: "a/../../other" })).toBe(
      "\"..\" and absolute roots are not allowed",
    );
    expect(refusalFor(root, { root: "/etc" })).toBe("\"..\" and absolute roots are not allowed");
  });

  it("refuses a symlink that leads out of the workspace", () => {
    const base = scratch();
    const root = makeRepo(path.join(base, "ws"));
    const outside = makeRepo(path.join(base, "outside"));
    fs.symlinkSync(outside, path.join(root, "link"));
    expect(refusalFor(root, { root: "link" })).toBe("resolves outside the workspace");
  });

  it("refuses a directory that is not the top of a git repository", () => {
    const root = makeRepo(path.join(scratch(), "ws"));
    const repo = makeRepo(path.join(root, "a"));
    fs.mkdirSync(path.join(repo, "sub"));
    fs.mkdirSync(path.join(root, "plain"));
    expect(refusalFor(root, { root: "a/sub" })).toBe("not the top of a git repository");
    expect(refusalFor(root, { root: "plain" })).toBe("not the top of a git repository");
  });

  it("lists a missing repository, a duplicate, the root itself and an entry with no root", () => {
    const root = makeRepo(path.join(scratch(), "ws"));
    makeRepo(path.join(root, "a"));
    const seen = new Set<string>();
    expect(refusalFor(root, { root: "gone" }, seen)).toBe("not found on this machine");
    expect(refusalFor(root, { root: "a" }, seen)).toBeUndefined();
    expect(refusalFor(root, { root: "./a" }, seen)).toBe("listed twice");
    expect(refusalFor(root, { root: "." }, seen)).toBe("the workspace root is turned on separately");
    expect(refusalFor(root, { space_uid: "space:x" }, seen)).toBe("no root");
  });

  it("keeps a valid space and a well-formed declared id, and drops malformed ones", () => {
    const root = makeRepo(path.join(scratch(), "ws"));
    makeRepo(path.join(root, "a"));
    makeRepo(path.join(root, "b"));
    const seen = new Set<string>();
    const good = validateWorkspaceEntry(
      root,
      { root: "a", space_uid: "space:project:a", repo_id: "github.com/acme/a" },
      seen,
      GIT,
    );
    expect(good).toEqual({
      included: {
        name: "a",
        root: path.join(root, "a"),
        declared_repo_id: "github.com/acme/a",
        space_uid: "space:project:a",
      },
    });
    const bad = validateWorkspaceEntry(
      root,
      { root: "b", space_uid: "not a space", repo_id: "has spaces in it" },
      seen,
      GIT,
    );
    expect(bad).toEqual({ included: { name: "b", root: path.join(root, "b"), space_uid: null } });
  });
});

describe("planConsent", () => {
  it("a workspace shaped like the owner's: the root plus each listed repository with its space, and the unlisted ones", () => {
    const base = scratch();
    const { root, repos, workspace } = ownerWorkspace(base);
    const before = snapshotTree(base);
    const plan = planConsent(root, { git: GIT }) as WorkspacePlan;
    expect(plan.kind).toBe("workspace");
    expect(plan.root).toBe(root);
    expect(plan.workspace_sha256).toBe(workspace.sha256);
    expect(plan.root_space_uid).toBe("space:workspace:mindgraph");
    expect(plan.root_is_repository).toBe(true);
    expect(plan.listed).toBe(3);
    expect(plan.refused).toEqual([]);
    expect(plan.included.map((r) => [r.root, r.space_uid])).toEqual([
      [repos[0], "space:project:rs"],
      [repos[1], "space:project:cloud"],
      [repos[2], "space:project:mcp"],
    ]);
    expect(plan.undeclared).toEqual(["mindgraph-mobile", "mindgraph-tools"]);
    // Planning never writes, not even a repository-id file.
    expect(snapshotTree(base)).toEqual(before);
  });

  it("finds the workspace from inside one of its repositories", () => {
    const { root, repos } = ownerWorkspace(scratch());
    const plan = planConsent(path.join(repos[1]), { git: GIT });
    expect(plan.kind).toBe("workspace");
    expect(plan.root).toBe(root);
    expect(plan.target).toBe(repos[1]);
  });

  it("a workspace with no usable id gets a root space from its path", () => {
    const root = makeRepo(path.join(scratch(), "ws"));
    makeWorkspace(root, [], "not a valid id!");
    const plan = planConsent(root, { git: GIT }) as WorkspacePlan;
    expect(plan.root_space_uid).toMatch(/^space:workspace:[0-9a-f]{12}$/);
    expect(plan.workspace_id).toBeUndefined();
  });

  it("refused entries are listed and never included", () => {
    const base = scratch();
    const root = makeRepo(path.join(base, "ws"));
    makeRepo(path.join(root, "a"));
    makeRepo(path.join(base, "outside"));
    makeWorkspace(root, [{ root: "a" }, { root: "../outside" }, { root: "missing" }]);
    const plan = planConsent(root, { git: GIT }) as WorkspacePlan;
    expect(plan.included.map((r) => r.name)).toEqual(["a"]);
    expect(plan.refused).toEqual([
      { name: "../outside", reason: "\"..\" and absolute roots are not allowed" },
      { name: "missing", reason: "not found on this machine" },
    ]);
  });

  it("a repository without a workspace file plans its top level", () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    fs.mkdirSync(path.join(repo, "src"));
    expect(planConsent(path.join(repo, "src"), { git: GIT })).toEqual({
      kind: "repo",
      target: path.join(repo, "src"),
      root: repo,
    });
  });

  it("refuses a missing directory, a folder outside git, the home directory and an unreadable workspace file", () => {
    const base = scratch();
    expect(() => planConsent(path.join(base, "nope"), { git: GIT })).toThrow(
      /No such directory/,
    );
    fs.mkdirSync(path.join(base, "plain"));
    expect(() => planConsent(path.join(base, "plain"), { git: GIT })).toThrow(
      /No git repository or MindGraph workspace/,
    );
    expect(() => planConsent(base, { git: GIT, home: base })).toThrow(ConsentPlanError);
    expect(() => planConsent(base, { git: GIT, home: base })).toThrow(
      /not for your home directory/,
    );
    const ws = makeRepo(path.join(base, "ws"));
    fs.mkdirSync(path.join(ws, ".mindgraph"));
    fs.writeFileSync(path.join(ws, ".mindgraph", "workspace.json"), "{ nope");
    expect(() => planConsent(ws, { git: GIT })).toThrow(/not a workspace file/);
  });

  it("refuses a repository whose top level is the home directory", () => {
    const home = makeRepo(path.join(scratch(), "home"));
    fs.mkdirSync(path.join(home, "notes"));
    expect(() => planConsent(path.join(home, "notes"), { git: GIT, home })).toThrow(
      /is your home directory/,
    );
  });

  it("refuses a workspace file that is too large or not a regular file, as resolution would", () => {
    const base = scratch();
    const ws = makeRepo(path.join(base, "ws"));
    makeRepo(path.join(ws, "a"));
    const file = makeWorkspace(ws, [{ root: "a" }]).file;
    const valid = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, valid + " ".repeat(1024 * 1024));
    expect(() => planConsent(ws, { git: GIT })).toThrow(/regular file of at most 1 MiB/);
    fs.rmSync(file);
    execFileSync("mkfifo", [file]);
    expect(() => planConsent(ws, { git: GIT })).toThrow(/regular file of at most 1 MiB/);
  });

  it("passes over a workspace file another account owns", () => {
    const base = scratch();
    const ws = makeRepo(path.join(base, "ws"));
    const repo = makeRepo(path.join(ws, "a"));
    makeWorkspace(ws, [{ root: "a" }]);
    expect(planConsent(repo, { git: GIT }).kind).toBe("workspace");
    const other = (process.getuid?.() ?? 0) + 1;
    expect(planConsent(repo, { git: GIT, uid: other })).toEqual({
      kind: "repo",
      target: repo,
      root: repo,
    });
  });

  it("does not look for a workspace file at or above the home directory", () => {
    const home = scratch();
    makeWorkspace(home, [{ root: "app" }]);
    const repo = makeRepo(path.join(home, "app"));
    expect(planConsent(repo, { git: GIT, home })).toMatchObject({ kind: "repo", root: repo });
  });
});

describe("resolveRepositoryId", () => {
  it("prefers the declared id, then the remote, then a durable local id", () => {
    const base = scratch();
    const remote = makeRepo(path.join(base, "remote"));
    git(["-C", remote, "remote", "add", "origin", "https://github.com/Acme/App.git"]);
    expect(resolveRepositoryId(remote, "declared/id", GIT)).toBe("declared/id");
    expect(resolveRepositoryId(remote, undefined, GIT)).toBe("github.com/Acme/App");
    const local = makeRepo(path.join(base, "local"));
    const id = resolveRepositoryId(local, undefined, GIT);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.readFileSync(path.join(local, ".git", "mindgraph", "repository-id"), "utf8").trim()).toBe(id);
    expect(resolveRepositoryId(local, undefined, GIT)).toBe(id);
  });
});
