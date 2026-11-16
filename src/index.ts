import { resolvePendingCall } from "./call-ledger.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MindGraph } from "mindgraph";
import { loadHookEnv, stableAgentId } from "./hook-env.js";
import { buildMindGraphServer } from "./server.js";
import { buildInstructions } from "./instructions.js";
import { resolveRepositoryScope, type ScopeClient } from "./workspace-scope.js";
import path from "node:path";
import {
  refreshHookRunner,
  refreshOwnedClaudeHooks,
  versionSkewNote,
} from "./hook-installer.js";

declare const __PACKAGE_VERSION__: string;

// ── Configuration ─────────────────────────────────────────────────────

const API_KEY = process.env.MINDGRAPH_API_KEY;
const BASE_URL =
  process.env.MINDGRAPH_BASE_URL || "https://api.mindgraph.cloud";
// Must resolve to the SAME identity as the hooks (hook-env resolution): the
// hooks claim/heartbeat leases under this id, and every tool call carries it
// as agent_id. Two different defaults meant the model's fenced writes fought
// the hook's lease on the server — an unwinnable 409 ping-pong.
const AGENT_ID =
  process.env.MINDGRAPH_AGENT_ID || loadHookEnv().agentId || stableAgentId();
const ORG_ID = process.env.MINDGRAPH_ORG_ID;
const PROFILE = process.env.MINDGRAPH_PROFILE || "general";
const HARNESS = process.env.MINDGRAPH_HARNESS || "generic";

if (!API_KEY) {
  console.error(
    "Error: MINDGRAPH_API_KEY environment variable is required.\n" +
      "Get your API key at https://mindgraph.cloud/dashboard/settings/api-keys\n" +
      "(or skip the key: add the hosted connector https://mindgraph.cloud/mcp to your app)\n" +
      "Or run: npx mindgraph-mcp init"
  );
  process.exit(1);
}

// ── MindGraph Client ──────────────────────────────────────────────────

const client = new MindGraph({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  orgId: ORG_ID,
  // Available in the companion mindgraph SDK from the D6 telemetry batch.
  // Cast keeps this repository buildable during the cross-package release
  // window where npm may still resolve the preceding SDK declaration file.
  telemetrySurface: "mcp",
} as ConstructorParameters<typeof MindGraph>[0] & { telemetrySurface: "mcp" });

// ── Server Instructions ───────────────────────────────────────────────

// Built from named sections in instructions.ts; test/instructions.test.ts
// holds every profile and harness under Claude Code's 4,096-character cut.
let INSTRUCTIONS = buildInstructions(PROFILE, HARNESS);

// Self-heal the pinned hook runner: the registration floats on `npx
// @latest`, so the freshest code in the system is this server — let it
// refresh the runner (and the owned hook entries' timeout budgets) instead
// of asking every machine to re-run install-hooks after each release. The
// bundled cli.js ships as a sibling of this file; in dev/test there is no
// sibling bundle and the refresh is a no-op.
const RUNNER_REFRESH = (() => {
  try {
    return refreshHookRunner(__PACKAGE_VERSION__, path.join(__dirname, "cli.js"));
  } catch {
    return undefined;
  }
})();
if (RUNNER_REFRESH?.refreshed) {
  const refreshedSettings = (() => {
    try {
      return refreshOwnedClaudeHooks();
    } catch {
      return [] as string[];
    }
  })();
  console.error(
    `[mindgraph-mcp] refreshed pinned hook runner ` +
      `${RUNNER_REFRESH.runnerVersion ? `v${RUNNER_REFRESH.runnerVersion}` : "(pre-sidecar)"}` +
      ` → v${__PACKAGE_VERSION__}` +
      (refreshedSettings.length > 0
        ? `; refreshed owned hook entries in ${refreshedSettings.join(", ")}`
        : ""),
  );
}

// Hook/server version skew: after a successful refresh the sidecar matches
// and this stays silent; it fires only when the self-heal was opted out,
// guarded (downgrade), or failed — a 0.14-era runner silently served
// 0.17-era sessions for two weeks before these checks existed.
const HOOK_SKEW_NOTE = (() => {
  try {
    return versionSkewNote(__PACKAGE_VERSION__);
  } catch {
    return undefined;
  }
})();
if (HOOK_SKEW_NOTE) {
  INSTRUCTIONS += `\n\n${HOOK_SKEW_NOTE}`;
  console.error(`[mindgraph-mcp] ${HOOK_SKEW_NOTE}`);
}

// ── MCP Server ────────────────────────────────────────────────────────

const GOVERNANCE_CONFIG = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  get disabled() {
    return process.env.MINDGRAPH_GOVERNANCE === "off";
  },
};

const MEMORY_RUNTIME_CONFIG = {
  serverVersion: __PACKAGE_VERSION__,
  baseUrl: BASE_URL,
  profile: PROFILE,
  harness: HARNESS,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  resolveWorkspaceScope: (agentId: string) =>
    resolveRepositoryScope(
      process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      client as unknown as ScopeClient,
      agentId,
    ),
};

// Tools, prompts and resources are wired in server.ts, shared with the hosted
// mode; this entry only supplies what it reads from the environment.
// A factory, not an instance: the stdio entry pins one server per connection
// to the era the client opens with (2026-07-28 envelope, or the 2025
// `initialize` handshake), and may build a discarded probe instance first.
const buildServer = () => buildMindGraphServer({
  client,
  serverVersion: __PACKAGE_VERSION__,
  instructions: INSTRUCTIONS,
  profile: PROFILE,
  agentId: AGENT_ID,
  governance: GOVERNANCE_CONFIG,
  memory: MEMORY_RUNTIME_CONFIG,
  resolveHookFields: (name, args) => resolvePendingCall(name, args),
});

// ── Start ─────────────────────────────────────────────────────────────

async function main() {
  serveStdio(buildServer, {
    onerror: (error) => console.error("MindGraph MCP transport error:", error.message),
  });
  console.error(
    `MindGraph MCP server v${__PACKAGE_VERSION__} running on stdio (${BASE_URL})`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
