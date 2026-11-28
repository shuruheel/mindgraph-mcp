import { sessionConsent } from "./session-consent.js";
import { browserSignIn } from "./browser-connect.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { MindGraph } from "mindgraph";
import {
  assertHookConfigReadable,
  loadHookEnv,
  mindgraphRuntimeDir,
  resolvedHookFeatures,
  saveHookEnv,
  stableAgentId,
} from "./hook-env.js";
import { loadConsentStore, eventDirectory } from "./consent.js";
import {
  consentStatusLines,
  hookConfigFailure,
  INSTALL_CONSENT_LINE,
  refreshRunnerForConsent,
  nodeConsentIo,
  runOff,
  runOn,
} from "./consent-cli.js";
import { runOffAll } from "./consent-residue.js";
import { printable } from "./consent-plan.js";
import { desktopTerminal, runDesktop } from "./desktop.js";
import { runImportNotes } from "./import-notes.js";
import {
  EVAL_REQUIRES_HOME,
  EVAL_REQUIRES_LOOPBACK,
  evalAppConfigRefusal,
  evalBaseUrlRefusal,
  evalHomeRefusal,
  evalMode,
  isLoopbackUrl,
  evalUserScopeRefusal,
} from "./eval-guard.js";
import {
  classifyMcpAddFailure,
  mcpAddFailureOutput,
  parseArgs,
} from "./cli-args.js";
import { httpSkillsApi, skillsPull, skillsPush } from "./skills-cli.js";
import {
  claudeHookOutput,
  readHookInput,
  runClaudeHook,
  type ClaudeHookInput as HookInput,
  type HookClient,
} from "./claude-hooks.js";
import { codexHookOutput, runCodexHook } from "./codex-hooks.js";
import { installCursor, uninstallCursor } from "./cursor-install.js";
import { formatHookStats, offOutput, previewCapture, readHookStats, recordFailOpen } from "./hook-core.js";
import { formatScope } from "./action-line.js";
import {
  gateFloorWarning,
  installClaudeHooks,
  installCodexHooks,
  type InstallResult,
  installHookRunner,
  overrideRunner,
  refreshPortableRunnerBelowGate,
  type HookScope,
  uninstallClaudeHooks,
  uninstallCodexHooks,
} from "./hook-installer.js";

// Compile-time define (tsup); the pinned runner records it in a sidecar so
// the MCP server can detect hook/server version skew.
declare const __PACKAGE_VERSION__: string;

// ── Hook health marker ────────────────────────────────────────────────

/**
 * Record a hook failure where a human can find it. Hooks fail open by
 * design (a broken hook must never block the harness), which previously
 * meant a revoked key or persistent transport error turned session
 * continuity off with ZERO observable signal anywhere. `mindgraph-mcp
 * status` and support can read this file; each failure also emits one
 * stderr line (visible in harness debug logs).
 */
function recordHookHealth(harness: string, error: string): void {
  try {
    const dir = mindgraphRuntimeDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "hook-health.json");
    let failures = 0;
    try {
      failures =
        Number(JSON.parse(fs.readFileSync(file, "utf8")).consecutiveFailures) ||
        0;
    } catch {
      // First failure, or an unreadable marker — start counting fresh.
    }
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        harness,
        lastError: error.slice(0, 500),
        lastFailureAt: new Date().toISOString(),
        consecutiveFailures: failures + 1,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Health reporting must never break the fail-open contract.
  }
}

/** Reset the failure counter once a hook call succeeds again. */
function clearHookHealth(harness: string): void {
  try {
    const file = path.join(
      mindgraphRuntimeDir(),
      "hook-health.json",
    );
    if (!fs.existsSync(file)) return;
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number(current.consecutiveFailures)) return;
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        harness,
        lastOkAt: new Date().toISOString(),
        consecutiveFailures: 0,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Health reporting must never break the fail-open contract.
  }
}

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

function installClaudeCode(
  apiKey: string,
  baseUrl?: string,
  agentId?: string
): void {
  const envArgs = [
    `--env`,
    `MINDGRAPH_API_KEY=${apiKey}`,
    "--env",
    "MINDGRAPH_PROFILE=coding",
    "--env",
    "MINDGRAPH_HARNESS=claude-code",
    "--env",
    // The registration, the hooks, and the serve path must all resolve the
    // SAME identity — a differing default here made the model's fenced tool
    // calls and the hook's lease two different agents on the server.
    `MINDGRAPH_AGENT_ID=${
      agentId ||
      process.env.MINDGRAPH_AGENT_ID ||
      loadHookEnv().agentId ||
      stableAgentId()
    }`,
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
  // This directory's consent state comes first: it decides whether anything
  // below does work here.
  for (const line of consentStatusLines(process.cwd())) console.log(line);
  const gateWarning = (() => {
    try {
      return gateFloorWarning();
    } catch {
      return undefined;
    }
  })();
  if (gateWarning) console.log(`Hook runner: ${gateWarning}`);
  console.log("");

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

  // Hook health — the one observable trace of fail-open hook failures.
  try {
    const healthFile = path.join(
      mindgraphRuntimeDir(),
      "hook-health.json",
    );
    if (fs.existsSync(healthFile)) {
      const health = JSON.parse(fs.readFileSync(healthFile, "utf8"));
      const failures = Number(health.consecutiveFailures) || 0;
      console.log(
        failures > 0
          ? `Hooks: FAILING (${failures} consecutive; last: ${health.lastError} at ${health.lastFailureAt})`
          : `Hooks: healthy (last recovery ${health.lastOkAt || "unknown"})`,
      );
    } else {
      console.log("Hooks: no health marker (no hook failures recorded)");
    }
  } catch {
    console.log("Hooks: health marker unreadable");
  }
}

function withHooksFlag(): boolean {
  // Only the non-interactive `install-code` path reads --hooks; the
  // interactive init flow always gets the tip (prompting mid-flow would
  // complicate scripted use of init's stdin).
  return process.argv.includes("--hooks");
}

/** Optional Claude hook features: explicit flags win, then the stored
 * choice in ~/.mindgraph/hooks.json, then the defaults (both off). Per-prompt
 * recall is opt-in: in a replay of 59 real prompts, 0-4% of the items it
 * injected were relevant, so a plain install or re-install leaves it off and
 * removes an entry an earlier default added. --no-prompt-recall is still
 * accepted; it only clears a stored opt-in. */
function claudeHookFeatures(): {
  promptRecall: boolean;
  capture: boolean;
  curatorMode: "off" | "shadow" | "live";
} {
  const flags = parseArgs(process.argv);
  const stored = loadHookEnv();
  return {
    promptRecall: flags.promptRecall ?? stored.promptRecall ?? false,
    capture: flags.capture ?? stored.capture ?? false,
    curatorMode: flags.curatorMode ?? stored.curatorMode ?? "off",
  };
}

function printClaudeHookFeatures(features: {
  promptRecall: boolean;
  capture: boolean;
  curatorMode: "off" | "shadow" | "live";
}): void {
  const curatorDesc =
    features.curatorMode === "shadow"
      ? "SHADOW (dry_run=true — redacted turns sent to /curator/turn for telemetry only, no graph writes; promote with --curator-live)"
      : features.curatorMode === "live"
        ? "LIVE — redacted turns sent to /curator/turn with coding-session write throttling"
        : "off (enable shadow-first with --curator)";
  console.log(
    `Prompt recall (UserPromptSubmit): ${features.promptRecall ? "on" : "off (opt in with --prompt-recall)"}; ` +
      `transcript capture (PreCompact/SessionEnd): ${features.capture ? "ON — user and assistant text (never tool calls or tool output), secrets redacted, is sent to MindGraph /ingest/session" : "off (enable with --capture)"}; ` +
      `session curator (Stop/PreCompact/SessionEnd): ${curatorDesc}`
  );
}

/** One plain line when an install removed MindGraph's own per-prompt recall
 * entry, so a user who had it (usually from the old default) learns why it
 * went and how to get it back. Hooks from other tools on the event stay. */
function printRemovedPromptRecall(result: InstallResult): void {
  if (!result.removedEvents.includes("UserPromptSubmit")) return;
  console.log(
    parseArgs(process.argv).promptRecall === false
      ? "Removed MindGraph's per-prompt recall hook (UserPromptSubmit)."
      : "Removed MindGraph's per-prompt recall hook (UserPromptSubmit): it is now off by default. Re-run this command with --prompt-recall to turn it back on."
  );
}

/** Most recent Claude Code transcript for a directory (Claude stores them
 * under ~/.claude/projects/<cwd with non-alphanumerics as "-">/). */
function latestTranscript(cwd: string): string | undefined {
  const dir = path.join(
    os.homedir(),
    ".claude",
    "projects",
    cwd.replace(/[^A-Za-z0-9]/g, "-")
  );
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

function finishCodeInstall(
  apiKey: string,
  baseUrl: string | undefined,
  withHooks: boolean,
  agentId?: string
): void {
  if (withHooks) {
    const runner = installHookRunner(__filename, undefined, __PACKAGE_VERSION__);
    console.log(`Installed pinned hook runner at ${runner}`);
    const features = claudeHookFeatures();
    const result = installClaudeHooks("user", undefined, features);
    console.log(
      `Installed ${result.added} and refreshed ${result.updated} MindGraph Claude Code hook entries in ${result.path}`
    );
    printClaudeHookFeatures(features);
    printRemovedPromptRecall(result);
    const envPath = saveHookEnv({
      apiKey,
      baseUrl,
      ...features,
      // Default the stable per-user identity only when nothing is stored —
      // an explicit or previously persisted agentId must survive reinstalls.
      agentId:
        agentId ||
        process.env.MINDGRAPH_AGENT_ID ||
        loadHookEnv().agentId ||
        stableAgentId(),
      // The org pin follows the install environment exactly: installing
      // without MINDGRAPH_ORG_ID clears any stale pin (null = clear).
      orgId: process.env.MINDGRAPH_ORG_ID ?? null,
    });
    console.log(`Saved hook connection settings to ${envPath} (mode 600)`);
  } else {
    console.log(
      "Tip: run with --hooks (or run install-hooks) to add the Claude Code " +
        "session hooks — work-brief injection, provenance, reflection checkpoint."
    );
  }
  printCodegraphStatus();
  console.log(INSTALL_CONSENT_LINE);
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
  mindgraph-mcp init             Interactive setup (Claude Desktop, Claude Code or both)
  mindgraph-mcp install          Install into Claude Desktop config
  mindgraph-mcp install-code     Install into Claude Code (--hooks: + session hooks)
  mindgraph-mcp uninstall        Remove from Claude Desktop config
  mindgraph-mcp uninstall-code   Remove from Claude Code
  mindgraph-mcp install-cursor   Install the local server (coding profile) into
                                 ~/.cursor/mcp.json
  mindgraph-mcp uninstall-cursor Remove from ~/.cursor/mcp.json
  mindgraph-mcp install-hooks --harness claude-code|codex [--scope user|project]
  mindgraph-mcp uninstall-hooks --harness claude-code|codex [--scope user|project]
  mindgraph-mcp hooks preview [transcript_path] [--session-id <id>]
                                 Print exactly what transcript capture would
                                 send (POST /ingest/session); sends nothing.
  mindgraph-mcp hooks stats [--session-id <id>]
                                 Per-event hook calls, time and characters
                                 injected for a session (latest by default).
  mindgraph-mcp hooks scope [--session-id <id>]
                                 Check that every memory item the hooks
                                 injected came from that place's own memory
                                 space and none was named at an edited file
                                 after the session replaced it; exits 1 if
                                 not (prompt-recall items whose space the
                                 server did not report count as unchecked).
  mindgraph-mcp desktop setup|remember|recall|resume|disconnect|status|dashboard|widgets|shell-daemon
                                 Desktop launcher, status, widgets, daemon, handoff, and disconnect
  mindgraph-mcp desktop install-menu|uninstall-menu
                                 Manage Omarchy menu entries for this user
  mindgraph-mcp on [path] [--space <uid>]
                                 Turn MindGraph on. --space pins a standalone repository
                                 (asks first; run it in your own terminal)
  mindgraph-mcp off [path]       Turn MindGraph off for a repository or workspace
  mindgraph-mcp off --all [--dry-run]
                                 Turn MindGraph off everywhere and remove its
                                 local files from repositories you never turned
                                 on (asks first; run it in your own terminal)
  mindgraph-mcp import notes [path] [--include-user] [--dry-run]
                                 Copy Claude Code's auto-memory notes for a
                                 place you turned on into its MindGraph memory,
                                 one item per note (asks first; run it in your
                                 own terminal). --dry-run lists what would be
                                 sent and sends nothing.
  mindgraph-mcp status           Show this directory's consent state and the
                                 installation status
  mindgraph-mcp skills pull [--dir .claude/skills]
                                 Write your org's published+granted skills as
                                 SKILL.md directories (allowlisted frontmatter
                                 only). Revoked/archived skills are withdrawn;
                                 local edits are never overwritten (.conflict
                                 sidecars). NOTE: coding harnesses hot-reload
                                 skill files — running sessions adopt pulled
                                 changes immediately; session pinning exists
                                 on the managed-agent leg only.
  mindgraph-mcp skills push <path>
                                 Import a SKILL.md directory as a review
                                 candidate (nothing auto-publishes). A
                                 previously pulled directory routes to the
                                 candidate-only update path.

OPTIONS:
  --api-key <key>     MindGraph API key (or set MINDGRAPH_API_KEY env var)
  --base-url <url>    Custom API base URL (default: https://api.mindgraph.cloud)
  --scope <scope>     Hook settings scope: project (default) or user
  --project-dir <dir> Project root for project-scoped hooks
  --harness <name>    Hook harness (claude-code or codex)
  --prompt-recall     Claude hooks: add per-prompt recall (UserPromptSubmit;
                      off by default; --no-prompt-recall turns it back off)
  --capture           Claude hooks: send user/assistant text to MindGraph
                      before compaction and at session end (off by default;
                      --no-capture turns it back off)
  --help, -h          Show this help message

EXAMPLES:
  # Interactive setup
  npx mindgraph-mcp init

  # Install with API key
  npx mindgraph-mcp install --api-key mg_your_key_here

  # Install into Claude Code
  npx mindgraph-mcp install-code --api-key mg_your_key_here

Get your API key at: https://mindgraph.cloud/dashboard/settings/api-keys
No install needed for chat apps: add the hosted connector https://mindgraph.cloud/mcp
(steps: https://mindgraph.cloud/docs/mcp#connect-an-app)
`);
}


/** Print an evaluation-run refusal and exit 1; nothing when undefined. */
function exitOnEvalRefusal(refusal: string | undefined): void {
  if (!refusal) return;
  console.error(`Error: ${refusal}`);
  process.exit(1);
}

/** What registering MindGraph in Claude Code (and installing its user-scope
 * hooks) needs in an evaluation run: the trial's own MINDGRAPH_HOME and
 * CLAUDE_CONFIG_DIR. */
function evalClaudeCodeInstallRefusal(): string | undefined {
  return evalHomeRefusal() ?? evalUserScopeRefusal("claude-code", "user");
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
      "\nEnter your MindGraph API key (from mindgraph.cloud/dashboard/settings/api-keys): "
    );
    if (!apiKey || !apiKey.startsWith("mg_")) {
      console.error('Invalid API key. Keys start with "mg_".');
      rl.close();
      process.exit(1);
    }
  } else {
    // Browser auth flow. An evaluation run signs in nowhere but loopback.
    try {
      apiKey = await browserSignIn(console.log, process.env.MINDGRAPH_DASHBOARD_URL || "https://mindgraph.cloud", process.env);
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

  // An evaluation run never writes Claude Desktop's configuration, and writes
  // Claude Code's only in the trial's own directories.
  const target = choice.trim();
  if (target === "1" || target === "3") {
    exitOnEvalRefusal(evalAppConfigRefusal("Claude Desktop"));
  }
  if (target === "2" || target === "3") {
    exitOnEvalRefusal(evalClaudeCodeInstallRefusal());
  }

  switch (target) {
    case "1":
      installClaudeDesktop(apiKey, baseUrl);
      break;
    case "2":
      installClaudeCode(apiKey, baseUrl, process.env.MINDGRAPH_AGENT_ID);
      finishCodeInstall(
        apiKey,
        baseUrl,
        withHooksFlag(),
        process.env.MINDGRAPH_AGENT_ID
      );
      break;
    case "3":
      installClaudeDesktop(apiKey, baseUrl);
      installClaudeCode(apiKey, baseUrl, process.env.MINDGRAPH_AGENT_ID);
      finishCodeInstall(
        apiKey,
        baseUrl,
        withHooksFlag(),
        process.env.MINDGRAPH_AGENT_ID
      );
      break;
    default:
      console.error("Invalid choice.");
      process.exit(1);
  }

  console.log("\nDone! Your knowledge graph is now connected.");
}

async function main(): Promise<void> {
  const {
    command,
    apiKey,
    baseUrl,
    scope,
    projectDir,
    harness,
    hooks,
    agentId,
    positionals,
    spaceUid,
    dir,
  } = parseArgs(process.argv);

  if (spaceUid && command !== "on") throw new Error("--space is supported by on only.");
  switch (command) {
    case "desktop": {
      const io = desktopTerminal();
      const args = process.argv.slice(3);
      io.refreshRunner = () => refreshRunnerForConsent(__PACKAGE_VERSION__, __filename);
      const fromMenu = args.at(-1) === "--from-menu";
      if (fromMenu) args.pop();
      try {
        if (fromMenu && args.length === 1 && args[0] === "welcome") {
          await runDesktop(["install-menu"], io);
          args[0] = "setup";
        }
        await runDesktop(args, io);
      } catch (error) {
        if (!fromMenu) throw error;
        console.error(printable(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      } finally {
        if (fromMenu && io.stdin.isTTY) await io.ask("Press Enter to close. ");
      }
      break;
    }
    case "skills": {
      if (!apiKey) {
        console.error(
          "API key required. Use --api-key or set MINDGRAPH_API_KEY."
        );
        process.exit(1);
      }
      const sub = positionals[0];
      const skillsBaseUrl = baseUrl ?? "https://api.mindgraph.cloud";
      const skillsRefusal = evalBaseUrlRefusal(skillsBaseUrl);
      if (skillsRefusal) {
        console.error(`Error: ${skillsRefusal}`);
        process.exit(1);
      }
      const api = httpSkillsApi(
        skillsBaseUrl,
        apiKey,
        agentId
      );
      if (sub === "pull") {
        if (!agentId) {
          console.error(
            "note: no --agent-id/MINDGRAPH_AGENT_ID — pulling ALL published " +
              "skills; bind an agent identity to scope the set by its grants."
          );
        }
        const report = await skillsPull(api, dir ?? ".claude/skills", agentId);
        for (const name of report.written) console.log(`  written    ${name}`);
        for (const name of report.unchanged)
          console.log(`  unchanged  ${name}`);
        for (const name of report.locallyEdited)
          console.log(`  local-edit ${name} — upstream unchanged; left alone`);
        for (const name of report.conflicts)
          console.log(
            `  CONFLICT   ${name} — local edits kept; new upstream saved as SKILL.md.conflict`
          );
        for (const removal of report.removed)
          console.log(
            `  withdrawn  ${removal.name}${
              removal.kept ? " (local edits kept as SKILL.md.conflict)" : ""
            }${removal.statusReason ? ` — ${removal.statusReason}` : ""}`
          );
        for (const refusal of report.refused)
          console.log(`  REFUSED    ${refusal.name} — ${refusal.reason}`);
        const total =
          report.written.length +
          report.unchanged.length +
          report.locallyEdited.length +
          report.conflicts.length;
        console.log(`\n${total} skill(s) synced.`);
      } else if (sub === "push") {
        const target = positionals[1];
        if (!target) {
          console.error("Usage: mindgraph-mcp skills push <path>");
          process.exit(1);
        }
        const report = await skillsPush(api, target);
        console.log(report.message);
        if (report.existingUid) {
          console.log(
            `  existing skill: ${report.existingUid}${
              report.existingStatus ? ` (${report.existingStatus})` : ""
            }`
          );
        }
        if (report.outcome === "error" || report.outcome === "conflict") {
          process.exit(1);
        }
      } else {
        console.error("Usage: mindgraph-mcp skills pull|push [...]");
        process.exit(1);
      }
      break;
    }

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
      exitOnEvalRefusal(evalAppConfigRefusal("Claude Desktop"));
      installClaudeDesktop(apiKey, baseUrl);
      break;

    case "install-code":
      if (!apiKey) {
        console.error(
          "API key required. Use --api-key or set MINDGRAPH_API_KEY."
        );
        process.exit(1);
      }
      // An evaluation run registers the server and installs hooks only into
      // its own MINDGRAPH_HOME and CLAUDE_CONFIG_DIR, never the real ones.
      exitOnEvalRefusal(evalClaudeCodeInstallRefusal());
      if (withHooksFlag()) {
        try {
          assertHookConfigReadable();
        } catch (error) {
          process.exit(hookConfigFailure(error, console.error));
        }
      }
      installClaudeCode(apiKey, baseUrl, agentId);
      finishCodeInstall(apiKey, baseUrl, withHooksFlag(), agentId);
      break;

    case "install-cursor": {
      if (!apiKey) {
        console.error(
          "API key required. Use --api-key or set MINDGRAPH_API_KEY."
        );
        process.exit(1);
      }
      exitOnEvalRefusal(evalAppConfigRefusal("Cursor"));
      // Same identity the hooks and the Claude Code registration resolve, so
      // work claimed in one harness is recognised in the other.
      const result = installCursor({
        apiKey,
        baseUrl,
        agentId:
          agentId ||
          process.env.MINDGRAPH_AGENT_ID ||
          loadHookEnv().agentId ||
          stableAgentId(),
      });
      console.log(
        `${result.updated ? "Updated" : "Added"} MindGraph (coding profile) in ${result.file}.`
      );
      console.log(
        "Open Cursor Settings › MCP to confirm the server is enabled."
      );
      console.log(INSTALL_CONSENT_LINE);
      break;
    }

    case "uninstall-cursor":
      exitOnEvalRefusal(evalAppConfigRefusal("Cursor"));
      console.log(
        uninstallCursor()
          ? "Removed MindGraph from ~/.cursor/mcp.json."
          : "MindGraph not found in ~/.cursor/mcp.json."
      );
      break;

    case "uninstall":
      exitOnEvalRefusal(evalAppConfigRefusal("Claude Desktop"));
      uninstallClaudeDesktop();
      break;

    case "uninstall-code":
      // `claude mcp remove` rewrites Claude Code's user configuration.
      exitOnEvalRefusal(evalUserScopeRefusal("claude-code", "user"));
      uninstallClaudeCode();
      break;

    case "install-hooks": {
      const hookHarness = harness || "claude-code";
      if (hookHarness !== "claude-code" && hookHarness !== "codex") {
        throw new Error("--harness must be claude-code or codex");
      }
      // An evaluation run installs only into its own MINDGRAPH_HOME and, for
      // user scope, its own harness configuration directory; it stops before
      // reading anything else.
      const evalRefusal = evalHomeRefusal() ?? evalUserScopeRefusal(hookHarness, scope);
      if (evalRefusal) {
        console.error(`Error: ${evalRefusal}`);
        process.exit(1);
      }
      // Stop before installing anything when hooks.json cannot be updated.
      try {
        assertHookConfigReadable();
      } catch (error) {
        process.exit(hookConfigFailure(error, console.error));
      }
      // Project settings are committed, so their hooks reach the runner through
      // $HOME. Under MINDGRAPH_HOME the runner is elsewhere and those hooks
      // would not find it: install them user-level instead.
      const movedRunner = overrideRunner();
      if (scope === "project" && movedRunner && !evalMode()) {
        console.error(
          `Error: MINDGRAPH_HOME is set, so the hook runner is installed at ${movedRunner}. ` +
            "Project settings are shared through git and must not name a path on this machine, " +
            "and their portable form looks for the runner under $HOME/.mindgraph. " +
            "Run install-hooks --scope user, or unset MINDGRAPH_HOME. Nothing was installed."
        );
        process.exit(1);
      }
      const runner = installHookRunner(__filename, undefined, __PACKAGE_VERSION__);
      console.log(`Installed pinned hook runner at ${runner}`);
      // Entries written before MINDGRAPH_HOME moved the runner (and committed
      // project settings) still run the one under $HOME: one that ignores
      // consent is brought up to this version too.
      const portable = refreshPortableRunnerBelowGate(__filename, __PACKAGE_VERSION__);
      if (portable) console.log(`Updated the older hook runner at ${portable} so it checks where MindGraph is on`);
      const features =
        hookHarness === "claude-code" ? claudeHookFeatures() : undefined;
      const result =
        hookHarness === "codex"
          ? installCodexHooks(scope, projectDir)
          : installClaudeHooks(scope, projectDir, features);
      console.log(
        `Installed ${result.added} and refreshed ${result.updated} MindGraph ${hookHarness === "codex" ? "Codex" : "Claude Code"} hook entries in ${result.path}`
      );
      if (features) {
        printClaudeHookFeatures(features);
        printRemovedPromptRecall(result);
      }
      printCodegraphStatus();
      // Hooks run with the harness's environment, which rarely carries the
      // MindGraph connection settings — persist them user-level (0600; never
      // into project settings, which get committed).
      // Always persist: the stable agent identity and org pin must reach the
      // hook runtime even when key/url ride the environment. saveHookEnv
      // merges, so existing stored values are never clobbered by undefined.
      const envPath = saveHookEnv({
        apiKey,
        baseUrl,
        ...(features || {}),
        // Default the stable per-user identity only when nothing is stored —
        // an explicit or previously persisted agentId must survive
        // reinstalls.
        agentId:
          agentId ||
          process.env.MINDGRAPH_AGENT_ID ||
          loadHookEnv().agentId ||
          stableAgentId(),
        // The org pin follows the install environment exactly: installing
        // without MINDGRAPH_ORG_ID clears any stale pin (null = clear).
        orgId: process.env.MINDGRAPH_ORG_ID ?? null,
      });
      console.log(`Saved hook connection settings to ${envPath} (mode 600)`);
      if (!apiKey && !baseUrl) {
        console.log(
          "Note: hooks read the API key and base URL only from " +
            `${envPath} — pass --api-key/--base-url ` +
            "to save them now."
        );
      }
      console.log(INSTALL_CONSENT_LINE);
      break;
    }

    case "uninstall-hooks": {
      const hookHarness = harness || "claude-code";
      if (hookHarness !== "claude-code" && hookHarness !== "codex") {
        throw new Error("--harness must be claude-code or codex");
      }
      // An evaluation run removes user-scope entries only from the trial's own
      // configuration directory, never the person's real settings.
      exitOnEvalRefusal(evalUserScopeRefusal(hookHarness, scope));
      // The pinned runner is shared by all harness adapters. Leave it in place
      // when removing one hook configuration; deleting it would break hooks
      // installed for the other harness (or a project outside this cwd).
      const result =
        hookHarness === "codex"
          ? uninstallCodexHooks(scope, projectDir)
          : uninstallClaudeHooks(scope, projectDir);
      console.log(
        `Removed ${result.removed} MindGraph ${hookHarness === "codex" ? "Codex" : "Claude Code"} hooks from ${result.path}`
      );
      break;
    }

    case "hook": {
      // Command hooks must fail open: nothing here may block the harness.
      const hookHarness = harness || "claude-code";
      if (hookHarness !== "claude-code" && hookHarness !== "codex") {
        throw new Error("--harness must be claude-code or codex");
      }
      const wire = hookHarness === "codex" ? codexHookOutput : claudeHookOutput;
      let input: HookInput;
      try {
        input = await readHookInput();
      } catch (error) {
        recordHookHealth(hookHarness, (error as Error)?.message || "unreadable hook input");
        process.stdout.write("{}\n");
        break;
      }
      // An evaluation run without its own MINDGRAPH_HOME stops before consent
      // or hooks.json is read: falling back to the real ~/.mindgraph would run
      // the trial on the person's own settings. The runtime directory would be
      // the real one too, so the refusal is recorded only where
      // MINDGRAPH_RUNTIME_DIR names one; it is always on stderr.
      const homeRefusal = evalHomeRefusal();
      if (homeRefusal) {
        if (process.env.MINDGRAPH_RUNTIME_DIR) {
          recordHookHealth(hookHarness, homeRefusal);
          recordFailOpen(input.session_id, input.hook_event_name, EVAL_REQUIRES_HOME, {
            harness: hookHarness,
          });
        }
        console.error(`mindgraph-hook: ${homeRefusal}`);
        process.stdout.write("{}\n");
        break;
      }
      // MindGraph acts only in a directory the user turned it on for. Outside
      // one, the hook checks no key, writes no file and builds no client.
      const decision = sessionConsent(eventDirectory(input));
      if (decision.state !== "on") {
        process.stdout.write(`${JSON.stringify(wire(offOutput(input, decision)))}\n`);
        break;
      }
      // The destination comes only from hooks.json, which the user's own
      // install wrote; the hook environment cannot redirect it.
      const stored = loadHookEnv();
      const hookApiKey = stored.apiKey;
      const hookBaseUrl = stored.baseUrl || "https://api.mindgraph.cloud";
      // An evaluation run talks only to a loopback server: no client is
      // built, and the refusal is counted like any other fail-open.
      const evalRefusal = evalBaseUrlRefusal(hookBaseUrl);
      if (evalRefusal) {
        recordHookHealth(hookHarness, evalRefusal);
        recordFailOpen(input.session_id, input.hook_event_name, EVAL_REQUIRES_LOOPBACK, {
          harness: hookHarness,
        });
        console.error(`mindgraph-hook: ${evalRefusal}`);
        process.stdout.write("{}\n");
        break;
      }
      if (!hookApiKey && !isLoopbackUrl(hookBaseUrl)) {
        recordHookHealth(hookHarness, "no-api-key");
        process.stdout.write("{}\n");
        break;
      }
      try {
        const client = new MindGraph({
          baseUrl: hookBaseUrl,
          apiKey: hookApiKey,
          // The org pin is stored beside the key, so hooks and the MCP tools
          // write to the same organization on a multi-org key.
          orgId: stored.orgId,
          maxRetries: 0,
          telemetrySurface: "mcp",
          // Prompt recall and Stop curator must never hold the hook past its deadline.
          ...(input.hook_event_name === "UserPromptSubmit"
            ? { timeoutMs: 4_000 }
            : input.hook_event_name === "Stop"
              ? { timeoutMs: 3_000 }
              : {}),
        });
        const features = resolvedHookFeatures(stored);
        const hookOptions = {
          consent: decision,
          // Recall runs only for an explicit opt-in: a UserPromptSubmit entry
          // left in a settings file no install has refreshed does nothing.
          promptRecall: features.promptRecall,
          capture: features.capture,
          curatorMode: features.curatorMode,
          // No harness-name fallback here: hook-core derives a stable
          // per-user default shared by both harnesses, which is what lets a
          // task claimed under Codex rebind under Claude Code.
          agentId: process.env.MINDGRAPH_AGENT_ID || stored.agentId,
          scopeCacheTenant: crypto.createHash("sha256")
            .update([hookBaseUrl, hookApiKey, stored.orgId || ""].join("\n"))
            .digest("hex")
            .slice(0, 16),
        };
        const output =
          hookHarness === "codex"
            ? await runCodexHook(input, client as unknown as HookClient, hookOptions)
            : await runClaudeHook(input, client as unknown as HookClient, hookOptions);
        clearHookHealth(hookHarness);
        process.stdout.write(`${JSON.stringify(output)}\n`, () => {
          // A recall that hit its deadline can leave a socket open that keeps
          // the process alive past the 5s hook budget; the answer is already
          // written, so exit instead of waiting for it.
          // The same holds for the session block's bounded memory read.
          if (
            input.hook_event_name === "UserPromptSubmit" ||
            input.hook_event_name === "SessionStart" ||
            input.hook_event_name === "Stop" ||
            (features.curatorMode !== "off" &&
              (input.hook_event_name === "PreCompact" || input.hook_event_name === "SessionEnd"))
          ) {
            process.exit(0);
          }
        });
      } catch (error) {
        // Still fail open — but not silently. The marker file plus one
        // stderr line are the ONLY observable difference between "hooks are
        // healthy" and "continuity has been off for a week because the key
        // was revoked".
        recordHookHealth(
          hookHarness,
          (error as Error)?.message || "hook failed",
        );
        recordFailOpen(input.session_id, input.hook_event_name, (error as Error)?.message || "hook failed", {
          harness: hookHarness,
        });
        console.error(
          `mindgraph-hook: failing open (${(error as Error)?.message || "unknown error"})`,
        );
        process.stdout.write("{}\n", () => {
          // A request still in flight must not hold the session open.
          if (input.hook_event_name === "SessionStart") process.exit(0);
        });
      }
      break;
    }

    case "hooks": {
      if (positionals[0] === "stats" || positionals[0] === "scope") {
        const stats = readHookStats(parseArgs(process.argv).sessionId);
        if (!stats) {
          console.error(
            "No hook statistics recorded yet. They are kept per session once the hooks from this version have run."
          );
          process.exit(1);
        }
        if (positionals[0] === "scope") {
          console.log(`Session ${stats.sessionId}. ${formatScope(stats.scope)}`);
          if (stats.scope.problems.length) process.exit(1);
          break;
        }
        console.log(formatHookStats(stats));
        break;
      }
      if (positionals[0] !== "preview") {
        console.error(
          "Usage: mindgraph-mcp hooks preview [transcript_path] [--session-id <id>]\n       mindgraph-mcp hooks stats|scope [--session-id <id>]"
        );
        process.exit(1);
      }
      const transcript = positionals[1] || latestTranscript(process.cwd());
      if (!transcript || !fs.existsSync(transcript)) {
        console.error(
          "No transcript found. Pass a Claude Code transcript path (~/.claude/projects/<dir>/<session>.jsonl)."
        );
        process.exit(1);
      }
      const sessionId =
        parseArgs(process.argv).sessionId || path.basename(transcript, ".jsonl");
      const preview = previewCapture(transcript, sessionId, {
        agentId: process.env.MINDGRAPH_AGENT_ID || loadHookEnv().agentId,
      });
      const enabled = loadHookEnv().capture === true;
      console.error(
        `Transcript: ${transcript}\nSession: ${sessionId}\nCapture is ${enabled ? "ON" : "OFF (nothing is sent; enable with install-hooks --capture)"}\n` +
          `Would send ${preview.turns} turn(s) from byte ${preview.offset} as POST /ingest/session (nothing sent by this preview):`
      );
      process.stdout.write(
        `${JSON.stringify(preview.body ?? null, null, 2)}\n`
      );
      break;
    }

    case "status":
      printStatus();
      break;

    case "on":
    case "off": {
      const flags = process.argv.slice(3);
      const all = command === "off" && flags.includes("--all");
      const dryRun = flags.includes("--dry-run");
      if (dryRun && !all) {
        console.error("--dry-run works only with: npx -y mindgraph-mcp@latest off --all --dry-run");
        process.exit(1);
      }
      if (all && positionals.length > 0) {
        console.error("Usage: npx -y mindgraph-mcp@latest off --all [--dry-run]");
        process.exit(1);
      }
      if (positionals.length > 1) {
        console.error(`Usage: npx -y mindgraph-mcp@latest ${command} [path]`);
        process.exit(1);
      }
      const io = nodeConsentIo(__PACKAGE_VERSION__, __filename);
      let code: number;
      try {
        code =
          command === "on"
            ? await runOn(positionals[0], io, spaceUid)
            : all
              ? await runOffAll(io, { dryRun })
              : await runOff(positionals[0], io);
      } catch (error) {
        code = hookConfigFailure(error, console.error);
      } finally {
        io.close();
      }
      process.exit(code);
    }

    case "import": {
      const flags = process.argv.slice(3).filter((arg) => arg.startsWith("-"));
      const unknown = flags.filter((f) => f !== "--dry-run" && f !== "--include-user");
      if (positionals[0] !== "notes" || positionals.length > 2 || unknown.length > 0) {
        console.error("Usage: npx -y mindgraph-mcp@latest import notes [path] [--include-user] [--dry-run]");
        process.exit(1);
      }
      const io = nodeConsentIo(__PACKAGE_VERSION__);
      let code: number;
      try {
        code = await runImportNotes(positionals[1], io, {
          dryRun: flags.includes("--dry-run"),
          includeUser: flags.includes("--include-user"),
        });
      } catch (error) {
        code = hookConfigFailure(error, console.error);
      } finally {
        io.close();
      }
      process.exit(code);
    }

    case "desktop-agent": {
      if (positionals.length !== 1 || !["claude-code", "codex"].includes(positionals[0])) throw new Error("Choose a supported desktop coding harness.");
      exitOnEvalRefusal(evalHomeRefusal());
      if (loadConsentStore().status !== "ok") throw new Error("Connect your desktop to MindGraph from the Omarchy menu first.");
      const stored = loadHookEnv();
      const url = stored.baseUrl || "https://api.mindgraph.cloud";
      exitOnEvalRefusal(evalBaseUrlRefusal(url));
      process.env.MINDGRAPH_BASE_URL = url;
      process.env.MINDGRAPH_API_KEY = stored.apiKey || "";
      process.env.MINDGRAPH_PROFILE = "coding";
      process.env.MINDGRAPH_HARNESS = positionals[0];
      process.env.MINDGRAPH_AGENT_ID = stored.agentId || stableAgentId();
      if (stored.orgId) process.env.MINDGRAPH_ORG_ID = stored.orgId;
      else delete process.env.MINDGRAPH_ORG_ID;
      await import("./index.js");
      break;
    }
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
