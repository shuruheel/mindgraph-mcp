import fs from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runOn, type ConsentIo } from "../src/consent-cli.js";
import { runDesktop } from "../src/desktop.js";
import { updateMenu } from "../src/omarchy-menu.js";
import { makeRepo, tempDir } from "./fixtures/consent.js";

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
    const body = JSON.parse(String(options.body));
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
