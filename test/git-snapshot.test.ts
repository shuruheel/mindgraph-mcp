import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSnapshot } from "../src/hook-core.js";
import { git, makeRepo, tempDir } from "./fixtures/consent.js";

/** What the three separate commands said before they became one. */
function threeCommands(cwd: string) {
  const run = (args: string[]) => {
    try {
      return git(["-C", cwd, ...args]).trim();
    } catch {
      return undefined;
    }
  };
  const status = run(["status", "--porcelain"]);
  return {
    branch: run(["branch", "--show-current"]),
    commit: run(["rev-parse", "HEAD"]),
    worktreeState: status === undefined ? "unknown" : status ? "dirty" : "clean",
  };
}

describe("gitSnapshot", () => {
  it("matches branch, rev-parse HEAD and status --porcelain in every state", () => {
    const repo = makeRepo(path.join(tempDir("mindgraph-git-"), "repo"));
    // No commit yet: a branch, no commit, clean.
    expect(gitSnapshot(repo)).toEqual(threeCommands(repo));
    expect(gitSnapshot(repo).commit).toBeUndefined();

    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    // An untracked file is dirty, as before.
    expect(gitSnapshot(repo)).toMatchObject({ worktreeState: "dirty" });
    expect(gitSnapshot(repo)).toEqual(threeCommands(repo));

    git(["-C", repo, "add", "a.txt"]);
    git(["-C", repo, "commit", "-q", "-m", "a"]);
    const clean = gitSnapshot(repo);
    expect(clean).toEqual(threeCommands(repo));
    expect(clean.worktreeState).toBe("clean");
    expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);

    fs.writeFileSync(path.join(repo, "a.txt"), "b\n");
    expect(gitSnapshot(repo)).toEqual(threeCommands(repo));

    git(["-C", repo, "checkout", "-q", "--", "a.txt"]);
    git(["-C", repo, "checkout", "-q", "--detach"]);
    const detached = gitSnapshot(repo);
    expect(detached).toEqual(threeCommands(repo));
    expect(detached.branch).toBe("");
  });

  it("knows nothing outside a repository", () => {
    const dir = tempDir("mindgraph-nogit-");
    expect(gitSnapshot(dir)).toEqual({ worktreeState: "unknown" });
    expect(threeCommands(dir).worktreeState).toBe("unknown");
  });
});
