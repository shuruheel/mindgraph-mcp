import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addExcludedDirectory,
  addExcludedRemote,
  createCloudRemoteResolver,
  desktopExclusionsPath,
  loadDesktopExclusions,
  loadLocalFoldersStore,
  localFoldersPath,
  normalizeGitOrigin,
  recognizeCheckout,
  removeExcludedDirectory,
  type RemoteLookupInput,
  type RemoteResolver,
} from "../src/checkout-recognition.js";
import { runOff, type ConsentIo } from "../src/consent-cli.js";
import { git, makeRepo, makeWorktree, repoEntry, tempDir, writeStore } from "./fixtures/consent.js";

let tmp: string;
let storeDir: string;
let env: NodeJS.ProcessEnv;

function makeIo(cwd: string, customEnv: NodeJS.ProcessEnv): ConsentIo {
  return {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    env: customEnv,
    cwd,
    out: () => {},
    err: () => {},
    ask: async () => "",
  };
}

beforeEach(() => {
  tmp = tempDir("mg-checkout-rec-");
  storeDir = path.join(tmp, "mindgraph-home");
  fs.mkdirSync(storeDir, { mode: 0o700 });
  env = { MINDGRAPH_HOME: storeDir, MINDGRAPH_EVAL: "1" };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("normalizeGitOrigin", () => {
  it("normalizes HTTPS with embedded credentials, SSH SCP, ssh://, and git:// identically without leaking credentials", () => {
    const variants = [
      "https://user:secret@github.com/Org/Repo.git",
      "https://ghp_supersecret@GITHUB.COM/Org/Repo.git/",
      "http://GitHub.com/Org/Repo",
      "git@github.com:Org/Repo.git",
      "user:secret@GITHUB.COM:Org/Repo.git",
      "git@github.com:/Org/Repo.git/",
      "ssh://git@github.com/Org/Repo.git",
      "ssh://user:secret@github.com:22/Org/Repo.git",
      "git://github.com/Org/Repo.git",
    ];

    for (const raw of variants) {
      const normalized = normalizeGitOrigin(raw);
      expect(normalized).toBe("github.com/Org/Repo");
      expect(normalized).not.toContain("secret");
      expect(normalized).not.toContain("user");
      expect(normalized).not.toContain("ghp_");
    }
  });

  it("preserves non-default ports and nested subgroup paths", () => {
    expect(
      normalizeGitOrigin("ssh://git@gitlab.example.com:2222/team/sub/service.git"),
    ).toBe("gitlab.example.com:2222/team/sub/service");
    expect(
      normalizeGitOrigin("https://user:pass@gitlab.example.com:8443/team/sub/service.git"),
    ).toBe("gitlab.example.com:8443/team/sub/service");
  });

  it("rejects local filesystem paths and invalid URLs", () => {
    const invalid = [
      "",
      "   ",
      "/tmp/local/repo",
      "/tmp/local/repo.git",
      "./relative/repo",
      "../parent/repo",
      "~/code/repo",
      "file:///tmp/local/repo.git",
      "file:/tmp/local/repo.git",
      "C:\\Users\\dev\\repo",
      "C:/Users/dev/repo.git",
      "ftp://example.com/org/repo.git",
      "https://github.com/",
      "https://github.com/.git",
      "git@github.com:.git",
      "https://github.com/org/../secret",
      "not a valid url",
      "invalid:something",
    ];

    for (const raw of invalid) {
      expect(normalizeGitOrigin(raw)).toBeNull();
    }
  });
});

describe("desktop exclusions persistence", () => {
  it("persists excludedDirectories and excludedRemotes with 0600 permissions and supports directory removal", () => {
    expect(loadDesktopExclusions(env)).toEqual({
      v: 1,
      excludedDirectories: [],
      excludedRemotes: [],
    });

    const dirA = path.join(tmp, "private-a");
    const dirB = path.join(tmp, "private-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    addExcludedDirectory(dirA, env);
    addExcludedDirectory(dirA, env); // duplicate is ignored
    addExcludedDirectory(dirB, env);
    addExcludedRemote("https://user:secret@github.com/Private/Client.git", env);
    addExcludedRemote("git@github.com:Private/Client.git", env); // duplicate after normalization

    const file = desktopExclusionsPath(env);
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).not.toContain("secret");

    expect(loadDesktopExclusions(env)).toEqual({
      v: 1,
      excludedDirectories: [dirA, dirB],
      excludedRemotes: ["github.com/Private/Client"],
    });

    removeExcludedDirectory(dirA, env);
    expect(loadDesktopExclusions(env)).toEqual({
      v: 1,
      excludedDirectories: [dirB],
      excludedRemotes: ["github.com/Private/Client"],
    });
  });
});

describe("recognizeCheckout precedence and opt-outs", () => {
  it("pauses immediately when MINDGRAPH_HOOKS=off with zero remote calls", async () => {
    const repo = makeRepo(path.join(tmp, "repo-paused"));
    git(["-C", repo, "remote", "add", "origin", "git@github.com:Org/Repo.git"]);

    const resolveRemote = vi.fn<RemoteResolver>();
    const result = await recognizeCheckout(repo, {
      env: { ...env, MINDGRAPH_HOOKS: "off" },
      resolveRemote,
    });

    expect(result).toEqual({ kind: "excluded", reason: "hooks_paused" });
    expect(resolveRemote).not.toHaveBeenCalled();
  });

  it("honors existing explicit consent from sessionConsent with zero remote calls", async () => {
    const repo = makeRepo(path.join(tmp, "repo-consented"));
    git(["-C", repo, "remote", "add", "origin", "git@github.com:Org/Repo.git"]);
    writeStore(storeDir, [
      {
        ...repoEntry(repo, "github.com/Org/Repo"),
        repositories: [
          { root: repo, repo_id: "github.com/Org/Repo", space_uid: "space:project:existing" },
        ],
      },
    ]);

    const resolveRemote = vi.fn<RemoteResolver>();
    const result = await recognizeCheckout(repo, { env, resolveRemote });

    expect(result.kind).toBe("consented");
    if (result.kind === "consented") {
      expect(result.root).toBe(repo);
      expect(result.repoId).toBe("github.com/Org/Repo");
      expect(result.spaceUid).toBe("space:project:existing");
      expect(result.decision.state).toBe("on");
    }
    expect(resolveRemote).not.toHaveBeenCalled();
  });

  it("blocks repositories excluded via runOff / reconnectExcluded with zero remote calls", async () => {
    const repo = makeRepo(path.join(tmp, "repo-turned-off"));
    const subDir = path.join(repo, "packages", "api");
    fs.mkdirSync(subDir, { recursive: true });
    git(["-C", repo, "remote", "add", "origin", "git@github.com:Org/Secret.git"]);

    // Turn on with reconnectSiblings enabled, then run `off` so `runOff` records `reconnectExcluded`.
    fs.writeFileSync(
      path.join(storeDir, "hooks.json"),
      JSON.stringify(
        {
          agentId: "u-test",
          consent: {
            v: 1,
            acknowledged_at: "2026-11-27T00:00:00.000Z",
            reconnectSiblings: true,
            roots: [
              {
                root: repo,
                kind: "repo",
                repositories: [
                  { root: repo, repo_id: "github.com/Org/Secret", space_uid: "space:project:sec" },
                ],
                consented_at: "2026-11-27T00:00:00.000Z",
              },
            ],
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const exitCode = await runOff(repo, makeIo(repo, env));
    expect(exitCode).toBe(0);

    const resolveRemote = vi.fn<RemoteResolver>();
    const result = await recognizeCheckout(subDir, { env, resolveRemote });

    expect(result).toEqual({ kind: "excluded", reason: "directory_excluded" });
    expect(resolveRemote).not.toHaveBeenCalled();
  });

  it("blocks excludedDirectories by realpath prefix (including symlinks) without matching sibling prefixes", async () => {
    const clientRoot = path.join(tmp, "client");
    const repoInside = makeRepo(path.join(clientRoot, "secret-app"));
    const nestedDir = path.join(repoInside, "src");
    fs.mkdirSync(nestedDir, { recursive: true });
    git(["-C", repoInside, "remote", "add", "origin", "git@github.com:Client/App.git"]);

    const symlinkToNested = path.join(tmp, "link-to-secret");
    fs.symlinkSync(nestedDir, symlinkToNested);

    const siblingRepo = makeRepo(path.join(tmp, "client-public"));
    git(["-C", siblingRepo, "remote", "add", "origin", "git@github.com:Public/App.git"]);

    addExcludedDirectory(clientRoot, env);

    const resolveRemote = vi.fn<RemoteResolver>(async () => ({
      status: "matched",
      orgId: "org_pub",
      spaceUid: "space:project:pub",
      repoUid: "repo_pub",
    }));

    expect(await recognizeCheckout(nestedDir, { env, resolveRemote })).toEqual({
      kind: "excluded",
      reason: "directory_excluded",
    });
    expect(await recognizeCheckout(symlinkToNested, { env, resolveRemote })).toEqual({
      kind: "excluded",
      reason: "directory_excluded",
    });
    expect(resolveRemote).not.toHaveBeenCalled();

    // Sibling folder `client-public` must NOT be matched by prefix `client`.
    const siblingRes = await recognizeCheckout(siblingRepo, { env, resolveRemote });
    expect(siblingRes).toEqual({
      kind: "recognized",
      root: siblingRepo,
      normalizedOrigin: "github.com/Public/App",
      orgId: "org_pub",
      spaceUid: "space:project:pub",
      repoUid: "repo_pub",
    });
    expect(resolveRemote).toHaveBeenCalledTimes(1);
  });

  it("blocks excludedRemotes across HTTPS/SSH variants with zero remote calls", async () => {
    const repo = makeRepo(path.join(tmp, "repo-excluded-remote"));
    git([
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://user:secret@github.com/ClientOrg/PrivateRepo.git",
    ]);

    addExcludedRemote("git@github.com:ClientOrg/PrivateRepo.git", env);

    const resolveRemote = vi.fn<RemoteResolver>();
    const result = await recognizeCheckout(repo, { env, resolveRemote });

    expect(result).toEqual({ kind: "excluded", reason: "remote_excluded" });
    expect(resolveRemote).not.toHaveBeenCalled();
  });
});

describe("recognizeCheckout remote resolution & privacy boundary", () => {
  it("handles matched, ambiguous, and new_identity passing ONLY normalizedOrigin and never raw paths or credentials", async () => {
    const repo = makeRepo(path.join(tmp, "super-sensitive-local-path", "my-checkout"));
    const subDir = path.join(repo, "packages", "web");
    fs.mkdirSync(subDir, { recursive: true });
    git([
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://user:secret@github.com/Acme/Platform.git",
    ]);

    const seenInputs: RemoteLookupInput[] = [];

    const matched = await recognizeCheckout(subDir, {
      env,
      resolveRemote: async (input) => {
        seenInputs.push(input);
        return {
          status: "matched",
          orgId: "org_acme",
          spaceUid: "space:project:platform",
          repoUid: "repo_platform",
        };
      },
    });
    expect(matched).toEqual({
      kind: "recognized",
      root: repo,
      normalizedOrigin: "github.com/Acme/Platform",
      orgId: "org_acme",
      spaceUid: "space:project:platform",
      repoUid: "repo_platform",
    });

    const ambiguous = await recognizeCheckout(subDir, {
      env,
      resolveRemote: async (input) => {
        seenInputs.push(input);
        return { status: "ambiguous", candidateCount: 2 };
      },
    });
    expect(ambiguous).toEqual({
      kind: "ambiguous_personal",
      root: repo,
      normalizedOrigin: "github.com/Acme/Platform",
      candidateCount: 2,
    });

    const provisioned = await recognizeCheckout(subDir, {
      env,
      resolveRemote: async (input) => {
        seenInputs.push(input);
        return { status: "new_identity", spaceUid: "space:personal:platform" };
      },
    });
    expect(provisioned).toEqual({
      kind: "personal_provisioned",
      root: repo,
      normalizedOrigin: "github.com/Acme/Platform",
      spaceUid: "space:personal:platform",
    });

    expect(seenInputs).toHaveLength(3);
    for (const input of seenInputs) {
      expect(Object.keys(input)).toEqual(["normalizedOrigin"]);
      expect(input.normalizedOrigin).toBe("github.com/Acme/Platform");
      const serialized = JSON.stringify(input);
      expect(serialized).not.toContain(tmp);
      expect(serialized).not.toContain("super-sensitive-local-path");
      expect(serialized).not.toContain("my-checkout");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("user");
    }
  });

  it("returns git_unlinked when no resolveRemote is supplied or when the repo has no remote", async () => {
    const repoWithOrigin = makeRepo(path.join(tmp, "repo-unlinked"));
    git(["-C", repoWithOrigin, "remote", "add", "origin", "git@github.com:Acme/Unlinked.git"]);

    const withoutResolver = await recognizeCheckout(repoWithOrigin, { env });
    expect(withoutResolver).toEqual({
      kind: "git_unlinked",
      root: repoWithOrigin,
      normalizedOrigin: "github.com/Acme/Unlinked",
    });

    // Local-only git repo with no remote never calls resolveRemote.
    const localOnlyRepo = makeRepo(path.join(tmp, "repo-local-only"));
    const resolveRemote = vi.fn<RemoteResolver>();
    const noOriginResult = await recognizeCheckout(localOnlyRepo, { env, resolveRemote });
    expect(noOriginResult).toEqual({
      kind: "git_unlinked",
      root: localOnlyRepo,
      normalizedOrigin: null,
    });
    expect(resolveRemote).not.toHaveBeenCalled();
  });

  it("resolves origin from a linked git worktree safely", async () => {
    const mainRepo = makeRepo(path.join(tmp, "main-repo"));
    git(["-C", mainRepo, "remote", "add", "origin", "git@github.com:Acme/Core.git"]);
    const wt = makeWorktree(mainRepo, "feature-wt", path.join(tmp, "wt-core"));

    const resolveRemote = vi.fn<RemoteResolver>(async () => ({
      status: "matched",
      orgId: "org_acme",
      spaceUid: "space:project:core",
      repoUid: "repo_core",
    }));

    const result = await recognizeCheckout(wt, { env, resolveRemote });
    expect(result).toEqual({
      kind: "recognized",
      root: wt,
      normalizedOrigin: "github.com/Acme/Core",
      orgId: "org_acme",
      spaceUid: "space:project:core",
      repoUid: "repo_core",
    });
    expect(resolveRemote).toHaveBeenCalledWith({ normalizedOrigin: "github.com/Acme/Core" });
  });
});

describe("non-git local folder continuity", () => {
  it("assigns stable salted local-folder IDs stored at mode 0600 without calling resolveRemote", async () => {
    const folderA = path.join(tmp, "notes-workspace");
    const folderB = path.join(tmp, "scratch-pad");
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const resolveRemote = vi.fn<RemoteResolver>();
    const firstA = await recognizeCheckout(folderA, { env, resolveRemote });
    const secondA = await recognizeCheckout(folderA, { env, resolveRemote });
    const firstB = await recognizeCheckout(folderB, { env, resolveRemote });

    expect(resolveRemote).not.toHaveBeenCalled();

    expect(firstA.kind).toBe("local_folder");
    expect(secondA.kind).toBe("local_folder");
    expect(firstB.kind).toBe("local_folder");
    if (
      firstA.kind === "local_folder" &&
      secondA.kind === "local_folder" &&
      firstB.kind === "local_folder"
    ) {
      expect(firstA.root).toBe(folderA);
      expect(firstA.localFolderId).toMatch(/^local-folder:[0-9a-f]{16}$/);
      expect(secondA.localFolderId).toBe(firstA.localFolderId);
      expect(firstB.localFolderId).toMatch(/^local-folder:[0-9a-f]{16}$/);
      expect(firstB.localFolderId).not.toBe(firstA.localFolderId);
    }

    const storeFile = localFoldersPath(env);
    const stat = fs.statSync(storeFile);
    expect(stat.mode & 0o777).toBe(0o600);

    const stored = loadLocalFoldersStore(env);
    expect(stored?.v).toBe(1);
    expect(stored?.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.folders[folderA]?.id).toBe(
      firstA.kind === "local_folder" ? firstA.localFolderId : "",
    );

    // A separate machine/runtime directory generates a different per-machine salt and ID.
    const otherRuntime = path.join(tmp, "other-machine-runtime");
    const otherMachineA = await recognizeCheckout(folderA, {
      env,
      runtimeDir: otherRuntime,
      resolveRemote,
    });
    expect(otherMachineA.kind).toBe("local_folder");
    if (firstA.kind === "local_folder" && otherMachineA.kind === "local_folder") {
      expect(otherMachineA.localFolderId).toMatch(/^local-folder:[0-9a-f]{16}$/);
      expect(otherMachineA.localFolderId).not.toBe(firstA.localFolderId);
    }
    expect(resolveRemote).not.toHaveBeenCalled();
  });

  it("createCloudRemoteResolver calls POST /v1/checkouts/resolve with ONLY normalizedOrigin", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["normalizedOrigin"]);
      expect(body.normalizedOrigin).toBe("github.com/Acme/Platform");
      return new Response(
        JSON.stringify({
          status: "matched",
          orgId: "org-acme",
          spaceUid: "space:repo:repo-1",
          repoUid: "repo-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const resolver = createCloudRemoteResolver({
      baseUrl: "https://api.mindgraph.cloud",
      getAccessToken: () => "tok-desktop",
      orgId: "org-acme",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const out = await resolver({ normalizedOrigin: "github.com/Acme/Platform" });
    expect(out).toEqual({
      status: "matched",
      orgId: "org-acme",
      spaceUid: "space:repo:repo-1",
      repoUid: "repo-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mindgraph.cloud/v1/checkouts/resolve");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-desktop");
  });
});
