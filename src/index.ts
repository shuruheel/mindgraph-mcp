import { resolvePendingCall } from "./call-ledger.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MindGraph } from "mindgraph";
import { homeIsAccountHome, loadHookEnv, stableAgentId } from "./hook-env.js";
import { buildMindGraphServer } from "./server.js";
import { buildInstructions, CONSENT_OFF_INSTRUCTION } from "./instructions.js";
import { resolveRepositoryScope, type ScopeClient } from "./workspace-scope.js";
import path from "node:path";
import {
  gateFloorWarning,
  refreshHookRunner,
  refreshOwnedClaudeHooks,
  runnerPredatesGate,
  runnerRefreshScopes,
  versionSkewNote,
} from "./hook-installer.js";
import { consentFor, type ConsentDecision } from "./consent.js";
import { notOptedIn, otherRoot, type ConsentCheck } from "./consent-refusal.js";
import { evalBaseUrlRefusal, evalHomeRefusal, evalMode } from "./eval-guard.js";

declare const __PACKAGE_VERSION__: string;

// ── Configuration ─────────────────────────────────────────────────────

const API_KEY = process.env.MINDGRAPH_API_KEY;
const BASE_URL =
  process.env.MINDGRAPH_BASE_URL || "https://api.mindgraph.cloud";

// An evaluation run (MINDGRAPH_EVAL=1) talks only to a loopback server and
// keeps its state in its own MINDGRAPH_HOME. The server exits here, before
// hooks.json is read or any client exists, so nothing is read from the real
// ~/.mindgraph, no request is made, and the host lists this server as failed.
const EVAL_REFUSAL = evalHomeRefusal() ?? evalBaseUrlRefusal(BASE_URL);
if (EVAL_REFUSAL) {
  console.error(`Error: ${EVAL_REFUSAL}`);
  process.exit(1);
}
// Must resolve to the SAME identity as the hooks (hook-env resolution): the
// hooks claim/heartbeat leases under this id, and every tool call carries it
// as agent_id. Two different defaults meant the model's fenced writes fought
// the hook's lease on the server — an unwinnable 409 ping-pong.
const AGENT_ID =
  process.env.MINDGRAPH_AGENT_ID || loadHookEnv().agentId || stableAgentId();
const ORG_ID = process.env.MINDGRAPH_ORG_ID;
const PROFILE = process.env.MINDGRAPH_PROFILE || "general";
const HARNESS = process.env.MINDGRAPH_HARNESS || "generic";
// The coding profile reads the checkout and runs on the user's repositories,
// so it works only where the user turned MindGraph on. The general profile
// is not gated.
const GATED = PROFILE === "coding";

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

// The session directory is where the host started this server.
const sessionDecision = (): ConsentDecision => consentFor(process.cwd());
const START_DECISION = GATED ? sessionDecision() : undefined;
if (GATED && START_DECISION?.state !== "on") {
  INSTRUCTIONS += `\n\n${CONSENT_OFF_INSTRUCTION}`;
}

/** Asked on every request: `on` and `off` can run mid-session. */
const consentGate = GATED
  ? (callCwd?: unknown): ConsentCheck => {
      const session = sessionDecision();
      if (session.state !== "on") {
        return { allowed: false, payload: notOptedIn(session, process.cwd()) };
      }
      if (callCwd === undefined) return { allowed: true, decision: session };
      const call = consentFor(callCwd);
      if (call.state !== "on") {
        // A call's directory that did not resolve is never echoed back.
        return { allowed: false, payload: notOptedIn(call) };
      }
      if (call.root !== session.root) {
        return { allowed: false, payload: otherRoot(session, call) };
      }
      return { allowed: true, decision: call };
    }
  : undefined;

// Self-heal the pinned hook runner: the registration floats on `npx
// @latest`, so the freshest code in the system is this server — let it
// refresh the runner (and the owned hook entries' timeout budgets) instead
// of asking every machine to re-run install-hooks after each release. The
// bundled cli.js ships as a sibling of this file; in dev/test there is no
// sibling bundle and the refresh is a no-op.
//
// Which entries it may rewrite is decided in runnerRefreshScopes; it never
// writes when $HOME is not the account's home directory. An evaluation run
// never self-heals: the trial's runner and settings are the ones its harness
// installed, whatever MINDGRAPH_HOOK_AUTOUPDATE says.
const INSIDE_CONSENT = START_DECISION?.state === "on";
const REFRESH_SCOPES = (() => {
  if (evalMode()) return undefined;
  try {
    return runnerRefreshScopes(
      INSIDE_CONSENT,
      !INSIDE_CONSENT && runnerPredatesGate(),
      homeIsAccountHome(),
    );
  } catch {
    return undefined;
  }
})();
const RUNNER_REFRESH = (() => {
  if (!REFRESH_SCOPES) return undefined;
  try {
    return refreshHookRunner(__PACKAGE_VERSION__, path.join(__dirname, "cli.js"));
  } catch {
    return undefined;
  }
})();
if (RUNNER_REFRESH?.refreshed && REFRESH_SCOPES) {
  const refreshedSettings = (() => {
    try {
      return refreshOwnedClaudeHooks(undefined, undefined, REFRESH_SCOPES);
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

// A runner below the consent floor that stayed (MINDGRAPH_HOOK_AUTOUPDATE=off,
// or a failed refresh) ignores consent: say so.
const GATE_WARNING = (() => {
  try {
    return gateFloorWarning();
  } catch {
    return undefined;
  }
})();
if (GATE_WARNING) console.error(`[mindgraph-mcp] ${GATE_WARNING}`);

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
  // Workspace scope is a coding-setup feature, and comes from the pinned set
  // only: no workspace file is discovered and no git runs. The general
  // profile has none.
  ...(GATED
    ? {
        resolveWorkspaceScope: async (agentId: string) => {
          const decision = sessionDecision();
          if (decision.state !== "on") {
            return { uids: [], names: {}, failures: ["MindGraph is off here"] };
          }
          return resolveRepositoryScope(
            decision.directory,
            client as unknown as ScopeClient,
            agentId,
            { repositories: decision.repositories },
          );
        },
      }
    : {}),
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
  ...(consentGate ? { consent: consentGate } : {}),
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
