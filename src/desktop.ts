import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { MindGraph } from "mindgraph";
import { repositoryIdentityKey } from "./codegraph.js";
import { consentFor, loadConsentStore, pathContains, resolveConsent, type PinnedRepository } from "./consent.js";
import { displayPath, type ConsentIo } from "./consent-cli.js";
import { printable } from "./consent-plan.js";
import { assertEvalBaseUrl, evalAppConfigRefusal, evalHomeRefusal, isLoopbackUrl } from "./eval-guard.js";
import { loadHookEnv, mindgraphConfigDir, stableAgentId } from "./hook-env.js";
import { updateMenu } from "./omarchy-menu.js";
import { renderContext, renderResumeContext } from "./render.js";

type DesktopIo = Pick<ConsentIo, "stdin" | "stdout" | "env" | "out" | "ask">;
// Give each prompt its own terminal reader. Closing it before a network request
// or an agent handoff releases stdin and restores the terminal's input mode.
export function desktopTerminal(): DesktopIo {
  return {
    stdin: process.stdin, stdout: process.stdout, env: process.env,
    out: line => console.log(line),
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

type RecordValue = Record<string, unknown>;
const NOTE_BYTES = 8192;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

// Keep line breaks, but render terminal controls from selections, paths and the API visibly.
function display(text: string): string {
  return text.split("\n").map(printable).join("\n");
}

async function pick<T>(io: DesktopIo, items: T[], label: (item: T) => string, question: string): Promise<T | undefined> {
  items.forEach((item, i) => io.out(`${i + 1}. ${printable(label(item))}`));
  const answer = (await io.ask(`${question} (Enter to close): `)).trim();
  if (!answer) return;
  const item = /^[1-9]\d*$/.test(answer) ? items[Number(answer) - 1] : undefined;
  if (!item) throw new Error("Select a number from the list.");
  return item;
}

function checkProject(repo: PinnedRepository, io: DesktopIo): void {
  const decision = consentFor(repo.root, { env: io.env });
  if (decision.state !== "on" || decision.repo?.root !== repo.root ||
      decision.repo.repo_id !== repo.repo_id || decision.space_uid !== repo.space_uid) {
    throw new Error("Project settings changed. Reopen the project picker.");
  }
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
  const identity = record(await client.entity({
    action: "resolve_identity", identity: { namespace: "external.code", key_version: 1,
      key: repositoryIdentityKey({ repoId: repo.repo_id, repoRoot: repo.root }) }, agent_id: agentId,
  }));
  if (identity.status === "absent") { io.out("No durable work has been linked to this repository yet."); return; }
  if (identity.status !== "existing" || typeof identity.uid !== "string" || !identity.uid) throw new Error("Could not resolve this repository's MindGraph identity.");
  const brief = record(await client.plan({ action: "resume_work", scope_uids: [identity.uid], limit: 1, agent_id: agentId }));
  if (brief.status === "no_eligible_work") { io.out("No eligible work in this repository."); return; }
  const { uid, label } = record(brief.task);
  if (typeof uid !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(uid) ||
      !Array.isArray(brief.task_scope_uids) || !brief.task_scope_uids.includes(identity.uid)) {
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
  const prompt = `Use MindGraph to read task ${uid} in this repository. Summarize its next step, rationale, and blockers for me.`;
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

export async function runDesktop(args: string[], io: DesktopIo): Promise<void> {
  const [action] = args;
  if (args.length !== 1 || !["install-menu", "uninstall-menu", "remember", "recall", "resume"].includes(action)) {
    throw new Error("Usage: mindgraph-mcp desktop install-menu|uninstall-menu|remember|recall|resume");
  }
  if (action.endsWith("-menu")) {
    const refusal = evalAppConfigRefusal("Omarchy", io.env);
    if (refusal) throw new Error(refusal);
    io.out(updateMenu(action === "install-menu"));
    return;
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY) throw new Error("Open a terminal for the desktop project picker.");
  if (io.env.MINDGRAPH_HOOKS === "off") throw new Error("MindGraph is paused (MINDGRAPH_HOOKS=off).");
  const refusal = evalHomeRefusal(io.env);
  if (refusal) throw new Error(refusal);
  const projects = listProjects(io);
  if (!projects.length) throw new Error("No enabled repositories. Run mindgraph-mcp on --space space:project:NAME in your repository first.");
  const repo = await pick(io, projects, r => displayPath(r.root), "Choose a project");
  if (!repo) return;
  checkProject(repo, io);
  const stored = loadHookEnv(mindgraphConfigDir(io.env).dir);
  const baseUrl = assertEvalBaseUrl(stored.baseUrl || "https://api.mindgraph.cloud", io.env);
  if (!stored.apiKey && !isLoopbackUrl(baseUrl)) throw new Error("Save your connection with mindgraph-mcp install-hooks first.");
  io.out(printable(`${repo.repo_id} · ${baseUrl} · ${stored.orgId || "default organization"}${repo.space_uid ? " · " + repo.space_uid : ""}`));
  const client = new MindGraph({ baseUrl, apiKey: stored.apiKey, orgId: stored.orgId, maxRetries: 0, timeoutMs: 15000 });
  switch (action) {
    case "remember": return remember(io, client, repo);
    case "recall": return recall(io, client, repo);
    case "resume": return resume(io, client, repo, io.env.MINDGRAPH_AGENT_ID || stored.agentId || stableAgentId());
  }
}
