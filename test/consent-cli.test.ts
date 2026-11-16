import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadConsentStore, resolveConsent } from "../src/consent.js";
import {
  consentStatusLines,
  refreshRunnerForConsent,
  runOff,
  runOn,
  type ConsentIo,
} from "../src/consent-cli.js";
import { nodeGit } from "../src/consent-plan.js";
import { installedHookRunnerVersion, installHookRunner } from "../src/hook-installer.js";
import {
  built,
  git,
  makeRepo,
  makeWorkspace,
  makeWorktree,
  ownerWorkspace,
  sha256File,
  snapshotTree,
  tempDir,
} from "./fixtures/consent.js";

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const RECORDER = path.join(__dirname, "fixtures", "fetch-recorder.cjs");
const ready = built(CLI);

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix = "mindgraph-cli-"): string {
  const dir = tempDir(prefix);
  cleanup.push(dir);
  return dir;
}

/** One owner-shaped workspace for the tests that do not change its files
 * (consent lives in each test's own store), to keep the suite light. */
let shared: ReturnType<typeof ownerWorkspace> | undefined;
let sharedBase: string | undefined;
function sharedWorkspace(): ReturnType<typeof ownerWorkspace> {
  if (!shared) {
    sharedBase = tempDir("mindgraph-cli-shared-");
    shared = ownerWorkspace(sharedBase);
  }
  return shared;
}
afterAll(() => {
  if (sharedBase) fs.rmSync(sharedBase, { recursive: true, force: true });
});

/** A person at a terminal: no agent variables, both streams are terminals,
 * a private MINDGRAPH_HOME, and scripted answers. */
function person(
  answers: string[],
  options: { cwd?: string; store?: string; env?: Record<string, string>; tty?: boolean } = {},
) {
  const store = options.store ?? path.join(scratch("mindgraph-cli-store-"), "store");
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    MINDGRAPH_HOME: store,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...options.env,
  };
  const tty = options.tty ?? true;
  const io: ConsentIo = {
    stdin: { isTTY: tty },
    stdout: { isTTY: tty },
    env,
    cwd: options.cwd ?? store,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? "";
    },
    git: nodeGit(env),
    now: () => new Date("2026-11-16T12:00:00.000Z"),
    version: "0.0.0-test",
  };
  return { io, out, err, asked, store, hooksJson: path.join(store, "hooks.json") };
}

function storedRoots(store: string) {
  return JSON.parse(fs.readFileSync(path.join(store, "hooks.json"), "utf8")).consent.roots;
}

function decisionAt(dir: string, store: string) {
  return resolveConsent(dir, loadConsentStore({ MINDGRAPH_HOME: store }), { env: {} });
}

function writeConnection(store: string, extra: Record<string, unknown> = {}): string {
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const file = path.join(store, "hooks.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ apiKey: "mg_file_key", baseUrl: "http://file.mindgraph.invalid", ...extra })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(file, 0o600);
  return file;
}

describe("on: refusals", () => {
  it("refuses an agent's shell with exit 2 and changes nothing", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const p = person(["1"], { cwd: repo, env: { CLAUDECODE: "1" } });
    const file = writeConnection(p.store);
    const before = fs.readFileSync(file);
    expect(await runOn(undefined, p.io)).toBe(2);
    expect(p.err.join("\n")).toContain("Detected: CLAUDECODE=1");
    expect(p.asked).toEqual([]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses without a terminal with exit 2", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const p = person(["1"], { cwd: repo, tty: false });
    expect(await runOn(undefined, p.io)).toBe(2);
    expect(p.err.join("\n")).toContain("Detected: no terminal");
    expect(fs.existsSync(p.hooksJson)).toBe(false);
  });

  it("a folder that is not a repository exits 1", async () => {
    const dir = scratch();
    const p = person([], { cwd: dir });
    expect(await runOn(undefined, p.io)).toBe(1);
    expect(p.err.join("\n")).toContain("No git repository or MindGraph workspace");
  });

  it("a hooks.json that is not valid JSON exits 1 with its message and is left as it was", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const p = person(["1"], { cwd: repo });
    fs.mkdirSync(p.store, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.hooksJson, "{ corrupt", { mode: 0o600 });
    expect(await runOn(undefined, p.io)).toBe(1);
    expect(p.err.join("\n")).toContain("is not valid JSON, so it was left unchanged");
    expect(fs.readFileSync(p.hooksJson, "utf8")).toBe("{ corrupt");
  });
});

describe("on: a repository", () => {
  it("answer 1 records the repository with its remote, keeping the connection settings", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    git(["-C", repo, "remote", "add", "origin", "git@github.com:acme/app.git"]);
    fs.mkdirSync(path.join(repo, "src"));
    const p = person(["1"], { cwd: path.join(repo, "src") });
    writeConnection(p.store);
    expect(await runOn(undefined, p.io)).toBe(0);
    const text = p.out.join("\n");
    expect(text).toContain(`Turn on MindGraph for ${repo}?`);
    expect(text).toContain("To http://file.mindgraph.invalid, the API key's default organization:");
    expect(text).toContain("(github.com/acme/app)");
    expect(text).toContain(`MindGraph is on in ${repo} from the next session.`);
    expect(text).toContain(`Turn off: npx -y mindgraph-mcp@latest off ${repo}`);
    const raw = JSON.parse(fs.readFileSync(p.hooksJson, "utf8"));
    expect(raw.apiKey).toBe("mg_file_key");
    expect(raw.consent.acknowledged_at).toBe("2026-11-16T12:00:00.000Z");
    expect(raw.consent.roots).toEqual([
      {
        root: repo,
        kind: "repo",
        repositories: [{ root: repo, repo_id: "github.com/acme/app", space_uid: null }],
        consented_at: "2026-11-16T12:00:00.000Z",
        consented_with: { command: "on", version: "0.0.0-test" },
      },
    ]);
    expect(decisionAt(path.join(repo, "src"), p.store)).toMatchObject({ state: "on", root: repo });
    expect(fs.statSync(p.hooksJson).mode & 0o777).toBe(0o600);
  });

  it("Enter, or an answer it does not recognise, records nothing", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    for (const answer of ["", "yes", "7"]) {
      const p = person([answer], { cwd: repo });
      const file = writeConnection(p.store);
      const before = fs.readFileSync(file);
      const repoBefore = snapshotTree(repo);
      expect(await runOn(undefined, p.io)).toBe(0);
      expect(p.out.join("\n")).toContain("Not now: nothing was changed.");
      expect(p.asked).toEqual(["Choose 1-3. Enter chooses 2. "]);
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      // Not even a repository-id file: identities resolve only after a yes.
      expect(snapshotTree(repo)).toEqual(repoBefore);
    }
  });

  it("the show choice points at the preview command, sends nothing and asks again", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const p = person(["3", ""], { cwd: repo });
    expect(await runOn(undefined, p.io)).toBe(0);
    expect(p.out.join("\n")).toContain("npx -y mindgraph-mcp@latest hooks preview");
    expect(p.asked.length).toBe(2);
    expect(fs.existsSync(p.hooksJson)).toBe(false);
  });

  it("a remote-less repository gets a durable local id only after the yes", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const p = person(["1"], { cwd: repo });
    expect(await runOn(undefined, p.io)).toBe(0);
    const id = fs.readFileSync(path.join(repo, ".git", "mindgraph", "repository-id"), "utf8").trim();
    expect(storedRoots(p.store)[0].repositories[0].repo_id).toBe(id);
  });

  it("running on again where it is already on says so and changes nothing", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const p = person(["1"], { cwd: repo });
    expect(await runOn(undefined, p.io)).toBe(0);
    const before = fs.readFileSync(p.hooksJson);
    const again = person([], { cwd: repo, store: p.store });
    expect(await runOn(undefined, again.io)).toBe(0);
    expect(again.out.join("\n")).toContain("MindGraph is already on in");
    expect(again.asked).toEqual([]);
    expect(fs.readFileSync(p.hooksJson).equals(before)).toBe(true);
  });
});

describe("on: the card's feature lines follow the stored hook features", () => {
  async function card(extra: Record<string, unknown>): Promise<string> {
    const repo = makeRepo(path.join(scratch(), "app"));
    const p = person([""], { cwd: repo });
    writeConnection(p.store, extra);
    await runOn(undefined, p.io);
    return p.out.join("\n");
  }

  it("nothing optional: prompts are on the never-sent line", async () => {
    const text = await card({});
    expect(text).not.toContain("Prompt recall is on");
    expect(text).not.toContain("Capture is on");
    expect(text).toContain("Never: your prompts, file contents, or command output.");
  });

  it("the retired default-on flag does not count as a choice", async () => {
    const text = await card({ promptRecall: true });
    expect(text).not.toContain("Prompt recall is on");
    expect(text).toContain("Never: your prompts, file contents, or command output.");
  });

  it("prompt recall opted in", async () => {
    const text = await card({ promptRecallOptIn: true });
    expect(text).toContain("Prompt recall is on: on each prompt, up to 8 keywords");
    expect(text).toContain("Never: file contents or command output.");
  });

  it("capture on", async () => {
    const text = await card({ capture: true, orgId: "org_abc" });
    expect(text).toContain("Capture is on: before compaction and at session end");
    expect(text).toContain(
      "Never: file contents or command output (tool calls and tool output are not sent).",
    );
    expect(text).toContain("organization org_abc");
  });

  it("no saved key says the hooks send nothing yet", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const p = person([""], { cwd: repo });
    await runOn(undefined, p.io);
    expect(p.out.join("\n")).toContain(
      "No API key is saved for the hooks yet, so they send nothing until you run npx -y mindgraph-mcp@latest install-hooks.",
    );
  });
});

describe("on: a workspace", () => {
  it("answer 1 turns on the root with its space and every listed repository with its own", async () => {
    const { root, repos } = sharedWorkspace();
    const p = person(["1"], { cwd: root });
    expect(await runOn(undefined, p.io)).toBe(0);
    const text = p.out.join("\n");
    expect(text).toContain("Turn on MindGraph for workspace mindgraph");
    expect(text).toContain("This workspace lists 3 repositories; 3 can be turned on:");
    expect(text).toContain("github.com/shuruheel/mindgraph-rs");
    expect(text).toContain("Stay off (repositories here the workspace does not list): mindgraph-mobile, mindgraph-tools");
    expect(text).toContain("use space:workspace:mindgraph.");
    expect(text).toContain("(workspace mindgraph: the root and 3 repositories) from the next session.");
    const [entry] = storedRoots(p.store);
    expect(entry).toMatchObject({
      root,
      kind: "workspace",
      root_enabled: true,
      root_space_uid: "space:workspace:mindgraph",
      workspace_id: "mindgraph",
    });
    expect(entry.repositories.map((r: { space_uid: string }) => r.space_uid)).toEqual([
      "space:project:rs",
      "space:project:cloud",
      "space:project:mcp",
    ]);
    expect(entry.repositories[0].repo_id).toBe("github.com/shuruheel/mindgraph-rs");
    expect(decisionAt(root, p.store)).toMatchObject({
      state: "on",
      space_uid: "space:workspace:mindgraph",
    });
    expect(decisionAt(repos[1], p.store)).toMatchObject({
      state: "on",
      space_uid: "space:project:cloud",
    });
    expect(decisionAt(path.join(root, "mindgraph-tools"), p.store)).toMatchObject({
      state: "off",
      reason: "undeclared_repository",
    });
  });

  it("choose repositories: 0 is the root, numbers pick repositories", async () => {
    const { root, repos } = sharedWorkspace();
    const p = person(["2", "0 2"], { cwd: root });
    expect(await runOn(undefined, p.io)).toBe(0);
    expect(p.asked[1]).toBe('Numbers separated by spaces, or "all": ');
    const [entry] = storedRoots(p.store);
    expect(entry.root_enabled).toBe(true);
    expect(entry.repositories.map((r: { root: string }) => r.root)).toEqual([repos[1]]);
    expect(decisionAt(repos[0], p.store).state).toBe("off");
    expect(decisionAt(repos[1], p.store).state).toBe("on");
  });

  it("choose repositories without the root leaves the root off", async () => {
    const { root, repos } = sharedWorkspace();
    const p = person(["2", "1"], { cwd: root });
    expect(await runOn(undefined, p.io)).toBe(0);
    expect(p.out.join("\n")).toContain("1 repository; the root itself stays off");
    expect(decisionAt(root, p.store)).toMatchObject({ state: "off", reason: "root_not_enabled" });
    expect(decisionAt(repos[0], p.store).state).toBe("on");
  });

  it("an empty or unrecognised selection is Not now", async () => {
    for (const answer of ["", "1 99", "x"]) {
      const { root } = sharedWorkspace();
      const p = person(["2", answer], { cwd: root });
      expect(await runOn(undefined, p.io)).toBe(0);
      expect(p.out.join("\n")).toContain("Not now");
      expect(fs.existsSync(p.hooksJson)).toBe(false);
    }
  });

  it("aborts when workspace.json changes between the card and the yes", async () => {
    const { root, workspace } = ownerWorkspace(scratch());
    const p = person(["1"], { cwd: root });
    p.io.beforeWrite = () => {
      makeWorkspace(root, [{ root: "mindgraph-rs" }, { root: "mindgraph-tools" }], "mindgraph");
    };
    expect(await runOn(undefined, p.io)).toBe(1);
    expect(p.err.join("\n")).toContain(
      "The workspace file changed while you were reading; nothing was saved. Run on again.",
    );
    expect(fs.existsSync(p.hooksJson)).toBe(false);
    expect(sha256File(workspace.file)).not.toBe(workspace.sha256);
  });

  it("refused entries are shown under Not included", async () => {
    const base = scratch();
    const root = makeRepo(path.join(base, "ws"));
    makeRepo(path.join(root, "a"));
    makeWorkspace(root, [{ root: "a" }, { root: "../shared" }]);
    const p = person([""], { cwd: root });
    await runOn(undefined, p.io);
    expect(p.out.join("\n")).toContain('  ../shared  ".." and absolute roots are not allowed');
  });

  it("control characters in names from the workspace file or from disk never reach the terminal", async () => {
    const base = scratch();
    const root = makeRepo(path.join(base, "ws"));
    makeRepo(path.join(root, "pub"));
    makeRepo(path.join(root, "evil\u001b[8m"));
    makeWorkspace(root, [
      { root: "pub" },
      { root: "\u001b]0;PWNED\u0007\u001b[2J\nMindGraph: all clear, nothing leaves this machine" },
      { root: "\u202epub" },
    ]);
    const p = person(["2", ""], { cwd: root });
    expect(await runOn(undefined, p.io)).toBe(0);
    for (const line of p.out) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    }
    const text = p.out.join("\n");
    expect(text).toContain("\\u{1b}]0;PWNED\\u{7}\\u{1b}[2J\\u{a}MindGraph: all clear");
    expect(text).toContain("evil\\u{1b}[8m");
    expect(text).toContain("\\u{202e}pub");
  });

  it("an entry that reaches a repository through a symlink is refused, so only what the card names turns on", async () => {
    const base = scratch();
    const root = makeRepo(path.join(base, "ws"));
    const pub = makeRepo(path.join(root, "pub"));
    makeRepo(path.join(root, "secret"));
    fs.symlinkSync(path.join(root, "secret"), path.join(root, "docs"));
    makeWorkspace(root, [{ root: "pub" }, { root: "docs" }]);
    const p = person(["1"], { cwd: root });
    expect(await runOn(undefined, p.io)).toBe(0);
    expect(p.out.join("\n")).toContain("  docs  reaches a repository through a symlink");
    expect(storedRoots(p.store)[0].repositories.map((r: { root: string }) => r.root)).toEqual([pub]);
    expect(decisionAt(path.join(root, "secret"), p.store).state).toBe("off");
  });
});

describe("on and off refresh the hook runner before writing consent", () => {
  it("on refreshes after the yes and before the write, never on Not now; off refreshes too", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const seen: string[] = [];
    const refresh = (p: ReturnType<typeof person>) => () => {
      seen.push(fs.existsSync(p.hooksJson) ? "after write" : "before write");
      return "Updated the hook runner to v0.0.0-test.";
    };
    const no = person([""], { cwd: repo });
    no.io.refreshRunner = refresh(no);
    await runOn(undefined, no.io);
    expect(seen).toEqual([]);
    const yes = person(["1"], { cwd: repo });
    yes.io.refreshRunner = refresh(yes);
    expect(await runOn(undefined, yes.io)).toBe(0);
    expect(seen).toEqual(["before write"]);
    expect(yes.out).toContain("Updated the hook runner to v0.0.0-test.");
    const off = person([], { cwd: repo, store: yes.store });
    off.io.refreshRunner = () => {
      seen.push("off");
      return undefined;
    };
    expect(await runOff(undefined, off.io)).toBe(0);
    expect(seen).toEqual(["before write", "off"]);
  });

  it("on refreshes a runner below the gate floor even with MINDGRAPH_HOOK_AUTOUPDATE=off, and a current one is left to the opt-out", () => {
    const home = scratch("mindgraph-cli-runner-");
    const old = path.join(home, "old.cjs");
    const bundle = path.join(home, "new.cjs");
    fs.writeFileSync(old, "// old");
    fs.writeFileSync(bundle, "// new");
    vi.stubEnv("MINDGRAPH_HOOK_AUTOUPDATE", "off");
    try {
      installHookRunner(old, home, "0.27.0");
      expect(refreshRunnerForConsent("0.28.0", bundle, home)).toBe(
        "Updated the hook runner to v0.28.0 so it checks where MindGraph is on.",
      );
      expect(installedHookRunnerVersion(home)).toBe("0.28.0");
      expect(refreshRunnerForConsent("0.29.0", bundle, home)).toBeUndefined();
      expect(installedHookRunnerVersion(home)).toBe("0.28.0");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("off", () => {
  async function turnedOn(dir: string, answers = ["1"], store?: string) {
    const p = person(answers, { cwd: dir, store });
    expect(await runOn(undefined, p.io)).toBe(0);
    return p.store;
  }

  it("removes a repository entry, from any shell", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const store = await turnedOn(repo);
    const p = person([], { cwd: repo, store, env: { CLAUDECODE: "1" }, tty: false });
    expect(await runOff(undefined, p.io)).toBe(0);
    expect(p.out[0]).toBe(`MindGraph is off in ${repo} from the next hook event.`);
    expect(storedRoots(store)).toEqual([]);
    expect(decisionAt(repo, store)).toMatchObject({ state: "off", reason: "not_consented" });
  });

  it("in a pinned repository, unpins only that repository", async () => {
    const { root, repos } = sharedWorkspace();
    const store = await turnedOn(root);
    const p = person([], { cwd: repos[0], store });
    expect(await runOff(undefined, p.io)).toBe(0);
    expect(p.out.join("\n")).toContain("is part of workspace mindgraph; MindGraph is off for this repository only.");
    expect(decisionAt(repos[0], store).state).toBe("off");
    expect(decisionAt(repos[1], store).state).toBe("on");
    expect(decisionAt(root, store).state).toBe("on");
  });

  it("at a workspace root, with a path argument, removes the whole workspace", async () => {
    const { root, repos } = sharedWorkspace();
    const store = await turnedOn(root);
    const p = person([], { cwd: repos[0], store });
    expect(await runOff(root, p.io)).toBe(0);
    expect(storedRoots(store)).toEqual([]);
  });

  it("removes a paused workspace", async () => {
    const { root } = ownerWorkspace(scratch());
    const store = await turnedOn(root);
    makeWorkspace(root, [{ root: "mindgraph-rs" }], "mindgraph");
    expect(decisionAt(root, store).state).toBe("needs_reapproval");
    const p = person([], { cwd: root, store });
    expect(await runOff(undefined, p.io)).toBe(0);
    expect(storedRoots(store)).toEqual([]);
  });

  it("removes the entry of a folder that no longer exists", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const store = await turnedOn(repo);
    fs.rmSync(repo, { recursive: true, force: true });
    const p = person([], { cwd: path.dirname(repo), store });
    expect(await runOff(repo, p.io)).toBe(0);
    expect(storedRoots(store)).toEqual([]);
  });

  it("nothing matched: already off, and the upgrade notice is acknowledged", async () => {
    const dir = makeRepo(path.join(scratch(), "other"));
    const p = person([], { cwd: dir });
    expect(await runOff(undefined, p.io)).toBe(0);
    expect(p.out).toEqual(["MindGraph is already off here."]);
    const raw = JSON.parse(fs.readFileSync(p.hooksJson, "utf8"));
    expect(raw.consent).toEqual({ v: 1, acknowledged_at: "2026-11-16T12:00:00.000Z", roots: [] });
  });

  it("a mistyped path changes nothing, under a workspace or a repository", async () => {
    const { root, repos } = sharedWorkspace();
    const store = await turnedOn(root);
    const repo = makeRepo(path.join(scratch(), "app"));
    await turnedOn(repo, ["1"], store);
    for (const typo of [`${repos[0]}-typo`, path.join(repos[0], "typo"), path.join(repo, "typo")]) {
      const p = person([], { cwd: root, store });
      expect(await runOff(typo, p.io)).toBe(0);
      expect(p.out[0]).toBe("MindGraph is already off here.");
    }
    const roots = storedRoots(store);
    expect(roots).toHaveLength(2);
    expect(roots[0].repositories).toHaveLength(3);
    expect(decisionAt(repos[0], store).state).toBe("on");
    expect(decisionAt(repo, store).state).toBe("on");
  });

  it("a deleted pinned repository is unpinned; the root and the other repositories stay on", async () => {
    const { root, repos } = ownerWorkspace(scratch());
    const store = await turnedOn(root);
    fs.rmSync(repos[1], { recursive: true, force: true });
    const p = person([], { cwd: root, store });
    expect(await runOff(repos[1], p.io)).toBe(0);
    expect(p.out.join("\n")).toContain("MindGraph is off for this repository only.");
    expect(storedRoots(store)[0].repositories.map((r: { root: string }) => r.root)).toEqual([
      repos[0],
      repos[2],
    ]);
    expect(decisionAt(root, store).state).toBe("on");
    expect(decisionAt(repos[0], store).state).toBe("on");
  });

  it("a pinned repository that lost its .git is unpinned, not the whole workspace", async () => {
    const { root, repos } = ownerWorkspace(scratch());
    const store = await turnedOn(root);
    fs.renameSync(path.join(repos[1], ".git"), path.join(repos[1], ".git-away"));
    const p = person([], { cwd: repos[1], store });
    expect(await runOff(undefined, p.io)).toBe(0);
    expect(p.out.join("\n")).toContain("MindGraph is off for this repository only.");
    fs.renameSync(path.join(repos[1], ".git-away"), path.join(repos[1], ".git"));
    expect(storedRoots(store)[0].repositories).toHaveLength(2);
    expect(decisionAt(root, store).state).toBe("on");
    expect(decisionAt(repos[0], store).state).toBe("on");
    expect(decisionAt(repos[1], store).state).toBe("off");
  });

  it("an undeclared repository inside a workspace is already off and names the whole-workspace command", async () => {
    const { root, undeclared } = sharedWorkspace();
    const store = await turnedOn(root);
    const p = person([], { cwd: undeclared[0], store });
    expect(await runOff(undefined, p.io)).toBe(0);
    expect(p.out[0]).toBe("MindGraph is already off here.");
    expect(p.out[1]).toContain(`npx -y mindgraph-mcp@latest off ${root}`);
    expect(storedRoots(store)).toHaveLength(1);
  });
});

describe("status", () => {
  it("starts with this directory's state and lists the places turned on", async () => {
    const { root, repos } = sharedWorkspace();
    const p = person(["1"], { cwd: root });
    await runOn(undefined, p.io);
    const on = consentStatusLines(repos[0], { MINDGRAPH_HOME: p.store });
    expect(on[0]).toBe(
      `MindGraph is on in this directory: workspace mindgraph (${root}), repository mindgraph-rs, space space:project:rs. Turned on 2026-11-16.`,
    );
    expect(on).toContain("Turned on: 1 place");
    expect(on).toContain(`  ${root}  workspace mindgraph: root on, 3 repositories`);
    const off = consentStatusLines(path.join(root, "mindgraph-tools"), { MINDGRAPH_HOME: p.store });
    expect(off[0]).toContain("MindGraph is off in this directory.");
    expect(off[0]).toContain("Turn on: npx -y mindgraph-mcp@latest on");
    expect(off[1]).toBe("Why: this repository is not one the workspace lists.");
  });

  it("a paused workspace says how to review it", async () => {
    const { root } = ownerWorkspace(scratch());
    const p = person(["1"], { cwd: root });
    await runOn(undefined, p.io);
    makeWorkspace(root, [], "mindgraph");
    expect(consentStatusLines(root, { MINDGRAPH_HOME: p.store })[0]).toBe(
      `MindGraph is paused in ${root}: .mindgraph/workspace.json changed since you turned it on. Review: npx -y mindgraph-mcp@latest on ${root}`,
    );
  });
});

// ── Spawned: the built CLI, the way a person or an agent would run it ──

function runCli(
  args: string[],
  env: Record<string, string>,
  options: { cwd: string; stdin?: string; log?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd,
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
    child.stdin.end(options.stdin ?? "1\n");
  });
}

describe.runIf(ready)("spawned on, off and install-hooks", () => {
  it("on from an agent's shell exits 2 and leaves hooks.json byte-identical", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const store = path.join(scratch(), "store");
    const file = writeConnection(store);
    const before = fs.readFileSync(file);
    const result = await runCli(
      ["on"],
      { HOME: scratch(), MINDGRAPH_HOME: store, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
      { cwd: repo },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Detected: CLAUDECODE=1");
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("on without a terminal exits 2 even with no agent variable", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const store = path.join(scratch(), "store");
    const file = writeConnection(store);
    const before = fs.readFileSync(file);
    const result = await runCli(["on"], { HOME: scratch(), MINDGRAPH_HOME: store }, { cwd: repo });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Detected: no terminal");
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("off without a terminal works", async () => {
    const repo = makeRepo(path.join(scratch(), "app"));
    const store = path.join(scratch(), "store");
    writeConnection(store);
    const result = await runCli(["off"], { HOME: scratch(), MINDGRAPH_HOME: store, CLAUDECODE: "1" }, { cwd: repo });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("MindGraph is already off here.");
  });

  it("install-hooks with a corrupt hooks.json exits 1 with its message, installs nothing and shows no stack", async () => {
    const project = makeRepo(path.join(scratch(), "app"));
    const home = scratch();
    const store = path.join(scratch(), "store");
    fs.mkdirSync(store, { mode: 0o700 });
    fs.writeFileSync(path.join(store, "hooks.json"), "{ corrupt", { mode: 0o600 });
    const result = await runCli(
      ["install-hooks", "--harness", "codex", "--scope", "project", "--project-dir", project],
      { HOME: home, MINDGRAPH_HOME: store },
      { cwd: project },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not valid JSON, so it was left unchanged");
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(fs.readFileSync(path.join(store, "hooks.json"), "utf8")).toBe("{ corrupt");
    expect(fs.existsSync(path.join(home, ".mindgraph"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".codex"))).toBe(false);
  });

  it("install-hooks ends with the line about turning MindGraph on", async () => {
    const project = makeRepo(path.join(scratch(), "app"));
    const store = path.join(scratch(), "store");
    const result = await runCli(
      ["install-hooks", "--harness", "codex", "--scope", "user", "--project-dir", project],
      { HOME: scratch(), MINDGRAPH_HOME: store, MINDGRAPH_API_KEY: "mg_test" },
      { cwd: project },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").pop()).toBe(
      "Hooks do nothing in a repository until you turn MindGraph on there: npx -y mindgraph-mcp@latest on",
    );
  });

  it("install-hooks --scope project refuses under MINDGRAPH_HOME, writing nothing", async () => {
    // Project settings are committed: they must not name this machine's
    // runner path, and their portable form would not find the moved runner.
    for (const hookHarness of ["claude-code", "codex"]) {
      const project = makeRepo(path.join(scratch(), "app"));
      const home = scratch();
      const store = path.join(scratch(), "store");
      const result = await runCli(
        ["install-hooks", "--harness", hookHarness, "--scope", "project", "--project-dir", project],
        { HOME: home, MINDGRAPH_HOME: store, MINDGRAPH_API_KEY: "mg_test" },
        { cwd: project },
      );
      expect(result.code, hookHarness).toBe(1);
      expect(result.stderr).toContain("install-hooks --scope user");
      expect(fs.existsSync(path.join(project, ".claude")), hookHarness).toBe(false);
      expect(fs.existsSync(path.join(project, ".codex")), hookHarness).toBe(false);
      expect(fs.existsSync(store), hookHarness).toBe(false);
      expect(snapshotTree(home), hookHarness).toEqual({});
    }
  });
});

describe.runIf(ready)("a store written by on drives the hook gate", () => {
  it("on for a workspace makes the root, a pinned repository and a linked worktree of it on, and a hook there runs", async () => {
    const base = scratch();
    const { root, repos } = ownerWorkspace(base);
    const store = path.join(scratch(), "store");
    writeConnection(store);
    const p = person(["1"], { cwd: root, store });
    expect(await runOn(undefined, p.io)).toBe(0);

    const worktree = makeWorktree(repos[2], "feature", path.join(base, "worktrees", "mcp-feature"));
    expect(decisionAt(root, store)).toMatchObject({ state: "on", reason: "consented" });
    expect(decisionAt(repos[2], store)).toMatchObject({ state: "on", reason: "consented" });
    expect(decisionAt(worktree, store)).toMatchObject({
      state: "on",
      reason: "consented_worktree",
      space_uid: "space:project:mcp",
    });

    const pinnedIds = storedRoots(store)[0].repositories.map((r: { repo_id: string }) => r.repo_id);
    const log = path.join(base, "requests.jsonl");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [CLI, "hook", "--harness", "claude-code"], {
          cwd: worktree,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: scratch(),
            MINDGRAPH_HOME: store,
            MINDGRAPH_RUNTIME_DIR: path.join(base, "runtime"),
            NODE_OPTIONS: `--require=${RECORDER}`,
            MINDGRAPH_TEST_REQUESTS: log,
            MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK: "1",
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(
          JSON.stringify({
            hook_event_name: "SessionStart",
            session_id: "on-e2e",
            cwd: worktree,
            source: "startup",
            model: "claude-test",
          }),
        );
      },
    );
    expect(result.code, result.stderr).toBe(0);
    const sent = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((r) => r.kind === "fetch");
    expect(sent.find((r) => r.body?.action === "open")).toBeDefined();
    // The session's scope is exactly the pinned set: no undeclared sibling.
    const resolved = sent
      .filter((r) => r.body?.action === "resolve_identity")
      .map((r) => r.body.identity.key.repo_id);
    expect(new Set(resolved)).toEqual(new Set(pinnedIds));
    for (const request of sent) {
      expect(String(request.url).startsWith("http://file.mindgraph.invalid/")).toBe(true);
    }
  });
});
