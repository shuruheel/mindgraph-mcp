import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MindGraph } from "mindgraph";
import { browserSignIn } from "./browser-connect.js";
import { requireHumanTerminal } from "./agent-shell.js";
import { anchorRepository, type CodeClient } from "./code-tool.js";
import { repositoryIdentityKey } from "./codegraph.js";
import { consentFor, loadConsentStore, writeConsent, type PinnedRepository } from "./consent.js";
import { displayPath, runOn, type ConsentIo } from "./consent-cli.js";
import { nodeGit, planConsent, printable, remoteRepositoryId } from "./consent-plan.js";
import { assertEvalBaseUrl, isLoopbackUrl } from "./eval-guard.js";
import { loadHookEnv, mindgraphConfigDir, saveHookEnv, stableAgentId } from "./hook-env.js";

export type DesktopIo = Pick<ConsentIo, "ask" | "out" | "stdin" | "stdout" | "env"> &
  Partial<Pick<ConsentIo, "cwd" | "refreshRunner">> & { secret?: (prompt: string) => Promise<string>; checkConnection?: () => void };
export const CLOUD_API = "https://api.mindgraph.cloud";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function pick<T>(io: DesktopIo, items: T[], label: (item: T) => string, question: string): Promise<T | undefined> {
  items.forEach((item, i) => io.out(`${i + 1}. ${printable(label(item))}`));
  const answer = (await io.ask(`${question} (Enter to close): `)).trim();
  if (!answer) return;
  const item = /^[1-9]\d*$/.test(answer) ? items[Number(answer) - 1] : undefined;
  if (item === undefined) throw new Error("Select a number from the list.");
  return item;
}

export function humanSetup(io: DesktopIo): void {
  const check = requireHumanTerminal(io);
  if (!check.ok) throw new Error("Open MindGraph from the Omarchy menu to approve desktop setup.");
}

export function connection(io: DesktopIo) {
  const dir = mindgraphConfigDir(io.env).dir;
  const stored = loadHookEnv(dir);
  const baseUrl = stored.baseUrl || CLOUD_API;
  return { baseUrl, apiKey: stored.apiKey, orgId: stored.orgId, agentId: stored.agentId || stableAgentId() };
}
export type Connection = ReturnType<typeof connection>;

export function checkConnection(io: DesktopIo, expected: Connection): void {
  const active = connection(io);
  if (active.baseUrl !== expected.baseUrl || (active.apiKey || "") !== (expected.apiKey || "") ||
      (active.orgId || "") !== (expected.orgId || "") || active.agentId !== expected.agentId) {
    throw new Error("Connection settings changed. Reopen MindGraph to confirm the destination.");
  }
}

export function graphClient(c: Connection, env = process.env): MindGraph {
  assertEvalBaseUrl(c.baseUrl, env);
  return new MindGraph({ ...c, maxRetries: 0, timeoutMs: 15000 });
}

function safeUrl(raw: string): string {
  const url = new URL(raw);
  if ((url.protocol !== "https:" && !isLoopbackUrl(raw)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS server URL, or HTTP on loopback, with credentials entered separately.");
  }
  return url.href.replace(/\/+$/, "");
}

export async function setupConnection(io: DesktopIo, saved: Connection): Promise<Connection | undefined> {
  humanSetup(io);
  const reusable = Boolean(saved.apiKey || isLoopbackUrl(saved.baseUrl));
  const choices = [...(reusable ? ["Use saved MindGraph connection"] : []), "Connect to MindGraph Cloud", "Connect to a custom server"];
  const choice = await pick(io, choices, s => s, "Connection");
  if (!choice) return;
  let next = { ...saved };
  if (choice === "Connect to MindGraph Cloud") {
    next = { ...saved, baseUrl: assertEvalBaseUrl(CLOUD_API, io.env), orgId: undefined,
      apiKey: await browserSignIn(io.out, "https://mindgraph.cloud", io.env) };
  } else if (choice === "Connect to a custom server") {
    const url = (await io.ask("Server URL (Enter to close): ")).trim();
    if (!url) return;
    const baseUrl = assertEvalBaseUrl(safeUrl(url), io.env);
    if (!io.secret) throw new Error("A terminal with hidden key entry is required.");
    const apiKey = await io.secret(isLoopbackUrl(baseUrl) ? "API key (optional on loopback): " : "API key: ");
    if (!apiKey && !isLoopbackUrl(baseUrl)) return;
    const orgId = (await io.ask("Organization ID (Enter for the key's organization): ")).trim();
    next = { ...saved, baseUrl, apiKey, orgId: orgId || undefined };
  }
  // This is a grant-filtered authenticated read, including for keys with limited access.
  await spacePage(graphClient(next, io.env), 0, 1);
  if (choice !== "Use saved MindGraph connection") {
    if (reusable && (saved.baseUrl !== next.baseUrl || saved.orgId !== next.orgId || saved.apiKey !== next.apiKey)
        && loadConsentStore(io.env).store?.roots.length) {
      if ((await io.ask("Use the new connection for ALL previously enabled checkouts on this machine? [y/N] ")).trim().toLowerCase() !== "y") return;
    }
    checkConnection(io, saved);
    saveHookEnv({ ...next, orgId: next.orgId ?? null }, mindgraphConfigDir(io.env).dir);
  }
  io.out(printable(`Verified graph access at ${new URL(next.baseUrl).host} · ${next.orgId || "this connection's default organization"}`));
  return next;
}

type Space = { uid: string; label: string };
async function spacePage(client: MindGraph, offset: number, limit: number) {
  const page = record(await client.getNodes({ node_type: "Space", offset, limit }));
  if (!Array.isArray(page.items) || typeof page.has_more !== "boolean") throw new Error("The server did not return a Space list.");
  return { items: page.items, hasMore: page.has_more };
}

function validSpace(uid: unknown): uid is string {
  return typeof uid === "string" && uid.length <= 512 && /^space:[A-Za-z0-9_.:-]+$/.test(uid);
}
async function spaces(client: MindGraph): Promise<Space[]> {
  const result: Space[] = [];
  let offset = 0;
  for (;;) {
    const page = await spacePage(client, offset, 100);
    for (const item of page.items) {
      const { uid, label } = record(item);
      if (validSpace(uid) && typeof label === "string") result.push({ uid, label });
    }
    if (!page.hasMore) return result;
    if (!page.items.length) throw new Error("Space pagination did not advance.");
    offset += page.items.length;
  }
}

export async function projectIdentity(client: MindGraph, root: string, repoId: string, agentId: string) {
  const identity = record(await client.entity({ action: "resolve_identity", agent_id: agentId,
    identity: { namespace: "external.code", key_version: 1, key: repositoryIdentityKey({ repoRoot: root, repoId }) } }));
  if (identity.status === "absent") return;
  if (identity.status !== "existing" || typeof identity.uid !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(identity.uid)) {
    throw new Error("Could not access the MindGraph identity for this repository.");
  }
  return identity.uid;
}

async function owningSpace(c: Connection, uid: string): Promise<string | undefined> {
  const headers = new Headers();
  if (c.apiKey) headers.set("Authorization", "Bearer " + c.apiKey);
  if (c.orgId) headers.set("X-MindGraph-Org", c.orgId);
  const response = await fetch(`${c.baseUrl.replace(/\/+$/, "")}/node/${encodeURIComponent(uid)}/provenance`, {
    headers, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Repository Space lookup failed (HTTP ${response.status}).`);
  const node = record(record(await response.json()).node);
  return node.uid === uid && validSpace(node.space_uid) ? node.space_uid : undefined;
}

function checkoutFolders(cwd: string): string[] {
  const home = os.homedir();
  const found = new Set<string>();
  if (fs.existsSync(path.join(cwd, ".git"))) found.add(cwd);
  for (const dir of [home, path.join(home, "Code"), path.join(home, "Projects"), path.join(home, "Work")]) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const folder = path.join(dir, entry.name);
      if (fs.existsSync(path.join(folder, ".git")) || fs.existsSync(path.join(folder, ".mindgraph/workspace.json"))) found.add(folder);
    }
  }
  return [...found].sort();
}

export async function linkProject(io: DesktopIo, c: Connection, client: MindGraph, initialRoot?: string): Promise<PinnedRepository | undefined> {
  humanSetup(io);
  const cwd = io.cwd || process.cwd();
  let input = initialRoot;
  if (!input) {
    const folders = checkoutFolders(cwd);
    if (folders.length) {
      const choice = await pick(io, [...folders, ""], s => s ? displayPath(s) : "Enter another folder", "Link a local checkout");
      if (choice === undefined) return;
      input = choice;
    }
    if (!input) input = (await io.ask("Local checkout folder to link (Enter to close): ")).trim();
  }
  if (!input) return;
  const target = path.resolve(cwd, input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input);
  const git = nodeGit(io.env);
  const plan = planConsent(target, { git });
  const consentIo: ConsentIo = { ...io, cwd, err: io.out, git };
  let member: PinnedRepository | undefined;
  if (plan.kind === "workspace") {
    const existing = consentFor(target, { env: io.env });
    if (existing.state !== "on") {
      if (await runOn(plan.root, consentIo) !== 0) return;
    }
    const enabled = plan.included.flatMap(item => {
      const d = consentFor(item.root, { env: io.env });
      return d.state === "on" && d.repo?.root === item.root ? [d.repo] : [];
    });
    member = enabled.find(r => r.root === target) ?? (enabled.length === 1 ? enabled[0]
      : enabled.length ? await pick(io, enabled, r => displayPath(r.root), "Choose a workspace repository") : undefined);
    if (!member || member.space_uid) return member;
  }
  const root = member?.root ?? plan.root;
  const repoId = member?.repo_id ?? remoteRepositoryId(root, git);
  io.out(printable(`Link ${displayPath(root)} with ${new URL(c.baseUrl).host}`));
  let anchor: string | undefined;
  let preferred: string | undefined;
  if (repoId) {
    if ((await io.ask(`Look up ${printable(repoId)} in this organization? [y/N] `)).trim().toLowerCase() !== "y") return;
    anchor = await projectIdentity(client, root, repoId, c.agentId);
    if (anchor) {
      preferred = await owningSpace(c, anchor);
      const brief = record(await client.plan({ action: "resume_work", agent_id: c.agentId, scope_uids: [anchor], limit: 1 }));
      const task = record(brief.task);
      if (Array.isArray(brief.task_scope_uids) && brief.task_scope_uids.includes(anchor) && typeof task.label === "string") {
        io.out(printable(`Existing task: ${task.label}`));
      }
    }
  }
  const all = await spaces(client);
  if (preferred && !all.some(s => s.uid === preferred)) {
    const space = await client.getNode(preferred);
    if (space.uid === preferred && space.node_type.toLowerCase() === "space") all.push({ uid: preferred, label: space.label });
  }
  all.sort((a, b) => Number(b.uid === preferred) - Number(a.uid === preferred) || a.label.localeCompare(b.label));
  const create = { uid: "", label: "Create a project Space" };
  const selected = await pick(io, [...all, create], s => s.uid
    ? `${s.label} (${s.uid})${s.uid === preferred ? " · existing repository Space" : ""}` : s.label, "Use which Space?");
  if (!selected) return;
  const name = path.basename(root);
  const suffix = createHash("sha256").update(repoId || root).digest("hex").slice(0, 12);
  const space = selected.uid || `space:project:${name.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 70)}-${suffix}`;
  if (!selected.uid) io.out(printable(`Create Space “${name}” when you enable this project.`));
  if (!anchor) io.out("Link the repository identity to the selected Space when you enable this project.");
  const provision = async (pinned: PinnedRepository) => {
    checkConnection(io, c);
    if (pinned.root !== root || (repoId && pinned.repo_id !== repoId)) throw new Error("Checkout identity changed during setup.");
    if (!selected.uid) await client.memoryConfig({ action: "ensure_space", space_uid: space, label: name } as never);
    if (!anchor) {
      const linked = await anchorRepository(client as unknown as CodeClient, { repoRoot: pinned.root, repoId: pinned.repo_id }, space, c.agentId);
      if (!linked.uid || !["created", "existing"].includes(linked.status || "")) throw new Error("Could not link the repository identity.");
    }
  };
  if (member) {
    if ((await io.ask(`Use ${printable(selected.label)} for ${printable(displayPath(root))}? [y/N] `)).trim().toLowerCase() !== "y") return;
    const check = consentFor(root, { env: io.env });
    if (check.state !== "on" || check.repo?.repo_id !== repoId || check.space_uid) throw new Error("Workspace settings changed. Reopen setup.");
    await provision(member);
    writeConsent(store => {
      const entry = store.roots.find(r => r.root === plan.root && r.kind === "workspace");
      const pinned = entry?.repositories.find(r => r.root === root && r.repo_id === repoId);
      if (!pinned || pinned.space_uid || entry?.workspace_sha256 !== (plan.kind === "workspace" ? plan.workspace_sha256 : undefined)) {
        throw new Error("Workspace settings changed. Reopen setup.");
      }
      pinned.space_uid = space;
    }, { env: io.env });
    return { ...member, space_uid: space };
  }
  const result = await runOn(root, { ...consentIo, prepareRepository: provision }, space);
  if (result !== 0) return;
  const decision = consentFor(root, { env: io.env });
  return decision.state === "on" && decision.repo?.space_uid === space ? decision.repo : undefined;
}

export async function reconnectPreference(io: DesktopIo): Promise<void> {
  humanSetup(io);
  const enabled = loadConsentStore(io.env).store?.reconnectSiblings === true;
  const choice = await pick(io, ["Enable automatic reconnect", "Keep each checkout separate"], s => s,
    `Reconnect sibling clones of previously approved standalone projects with the same Git origin and Space? Currently ${enabled ? "on" : "off"}`);
  if (choice) writeConsent(store => { store.reconnectSiblings = choice === "Enable automatic reconnect"; }, { env: io.env });
}
