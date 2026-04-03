import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execSync } from "child_process";

// ── Config Paths ──────────────────────────────────────────────────────

function getClaudeDesktopConfigPath(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      );
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json"
      );
    case "linux":
      return path.join(
        os.homedir(),
        ".config",
        "Claude",
        "claude_desktop_config.json"
      );
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function getClaudeCodeConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

// ── Helpers ───────────────────────────────────────────────────────────

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function getMcpServerEntry(apiKey: string, baseUrl?: string) {
  const env: Record<string, string> = { MINDGRAPH_API_KEY: apiKey };
  if (baseUrl) env.MINDGRAPH_BASE_URL = baseUrl;

  return {
    command: "npx",
    args: ["-y", "mindgraph-mcp@latest"],
    env,
  };
}

// ── Commands ──────────────────────────────────────────────────────────

function installClaudeDesktop(apiKey: string, baseUrl?: string): void {
  const configPath = getClaudeDesktopConfigPath();
  console.log(`Claude Desktop config: ${configPath}`);

  const config = readJsonFile(configPath);
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  const isUpdate = "mindgraph" in servers;
  servers.mindgraph = getMcpServerEntry(apiKey, baseUrl);

  writeJsonFile(configPath, config);

  if (isUpdate) {
    console.log("Updated MindGraph MCP server in Claude Desktop config.");
  } else {
    console.log("Added MindGraph MCP server to Claude Desktop config.");
  }
  console.log("Restart Claude Desktop to activate.");
}

function installClaudeCode(apiKey: string, baseUrl?: string): void {
  const envArgs = [`--env`, `MINDGRAPH_API_KEY=${apiKey}`];
  if (baseUrl) {
    envArgs.push("--env", `MINDGRAPH_BASE_URL=${baseUrl}`);
  }

  try {
    execSync(
      [
        "claude",
        "mcp",
        "add",
        "mindgraph",
        ...envArgs,
        "--",
        "npx",
        "-y",
        "mindgraph-mcp@latest",
      ].join(" "),
      { stdio: "inherit" }
    );
    console.log("Added MindGraph MCP server to Claude Code.");
  } catch {
    console.error(
      "Failed to run 'claude mcp add'. Is Claude Code CLI installed?"
    );
    console.error("Install it from: https://claude.ai/code");
    process.exit(1);
  }
}

function uninstallClaudeDesktop(): void {
  const configPath = getClaudeDesktopConfigPath();
  if (!fs.existsSync(configPath)) {
    console.log("Claude Desktop config not found. Nothing to remove.");
    return;
  }

  const config = readJsonFile(configPath);
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !("mindgraph" in servers)) {
    console.log("MindGraph not found in Claude Desktop config.");
    return;
  }

  delete servers.mindgraph;
  writeJsonFile(configPath, config);
  console.log("Removed MindGraph from Claude Desktop config.");
  console.log("Restart Claude Desktop to apply.");
}

function uninstallClaudeCode(): void {
  try {
    execSync("claude mcp remove mindgraph", { stdio: "inherit" });
    console.log("Removed MindGraph MCP server from Claude Code.");
  } catch {
    console.error("Failed to run 'claude mcp remove'.");
  }
}

function printStatus(): void {
  // Check Claude Desktop
  const desktopPath = getClaudeDesktopConfigPath();
  if (fs.existsSync(desktopPath)) {
    const config = readJsonFile(desktopPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (servers && "mindgraph" in servers) {
      console.log("Claude Desktop: installed");
    } else {
      console.log("Claude Desktop: not installed");
    }
  } else {
    console.log("Claude Desktop: config not found");
  }

  // Check env
  console.log(
    `MINDGRAPH_API_KEY: ${process.env.MINDGRAPH_API_KEY ? "set" : "not set"}`
  );
  console.log(
    `MINDGRAPH_BASE_URL: ${process.env.MINDGRAPH_BASE_URL || "https://api.mindgraph.cloud (default)"}`
  );
}

// ── CLI Entry Point ───────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
mindgraph-mcp — MCP server for MindGraph knowledge graphs

USAGE:
  mindgraph-mcp                  Start the MCP server (stdio transport)
  mindgraph-mcp init             Interactive setup for Claude Desktop
  mindgraph-mcp install          Install into Claude Desktop config
  mindgraph-mcp install-code     Install into Claude Code
  mindgraph-mcp uninstall        Remove from Claude Desktop config
  mindgraph-mcp uninstall-code   Remove from Claude Code
  mindgraph-mcp status           Show installation status

OPTIONS:
  --api-key <key>     MindGraph API key (or set MINDGRAPH_API_KEY env var)
  --base-url <url>    Custom API base URL (default: https://api.mindgraph.cloud)
  --help, -h          Show this help message

EXAMPLES:
  # Interactive setup
  npx mindgraph-mcp init

  # Install with API key
  npx mindgraph-mcp install --api-key mg_your_key_here

  # Install into Claude Code
  npx mindgraph-mcp install-code --api-key mg_your_key_here

Get your API key at: https://mindgraph.cloud/dashboard/keys
`);
}

function parseArgs(argv: string[]): {
  command: string;
  apiKey?: string;
  baseUrl?: string;
} {
  const args = argv.slice(2);
  let command = "serve";
  let apiKey = process.env.MINDGRAPH_API_KEY;
  let baseUrl: string | undefined = process.env.MINDGRAPH_BASE_URL;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--api-key":
        apiKey = args[++i];
        break;
      case "--base-url":
        baseUrl = args[++i];
        break;
      case "--help":
      case "-h":
        command = "help";
        break;
      default:
        if (!arg.startsWith("-")) {
          command = arg;
        }
        break;
    }
  }

  return { command, apiKey, baseUrl };
}

const DASHBOARD_URL =
  process.env.MINDGRAPH_DASHBOARD_URL || "https://mindgraph.cloud";
const POLL_INTERVAL = 2000; // 2 seconds
const POLL_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function generateCode(): string {
  return crypto.randomBytes(32).toString("hex");
}

function openBrowser(url: string): void {
  try {
    switch (process.platform) {
      case "darwin":
        execSync(`open "${url}"`);
        break;
      case "win32":
        execSync(`start "" "${url}"`);
        break;
      case "linux":
        execSync(`xdg-open "${url}"`);
        break;
    }
  } catch {
    // Silently fail — we'll show the URL for manual copy
  }
}

async function pollForKey(code: string): Promise<string> {
  const pollUrl = `${DASHBOARD_URL}/api/connect?code=${code}`;
  const deadline = Date.now() + POLL_TIMEOUT;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(pollUrl);
      const data = await res.json();

      if (data.status === "authorized" && data.api_key) {
        return data.api_key;
      }
      if (data.status === "expired") {
        throw new Error("Session expired. Please try again.");
      }
      if (data.status === "claimed") {
        throw new Error("Session already used. Please try again.");
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("Session")) throw e;
      // Network error — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error("Timed out waiting for authorization.");
}

async function interactiveInit(baseUrl?: string): Promise<void> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log("\nMindGraph MCP Server Setup\n");
  console.log("  1. Sign in via browser (recommended)");
  console.log("  2. Enter API key manually");
  console.log("");

  const method = await ask("Choice (1/2): ");

  let apiKey: string;

  if (method.trim() === "2") {
    // Manual API key entry
    apiKey = await ask(
      "\nEnter your MindGraph API key (from mindgraph.cloud/dashboard/keys): "
    );
    if (!apiKey || !apiKey.startsWith("mg_")) {
      console.error('Invalid API key. Keys start with "mg_".');
      rl.close();
      process.exit(1);
    }
  } else {
    // Browser auth flow
    const code = generateCode();
    const authUrl = `${DASHBOARD_URL}/dashboard/connect?code=${code}`;

    console.log("\nOpening browser to authorize...\n");
    console.log(`  ${authUrl}\n`);
    console.log("If the browser didn't open, copy the URL above and paste it in your browser.");
    console.log("Waiting for authorization...\n");

    openBrowser(authUrl);

    try {
      apiKey = await pollForKey(code);
      console.log("Authorization received!\n");
    } catch (e) {
      console.error(e instanceof Error ? e.message : "Authorization failed.");
      rl.close();
      process.exit(1);
    }
  }

  console.log("Where do you want to install?\n");
  console.log("  1. Claude Desktop");
  console.log("  2. Claude Code");
  console.log("  3. Both");
  console.log("");

  const choice = await ask("Choice (1/2/3): ");
  rl.close();

  switch (choice.trim()) {
    case "1":
      installClaudeDesktop(apiKey, baseUrl);
      break;
    case "2":
      installClaudeCode(apiKey, baseUrl);
      break;
    case "3":
      installClaudeDesktop(apiKey, baseUrl);
      installClaudeCode(apiKey, baseUrl);
      break;
    default:
      console.error("Invalid choice.");
      process.exit(1);
  }

  console.log("\nDone! Your knowledge graph is now connected.");
}

async function main(): Promise<void> {
  const { command, apiKey, baseUrl } = parseArgs(process.argv);

  switch (command) {
    case "help":
      printUsage();
      break;

    case "init":
      await interactiveInit(baseUrl);
      break;

    case "install":
      if (!apiKey) {
        console.error(
          "API key required. Use --api-key or set MINDGRAPH_API_KEY."
        );
        process.exit(1);
      }
      installClaudeDesktop(apiKey, baseUrl);
      break;

    case "install-code":
      if (!apiKey) {
        console.error(
          "API key required. Use --api-key or set MINDGRAPH_API_KEY."
        );
        process.exit(1);
      }
      installClaudeCode(apiKey, baseUrl);
      break;

    case "uninstall":
      uninstallClaudeDesktop();
      break;

    case "uninstall-code":
      uninstallClaudeCode();
      break;

    case "status":
      printStatus();
      break;

    case "serve": {
      // When run without a subcommand, start the MCP server
      // Import dynamically to avoid loading MCP SDK for CLI commands
      await import("./index.js");
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error.message || error);
  process.exit(1);
});
