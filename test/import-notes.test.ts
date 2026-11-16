import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsentIo } from "../src/consent-cli.js";
import { nodeGit } from "../src/consent-plan.js";
import {
  anchorCandidates,
  findMemoryDirectory,
  looksLikeSecret,
  manifestPath,
  nodeNoteFs,
  parseFrontmatter,
  projectSlug,
  runImportNotes,
  type ImportClient,
  type NoteFs,
} from "../src/import-notes.js";
import { makeRepo, makeWorkspace, pinned, repoEntry, snapshotTree, tempDir, workspaceEntry, writeStore } from "./fixtures/consent.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix = "mindgraph-import-"): string {
  const dir = tempDir(prefix);
  cleanup.push(dir);
  return dir;
}

const SPACE = "space:project:app";
const SECRET = "sk_l" + "ive_0123456789abcdefghijKLMN";

/** A consented repository, its own MINDGRAPH_HOME and Claude config dir, and
 * a memory folder where Claude Code would keep its notes. */
function setup(options: { consent?: boolean; space?: string | null } = {}) {
  const base = scratch();
  const root = makeRepo(path.join(base, "app"));
  const store = path.join(base, "store");
  const claude = path.join(base, "claude");
  const entry = repoEntry(root);
  entry.repositories[0].space_uid = options.space === undefined ? SPACE : options.space;
  writeStore(store, options.consent === false ? [] : [entry], {
    apiKey: "mg_test_key",
    baseUrl: "http://127.0.0.1:9",
  });
  const memory = path.join(claude, "projects", projectSlug(root), "memory");
  fs.mkdirSync(memory, { recursive: true });
  return { base, root, store, claude, memory };
}

function note(memory: string, name: string, body: string): string {
  const file = path.join(memory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function person(
  ctx: { store: string; claude: string; root: string },
  answers: string[] = ["1"],
  extraEnv: Record<string, string> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    MINDGRAPH_HOME: ctx.store,
    CLAUDE_CONFIG_DIR: ctx.claude,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extraEnv,
  };
  const io: ConsentIo = {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    env,
    cwd: ctx.root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ask: async () => answers.shift() ?? "",
    git: nodeGit(env),
    now: () => new Date("2026-11-16T12:00:00.000Z"),
  };
  return { io, out, err, env };
}

/** The item key without its per-source part, for readable assertions. */
function short(id: unknown): string {
  return String(id).replace(/^claude-auto-memory:[0-9a-f]{12}:/, "claude-auto-memory:");
}

/** A server stand-in: custom_id upsert and forget per space, recording every
 * body. `fail` may throw for a call before it lands. */
function fakeServer() {
  const items = new Map<string, string>();
  const calls: Array<{ route: "remember" | "forget"; body: Record<string, unknown> }> = [];
  const state: { fail?: (route: "remember" | "forget", body: Record<string, unknown>) => void } = {};
  const keyOf = (body: Record<string, unknown>) =>
    `${(body.scope as { space_uid: string }).space_uid}|${body.custom_id as string}`;
  const client: ImportClient = {
    remember: async (body) => {
      calls.push({ route: "remember", body });
      state.fail?.("remember", body);
      const id = keyOf(body);
      const before = items.get(id);
      items.set(id, body.text as string);
      return { action: before === undefined ? "inserted" : before === body.text ? "unchanged" : "updated" };
    },
    forget: async (body) => {
      calls.push({ route: "forget", body });
      state.fail?.("forget", body);
      const id = keyOf(body);
      if (!items.has(id)) throw Object.assign(new Error("not found"), { status: 404, code: "not_found" });
      items.delete(id);
      return { tombstoned: true };
    },
  };
  /** Live item keys, as `claude-auto-memory:<path>` (any space). */
  const keys = () => [...items.keys()].map((k) => short(k.slice(k.indexOf("|") + 1)));
  return { items, calls, state, keys, factory: () => client };
}

function httpError(status: number, code: string): Error {
  return Object.assign(new Error(code), { status, code });
}

describe("import notes", () => {
  it("is idempotent: a second run sends nothing and the item count stays the same", async () => {
    const ctx = setup();
    note(ctx.memory, "MEMORY.md", "- [a](feedback_a.md)\n");
    note(ctx.memory, "feedback_a.md", "---\nname: Prefer small PRs\nmetadata:\n  type: feedback\n---\nKeep PRs small.\n");
    note(ctx.memory, "notes/project/b.md", "Project note b.\n");
    const server = fakeServer();
    expect(await runImportNotes(undefined, person(ctx).io, { client: server.factory })).toBe(0);
    expect(server.items.size).toBe(2);
    const first = server.calls.length;
    const second = person(ctx);
    expect(await runImportNotes(undefined, second.io, { client: server.factory })).toBe(0);
    expect(server.calls.length).toBe(first);
    expect(server.items.size).toBe(2);
    expect(second.out.join("\n")).toContain("2 unchanged since the last import are skipped.");
    const sent = server.calls[0].body;
    expect(sent.scope).toEqual({ space_uid: SPACE });
    expect(sent.custom_id).toMatch(/^claude-auto-memory:[0-9a-f]{12}:feedback_a\.md$/);
    expect(sent.label).toBe("Prefer small PRs");
    expect((sent.props as Record<string, unknown>).source).toBe("claude_auto_memory");
    expect(fs.statSync(manifestPath(person(ctx).env)).mode & 0o777).toBe(0o600);
  });

  it("revises one item when a note is edited and hides one when a note is deleted", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    const gone = note(ctx.memory, "b.md", "Note b.\n");
    note(ctx.memory, "c.md", "Note c.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    server.calls.length = 0;
    note(ctx.memory, "a.md", "Note a, revised.\n");
    fs.rmSync(gone);
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(0);
    expect(server.calls.map((c) => `${c.route} ${short(c.body.custom_id)}`)).toEqual([
      "remember claude-auto-memory:a.md",
      "forget claude-auto-memory:b.md",
    ]);
    expect(server.items.size).toBe(2);
    expect(run.out.join("\n")).toContain("b.md  no longer in the folder");
    expect(run.out.join("\n")).toContain("0 new, 1 updated");
  });

  it("leaves out a note holding a secret, names it only, and sends none of it", async () => {
    const ctx = setup();
    note(ctx.memory, "ok.md", "Fine note.\n");
    note(ctx.memory, "keys.md", `Deploy with api_key = ${SECRET}\nand more detail.\n`);
    const server = fakeServer();
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(0);
    const wire = JSON.stringify(server.calls);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain("Deploy with");
    expect(wire).not.toContain("keys.md");
    const printed = [...run.out, ...run.err].join("\n");
    expect(printed).toContain("keys.md");
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain("Deploy with");
    expect(fs.readFileSync(manifestPath(run.env), "utf8")).not.toContain(SECRET);
  });

  it("hides a note imported before that now holds a secret", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Clean at first.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    server.calls.length = 0;
    note(ctx.memory, "a.md", `Now with token: ${SECRET}\n`);
    const run = person(ctx);
    await runImportNotes(undefined, run.io, { client: server.factory });
    expect(server.calls.map((c) => ({ ...c.body, custom_id: short(c.body.custom_id), route: c.route }))).toEqual([
      {
        route: "forget",
        scope: { space_uid: SPACE },
        custom_id: "claude-auto-memory:a.md",
        reason: "Claude Code note left out of the import",
      },
    ]);
    expect(run.out.join("\n")).toContain("now holds text that looks like a secret");
  });

  it("lists every exclusion with its reason and never sends excluded notes", async () => {
    const ctx = setup();
    note(ctx.memory, "MEMORY.md", "index\n");
    note(ctx.memory, "CATALOG.md", "catalog\n");
    note(ctx.memory, "user_profile.md", "---\nname: Me\nmetadata:\n  type: user\n---\nAbout me.\n");
    note(ctx.memory, "user_flat.md", "---\ntype: user\n---\nAlso me.\n");
    note(ctx.memory, "private.md", "---\nmindgraph: skip\n---\nKeep local.\n");
    note(ctx.memory, "big.md", "x".repeat(9_000));
    note(ctx.memory, "sub/README.md", "A note that happens to be called README.\n");
    note(ctx.memory, "kept.md", "Kept.\n");
    const server = fakeServer();
    const run = person(ctx);
    await runImportNotes(undefined, run.io, { client: server.factory });
    const card = run.out.join("\n");
    expect(card).toMatch(/Indexes, not notes:\n {4}CATALOG\.md\n {4}MEMORY\.md/);
    expect(card).toMatch(/About you \(type user\); add --include-user to send them:\n {4}user_flat\.md\n {4}user_profile\.md/);
    expect(card).toMatch(/Marked "mindgraph: skip" in their frontmatter:\n {4}private\.md/);
    expect(card).toMatch(/Longer than 8 KB[^\n]*:\n {4}big\.md/);
    expect(server.keys().sort()).toEqual([
      "claude-auto-memory:kept.md",
      "claude-auto-memory:sub/README.md",
    ]);

    const withUser = fakeServer();
    const ctx2 = setup();
    note(ctx2.memory, "user_profile.md", "---\nmetadata:\n  type: user\n---\nAbout me.\n");
    await runImportNotes(undefined, person(ctx2).io, { client: withUser.factory, includeUser: true });
    expect(withUser.keys()).toEqual(["claude-auto-memory:user_profile.md"]);
  });

  it("never changes a file in the memory folder", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a with `src/x.ts`.\n");
    note(ctx.memory, "MEMORY.md", "index\n");
    note(ctx.memory, "keys.md", `password=${SECRET}\n`);
    const before = snapshotTree(ctx.memory);
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    fs.rmSync(path.join(ctx.memory, "a.md"));
    const middle = snapshotTree(ctx.memory);
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    expect(snapshotTree(ctx.memory)).toEqual(middle);
    delete before["a.md"];
    expect(middle).toEqual(before);
  });

  it("refuses a memory folder inside a repository and reads nothing in it", async () => {
    const ctx = setup();
    const inRepo = note(ctx.root, "memory/lesson.md", "Written by the repository's authors.\n");
    note(ctx.claude, "settings.json", JSON.stringify({ autoMemoryDirectory: path.dirname(inRepo) }));
    const touched: string[] = [];
    const recording: NoteFs = {
      ...nodeNoteFs,
      readdir: (p) => (touched.push(p), nodeNoteFs.readdir(p)),
      readFile: (p) => (touched.push(p), nodeNoteFs.readFile(p)),
    };
    const server = fakeServer();
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory, nfs: recording })).toBe(1);
    expect(run.err.join("\n")).toContain("never imported");
    expect(touched.filter((p) => p.startsWith(path.join(ctx.root, "memory")))).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("does not read a repository nested inside the memory folder", async () => {
    const ctx = setup();
    makeRepo(path.join(ctx.memory, "cloned"));
    note(ctx.memory, "cloned/memory/x.md", "From someone else's repository.\n");
    note(ctx.memory, "mine.md", "Mine.\n");
    const server = fakeServer();
    const run = person(ctx);
    await runImportNotes(undefined, run.io, { client: server.factory });
    expect(server.keys()).toEqual(["claude-auto-memory:mine.md"]);
    expect(run.out.join("\n")).toMatch(/Repositories inside the memory folder \(never read\):\n {4}cloned\//);
  });

  it("exits 2 from an agent's shell and changes nothing", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    const server = fakeServer();
    const run = person(ctx, ["1"], { CLAUDECODE: "1" });
    const store = snapshotTree(ctx.store);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(2);
    expect(run.err.join("\n")).toContain("CLAUDECODE=1");
    expect(server.calls).toEqual([]);
    expect(snapshotTree(ctx.store)).toEqual(store);
  });

  it("refuses outside a place MindGraph is on", async () => {
    const ctx = setup({ consent: false });
    note(ctx.memory, "a.md", "Note a.\n");
    const server = fakeServer();
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(1);
    expect(run.err.join("\n")).toBe("MindGraph is off here. Turn it on first: npx -y mindgraph-mcp@latest on");
    expect(run.out).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("refuses when the place has no memory space", async () => {
    const ctx = setup({ space: null });
    note(ctx.memory, "a.md", "Note a.\n");
    const server = fakeServer();
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(1);
    expect(run.err.join("\n")).toContain("no memory space of its own");
    expect(server.calls).toEqual([]);
  });

  it("a dry run sends nothing, writes nothing and runs from any shell", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    const server = fakeServer();
    const run = person(ctx, [], { CLAUDECODE: "1" });
    const store = snapshotTree(ctx.store);
    expect(await runImportNotes(undefined, run.io, { client: server.factory, dryRun: true })).toBe(0);
    expect(server.calls).toEqual([]);
    expect(snapshotTree(ctx.store)).toEqual(store);
    const card = run.out.join("\n");
    expect(card).toContain("Import your Claude Code notes into MindGraph?");
    expect(card).toContain(`memory for repository app (${SPACE})`);
    expect(card).toContain("Nothing leaves this machine.");
    expect(card).toContain("Dry run: nothing was sent.");
  });

  it("Enter never sends", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    const server = fakeServer();
    const run = person(ctx, ["", "", "", "", "", ""]);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(0);
    expect(server.calls).toEqual([]);
    expect(run.out.join("\n")).toContain("Not now: nothing was sent.");
    expect(fs.existsSync(manifestPath(run.env))).toBe(false);
  });

  it("says who can read the notes when they leave the machine", async () => {
    const ctx = setup();
    writeStore(ctx.store, [{ ...repoEntry(ctx.root), repositories: [{ root: ctx.root, repo_id: "local/app", space_uid: SPACE }] }], {
      apiKey: "mg_test_key",
      orgId: "acme",
    });
    note(ctx.memory, "a.md", "Note a.\n");
    const run = person(ctx);
    await runImportNotes(undefined, run.io, { dryRun: true });
    const card = run.out.join("\n");
    expect(card).toContain("To    https://api.mindgraph.cloud, organization acme");
    expect(card).toContain("These notes will leave this machine. Anyone holding an API key for that");
    expect(card).not.toContain("mg_test_key");
  });

  it("anchors carry the blob hash of files git tracks inside the root only, never .env", async () => {
    const ctx = setup();
    fs.mkdirSync(path.join(ctx.root, "src"), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(ctx.root, "src", "untracked.ts"), "export const b = 2;\n");
    fs.writeFileSync(path.join(ctx.root, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(ctx.root, ".env"), "API=1\n");
    execFileSync("git", ["-C", ctx.root, "add", "src/a.ts", ".gitignore"]);
    fs.writeFileSync(path.join(ctx.base, "outside.txt"), "outside\n");
    note(
      ctx.memory,
      "a.md",
      "See `src/a.ts:12`, `src/missing.ts`, `src/untracked.ts`, `.env`, `../outside.txt`, `" +
        path.join(ctx.base, "outside.txt") +
        "`, `.git/config` and `npm run test`.\n",
    );
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    const expected = execFileSync("git", ["hash-object", path.join(ctx.root, "src", "a.ts")]).toString().trim();
    expect((server.calls[0].body.props as Record<string, unknown>).anchors).toEqual([
      { path: "src/a.ts", blob: expected },
    ]);
  });

  it("imports a workspace root's notes into the workspace space", async () => {
    const base = scratch();
    const root = makeRepo(path.join(base, "ws"));
    const child = makeRepo(path.join(root, "child"));
    const workspace = makeWorkspace(root, [{ root: "child", space_uid: "space:project:child" }]);
    const store = path.join(base, "store");
    const claude = path.join(base, "claude");
    writeStore(store, [workspaceEntry(root, workspace, [pinned(child, "space:project:child")])], {
      apiKey: "mg_test_key",
      baseUrl: "http://127.0.0.1:9",
    });
    note(path.join(claude, "projects", projectSlug(root), "memory"), "w.md", "Workspace note.\n");
    note(path.join(claude, "projects", projectSlug(child), "memory"), "c.md", "Child note.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person({ store, claude, root }).io, { client: server.factory });
    await runImportNotes(child, person({ store, claude, root }).io, { client: server.factory });
    expect(server.calls.map((c) => [short(c.body.custom_id), c.body.scope])).toEqual([
      ["claude-auto-memory:w.md", { space_uid: "space:workspace:ws" }],
      ["claude-auto-memory:c.md", { space_uid: "space:project:child" }],
    ]);
  });
});

/** Point the consented repository at another space or destination. */
function rewire(ctx: { root: string; store: string }, space: string, hooks: { baseUrl?: string; orgId?: string } = {}) {
  const entry = repoEntry(ctx.root);
  entry.repositories[0].space_uid = space;
  writeStore(ctx.store, [entry], { apiKey: "mg_test_key", baseUrl: "http://127.0.0.1:9", ...hooks });
}

describe("import notes: identity, secrets and partial runs", () => {
  it("two people on one space never overwrite or hide each other's notes", async () => {
    const alice = setup();
    const bobStore = path.join(alice.base, "bob-store");
    const bobClaude = path.join(alice.base, "bob-claude");
    const entry = repoEntry(alice.root);
    entry.repositories[0].space_uid = SPACE;
    writeStore(bobStore, [entry], { apiKey: "mg_test_key", baseUrl: "http://127.0.0.1:9" });
    const bob = { root: alice.root, store: bobStore, claude: bobClaude };
    const bobMemory = path.join(bobClaude, "projects", projectSlug(alice.root), "memory");
    note(alice.memory, "feedback_testing.md", "Alice: use the real DB in tests.\n");
    const bobNote = note(bobMemory, "feedback_testing.md", "Bob: never mock the DB.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(alice).io, { client: server.factory });
    await runImportNotes(undefined, person(bob).io, { client: server.factory });
    expect([...server.items.values()].sort()).toEqual(["Alice: use the real DB in tests.", "Bob: never mock the DB."]);
    fs.rmSync(bobNote);
    await runImportNotes(undefined, person(bob).io, { client: server.factory });
    expect([...server.items.values()]).toEqual(["Alice: use the real DB in tests."]);
    const again = person(alice);
    await runImportNotes(undefined, again.io, { client: server.factory });
    expect([...server.items.values()]).toEqual(["Alice: use the real DB in tests."]);
  });

  it("treats every common secret shape as a secret, and ordinary notes as notes", () => {
    for (const secret of [
      "AWS_SECRET_ACCESS_KEY=wJalrX" + "UtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "MINDGRAPH_TOKEN=f3a9c0d1e2f3a4b5c6d7",
      "GOOGLE_CLIENT_SECRET=GOC" + "SPX-abcdefghijklmnop",
      "DB_PASSWORD=Tr0ub4dor&3xyz",
      "postgres://postgres:Sup3rS3cretPw@db.example.com:5432/app",
      "AIz" + "aSyA1234567890abcdefghijklmnopqrstuv",
      "np" + "m_abcdefghijklmnopqrstuvwxyz0123456789",
      "glp" + "at-abcdefghijklmnopqrst",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----",
      "FLY_API_TOKEN=FlyV1" + " fm2_lJPECAAAAAAA",
      "stripe_sk_l" + "ive_0123456789abcdefghijKLMN.md",
      "mg" + "_0123456789abcdef0123",
      "password: hunter22",
    ]) {
      expect(looksLikeSecret(secret), secret).toBe(true);
    }
    for (const plain of [
      "Use the token bucket for rate limits.",
      "The password reset flow lives in `src/auth.ts`.",
      "AWS_REGION=us-east-1",
      "Set MINDGRAPH_TOKEN in the environment before running.",
      "See https://example.com/docs for details.",
      "Secrets: we keep them in the vault.",
    ]) {
      expect(looksLikeSecret(plain), plain).toBe(false);
    }
  });

  it("leaves out a note whose file name looks like a secret: in no request and not in the manifest", async () => {
    const ctx = setup();
    const named = "stripe_sk_l" + "ive_0123456789abcdefghijKLMN";
    note(ctx.memory, `${named}.md`, "Harmless text.\n");
    note(ctx.memory, `${named}/inside.md`, "Harmless too.\n");
    note(ctx.memory, "ok.md", "Fine.\n");
    const server = fakeServer();
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(0);
    expect(JSON.stringify(server.calls)).not.toContain("sk_live_");
    expect(fs.readFileSync(manifestPath(run.env), "utf8")).not.toContain("sk_live_");
    expect([...run.out, ...run.err].join("\n")).not.toContain("sk_live_");
    expect(server.keys()).toEqual(["claude-auto-memory:ok.md"]);
  });

  it("treats type User or USER as a note about you", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "---\ntype: User\n---\nMe.\n");
    note(ctx.memory, "b.md", "---\nmetadata:\n  type: USER\n---\nAlso me.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    expect(server.calls).toEqual([]);
  });

  it("refuses a notes folder that is a file-system root, the home folder, or above the root, and reads nothing", async () => {
    for (const dir of ["/", os.userInfo().homedir, "ABOVE"]) {
      const ctx = setup();
      note(ctx.claude, "settings.json", JSON.stringify({ autoMemoryDirectory: dir === "ABOVE" ? ctx.base : dir }));
      const touched: string[] = [];
      const guard: NoteFs = {
        ...nodeNoteFs,
        readdir: (p) => (touched.push(p), []),
        readFile: (p) => (p.endsWith("settings.json") ? nodeNoteFs.readFile(p) : (touched.push(p), "")),
      };
      const server = fakeServer();
      const run = person(ctx);
      const code = await runImportNotes(undefined, run.io, { client: server.factory, nfs: guard });
      expect(code, `${dir}: ${[...run.out, ...run.err].join(" / ")}`).toBe(1);
      expect(run.err.join("\n")).toMatch(/is (a file-system root|your home folder|.* itself or a folder above it), so it is never read/);
      expect(touched).toEqual([]);
      expect(server.calls).toEqual([]);
    }
  });

  it("ignores autoMemoryDirectory in the checked-in settings and warns when local settings choose the folder", async () => {
    const ctx = setup();
    const elsewhere = path.join(ctx.base, "private-docs");
    note(elsewhere, "diary.md", "Private diary.\n");
    note(ctx.root, ".claude/settings.json", JSON.stringify({ autoMemoryDirectory: elsewhere }));
    note(ctx.memory, "mine.md", "Mine.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    expect(server.keys()).toEqual(["claude-auto-memory:mine.md"]);
    note(ctx.root, ".claude/settings.local.json", JSON.stringify({ autoMemoryDirectory: elsewhere }));
    const run = person(ctx);
    await runImportNotes(undefined, run.io, { dryRun: true });
    expect(run.out.join("\n")).toContain("A settings file inside");
  });

  it("keeps the old space's items until they are hidden, even when a run stops partway", async () => {
    const ctx = setup();
    rewire(ctx, "space:one");
    note(ctx.memory, "a.md", "Note a.\n");
    note(ctx.memory, "b.md", "Note b.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    rewire(ctx, "space:two");
    server.state.fail = () => {
      throw httpError(503, "unavailable");
    };
    expect(await runImportNotes(undefined, person(ctx).io, { client: server.factory })).toBe(1);
    server.state.fail = undefined;
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(0);
    expect(run.out.join("\n")).toContain("(hidden in space:one)");
    expect(server.items.size).toBe(2);
    expect([...server.items.keys()].every((k) => k.startsWith("space:two|"))).toBe(true);
  });

  it("starts afresh for a new server or organization and sends no forgets there", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    server.calls.length = 0;
    rewire(ctx, SPACE, { baseUrl: "http://127.0.0.1:10", orgId: "other" });
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(0);
    expect(server.calls.map((c) => `${c.route} ${short(c.body.custom_id)}`)).toEqual(["remember claude-auto-memory:a.md"]);
    expect(run.out.join("\n")).toContain("Notes imported before to http://127.0.0.1:9 stay there");
  });

  it("does not hide notes it could not reach when the folder is read only in part", async () => {
    const ctx = setup();
    note(ctx.memory, "sub/n.md", "Nested.\n");
    note(ctx.memory, "z.md", "Last.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    server.calls.length = 0;
    const sub = path.join(fs.realpathSync.native(ctx.memory), "sub");
    const broken: NoteFs = {
      ...nodeNoteFs,
      readdir: (p) => {
        if (p === sub) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        const names = nodeNoteFs.readdir(p);
        return p === fs.realpathSync.native(ctx.memory) ? [...Array.from({ length: 2001 }, (_, i) => `a${i}.txt`), ...names] : names;
      },
    };
    const run = person(ctx);
    expect(await runImportNotes(undefined, run.io, { client: server.factory, nfs: broken })).toBe(0);
    expect(server.calls).toEqual([]);
    expect(run.out.join("\n")).toContain("could not be read");
    expect(server.keys().sort()).toEqual(["claude-auto-memory:sub/n.md", "claude-auto-memory:z.md"]);
  });

  it("keeps a note listed when the forget is refused for the space, and stops on a refusal", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    note(ctx.memory, "b.md", "Note b.\n");
    const server = fakeServer();
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    fs.rmSync(path.join(ctx.memory, "a.md"));
    fs.rmSync(path.join(ctx.memory, "b.md"));
    server.calls.length = 0;
    server.state.fail = () => {
      throw httpError(404, "scope_not_found");
    };
    const refused = person(ctx);
    expect(await runImportNotes(undefined, refused.io, { client: server.factory })).toBe(1);
    expect(server.calls).toHaveLength(1);
    expect(refused.err.join("\n")).toContain("MindGraph refused the import (scope_not_found)");
    server.state.fail = undefined;
    server.calls.length = 0;
    await runImportNotes(undefined, person(ctx).io, { client: server.factory });
    expect(server.calls.map((c) => c.route)).toEqual(["forget", "forget"]);
    expect(server.items.size).toBe(0);

    note(ctx.memory, "c.md", "c\n");
    note(ctx.memory, "d.md", "d\n");
    server.calls.length = 0;
    server.state.fail = () => {
      throw httpError(401, "unauthorized");
    };
    expect(await runImportNotes(undefined, person(ctx).io, { client: server.factory })).toBe(1);
    expect(server.calls).toHaveLength(1);
  });
});

describe("where the notes are", () => {
  it("uses the project folder named after the launch directory", () => {
    expect(projectSlug("/Users/me/Code/mindgraph/.worktrees/cmb")).toBe("-Users-me-Code-mindgraph--worktrees-cmb");
    const loc = findMemoryDirectory("/r/app", { CLAUDE_CONFIG_DIR: "/cfg" }, { ...nodeNoteFs, lstat: () => undefined });
    expect(loc).toEqual({ dir: "/cfg/projects/-r-app/memory", source: "default" });
  });

  it("honours autoMemoryDirectory from untracked local settings, then user settings, never the checked-in file", () => {
    const ctx = setup();
    const env = { CLAUDE_CONFIG_DIR: ctx.claude };
    note(ctx.claude, "settings.json", JSON.stringify({ autoMemoryDirectory: "/from/user" }));
    expect(findMemoryDirectory(ctx.root, env)?.dir).toBe("/from/user");
    note(ctx.root, ".claude/settings.json", JSON.stringify({ autoMemoryDirectory: "/from/project" }));
    expect(findMemoryDirectory(ctx.root, env)).toMatchObject({ dir: "/from/user", source: "user" });
    note(ctx.root, ".claude/settings.local.json", JSON.stringify({ autoMemoryDirectory: "relative/ignored" }));
    expect(findMemoryDirectory(ctx.root, env)?.dir).toBe("/from/user");
    note(ctx.root, ".claude/settings.local.json", JSON.stringify({ autoMemoryDirectory: "/from/local" }));
    expect(findMemoryDirectory(ctx.root, env)).toMatchObject({ dir: "/from/local", source: "local" });
    // A local settings file the repository checks in is the repository's.
    execFileSync("git", ["-C", ctx.root, "add", "-f", ".claude/settings.local.json"]);
    expect(findMemoryDirectory(ctx.root, env)?.dir).toBe("/from/user");
  });

  it("reads frontmatter and backticked paths", () => {
    expect(parseFrontmatter("---\nname: x\nmetadata:\n  type: user\n---\nbody")).toEqual({
      name: "x",
      metadata: "",
      "metadata.type": "user",
    });
    expect(parseFrontmatter("---\ntype: user\nno close")).toEqual({});
    expect(anchorCandidates("`a/b.ts:3` `c.rs` `run the thing` `https://x.y/z` `--flag`")).toEqual(["a/b.ts", "c.rs"]);
  });
});

describe("import notes under MINDGRAPH_EVAL=1", () => {
  function pointAt(store: string, baseUrl: string) {
    const file = path.join(store, "hooks.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, `${JSON.stringify({ ...raw, baseUrl }, null, 2)}\n`, { mode: 0o600 });
  }

  it("refuses a hosted MindGraph before the card, so nothing is asked or sent", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    pointAt(ctx.store, "https://api.mindgraph.cloud");
    for (const dryRun of [false, true]) {
      const server = fakeServer();
      const run = person(ctx, ["1"], { MINDGRAPH_EVAL: "1" });
      expect(await runImportNotes(undefined, run.io, { client: server.factory, dryRun })).toBe(1);
      expect(server.calls).toEqual([]);
      expect(run.out).toEqual([]);
      expect(run.err.join("\n")).toContain("eval_requires_loopback");
      expect(run.err.join("\n")).toContain("api.mindgraph.cloud");
      expect(fs.existsSync(manifestPath(run.env))).toBe(false);
    }
  });

  it("refuses without an accepted MINDGRAPH_HOME, before any store is read", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    // Inside a git work tree the override is refused; a relative one too.
    for (const home of [path.join(ctx.root, "store"), "relative-store"]) {
      const server = fakeServer();
      const run = person(ctx, ["1"], { MINDGRAPH_EVAL: "1", MINDGRAPH_HOME: home });
      expect(await runImportNotes(undefined, run.io, { client: server.factory, dryRun: true })).toBe(1);
      expect(server.calls).toEqual([]);
      expect(run.out).toEqual([]);
      expect(run.err.join("\n")).toContain("eval_requires_home");
      expect(fs.existsSync(path.join(ctx.root, "store"))).toBe(false);
    }
  });

  it("imports into a loopback server as usual", async () => {
    const ctx = setup();
    note(ctx.memory, "a.md", "Note a.\n");
    const server = fakeServer();
    const run = person(ctx, ["1"], { MINDGRAPH_EVAL: "1" });
    expect(await runImportNotes(undefined, run.io, { client: server.factory })).toBe(0);
    expect(server.items.size).toBe(1);
  });
});
