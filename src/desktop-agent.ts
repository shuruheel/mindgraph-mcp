import path from "node:path";
import { spawnSync } from "node:child_process";
import { evalMode, evalUserScopeRefusal } from "./eval-guard.js";
import type { PinnedRepository } from "./consent.js";
import { type DesktopIo, type Connection, checkConnection, graphClient, pick, projectIdentity, record, humanSetup } from "./desktop-setup.js";

export type SupportedCodingAgent = "claude" | "codex";
export type CodingAppSelection = SupportedCodingAgent | "both" | "dashboard-only";

export function defaultAgent(env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync("omarchy", ["default", "agent"], { env, encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

const CODING_APP_CHOICES: Array<{ value: CodingAppSelection; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
  { value: "both", label: "Both Codex and Claude Code" },
  { value: "dashboard-only", label: "Dashboard only" },
];

export async function selectCodingApps(io: DesktopIo): Promise<CodingAppSelection | undefined> {
  const chosen = await pick(io, CODING_APP_CHOICES, c => c.label, "Which coding applications do you use?");
  return chosen?.value;
}

export function agentsForSelection(selection: CodingAppSelection): SupportedCodingAgent[] {
  if (selection === "dashboard-only") return [];
  if (selection === "both") return ["codex", "claude"];
  return [selection];
}

// The harness registration contains only the executable and harness name.
// Each launch reads the desktop's current connection from the owner-only store.
async function configureSingleAgent(
  io: DesktopIo,
  saved: Connection,
  repo: PinnedRepository,
  agent: SupportedCodingAgent,
  confirm: boolean,
): Promise<boolean> {
  const harness = agent === "claude" ? "claude-code" : "codex";
  if (confirm && (await io.ask(`Set up the MindGraph coding tools and session hooks for ${agent} on this desktop? [y/N] `)).trim().toLowerCase() !== "y") {
    return false;
  }
  checkConnection(io, saved);
  const env = { ...io.env };
  const refusal = evalUserScopeRefusal(harness, "user", env);
  if (refusal) throw new Error(refusal);
  const homeVariable = agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  if (!evalMode(env) && !env[homeVariable]) {
    const selected = spawnSync("omarchy-agent-account-home", [agent], { env, encoding: "utf8", timeout: 5000 });
    if (selected.status === 0 && selected.stdout.trim()) env[homeVariable] = selected.stdout.trim();
  }
  const cli = path.resolve(process.argv[1]);
  const name = "mindgraph-desktop";
  const command = process.execPath;
  const args = [cli, "desktop-agent", harness];
  const options = { env, cwd: repo.root, encoding: "utf8" as const, timeout: 30000 };
  const read = () => spawnSync(agent, ["mcp", "get", name, ...(agent === "codex" ? ["--json"] : [])], options);
  const matches = (output: string): boolean => {
    if (agent === "claude") return output.split(/\r?\n/).some(l => l.trim() === "Command: " + command)
      && output.split(/\r?\n/).some(l => l.trim() === "Args: " + args.join(" "));
    try {
      const entry = JSON.parse(output);
      return entry.enabled !== false && entry.transport?.command === command && JSON.stringify(entry.transport.args) === JSON.stringify(args);
    } catch { return false; }
  };
  const current = read();
  if (current.status === 0 && !matches(current.stdout)) throw new Error(`A different ${name} registration already exists in ${agent}. Review it in the agent's MCP settings.`);
  if (current.status !== 0) {
    const add = spawnSync(agent, ["mcp", "add", ...(agent === "claude" ? ["--scope", "user"] : []), name, "--", command, ...args], options);
    if (add.status !== 0 || !matches(read().stdout || "")) throw new Error(`Could not verify the MCP registration in ${agent}.`);
  }
  checkConnection(io, saved);
  const hookEnv = { ...env, MINDGRAPH_API_KEY: saved.apiKey || "", MINDGRAPH_BASE_URL: saved.baseUrl,
    MINDGRAPH_AGENT_ID: saved.agentId, MINDGRAPH_ORG_ID: saved.orgId || "" };
  const hooks = spawnSync(command, [cli, "install-hooks", "--harness", harness, "--scope", "user"], { ...options, env: hookEnv });
  if (hooks.status !== 0) throw new Error(`Registered the coding tools. Reopen setup to retry installing the ${agent} hooks.`);
  const verified = await verifyAgentTools(saved, repo, command, args, env);
  if (verified) io.out(`The coding tools read task ${verified} from this checkout.`);
  io.out(`Verified ${agent}'s MindGraph desktop registration for this checkout and installed its session hooks.`);
  if (agent === "codex") io.out("Review the new session hooks with /hooks in Codex.");
  return true;
}

export async function configureAgent(io: DesktopIo, saved: Connection, repo: PinnedRepository): Promise<void> {
  humanSetup(io);
  const agent = defaultAgent(io.env);
  if (agent !== "claude" && agent !== "codex") {
    io.out(agent ? `Configure MindGraph coding tools in your selected agent (${agent}) for task handoff.` : "Choose a default agent in Omarchy → Setup → Defaults → Agent for task handoff.");
    return;
  }
  await configureSingleAgent(io, saved, repo, agent, true);
}

export async function configureSelectedAgents(
  io: DesktopIo,
  saved: Connection,
  repo: PinnedRepository,
  selection?: CodingAppSelection,
): Promise<{ selection?: CodingAppSelection; configured: SupportedCodingAgent[]; failed: Array<{ agent: SupportedCodingAgent; error: string }> }> {
  humanSetup(io);
  const chosen = selection ?? await selectCodingApps(io);
  if (!chosen) return { configured: [], failed: [] };
  const agents = agentsForSelection(chosen);
  if (!agents.length) {
    io.out("Dashboard-only mode selected. No local coding app MCP servers or hooks were modified.");
    return { selection: chosen, configured: [], failed: [] };
  }
  const configured: SupportedCodingAgent[] = [];
  const failed: Array<{ agent: SupportedCodingAgent; error: string }> = [];
  for (const agent of agents) {
    try {
      const ok = await configureSingleAgent(io, saved, repo, agent, false);
      if (ok) configured.push(agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ agent, error: message });
      io.out(`${agent} setup needs attention: ${message}`);
    }
  }
  return { selection: chosen, configured, failed };
}

async function verifyAgentTools(saved: Connection, repo: PinnedRepository, command: string, args: string[], env: NodeJS.ProcessEnv) {
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const client = graphClient(saved, env);
  const identity = await projectIdentity(client, repo.root, repo.repo_id, saved.agentId);
  const transport = new StdioClientTransport({ command, args, cwd: repo.root, stderr: "pipe",
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")) });
  const mcp = new Client({ name: "mindgraph-desktop-setup", version: "1" });
  try {
    await mcp.connect(transport);
    const listed = await mcp.listTools();
    if (!listed.tools.some(t => t.name === "mindgraph_plan")) throw new Error("The registered coding server does not offer MindGraph project tasks.");
    if (!identity) return;
    const query = { action: "resume_work" as const, scope_uids: [identity], limit: 1 };
    const brief = record(await client.plan({ ...query, agent_id: saved.agentId }));
    const result = await mcp.callTool({ name: "mindgraph_plan", arguments: query });
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    if (result.isError || first?.type !== "text") throw new Error("The coding server could not read this project's work brief.");
    const actual = record(JSON.parse(first.text));
    if (brief.status === "no_eligible_work" && actual.status === brief.status) return;
    const uid = record(brief.task).uid;
    if (typeof uid !== "string" || record(actual.task).uid !== uid || !Array.isArray(actual.task_scope_uids) ||
        !actual.task_scope_uids.includes(identity) || !Array.isArray(brief.task_scope_uids) || !brief.task_scope_uids.includes(identity)) {
      throw new Error("The desktop and coding server returned different work. Reopen setup to verify the current task.");
    }
    return uid;
  } finally {
    await mcp.close();
  }
}
