import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { MindGraph } from "mindgraph";
import { loadHookEnv, saveHookEnv } from "./hook-env.js";
import {
  classifyMcpAddFailure,
  mcpAddFailureOutput,
  parseArgs,
} from "./cli-args.js";
import {
  readHookInput,
  runClaudeHook,
  type HookClient,
} from "./claude-hooks.js";
import {
  installClaudeHooks,
  installHookRunner,
  type HookScope,
  uninstallClaudeHooks,
  uninstallHookRunner,
} from "./hook-installer.js";

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
  const envArgs = [
    `--env`,
    `MINDGRAPH_API_KEY=${apiKey}`,
    "--env",
    "MINDGRAPH_PROFILE=coding",
    "--env",
    "MINDGRAPH_HARNESS=claude-code",
    "--env",
    "MINDGRAPH_AGENT_ID=claude-code",
  ];
  if (baseUrl) {
    envArgs.push("--env", `MINDGRAPH_BASE_URL=${baseUrl}`);
  }

  try {
    // C44: this used to `.join(" ")` the argv into one string and hand it to
    // `execSync`, which runs it through `/bin/sh -c`. The API key and base URL
    // were interpolated unquoted, so either containing `;`, backticks or
    // `$(…)` executed arbitrary commands — on the onboarding path, with a
    // value the user pastes from elsewhere.
    //
    // `execFileSync` takes argv directly and spawns no shell, so no character
    // in either value can be read as syntax.
    //
    // Note this does NOT hide the key from `ps`: `claude mcp add --env K=V`
    // puts it in the child's argv either way, which is that CLI's interface.
    // What is fixed is shell interpretation and the `sh -c` layer.
    const out = execFileSync(
      "claude",
      [
        "mcp",
        "add",
        "mindgraph",
        ...envArgs,
        "--",
        "npx",
        "-y",
        "mindgraph-mcp@latest",
      ],
      { stdio: ["inherit", "pipe", "pipe"] }
    );
    if (out?.length) process.stdout.write(out);
    console.log("Added MindGraph MCP server to Claude Code.");
  } catch (e) {
    switch (classifyMcpAddFailure(e)) {
      case "already-exists":
        // Re-install/upgrade path: the registration points at
        // `npx mindgraph-mcp@latest`, so it upgrades itself — leaving it in
        // place is correct. Exiting here used to abort BEFORE the --hooks
        // step, so upgrades never received new hook entries (found on the
        // first real re-install, 2026-07-29).
        console.log(
          "MindGraph MCP server already registered in Claude Code — leaving it in place."
        );
        break;
      case "missing-cli":
        console.error(
          "Failed to run 'claude mcp add'. Is Claude Code CLI installed?"
        );
        console.error("Install it from: https://claude.ai/code");
        process.exit(1);
        break;
      default: {
        const detail = mcpAddFailureOutput(e);
        console.error(detail || "'claude mcp add' failed.");
        process.exit(1);
      }
    }
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
    // Static string, so this was never injectable — converted so the file
    // spawns no shell at all and the `execSync` import can go.
    execFileSync("claude", ["mcp", "remove", "mindgraph"], {
      stdio: "inherit",
    });
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

function withHooksFlag(): boolean {
  // Only the non-interactive `install-code` path reads --hooks; the
  // interactive init flow always gets the tip (prompting mid-flow would
  // complicate scripted use of init's stdin).
  return process.argv.includes("--hooks");
}

function finishCodeInstall(
  apiKey: string,
  baseUrl: string | undefined,
  withHooks: boolean
): void {
  if (withHooks) {
    const runner = installHookRunner(__filename);
    console.log(`Installed pinned hook runner at ${runner}`);
    const result = installClaudeHooks("user");
    console.log(
      `Installed ${result.added} MindGraph Claude Code hook entries in ${result.path}`
    );
    const envPath = saveHookEnv({ apiKey, baseUrl });
    console.log(`Saved hook connection settings to ${envPath} (mode 600)`);
  } else {
    console.log(
      "Tip: run with --hooks (or run install-hooks) to add the Claude Code " +
        "session hooks — work-brief injection, provenance, reflection checkpoint."
    );
  }
  printCodegraphStatus();
}

function printCodegraphStatus(): void {
  // codegraph is the optional "code intelligence" layer: without it,
  // mindgraph_code anchor/expand degrade to typed unavailable results while
  // memory and work tools keep working. Surface the choice at install time
  // instead of degrading silently later.
  try {
    execFileSync("codegraph", ["--version"], { stdio: "pipe" });
    console.log("Code intelligence: codegraph detected — anchors and structural recall are enabled.");
  } catch {
    console.log(
      "Optional: enable code intelligence by installing codegraph " +
        "(https://github.com/colbymchenry/codegraph) and running `codegraph init` " +
        "in your repositories. Without it, memory and work tools still function; " +
        "code anchoring degrades gracefully."
    );
  }
}

// ── CLI Entry Point ───────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
mindgraph-mcp — MCP server for MindGraph knowledge graphs

USAGE:
  mindgraph-mcp                  Start the MCP server (stdio transport)
  mindgraph-mcp init             Interactive setup for Claude Desktop
  mindgraph-mcp install          Install into Claude Desktop config
  mindgraph-mcp install-code     Install into Claude Code (--hooks: + session hooks)
  mindgraph-mcp uninstall        Remove from Claude Desktop config
  mindgraph-mcp uninstall-code   Remove from Claude Code
  mindgraph-mcp install-hooks --harness claude-code [--scope user|project]
  mindgraph-mcp uninstall-hooks --harness claude-code [--scope user|project]
  mindgraph-mcp status           Show installation status

OPTIONS:
  --api-key <key>     MindGraph API key (or set MINDGRAPH_API_KEY env var)
  --base-url <url>    Custom API base URL (default: https://api.mindgraph.cloud)
  --scope <scope>     Hook settings scope: project (default) or user
  --project-dir <dir> Project root for project-scoped hooks
  --harness <name>    Hook harness (currently claude-code)
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


const DASHBOARD_URL =
  process.env.MINDGRAPH_DASHBOARD_URL || "https://mindgraph.cloud";
const POLL_INTERVAL = 2000; // 2 seconds
const POLL_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function generateCode(): string {
  return crypto.randomBytes(32).toString("hex");
}

function openBrowser(url: string): void {
  // C44 (same class): the URL was interpolated into a shell string, and it
  // derives from MINDGRAPH_DASHBOARD_URL. Lower severity than the API-key path
  // since the operator sets their own env, but it is the same one-line fix, so
  // there is no reason to leave a second shell-interpolation site behind.
  try {
    switch (process.platform) {
      case "darwin":
        execFileSync("open", [url]);
        break;
      case "win32":
        // `start` is a cmd builtin, so cmd is unavoidable — but passing argv
        // keeps the URL out of the command STRING. The empty argument is
        // start's title placeholder.
        execFileSync("cmd", ["/c", "start", "", url]);
        break;
      case "linux":
        execFileSync("xdg-open", [url]);
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
      finishCodeInstall(apiKey, baseUrl, withHooksFlag());
      break;
    case "3":
      installClaudeDesktop(apiKey, baseUrl);
      installClaudeCode(apiKey, baseUrl);
      finishCodeInstall(apiKey, baseUrl, withHooksFlag());
      break;
    default:
      console.error("Invalid choice.");
      process.exit(1);
  }

  console.log("\nDone! Your knowledge graph is now connected.");
}

async function main(): Promise<void> {
  const { command, apiKey, baseUrl, scope, projectDir, harness, hooks } =
    parseArgs(process.argv);

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
      finishCodeInstall(apiKey, baseUrl, withHooksFlag());
      break;

    case "uninstall":
      uninstallClaudeDesktop();
      break;

    case "uninstall-code":
      uninstallClaudeCode();
      break;

    case "install-hooks": {
      if ((harness || "claude-code") !== "claude-code") {
        throw new Error("only --harness claude-code is available in this release");
      }
      const runner = installHookRunner(__filename);
      console.log(`Installed pinned hook runner at ${runner}`);
      const result = installClaudeHooks(scope, projectDir);
      console.log(
        `Installed ${result.added} MindGraph Claude Code hook entries in ${result.path}`
      );
      // Hooks run with the harness's environment, which rarely carries the
      // MindGraph connection settings — persist them user-level (0600; never
      // into project settings, which get committed).
      if (apiKey || baseUrl) {
        const envPath = saveHookEnv({ apiKey, baseUrl });
        console.log(`Saved hook connection settings to ${envPath} (mode 600)`);
      } else {
        console.log(
          "Note: hooks resolve MINDGRAPH_API_KEY/MINDGRAPH_BASE_URL from the " +
            "environment or ~/.mindgraph/hooks.json — pass --api-key/--base-url " +
            "to persist them now."
        );
      }
      break;
    }

    case "uninstall-hooks": {
      if ((harness || "claude-code") !== "claude-code") {
        throw new Error("only --harness claude-code is available in this release");
      }
      uninstallHookRunner();
      const result = uninstallClaudeHooks(scope, projectDir);
      console.log(
        `Removed ${result.removed} MindGraph Claude Code hooks from ${result.path}`
      );
      break;
    }

    case "hook": {
      // Command hooks must fail open. A missing key or transient API failure
      // disables context/checkpoint nudges but never blocks Claude Code.
      // Resolution order: process env / flags, then ~/.mindgraph/hooks.json.
      const stored = loadHookEnv();
      const hookApiKey = apiKey ?? stored.apiKey;
      const hookBaseUrl = baseUrl ?? stored.baseUrl;
      if (!hookApiKey) {
        process.stdout.write("{}\n");
        break;
      }
      try {
        const input = await readHookInput();
        const client = new MindGraph({
          baseUrl: hookBaseUrl || "https://api.mindgraph.cloud",
          apiKey: hookApiKey,
          orgId: process.env.MINDGRAPH_ORG_ID,
          maxRetries: 0,
          telemetrySurface: "mcp",
        });
        const output = await runClaudeHook(input, client as unknown as HookClient, {
          agentId: process.env.MINDGRAPH_AGENT_ID || "claude-code",
        });
        process.stdout.write(`${JSON.stringify(output)}\n`);
      } catch {
        process.stdout.write("{}\n");
      }
      break;
    }

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
