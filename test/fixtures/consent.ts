import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  nodeConsentFs,
  type ConsentFs,
  type ConsentRoot,
  type OnDecision,
  type PinnedRepository,
} from "../../src/consent.js";

/** An on decision for tests that call hooks directly. `repositories` is
 * required, as it is on every real on decision. */
export function consentOn(
  root: string,
  repositories: PinnedRepository[],
  extra: Partial<OnDecision> = {},
): OnDecision {
  const repo = repositories.find((r) => r.root === root) ?? repositories[0];
  return {
    state: "on",
    reason: "consented",
    directory: root,
    root,
    kind: repositories.length === 1 && repositories[0].root === root ? "repo" : "workspace",
    ...(repo ? { repo } : {}),
    space_uid: repo?.space_uid ?? null,
    repositories,
    storeAcknowledged: true,
    ...extra,
  };
}

/** A fresh real-path temporary directory, removed by `cleanup()`. */
export function tempDir(prefix = "mindgraph-consent-"): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

export function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" }).toString();
}

/** A real git repository at `dir` (created if needed); returns its real path. */
export function makeRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", dir]);
  return fs.realpathSync.native(dir);
}

export interface WorkspaceFile {
  file: string;
  sha256: string;
}

/** Write `<root>/.mindgraph/workspace.json` and return its path and hash. */
export function makeWorkspace(
  root: string,
  repositories: Array<{ root: string; space_uid?: string }>,
  workspaceId = "ws",
): WorkspaceFile {
  const file = path.join(root, ".mindgraph", "workspace.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ v: 1, workspace_id: workspaceId, repositories }, null, 2)}\n`,
  );
  return { file, sha256: sha256File(file) };
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function repoEntry(root: string, repoId = `local/${path.basename(root)}`): ConsentRoot {
  return {
    root,
    kind: "repo",
    repositories: [{ root, repo_id: repoId, space_uid: null }],
    consented_at: "2026-11-16T00:00:00.000Z",
  };
}

export function workspaceEntry(
  root: string,
  workspace: WorkspaceFile,
  repositories: PinnedRepository[],
  options: { root_enabled?: boolean; root_space_uid?: string | null } = {},
): ConsentRoot {
  return {
    root,
    kind: "workspace",
    root_enabled: options.root_enabled ?? true,
    root_space_uid: options.root_space_uid ?? "space:workspace:ws",
    workspace_file: workspace.file,
    workspace_sha256: workspace.sha256,
    workspace_id: "ws",
    repositories,
    consented_at: "2026-11-16T00:00:00.000Z",
  };
}

export function pinned(root: string, space?: string): PinnedRepository {
  return {
    root,
    repo_id: `local/${path.basename(root)}`,
    space_uid: space ?? `space:project:${path.basename(root)}`,
  };
}

/** Write a hooks.json holding `roots` into `home` (a MINDGRAPH_HOME). */
export function writeStore(
  home: string,
  roots: unknown[],
  extra: Record<string, unknown> = {},
): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "hooks.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        agentId: "u-test",
        consent: { v: 1, acknowledged_at: "2026-11-16T00:00:00.000Z", roots },
        ...extra,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(file, 0o600);
  return file;
}

/** A linked worktree of `repo` at `at`, made by git itself. */
export function makeWorktree(repo: string, name: string, at: string): string {
  try {
    git(["-C", repo, "rev-parse", "--verify", "-q", "HEAD"]);
  } catch {
    git(["-C", repo, "commit", "-q", "--allow-empty", "--no-verify", "-m", "init"]);
  }
  fs.mkdirSync(path.dirname(at), { recursive: true });
  git(["-C", repo, "worktree", "add", "-q", "-b", name, at]);
  return fs.realpathSync.native(at);
}

export interface FsCounts {
  reads: number;
  heads: number;
  stats: number;
  realpaths: number;
}

/** A ConsentFs over the real filesystem that counts every call. */
export function countingFs(): { fs: ConsentFs; counts: FsCounts } {
  const counts: FsCounts = { reads: 0, heads: 0, stats: 0, realpaths: 0 };
  return {
    counts,
    fs: {
      realpath: (p) => {
        counts.realpaths += 1;
        return nodeConsentFs.realpath(p);
      },
      stat: (p) => {
        counts.stats += 1;
        return nodeConsentFs.stat(p);
      },
      readFile: (p) => {
        counts.reads += 1;
        return nodeConsentFs.readFile(p);
      },
      readHead: (p, max) => {
        counts.heads += 1;
        return nodeConsentFs.readHead(p, max);
      },
    },
  };
}

/** Every file and directory under `dir` with its size, mode and content hash;
 * {} when `dir` does not exist. Two equal snapshots mean nothing was written. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        out[`${rel}/`] = `dir ${stat.mode}`;
        walk(full);
      } else if (entry.isSymbolicLink()) {
        out[rel] = `link ${fs.readlinkSync(full)}`;
      } else {
        out[rel] = `file ${stat.size} ${stat.mode} ${sha256File(full)}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** Whether a built file a spawn-based suite needs exists. Locally a missing
 * build skips the suite; in CI, which builds before testing, it is an error. */
export function built(file: string): boolean {
  if (fs.existsSync(file)) return true;
  if (process.env.CI) {
    throw new Error(`${file} is missing; run npm run build before the tests.`);
  }
  return false;
}
