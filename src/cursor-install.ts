import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Local MindGraph server for Cursor, with the coding profile.
 *
 * Cursor reads user-level MCP servers from `~/.cursor/mcp.json`. Only that
 * file is written: a project-level `.cursor/mcp.json` is usually committed,
 * and this entry carries an API key.
 *
 * Hooks are not installed here. Cursor loads Claude Code hooks from
 * `~/.claude/settings.json` on its own (Settings → Agents → Third-Party
 * Imports, on by default), so a machine with the Claude Code hooks may run
 * them in Cursor already; that path has not had a live Cursor test.
 */
export interface CursorInstallOptions {
  apiKey: string;
  baseUrl?: string;
  agentId?: string;
  homeDir?: string;
}

export function cursorConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".cursor", "mcp.json");
}

function readConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object; fix or remove it first.`);
  }
  return parsed as Record<string, unknown>;
}

function writeConfig(file: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  // The file holds an API key: owner-only, as the hook settings are.
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

/** Adds or replaces the `mindgraph` entry and leaves every other server
 * untouched. Returns the file and whether an entry was replaced. */
export function installCursor(options: CursorInstallOptions): {
  file: string;
  updated: boolean;
} {
  const file = cursorConfigPath(options.homeDir);
  const config = readConfig(file);
  const servers =
    config.mcpServers && typeof config.mcpServers === "object"
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  const env: Record<string, string> = {
    MINDGRAPH_API_KEY: options.apiKey,
    MINDGRAPH_PROFILE: "coding",
    MINDGRAPH_HARNESS: "cursor",
  };
  if (options.agentId) env.MINDGRAPH_AGENT_ID = options.agentId;
  if (options.baseUrl) env.MINDGRAPH_BASE_URL = options.baseUrl;
  const updated = "mindgraph" in servers;
  servers.mindgraph = {
    command: "npx",
    args: ["-y", "mindgraph-mcp@latest"],
    env,
  };
  config.mcpServers = servers;
  writeConfig(file, config);
  return { file, updated };
}

/** Removes only the `mindgraph` entry. Returns false when there was none. */
export function uninstallCursor(homeDir?: string): boolean {
  const file = cursorConfigPath(homeDir);
  if (!fs.existsSync(file)) return false;
  const config = readConfig(file);
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object" || !("mindgraph" in servers)) {
    return false;
  }
  delete servers.mindgraph;
  writeConfig(file, config);
  return true;
}
