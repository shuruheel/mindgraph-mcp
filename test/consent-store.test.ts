import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadConsentStore,
  nodeConsentFs,
  parseConsentStore,
  writeConsent,
} from "../src/consent.js";
import {
  hookEnvPath,
  loadHookEnv,
  mindgraphConfigDir,
  resolvedHookFeatures,
  RETIRED_KEYS,
  saveHookEnv,
  updateHookConfig,
} from "../src/hook-env.js";
import {
  countingFs,
  makeRepo,
  makeWorkspace,
  pinned,
  repoEntry,
  tempDir,
  workspaceEntry,
  writeStore,
} from "./fixtures/consent.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = tempDir("mindgraph-store-");
  cleanup.push(dir);
  return dir;
}

function writeRaw(dir: string, text: string): string {
  const file = path.join(dir, "hooks.json");
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

describe("the test environment", () => {
  it("points MINDGRAPH_HOME away from the real store", () => {
    const configured = process.env.MINDGRAPH_HOME!;
    expect(configured).toBeTruthy();
    expect(configured.startsWith(fs.realpathSync.native(os.tmpdir()))).toBe(true);
    expect(hookEnvPath()).toBe(path.join(configured, "hooks.json"));
  });
});

describe("where hooks.json lives", () => {
  it("uses the account's home directory, not $HOME", () => {
    const repo = makeRepo(path.join(home(), "repo"));
    const where = mindgraphConfigDir({ HOME: repo });
    expect(where.source).toBe("passwd");
    expect(where.refused).toBeUndefined();
    expect(where.dir).toBe(path.join(os.userInfo().homedir, ".mindgraph"));
    expect(pathInside(repo, where.dir)).toBe(false);
  });

  it("uses MINDGRAPH_HOME outside any git work tree", () => {
    const dir = home();
    expect(mindgraphConfigDir({ MINDGRAPH_HOME: dir })).toEqual({
      dir,
      source: "override",
    });
  });

  it("refuses a MINDGRAPH_HOME inside a git work tree, without reading any store", () => {
    const repo = makeRepo(path.join(home(), "repo"));
    const inside = path.join(repo, "not-yet", "created");
    const where = mindgraphConfigDir({ MINDGRAPH_HOME: inside });
    expect(where.refused).toMatch(/inside a git work tree/);
    expect(where.dir).not.toContain(repo);

    const counter = countingFs();
    const loaded = loadConsentStore({ MINDGRAPH_HOME: inside }, { fs: counter.fs });
    expect(loaded.status).toBe("unsafe_location");
    expect(counter.counts).toEqual({ reads: 0, heads: 0, stats: 0, realpaths: 0 });
    expect(() =>
      writeConsent(() => undefined, { env: { MINDGRAPH_HOME: inside } }),
    ).toThrow(/nothing was saved/);
    expect(fs.existsSync(path.join(inside, "hooks.json"))).toBe(false);
  });

  it("refuses a relative MINDGRAPH_HOME", () => {
    expect(mindgraphConfigDir({ MINDGRAPH_HOME: "relative/dir" }).refused).toMatch(
      /absolute/,
    );
    expect(loadConsentStore({ MINDGRAPH_HOME: "relative/dir" }).status).toBe(
      "unsafe_location",
    );
  });
});

function pathInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

describe("loading the consent store fails closed", () => {
  it("reports a missing file", () => {
    const dir = home();
    expect(loadConsentStore({ MINDGRAPH_HOME: dir }).status).toBe("missing");
  });

  it.each([
    ["not JSON", "{ nope"],
    ["a JSON array", "[]"],
    ["consent as a string", JSON.stringify({ consent: "yes" })],
    ["consent as an array", JSON.stringify({ consent: [] })],
  ])("reports %s as unreadable", (_label, text) => {
    const dir = home();
    writeRaw(dir, text);
    const loaded = loadConsentStore({ MINDGRAPH_HOME: dir });
    expect(loaded.status).toBe("unreadable");
    expect(loaded.store).toBeUndefined();
  });

  it.each([
    ["no v", {}],
    ["v 0", { v: 0, roots: [] }],
    ["v 2", { v: 2, roots: [] }],
    ["v as a string", { v: "1", roots: [] }],
  ])("reports %s as unsupported", (_label, consent) => {
    const dir = home();
    writeRaw(dir, JSON.stringify({ consent }));
    expect(loadConsentStore({ MINDGRAPH_HOME: dir }).status).toBe("unsupported_version");
  });

  it.runIf(process.platform !== "win32")("refuses a group- or world-writable file or directory", () => {
    const dir = home();
    const file = writeStore(dir, []);
    fs.chmodSync(file, 0o620);
    expect(loadConsentStore({ MINDGRAPH_HOME: dir }).status).toBe("unsafe_permissions");
    fs.chmodSync(file, 0o600);
    expect(loadConsentStore({ MINDGRAPH_HOME: dir }).status).toBe("ok");
    fs.chmodSync(dir, 0o707);
    expect(loadConsentStore({ MINDGRAPH_HOME: dir }).status).toBe("unsafe_permissions");
    fs.chmodSync(dir, 0o700);
  });

  it.runIf(process.platform !== "win32")("refuses a file owned by another account", () => {
    const dir = home();
    const file = writeStore(dir, []);
    const foreign = {
      ...nodeConsentFs,
      stat: (p: string) => {
        const stat = nodeConsentFs.stat(p);
        return stat && p === file ? { ...stat, uid: (process.getuid?.() ?? 0) + 1 } : stat;
      },
    };
    expect(loadConsentStore({ MINDGRAPH_HOME: dir }, { fs: foreign }).status).toBe(
      "unsafe_permissions",
    );
  });

  it("treats a file with no consent key as the upgrade state: ok, nothing on, not acknowledged", () => {
    const dir = home();
    writeRaw(dir, JSON.stringify({ apiKey: "k", agentId: "u-1" }));
    const loaded = loadConsentStore({ MINDGRAPH_HOME: dir });
    expect(loaded.status).toBe("ok");
    expect(loaded.store).toEqual({ v: 1, roots: [] });
    expect(JSON.stringify(loaded)).not.toContain("\"k\"");
  });
});

describe("root entries are validated one by one", () => {
  it("drops every invalid entry and keeps the valid ones", () => {
    const base = home();
    const repo = makeRepo(path.join(base, "repo"));
    const ws = path.join(base, "ws");
    const a = makeRepo(path.join(ws, "a"));
    const file = makeWorkspace(ws, [{ root: "a" }]);
    const good = repoEntry(repo);
    const goodWorkspace = workspaceEntry(ws, file, [pinned(a)]);
    const bad: Array<[string, unknown]> = [
      ["relative root", { ...repoEntry(repo), root: "repo", repositories: [{ root: "repo", repo_id: "x", space_uid: null }] }],
      ["dot-dot segment", repoEntry(`${base}/x/../repo`)],
      ["filesystem root", repoEntry("/")],
      ["account home", repoEntry(os.userInfo().homedir)],
      ["directory above the account home", repoEntry(path.dirname(os.userInfo().homedir))],
      ["trailing separator", repoEntry(`${repo}/`)],
      ["repo kind with a repository elsewhere", { ...repoEntry(repo), repositories: [pinned(a)] }],
      ["repo kind with two repositories", { ...repoEntry(repo), repositories: [pinned(repo), pinned(a)] }],
      ["repo kind with workspace fields", { ...repoEntry(repo), workspace_sha256: file.sha256 }],
      ["empty repo id", { ...repoEntry(repo), repositories: [{ root: repo, repo_id: "", space_uid: null }] }],
      ["oversized repo id", { ...repoEntry(repo), repositories: [{ root: repo, repo_id: "x".repeat(513), space_uid: null }] }],
      ["bad space", workspaceEntry(ws, file, [{ ...pinned(a), space_uid: "project:a" }])],
      ["repository outside the workspace", workspaceEntry(ws, file, [pinned(repo)])],
      ["repository at the workspace root", workspaceEntry(ws, file, [pinned(ws)])],
      ["repository listed twice", workspaceEntry(ws, file, [pinned(a), pinned(a)])],
      ["workspace file elsewhere", { ...goodWorkspace, workspace_file: path.join(a, ".mindgraph", "workspace.json") }],
      ["short hash", { ...goodWorkspace, workspace_sha256: "abc" }],
      ["root_enabled missing", { ...goodWorkspace, root_enabled: undefined }],
      ["unknown kind", { ...good, kind: "folder" }],
      ["no consented_at", { ...good, consented_at: undefined }],
      ["not an object", "repo"],
    ];
    for (const [label, entry] of bad) {
      const store = parseConsentStore({ v: 1, roots: [entry, good] });
      expect(store?.roots, label).toEqual([good]);
    }
    expect(parseConsentStore({ v: 1, roots: [goodWorkspace, good, { ...good }] })?.roots).toEqual([
      goodWorkspace,
      good,
    ]);
  });

  it("loads the valid entries from disk while dropping a bad one", () => {
    const dir = home();
    const repo = makeRepo(path.join(dir, "repo"));
    writeStore(dir, [repoEntry("relative"), repoEntry(repo)]);
    const loaded = loadConsentStore({ MINDGRAPH_HOME: dir });
    expect(loaded.status).toBe("ok");
    expect(loaded.store?.roots.map((r) => r.root)).toEqual([repo]);
    expect(loaded.store?.acknowledged_at).toBe("2026-11-16T00:00:00.000Z");
  });
});

describe("writing hooks.json", () => {
  it("saveHookEnv keeps consent and unknown keys and drops the retired promptRecall", () => {
    const dir = home();
    const consent = { v: 1, acknowledged_at: "2026-11-16T00:00:00.000Z", roots: [] };
    writeRaw(
      dir,
      JSON.stringify({ apiKey: "k", promptRecall: true, consent, futureKey: { a: 1 } }),
    );
    expect(RETIRED_KEYS).toContain("promptRecall");
    saveHookEnv({ baseUrl: "http://127.0.0.1:1", capture: true }, dir);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8"));
    expect(stored).toEqual({
      apiKey: "k",
      baseUrl: "http://127.0.0.1:1",
      capture: true,
      consent,
      futureKey: { a: 1 },
    });
    expect(loadHookEnv(dir)).toEqual({ apiKey: "k", baseUrl: "http://127.0.0.1:1", capture: true });
    // orgId: null still clears the pin.
    saveHookEnv({ orgId: "org_1" }, dir);
    saveHookEnv({ orgId: null }, dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8")).orgId).toBeUndefined();
  });

  it("writes atomically with mode 0600 and leaves no temporary file", () => {
    const dir = path.join(home(), "nested", "mindgraph");
    const file = updateHookConfig((raw) => {
      raw.apiKey = "k";
    }, { dir });
    expect(file).toBe(path.join(dir, "hooks.json"));
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    const before = fs.statSync(file).ino;
    updateHookConfig((raw) => {
      raw.agentId = "u-1";
    }, { dir });
    // A new file was renamed into place rather than rewritten in place.
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(fs.readdirSync(dir)).toEqual(["hooks.json"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ apiKey: "k", agentId: "u-1" });
  });

  it("leaves the file untouched when the change throws", () => {
    const dir = home();
    const file = writeRaw(dir, JSON.stringify({ apiKey: "k" }));
    const before = fs.readFileSync(file);
    expect(() =>
      updateHookConfig(() => {
        throw new Error("boom");
      }, { dir }),
    ).toThrow("boom");
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["hooks.json"]);
  });

  it("refuses to replace a file that is not valid JSON", () => {
    const dir = home();
    const file = writeRaw(dir, "{ corrupt");
    expect(() => saveHookEnv({ apiKey: "k" }, dir)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ corrupt");
  });

  it("writes through a symlinked hooks.json and keeps the link", () => {
    const dir = home();
    const target = path.join(home(), "dotfiles-hooks.json");
    fs.writeFileSync(target, JSON.stringify({ apiKey: "k" }), { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, "hooks.json"));
    saveHookEnv({ capture: true }, dir);
    expect(fs.lstatSync(path.join(dir, "hooks.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ apiKey: "k", capture: true });
    expect(fs.readdirSync(dir)).toEqual(["hooks.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "writeConsent tightens a group-writable config directory, so the store it wrote loads",
    () => {
      const dir = home();
      const repo = makeRepo(path.join(dir, "repo"));
      fs.chmodSync(dir, 0o775);
      const env = { MINDGRAPH_HOME: dir };
      writeConsent((store) => store.roots.push(repoEntry(repo)), { env });
      expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
      expect(loadConsentStore(env).status).toBe("ok");
    },
  );

  it("writeConsent starts a store, stamps acknowledged_at and keeps the connection settings", () => {
    const dir = home();
    const repo = makeRepo(path.join(dir, "repo"));
    writeRaw(dir, JSON.stringify({ apiKey: "k", agentId: "u-1" }));
    const env = { MINDGRAPH_HOME: dir };
    writeConsent((store) => store.roots.push(repoEntry(repo)), {
      env,
      now: () => new Date("2026-11-16T12:00:00.000Z"),
    });
    const loaded = loadConsentStore(env);
    expect(loaded.status).toBe("ok");
    expect(loaded.store).toEqual({
      v: 1,
      acknowledged_at: "2026-11-16T12:00:00.000Z",
      roots: [repoEntry(repo)],
    });
    expect(loadHookEnv(dir)).toEqual({ apiKey: "k", agentId: "u-1" });
  });

  it("writeConsent refuses a newer store and an invalid entry", () => {
    const dir = home();
    const env = { MINDGRAPH_HOME: dir };
    const file = writeRaw(dir, JSON.stringify({ consent: { v: 2, roots: [] } }));
    expect(() => writeConsent(() => undefined, { env })).toThrow(/does not understand/);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).consent.v).toBe(2);

    writeRaw(dir, JSON.stringify({}));
    expect(() =>
      writeConsent((store) => store.roots.push(repoEntry("relative")), { env }),
    ).toThrow(/not valid/);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({});
  });
});

describe("resolvedHookFeatures", () => {
  it("runs only the features the user opted into", () => {
    expect(resolvedHookFeatures({})).toEqual({
      promptRecall: false,
      capture: false,
      curatorMode: "off",
    });
    expect(resolvedHookFeatures({ promptRecall: true, capture: true, curatorMode: "shadow" })).toEqual({
      promptRecall: true,
      capture: true,
      curatorMode: "shadow",
    });
    const dir = home();
    // The legacy default-on flag is not an opt-in.
    writeRaw(dir, JSON.stringify({ promptRecall: true }));
    expect(resolvedHookFeatures(loadHookEnv(dir)).promptRecall).toBe(false);
    expect(resolvedHookFeatures(loadHookEnv(dir)).curatorMode).toBe("off");
  });
});
