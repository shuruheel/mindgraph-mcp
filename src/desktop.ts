import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { MindGraph } from "mindgraph";
import { openBrowser } from "./browser-connect.js";
import { configureAgent, configureSelectedAgents } from "./desktop-agent.js";
import { CLOUD_API, checkConnection, connection, graphClient, humanSetup, linkProject, pick, projectIdentity, reconnectPreference, record, setupConnection, type DesktopIo } from "./desktop-setup.js";
import { desktopConnectionStatus, revokeDeviceAuth } from "./device-auth.js";
import { mindgraphConfigDir, mindgraphRuntimeDir, updateHookConfig } from "./hook-env.js";
import { clearShellRuntimeState, loadWidgetPreferences, saveWidgetPreferences, WIDGET_KINDS, type WidgetKind } from "./shell-widgets.js";
import { createShellDaemon, queryShellDaemon, shellSocketPath } from "./shell-daemon.js";
import { sessionConsent } from "./session-consent.js";
import { loadConsentStore, pathContains, resolveConsent, type PinnedRepository } from "./consent.js";
import { displayPath } from "./consent-cli.js";
import { printable } from "./consent-plan.js";
import { evalAppConfigRefusal, evalHomeRefusal, isLoopbackUrl } from "./eval-guard.js";
import { Writable } from "node:stream";
import { updateMenu } from "./omarchy-menu.js";
import { renderContext, renderResumeContext } from "./render.js";

// Give each prompt its own terminal reader. Closing it before a network request
// or an agent handoff releases stdin and restores the terminal's input mode.
export function desktopTerminal(): DesktopIo {
  return {
    stdin: process.stdin, stdout: process.stdout, env: process.env,
    out: line => console.log(line),
    secret: question => new Promise(resolve => {
      process.stdout.write(question);
      const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
      const reader = createInterface({ input: process.stdin, output: sink, terminal: true });
      reader.once("close", () => { process.stdout.write("\n"); resolve(""); });
      reader.question("", answer => { resolve(answer); reader.close(); });
    }),
    ask: question => new Promise(resolve => {
      const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      reader.once("close", () => resolve(""));
      reader.question(question, answer => {
        resolve(answer);
        reader.close();
      });
    }),
  };
}

const NOTE_BYTES = 8192;

// Keep line breaks, but render terminal controls from selections, paths and the API visibly.
function display(text: string): string {
  return text.split("\n").map(printable).join("\n");
}

function checkProject(repo: PinnedRepository, io: DesktopIo): void {
  const decision = sessionConsent(repo.root, io.env);
  if (decision.state !== "on" || decision.repo?.root !== repo.root ||
      decision.repo.repo_id !== repo.repo_id || decision.space_uid !== repo.space_uid) {
    throw new Error("Project settings changed. Reopen the project picker.");
  }
  io.checkConnection?.();
}

function listProjects(io: DesktopIo): PinnedRepository[] {
  const store = loadConsentStore(io.env);
  if (store.status !== "ok" && store.status !== "missing") throw new Error(`Cannot read MindGraph project settings (${store.status}).`);
  const projects = new Map<string, PinnedRepository>();
  for (const entry of store.store?.roots ?? []) {
    for (const pinned of entry.repositories) {
      const decision = resolveConsent(pinned.root, store, { env: io.env });
      if (decision.state === "on" && decision.repo?.root === pinned.root) projects.set(pinned.root, decision.repo);
    }
  }
  return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
}

function memorySpace(repo: PinnedRepository): string {
  if (repo.space_uid) return repo.space_uid;
  throw new Error("This repository needs a memory Space. For a standalone repository, run mindgraph-mcp on --space space:project:NAME there. For a workspace, set the repository's space_uid in .mindgraph/workspace.json and run on at the workspace root.");
}

async function remember(io: DesktopIo, client: MindGraph, repo: PinnedRepository): Promise<void> {
  const memory = client.memory({ space_uid: memorySpace(repo) });
  const input = await io.ask("Type a note, :selection for selected text, or :clipboard for copied text (Enter to close): ");
  if (!input.trim()) return;
  let note = input;
  if (input === ":selection" || input === ":clipboard") {
    const args = ["--no-newline", "--type", "text"];
    if (input === ":selection") args.push("--primary");
    try {
      note = execFileSync("wl-paste", args, { encoding: "utf8", timeout: 3000, maxBuffer: NOTE_BYTES + 4, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new Error("Could not read a text selection of up to 8 KiB with wl-paste. Copy the text and use :clipboard, or type a note.");
    }
  }
  if (!note.trim()) throw new Error("The selected text is empty.");
  const source = (await io.ask("Source URL or file path (optional): ")).trim();
  const text = source ? `Source: ${source}\n\n${note}` : note;
  if (Buffer.byteLength(text) > NOTE_BYTES) throw new Error("The note and source exceed 8 KiB. Select a shorter excerpt.");
  io.out(display(text));
  if ((await io.ask("Save this note to the destination above? [y/N] ")).trim().toLowerCase() !== "y") return;
  checkProject(repo, io);
  const key = createHash("sha256").update(JSON.stringify([note, source])).digest("hex");
  const result = await memory.remember(text, {
    custom_id: `desktop:${key}`,
    label: Array.from(note.trim().split("\n", 1)[0]).slice(0, 80).join(""),
  });
  io.out(`Saved ${printable(result.uid)}.`);
}

function localFile(repo: PinnedRepository, relative: unknown): string | undefined {
  if (typeof relative !== "string" || path.isAbsolute(relative)) return;
  try {
    const file = fs.realpathSync(path.resolve(repo.root, relative));
    if (pathContains(repo.root, file) && fs.statSync(file).isFile()) return file;
  } catch { /* A moved or deleted target has no local file to open. */ }
}

async function openTarget(io: DesktopIo, client: MindGraph, repo: PinnedRepository, targets: unknown[]): Promise<void> {
  const uids = targets.slice(0, 20).map(item => record(item).uid).filter((uid): uid is string => typeof uid === "string");
  const files = new Set<string>();
  for (const node of uids.length ? await client.getNodesBatch(uids) : []) {
    const props = node.props;
    const data = record(props?.data ?? props);
    const ref = record(record(data.attributes).code_ref);
    if (ref.repoId !== repo.repo_id) continue;
    const file = localFile(repo, ref.path);
    if (file) files.add(path.relative(repo.root, file));
  }
  if (!files.size) { io.out("No referenced file is available in this checkout."); return; }
  const selected = await pick(io, [...files], f => f, "Open file");
  if (!selected) return;
  checkProject(repo, io);
  const file = localFile(repo, selected);
  if (!file) throw new Error("That file is no longer available.");
  execFileSync("omarchy-launch-editor", [file], { cwd: repo.root, stdio: "inherit" });
}

async function resume(io: DesktopIo, client: MindGraph, repo: PinnedRepository, agentId: string): Promise<void> {
  const uidOfRepo = await projectIdentity(client, repo.root, repo.repo_id, agentId);
  if (!uidOfRepo) { io.out("No durable work has been linked to this repository yet."); return; }
  const brief = record(await client.plan({ action: "resume_work", scope_uids: [uidOfRepo], limit: 1, agent_id: agentId }));
  if (brief.status === "no_eligible_work") { io.out("No eligible work in this repository."); return; }
  const { uid, label } = record(brief.task);
  if (typeof uid !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(uid) ||
      !Array.isArray(brief.task_scope_uids) || !brief.task_scope_uids.includes(uidOfRepo)) {
    throw new Error("The server did not return a task verified for this repository.");
  }
  io.out(display(renderResumeContext(brief, 6000) ?? "No work brief available."));
  if (repo.space_uid && typeof label === "string" && label.trim()) {
    try {
      const related = await client.memory({ space_uid: repo.space_uid }).context({
        query: label, format: "text", max_tokens: 500, node_limit: 3,
      });
      if (related.graph?.nodes.length || related.articles?.length || related.chunks?.length) {
        io.out("Related project memory");
        io.out(display(renderContext(related, 2200) ?? ""));
      }
    } catch (error) {
      io.out(`Related project memory unavailable (${printable(error instanceof Error ? error.message : String(error))}).`);
    }
  }
  const targets = Array.isArray(brief.code_targets) ? brief.code_targets : [];
  const actions = ["Continue in default agent"];
  if (targets.length) actions.push("Open a referenced file");
  if (repo.space_uid) actions.push("Recall the project rationale");
  const action = await pick(io, actions, a => a, "Next action");
  if (!action) return;
  checkProject(repo, io);
  if (action === "Open a referenced file") return openTarget(io, client, repo, targets);
  if (action === "Recall the project rationale") return recall(io, client, repo);
  const prompt = `Use mindgraph_plan resume_work with scope_uids [${JSON.stringify(uidOfRepo)}] in this checkout. Verify the returned task UID is ${uid} before summarizing it. Summarize its next step, rationale, and blockers for me.`;
  execFileSync("omarchy", ["agent", "prompt", "--inline", prompt], { cwd: repo.root, stdio: "inherit" });
}

async function recall(io: DesktopIo, client: MindGraph, repo: PinnedRepository): Promise<void> {
  const memory = client.memory({ space_uid: memorySpace(repo) });
  const query = (await io.ask("What would you like to recall? (Enter to close): ")).trim();
  if (!query) return;
  checkProject(repo, io);
  const result = await memory.context({ query, format: "text", max_tokens: 1200, node_limit: 8 });
  io.out(display(renderContext(result, 6000) ?? "No matching records in this Space."));
}

async function disconnectDesktop(io: DesktopIo): Promise<void> {
  humanSetup(io);
  const status = desktopConnectionStatus(io.env, CLOUD_API);
  const saved = connection(io);
  const hasSaved = status.connected || Boolean(saved.apiKey || saved.orgId || saved.baseUrl !== CLOUD_API);
  if (!hasSaved) {
    io.out("MindGraph is already disconnected on this desktop.");
    return;
  }
  if ((await io.ask("Disconnect MindGraph on this desktop? Local repository exclusions will be preserved. [y/N] ")).trim().toLowerCase() !== "y") {
    return;
  }
  checkConnection(io, saved);
  const revoked = await revokeDeviceAuth(io.env);
  const configDir = mindgraphConfigDir(io.env).dir;
  updateHookConfig(raw => {
    delete raw.apiKey;
    delete raw.orgId;
    delete raw.baseUrl;
  }, { dir: configDir, env: io.env });
  clearShellRuntimeState(io.env);
  fs.rmSync(path.join(mindgraphRuntimeDir(io.env), "hook-health.json"), { force: true });
  // Notify any running Omarchy shell daemon over its local Unix socket to wipe live widgets.
  try {
    await queryShellDaemon(shellSocketPath(io.env), { id: "disconnect", method: "disconnect" }, 1500);
  } catch {
    // Daemon not running — local disk caches are already cleared above.
  }
  if (revoked.remoteRevoked) {
    io.out("Disconnected locally and revoked device access remotely. Subsequent desktop-managed requests are stopped.");
  } else {
    io.out("Disconnected locally. Subsequent desktop-managed requests are stopped. If a device grant is still active remotely, revoke it in Connected apps.");
  }
}

async function runWidgets(rest: string[], io: DesktopIo): Promise<void> {
  const refusal = evalHomeRefusal(io.env);
  if (refusal) throw new Error(refusal);
  let prefs = loadWidgetPreferences(io.env);
  const validKinds = new Set<string>(WIDGET_KINDS);
  if (rest.length > 0) {
    let asJson = false;
    let mutated = false;
    const enabled = new Set<WidgetKind>(prefs.enabledWidgets);
    let notify = prefs.notifyBlockers;
    for (let i = 0; i < rest.length; i += 1) {
      const flag = rest[i];
      if (flag === "--json") {
        asJson = true;
      } else if (flag === "--notify") {
        notify = true;
        mutated = true;
      } else if (flag === "--mute") {
        notify = false;
        mutated = true;
      } else if (flag === "--enable" || flag === "--disable") {
        const kind = rest[++i];
        if (!kind || !validKinds.has(kind)) {
          throw new Error(`Unknown widget "${kind ?? ""}". Choose from: ${WIDGET_KINDS.join(", ")}.`);
        }
        if (flag === "--enable") enabled.add(kind as WidgetKind);
        else enabled.delete(kind as WidgetKind);
        mutated = true;
      } else {
        throw new Error("Usage: mindgraph-mcp desktop widgets [--json] [--enable <kind>] [--disable <kind>] [--notify|--mute]");
      }
    }
    if (mutated) {
      prefs = saveWidgetPreferences({ enabledWidgets: [...enabled], notifyBlockers: notify }, io.env);
    }
    if (asJson) {
      io.out(JSON.stringify(prefs));
    } else {
      io.out(`Widgets: ${prefs.enabledWidgets.length ? prefs.enabledWidgets.join(", ") : "none"} · Blocker alerts: ${prefs.notifyBlockers ? "on" : "muted"}`);
    }
    return;
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    io.out(JSON.stringify(prefs));
    return;
  }
  humanSetup(io);
  const options = [
    ...WIDGET_KINDS.map(kind => `${prefs.enabledWidgets.includes(kind) ? "[x]" : "[ ]"} ${kind}`),
    `${prefs.notifyBlockers ? "[x]" : "[ ]"} Blocker desktop notifications`,
  ];
  const chosen = await pick(io, options, s => s, "Toggle a desktop widget or interruption setting");
  if (!chosen) return;
  const idx = options.indexOf(chosen);
  if (idx === WIDGET_KINDS.length) {
    prefs = saveWidgetPreferences({ enabledWidgets: prefs.enabledWidgets, notifyBlockers: !prefs.notifyBlockers }, io.env);
  } else {
    const kind = WIDGET_KINDS[idx];
    const next = prefs.enabledWidgets.includes(kind)
      ? prefs.enabledWidgets.filter(k => k !== kind)
      : [...prefs.enabledWidgets, kind];
    prefs = saveWidgetPreferences({ enabledWidgets: next, notifyBlockers: prefs.notifyBlockers }, io.env);
  }
  io.out(`Saved widgets: ${prefs.enabledWidgets.length ? prefs.enabledWidgets.join(", ") : "none"} · Blocker alerts: ${prefs.notifyBlockers ? "on" : "muted"}`);
}

export async function runDesktop(args: string[], io: DesktopIo): Promise<void> {
  const [action, ...rest] = args;
  const validActions = ["install-menu", "uninstall-menu", "setup", "remember", "recall", "resume", "disconnect", "status", "dashboard", "widgets", "shell-daemon"];
  const validStatusArgs = action === "status" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"));
  const allowsRest = action === "status" || action === "widgets";
  if (!validActions.includes(action) || (!allowsRest && rest.length !== 0) || (action === "status" && !validStatusArgs)) {
    throw new Error("Usage: mindgraph-mcp desktop install-menu|uninstall-menu|setup|remember|recall|resume|disconnect|status [--json]|dashboard|widgets|shell-daemon");
  }
  if (action === "widgets") return runWidgets(rest, io);
  if (action === "shell-daemon") {
    const refusal = evalHomeRefusal(io.env);
    if (refusal) throw new Error(refusal);
    const daemon = createShellDaemon({ env: io.env });
    await daemon.start();
    io.out(`MindGraph shell daemon listening on ${daemon.socketPath}`);
    await new Promise<void>(resolve => {
      const stop = () => { void daemon.stop().finally(resolve); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  if (action === "status") {
    const refusal = evalHomeRefusal(io.env);
    if (refusal) throw new Error(refusal);
    const status = desktopConnectionStatus(io.env, CLOUD_API);
    if (rest[0] === "--json") {
      io.out(JSON.stringify(status));
    } else {
      io.out(status.connected ? `connected (${status.authMode})` : "signed_out");
    }
    return;
  }
  if (action === "dashboard") {
    const refusal = evalHomeRefusal(io.env);
    if (refusal) throw new Error(refusal);
    const status = desktopConnectionStatus(io.env, CLOUD_API);
    if (!status.connected) {
      io.out("MindGraph is signed out. Connect MindGraph from the Omarchy menu first.");
      return;
    }
    const url = `${(status.dashboardUrl || "https://mindgraph.cloud").replace(/\/+$/, "")}/dashboard`;
    openBrowser(url);
    io.out(printable(url));
    return;
  }
  if (action.endsWith("-menu")) {
    const refusal = evalAppConfigRefusal("Omarchy", io.env);
    if (refusal) throw new Error(refusal);
    io.out(updateMenu(action === "install-menu"));
    return;
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY) throw new Error("Open a terminal for the desktop project picker.");
  const refusal = evalHomeRefusal(io.env);
  if (refusal) throw new Error(refusal);
  if (action === "disconnect") return disconnectDesktop(io);
  if (io.env.MINDGRAPH_HOOKS === "off") throw new Error("MindGraph is paused (MINDGRAPH_HOOKS=off).");
  const projects = listProjects(io);
  let saved = connection(io);
  const firstRun = !projects.length || (!saved.apiKey && !isLoopbackUrl(saved.baseUrl));
  if (firstRun || action === "setup") {
    const next = await setupConnection(io, saved);
    if (!next) return;
    saved = next;
  }
  const initialIo = io;
  io = { ...io, checkConnection: () => checkConnection(initialIo, saved) };
  const client = graphClient(saved, io.env);
  let repo: PinnedRepository | undefined;
  if (action === "setup" && projects.length) {
    const options = ["Link a project", "Configure coding applications", "Automatic reconnect", "Disconnect"];
    const choice = await pick(io, options, s => s, "Desktop settings");
    if (!choice) return;
    if (choice === options[3]) return disconnectDesktop(io);
    if (choice === options[2]) return reconnectPreference(io);
    if (choice === options[1]) {
      const project = await pick(io, projects, r => displayPath(r.root), "Use which checkout?");
      if (project) await configureSelectedAgents(io, saved, project);
      return;
    }
  }
  if (!projects.length || action === "setup") {
    repo = await linkProject(io, saved, client);
  } else {
    const current = sessionConsent(io.cwd || process.cwd(), io.env);
    if (current.state === "on" && current.reason === "reconnected" && current.repo) projects.unshift(current.repo);
    repo = await pick(io, projects, r => displayPath(r.root), "Choose a project");
    if (repo && !repo.space_uid && action !== "resume") repo = await linkProject(io, saved, client, repo.root);
  }
  if (!repo) return;
  checkProject(repo, io);
  if (firstRun || action === "setup") {
    await reconnectPreference(io);
    try {
      await configureAgent(io, saved, repo);
    } catch (error) {
      io.out(printable(`Agent setup needs attention: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  io.out(printable(`${repo.repo_id} · ${new URL(saved.baseUrl).host} · ${saved.orgId || "default organization"}${repo.space_uid ? " · " + repo.space_uid : ""}`));
  switch (action) {
    case "remember": return remember(io, client, repo);
    case "recall": return recall(io, client, repo);
    case "resume": return resume(io, client, repo, saved.agentId);
  }
}
