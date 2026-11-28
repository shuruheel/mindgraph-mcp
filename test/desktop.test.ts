import fs from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runOff, runOn, type ConsentIo } from "../src/consent-cli.js";
import { runDesktop } from "../src/desktop.js";
import { agentsForSelection, configureSelectedAgents, selectCodingApps } from "../src/desktop-agent.js";
import { sessionConsent } from "../src/session-consent.js";
import { loadConsentStore, writeConsent } from "../src/consent.js";
import { connection, graphClient, linkProject, setupConnection } from "../src/desktop-setup.js";
import { loadHookEnv, mindgraphRuntimeDir } from "../src/hook-env.js";
import { updateMenu } from "../src/omarchy-menu.js";
import { git, makeWorkspace, makeRepo, tempDir } from "./fixtures/consent.js";

let tmp: string;
let io: ConsentIo;
let answers: string[];
let shown: string[];
let calls: Array<{ route: string; body: any }>;
const space = "space:project:display";
const source = "drivers/display config.conf";

function respond(handler: (route: string, body: any) => object): void {
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    const route = new URL(url).pathname;
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ route, body });
    const result = handler(route, body);
    return Response.json(result, { headers: { "x-mindgraph-contract": "memory.v1" } });
  });
}

beforeEach(async () => {
  tmp = tempDir("mg-desktop-");
  const store = path.join(tmp, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  fs.writeFileSync(path.join(store, "hooks.json"), '{"baseUrl":"http://127.0.0.1:18900"}', { mode: 0o600 });
  answers = ["1"];
  shown = [];
  calls = [];
  io = {
    cwd: makeRepo(path.join(tmp, "display")), env: { MINDGRAPH_HOME: store, MINDGRAPH_EVAL: "1" },
    stdin: { isTTY: true }, stdout: { isTTY: true },
    out: line => shown.push(line), err: line => shown.push(line),
    ask: async () => answers.shift() ?? "",
  };
  expect(await runOn(undefined, io, space)).toBe(0);
  shown.length = 0;
  respond(() => { throw new Error("Unexpected request"); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("previews note, source and destination, and sends nothing on cancellation", async () => {
  answers = ["1", "Pin the driver", source, ""];
  await runDesktop(["remember"], io);
  expect(shown.join("\n")).toContain(space);
  expect(shown.join("\n")).toContain(source);
  expect(calls).toEqual([]);
});

it("keeps the source before a long selection and uses the same scoped key on replay", async () => {
  const note = "Monitor settings ".repeat(100);
  respond(() => ({ contract: "memory.v1", scope: { space_uid: space }, uid: "n1" }));
  for (let i = 0; i < 2; i++) {
    answers = ["1", note, source, "y"];
    await runDesktop(["remember"], io);
  }
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject({ route: "/memory/v1/remember", body: {
    scope: { space_uid: space }, text: `Source: ${source}\n\n${note}`, custom_id: expect.stringMatching(/^desktop:/),
  } });
});

it("refuses a changed project between preview and confirmation", async () => {
  answers = ["1", "note", source, "y"];
  io.ask = async prompt => {
    if (prompt.startsWith("Save this note")) fs.unlinkSync(path.join(io.env.MINDGRAPH_HOME!, "hooks.json"));
    return answers.shift() ?? "";
  };
  await expect(runDesktop(["remember"], io)).rejects.toThrow("Project settings changed");
  expect(calls).toEqual([]);
});

it("reads only the selected Space and displays its cited context", async () => {
  respond(() => ({ contract: "memory.v1", scope: { space_uid: space }, include_org_space: false,
    context_text: "Pin the driver\nSource: " + source }));
  answers = ["1", "driver"];
  await runDesktop(["recall"], io);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ route: "/memory/v1/context", body: { query: "driver", scope: { space_uid: space } } });
  expect(shown.join("\n")).toContain(source);
});

it("never runs an unscoped resume when the repository has no graph identity", async () => {
  respond(() => ({ status: "absent" }));
  answers = ["1"];
  await runDesktop(["resume"], io);
  expect(calls.map(c => c.route)).toEqual(["/reality/entity"]);
  expect(shown.join("\n")).toContain("No durable work");
});

it("withholds a task that lacks the selected repository scope", async () => {
  respond(route => route === "/reality/entity" ? { status: "existing", uid: "repo1" } :
    { task: { uid: "task1", label: "Other project" }, task_scope_uids: ["repo2"] });
  answers = ["1"];
  await expect(runDesktop(["resume"], io)).rejects.toThrow("verified for this repository");
  expect(calls[1]).toMatchObject({ route: "/agent/plan", body: { scope_uids: ["repo1"] } });
  expect(shown.join("\n")).not.toContain("Other project");
});

it("preserves symlinked JSONC byte-for-byte across repeat install and removal", () => {
  const dir = path.join(tmp, "omarchy/extensions");
  fs.mkdirSync(dir, { recursive: true });
  const menu = path.join(dir, "omarchy-menu.jsonc");
  const dotfile = path.join(tmp, "stowed");
  fs.symlinkSync(dotfile, menu);
  const original = '{\n "items": {\n // "spare": {"label":"Personal"},\n "mine": {"action":"true"},\n }\n}\n';
  fs.writeFileSync(dotfile, original);
  updateMenu(true, tmp);
  const installed = fs.readFileSync(menu, "utf8");
  expect(parse(installed, [], { allowTrailingComma: true }).items["mindgraph.resume"].action).toContain("desktop resume");
  updateMenu(true, tmp);
  expect(fs.readFileSync(menu, "utf8")).toBe(installed);
  updateMenu(false, tmp);
  expect(fs.lstatSync(menu).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(menu, "utf8")).toBe(original);
});

it("keeps conflicting menu actions and refuses to modify desktop configuration in eval mode", async () => {
  const dir = path.join(tmp, "omarchy/extensions");
  fs.mkdirSync(dir, { recursive: true });
  const menu = path.join(dir, "omarchy-menu.jsonc");
  const mine = '{"mindgraph.recall":{"action":"my-recall"}}';
  fs.writeFileSync(menu, mine);
  expect(() => updateMenu(true, tmp)).toThrow("already exists");
  expect(fs.readFileSync(menu, "utf8")).toBe(mine);
  await expect(runDesktop(["install-menu"], io)).rejects.toThrow("MINDGRAPH_EVAL");
});

it("shows a verified task and reads its rationale from the selected Space", async () => {
  respond(route => {
    if (route === "/reality/entity") return { status: "existing", uid: "repo1" };
    if (route === "/agent/plan") return {
      task: { uid: "task-display", label: "Resume monitor" }, task_scope_uids: ["repo1"],
      next_steps: [{ label: "Test suspend" }], blockers: [{ label: "Missing dock" }],
    };
    return { contract: "memory.v1", scope: { space_uid: space }, include_org_space: false,
      graph: { nodes: [{ uid: "note" }] }, context_text: "Source: drivers/display.conf" };
  });
  answers = ["1", ""];
  await runDesktop(["resume"], io);
  expect(calls.map(c => c.route)).toEqual(["/reality/entity", "/agent/plan", "/memory/v1/context"]);
  expect(calls[2].body.scope.space_uid).toBe(space);
  for (const detail of ["Resume monitor", "Test suspend", "Missing dock", "drivers/display.conf"]) {
    expect(shown.join("\n")).toContain(detail);
  }
});

it("reuses a personal submenu and leaves its custom children intact", () => {
  const dir = path.join(tmp, "omarchy/extensions");
  fs.mkdirSync(dir, { recursive: true });
  const menu = path.join(dir, "omarchy-menu.jsonc");
  const original = '{"mindgraph":{"label":"My memory"},"mindgraph.notes":{"action":"notes"}}';
  fs.writeFileSync(menu, original);
  updateMenu(true, tmp);
  expect(parse(fs.readFileSync(menu, "utf8"), [], { allowTrailingComma: true }).mindgraph.label).toBe("My memory");
  updateMenu(false, tmp);
  expect(fs.readFileSync(menu, "utf8")).toBe(original);
});

it("links a recognized checkout on first recall and continues the original action", async () => {
  writeConsent(store => { store.roots = []; }, { env: io.env });
  git(["remote", "add", "origin", "git@example.org:team/display.git"], io.cwd);
  const wrong = { uid: "space:other", label: "Another Space" };
  const right = { uid: space, label: "Display project" };
  const prompts: string[] = [];
  io.ask = async prompt => {
    prompts.push(prompt);
    if (prompt.startsWith("Link a local")) return String(shown.findLast(s => /^\d+\. /.test(s) && s.endsWith(io.cwd))?.split(".")[0]);
    if (prompt.startsWith("Look up")) return "y";
    if (prompt.startsWith("Reconnect") || prompt.startsWith("Set up the MindGraph")) return "";
    if (prompt.startsWith("What would")) return "monitor marker";
    return "1";
  };
  respond((route, body) => {
    if (route === "/nodes") return { items: [wrong, right], has_more: false };
    if (route === "/reality/entity" && body.action === "resolve_identity") return { status: "existing", uid: "repo:display" };
    if (route === "/node/repo%3Adisplay/provenance") return { node: { uid: "repo:display", space_uid: space } };
    if (route === "/agent/plan") return { task: { uid: "task:fixture", label: "Monitor check" }, task_scope_uids: ["repo:display"] };
    if (route === "/memory/v1/context") return { contract: "memory.v1", scope: { space_uid: space }, include_org_space: false, context_text: "Source: drivers/display.conf" };
    throw new Error("Unexpected route: " + route);
  });
  await runDesktop(["recall"], io);
  expect(shown.join("\n")).toContain("Existing task: Monitor check");
  expect(shown.join("\n")).toContain("1. Display project (" + space + ") · existing repository Space");
  expect(shown.join("\n")).toContain("Source: drivers/display.conf");
  expect(loadConsentStore(io.env).store?.roots[0].repositories[0].space_uid).toBe(space);
  expect(prompts.filter(p => p.startsWith("Choose a project"))).toHaveLength(0);
});

it("declining enable creates neither the proposed Space nor a local approval", async () => {
  writeConsent(s => { s.roots = []; }, { env: io.env });
  respond(() => ({ items: [], has_more: false }));
  answers = ["1", "2"];
  const saved = connection(io);
  expect(await linkProject(io, saved, graphClient(saved), io.cwd)).toBeUndefined();
  expect(calls.map(c => c.route)).toEqual(["/nodes"]);
  expect(loadConsentStore(io.env).store?.roots).toEqual([]);
});

it("checks the chosen server before saving any credentials", async () => {
  const file = path.join(io.env.MINDGRAPH_HOME!, "hooks.json");
  const before = fs.readFileSync(file);
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("denied", { status: 401 })));
  answers = ["3", "http://localhost:18791", ""];
  const desktop = { ...io, secret: async () => "mg_only_for_this_test" };
  await expect(setupConnection(desktop, connection(io))).rejects.toThrow();
  expect(fs.readFileSync(file)).toEqual(before);
  expect(shown.join("\n")).not.toContain("mg_only_for_this_test");
});

it("keeps setup approvals in a human terminal and evaluation traffic on loopback", async () => {
  const saved = connection(io);
  await expect(linkProject({ ...io, env: { ...io.env, CLAUDECODE: "1" } }, saved, graphClient(saved), io.cwd)).rejects.toThrow("approve desktop setup");
  answers = ["2"];
  await expect(setupConnection(io, saved)).rejects.toThrow("eval_requires_loopback");
  expect(calls).toEqual([]);
});

it("reconnects only matching sibling clones after opt-in and honors off", async () => {
  const remote = "git@example.org:team/display.git";
  git(["remote", "add", "origin", remote], io.cwd);
  const sibling = makeRepo(path.join(tmp, "fresh-clone"));
  git(["remote", "add", "origin", remote], sibling);
  const elsewhere = makeRepo(path.join(tmp, "elsewhere", "other-clone"));
  git(["remote", "add", "origin", remote], elsewhere);
  writeConsent(s => { s.roots[0].repositories[0].repo_id = "example.org/team/display"; }, { env: io.env });
  expect(sessionConsent(sibling, io.env).state).toBe("off");
  writeConsent(s => { s.reconnectSiblings = true; }, { env: io.env });
  expect(sessionConsent(sibling, io.env)).toMatchObject({ reason: "reconnected", repo: { root: sibling, space_uid: space } });
  expect(sessionConsent(elsewhere, io.env).state).toBe("off");
  expect(sessionConsent(sibling, { ...io.env, MINDGRAPH_HOOKS: "off" }).state).toBe("off");
  const nested = makeRepo(path.join(sibling, "nested"));
  git(["remote", "add", "origin", remote], nested);
  expect(sessionConsent(nested, io.env).state).toBe("off");
  expect(await runOff(sibling, io)).toBe(0);
  expect(sessionConsent(sibling, io.env).state).toBe("off");
  expect(sessionConsent(io.cwd, io.env).state).toBe("on");
});

it("allows choosing a Space by name for an approved workspace member with no mapping", async () => {
  const ws = path.join(tmp, "workspace");
  const member = makeRepo(path.join(ws, "driver"));
  makeWorkspace(ws, [{ root: "driver" }]);
  const saved = connection(io);
  respond((route, body) => {
    if (route === "/nodes") return { items: [{ uid: space, label: "Display" }], has_more: false };
    if (route === "/reality/entity") return body.action === "create" ? { status: "created", uid: "repo1" } : { status: "absent" };
    throw new Error(route);
  });
  answers = ["1", "y", "1", "y"];
  expect(await linkProject(io, saved, graphClient(saved), member)).toMatchObject({ root: member, space_uid: space });
  expect(sessionConsent(member, io.env)).toMatchObject({ kind: "workspace", space_uid: space });
});

it("upgrades the previously installed menu block and preserves personal rows", () => {
  const menu = path.join(tmp, "omarchy/extensions/omarchy-menu.jsonc");
  fs.mkdirSync(path.dirname(menu), { recursive: true });
  const original = '{\n  "personal": {"label":"Personal"},\n}\n';
  fs.writeFileSync(menu, original);
  updateMenu(true, tmp);
  const current = fs.readFileSync(menu, "utf8");
  fs.writeFileSync(menu, current.split("\n").filter(l => !l.includes('"mindgraph.setup"')).join("\n"));
  updateMenu(true, tmp);
  expect(fs.readFileSync(menu, "utf8")).toBe(current);
  updateMenu(false, tmp);
  expect(fs.readFileSync(menu, "utf8")).toBe(original);
});

it("disconnects locally, clears runtime caches, and preserves repository exclusions", async () => {
  const storeDir = io.env.MINDGRAPH_HOME!;
  const hookFile = path.join(storeDir, "hooks.json");
  const raw = JSON.parse(fs.readFileSync(hookFile, "utf8"));
  raw.apiKey = "mg_secret_desktop_key";
  raw.orgId = "org_demo";
  raw.agentId = "u-preserved";
  fs.writeFileSync(hookFile, JSON.stringify(raw), { mode: 0o600 });

  const runtimeDir = mindgraphRuntimeDir(io.env);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const widgetCache = path.join(runtimeDir, "widget-cache.json");
  const healthFile = path.join(runtimeDir, "hook-health.json");
  fs.writeFileSync(widgetCache, '{"blockers":[]}', { mode: 0o600 });
  fs.writeFileSync(healthFile, '{"consecutiveFailures":1}', { mode: 0o600 });

  const excluded = makeRepo(path.join(tmp, "private-client"));
  expect(await runOff(excluded, io)).toBe(0);

  answers = ["y"];
  await runDesktop(["disconnect"], { ...io, env: { ...io.env, MINDGRAPH_HOOKS: "off" } });

  const after = loadHookEnv(storeDir);
  expect(after.apiKey).toBeUndefined();
  expect(after.orgId).toBeUndefined();
  expect(after.baseUrl).toBeUndefined();
  expect(after.agentId).toBe("u-preserved");
  expect(fs.existsSync(widgetCache)).toBe(false);
  expect(fs.existsSync(healthFile)).toBe(false);
  expect(loadConsentStore(io.env).store?.roots.length).toBeGreaterThan(0);
  expect(sessionConsent(excluded, io.env).state).toBe("off");
  expect(shown.join("\n")).toContain("Disconnected locally");

  // Running disconnect again reports already disconnected without prompting.
  shown.length = 0;
  answers = [];
  await runDesktop(["disconnect"], io);
  expect(shown.join("\n")).toContain("already disconnected");
});

it("supports selecting Codex, Claude Code, both, or dashboard-only during onboarding", async () => {
  expect(agentsForSelection("codex")).toEqual(["codex"]);
  expect(agentsForSelection("claude")).toEqual(["claude"]);
  expect(agentsForSelection("both")).toEqual(["codex", "claude"]);
  expect(agentsForSelection("dashboard-only")).toEqual([]);

  answers = ["4"];
  expect(await selectCodingApps(io)).toBe("dashboard-only");

  const repo = loadConsentStore(io.env).store!.roots[0].repositories[0];
  answers = ["4"];
  const result = await configureSelectedAgents(io, connection(io), repo);
  expect(result).toEqual({ selection: "dashboard-only", configured: [], failed: [] });
  expect(shown.join("\n")).toContain("Dashboard-only mode selected");
});

it("reports local desktop connection status without requiring a TTY or network call", async () => {
  const nonTty = { ...io, stdin: { isTTY: false }, stdout: { isTTY: false } };
  await runDesktop(["status", "--json"], nonTty);
  expect(JSON.parse(shown.at(-1)!)).toMatchObject({
    connected: true,
    authMode: "loopback",
  });
  expect(calls).toEqual([]);

  // Disconnect and confirm signed_out status.
  answers = ["y"];
  await runDesktop(["disconnect"], io);
  shown.length = 0;
  await runDesktop(["status"], nonTty);
  expect(shown).toEqual(["signed_out"]);
});

it("transitions Omarchy menu entries between signed-out and connected states while preserving personal rows", () => {
  const dir = path.join(tmp, "omarchy/extensions");
  fs.mkdirSync(dir, { recursive: true });
  const menu = path.join(dir, "omarchy-menu.jsonc");
  const original = '{\n  "mindgraph": {"label":"MindGraph"},\n  "mindgraph.custom": {"action":"my-tool"},\n}\n';
  fs.writeFileSync(menu, original);

  updateMenu(true, tmp, { connected: false });
  const signedOutParsed = parse(fs.readFileSync(menu, "utf8"), [], { allowTrailingComma: true });
  expect(signedOutParsed["mindgraph.connect"].label).toBe("Connect");
  expect(signedOutParsed["mindgraph.disconnect"]).toBeUndefined();
  expect(signedOutParsed["mindgraph.custom"].action).toBe("my-tool");

  updateMenu(true, tmp, { connected: true });
  const connectedParsed = parse(fs.readFileSync(menu, "utf8"), [], { allowTrailingComma: true });
  expect(connectedParsed["mindgraph.dashboard"].action).toBe("mindgraph-mcp desktop dashboard");
  expect(connectedParsed["mindgraph.disconnect"].label).toBe("Disconnect");
  expect(connectedParsed["mindgraph.widgets"].label).toBe("Desktop widgets");
  expect(connectedParsed["mindgraph.connect"]).toBeUndefined();
  expect(connectedParsed["mindgraph.custom"].action).toBe("my-tool");

  updateMenu(false, tmp);
  expect(fs.readFileSync(menu, "utf8")).toBe(original);
});

it("manages desktop widgets and blocker notification muting via CLI flags without requiring a TTY", async () => {
  const nonTty = { ...io, stdin: { isTTY: false }, stdout: { isTTY: false } };
  await runDesktop(["widgets", "--enable", "objectives", "--enable", "lanes", "--mute", "--json"], nonTty);
  expect(JSON.parse(shown.at(-1)!)).toEqual({
    v: 1,
    enabledWidgets: ["blockers", "objectives", "lanes"],
    notifyBlockers: false,
  });

  await runDesktop(["widgets", "--disable", "blockers", "--notify", "--json"], nonTty);
  expect(JSON.parse(shown.at(-1)!)).toEqual({
    v: 1,
    enabledWidgets: ["objectives", "lanes"],
    notifyBlockers: true,
  });
});
