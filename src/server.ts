// The MCP server wiring shared by the stdio entry (`index.ts`) and the hosted
// Streamable HTTP mode (`mindgraph-mcp/server`, spec D5/D6). This module has
// no load-time side effects: everything the handlers close over arrives in a
// `ServerWiring`, so a hosted route can build one Server per request.
import {
  createMcpHandler,
  isLegacyRequest,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { MindGraph } from "mindgraph";
import {
  createGeneratedToolsEntry,
  getGeneratedTools,
  handleGeneratedTool,
  type GeneratedToolsEntry,
} from "./generated-tools.js";
import {
  checkMcpGovernance,
  createGovernanceLatch,
  type GovernanceConfig,
  type GovernanceLatch,
} from "./governance.js";
import {
  decorateHostedTool,
  handleHostedTool,
  hostedInstructions,
  HOSTED_TOOL_NAMES,
  HOSTED_TOOLS,
  type HostedIdentity,
} from "./hosted-tools.js";
import type { MemoryRuntimeConfig } from "./memory-tool.js";
import { getPrompt, PROMPTS } from "./prompts.js";
import { RESOURCES, RESOURCE_TEMPLATES, readGovernedResource } from "./resources.js";
import { handleTool, toolsForProfile } from "./tools.js";
import type { ToolRuntime } from "./job-wait.js";

export type { GeneratedToolsEntry, GovernanceLatch };

/** Everything the request handlers close over. */
export interface ServerWiring {
  client: MindGraph;
  /** Fields a local harness hook recorded for a call (see call-ledger.ts).
   * Injected by the stdio entry so this module stays free of node:fs for the
   * hosted bundle. */
  resolveHookFields?: (
    name: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  serverVersion: string;
  instructions: string;
  profile: string;
  /** Trusted agent identity: the default in stdio mode, the only one in hosted mode. */
  agentId: string;
  governance: GovernanceConfig;
  memory: MemoryRuntimeConfig;
  /** Manifest cache; omitted → the process-wide entry (stdio). */
  generatedTools?: GeneratedToolsEntry;
  /** Present in hosted mode: adds search/fetch/whoami and the attribution rule (D4). */
  hosted?: HostedIdentity & { log?: (event: Record<string, unknown>) => void };
}

export function buildMindGraphServer(wiring: ServerWiring): Server {
  const { client, hosted } = wiring;
  const server = new Server(
    { name: "mindgraph", version: wiring.serverVersion },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: wiring.instructions,
    },
  );

  server.setRequestHandler('tools/list', async () => {
    // Static tools + per-object-type read tools generated from the active
    // ontology (never throws — empty set if the manifest endpoint is absent).
    const generated = await getGeneratedTools(client, wiring.generatedTools);
    const tools = [...toolsForProfile(wiring.profile), ...generated.tools];
    if (!hosted) return { tools };
    return {
      tools: [
        ...tools.map((tool) => decorateHostedTool(tool, generated.byName.has(tool.name))),
        ...HOSTED_TOOLS.map((tool) => decorateHostedTool(tool)),
      ],
    };
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: args } = request.params;

    const rawArgs = {
      ...((args as Record<string, unknown>) || {}),
      // H1: session, lease and invocation fields the local hook recorded for
      // this exact call (stdio only; hosted mode has no local hook).
      ...(hosted ? {} : wiring.resolveHookFields?.(name, (args as Record<string, unknown>) || {})),
    };
    // Inject default agent_id if not provided. Static tools declare agent_id;
    // generated ontology tools do not, and their schemas reject it — so the
    // injected copy is kept separate from the args they receive.
    const toolArgs = { ...rawArgs };
    let governanceConfig = wiring.governance;
    if (hosted) {
      // D4: in hosted mode the argument is model output and prompt-injectable.
      // The identity is always the signed-in member; a supplied value is kept
      // only as an untrusted label in the call metadata.
      const requested = rawArgs.agent_id;
      delete rawArgs.agent_id;
      toolArgs.agent_id = wiring.agentId;
      if (requested !== undefined) {
        governanceConfig = {
          ...governanceConfig,
          context: { ...governanceConfig.context, requested_agent_id: String(requested) },
        };
      }
      hosted.log?.({
        event: "tool_call",
        tool: name,
        agent_id: wiring.agentId,
        ...(requested !== undefined ? { requested_agent_id: String(requested) } : {}),
      });
      // whoami reads nothing from the graph; there is nothing to govern.
      if (name === "whoami") return handleHostedTool(name, toolArgs, client, hosted);
    } else if (!toolArgs.agent_id) {
      toolArgs.agent_id = wiring.agentId;
    }

    const governance = await checkMcpGovernance(name, toolArgs, governanceConfig);
    if (!governance.allowed) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: governance.message, ...governance }) }],
        isError: true,
      };
    }

    // Route schema-qualified generated ontology tools, including relation-role
    // reads and the structured composite.
    const generated = await getGeneratedTools(client, wiring.generatedTools);
    const desc = generated.byName.get(name);
    if (desc) {
      return handleGeneratedTool(client, desc, rawArgs);
    }

    if (hosted && HOSTED_TOOL_NAMES.has(name)) {
      return handleHostedTool(name, toolArgs, client, hosted);
    }
    return handleTool(client, name, toolArgs, wiring.memory, toolRuntime(ctx, Boolean(hosted)));
  });

  server.setRequestHandler('prompts/list', async () => {
    return { prompts: PROMPTS };
  });

  server.setRequestHandler('prompts/get', async (request) => {
    const { name, arguments: args } = request.params;
    return getPrompt(name, args);
  });

  server.setRequestHandler('resources/list', async () => {
    return { resources: RESOURCES };
  });

  server.setRequestHandler('resources/templates/list', async () => {
    return { resourceTemplates: RESOURCE_TEMPLATES };
  });

  server.setRequestHandler('resources/read', async (request) => {
    return readGovernedResource(
      client,
      request.params.uri,
      wiring.governance,
      wiring.memory,
    );
  });

  return server;
}

// ── Hosted mode ───────────────────────────────────────────────────────

export interface MindGraphServerOptions {
  /** SDK client already authenticated with the exchanged API token. */
  client: MindGraph;
  /** The exchanged API token; used by the governance probe in place of an API key. */
  bearer: string;
  baseUrl: string;
  orgId: string;
  orgName?: string;
  /** `mcp:{client_host}:{user_id}`; overwrites agent_id on every call (D4). */
  agentId: string;
  user: { id: string; name?: string; email?: string };
  profile: "general";
  harness: "hosted";
  instructions?: string;
  serverVersion: string;
  /** Skip the governance checkpoint (the stdio MINDGRAPH_GOVERNANCE=off knob). */
  governanceDisabled?: boolean;
  /** Per-org caches owned by the route; one entry per org, same TTLs as stdio. */
  caches: {
    generatedTools: Map<string, GeneratedToolsEntry>;
    governance: Map<string, GovernanceLatch>;
  };
  /** Structured call log (never receives the bearer). */
  log?: (event: Record<string, unknown>) => void;
}

function perOrg<T>(map: Map<string, T>, orgId: string, create: () => T): T {
  let entry = map.get(orgId);
  if (!entry) {
    entry = create();
    map.set(orgId, entry);
  }
  return entry;
}

/** Build one hosted Server (one request, one member, one org). */
export function createMindGraphServer(opts: MindGraphServerOptions): Server {
  const { baseUrl, orgId, agentId } = opts;
  return buildMindGraphServer({
    client: opts.client,
    serverVersion: opts.serverVersion,
    instructions: opts.instructions ?? hostedInstructions(),
    profile: opts.profile,
    agentId,
    governance: {
      baseUrl,
      apiKey: opts.bearer,
      orgId,
      agentId,
      disabled: opts.governanceDisabled ?? false,
      latch: perOrg(opts.caches.governance, orgId, createGovernanceLatch),
      context: { harness: opts.harness },
    },
    memory: {
      serverVersion: opts.serverVersion,
      baseUrl,
      profile: opts.profile,
      harness: opts.harness,
      orgId,
      agentId,
    },
    generatedTools: perOrg(opts.caches.generatedTools, orgId, createGeneratedToolsEntry),
    hosted: { user: opts.user, orgId, orgName: opts.orgName, log: opts.log },
  });
}

/** Hosted requests are served as one JSON body by a function that is billed
 * while it waits, so a hosted wait is shorter and carries no progress. */
const HOSTED_MAX_JOB_WAIT_SECONDS = 25;

interface CallContext {
  mcpReq: {
    _meta?: { progressToken?: string | number };
    signal?: AbortSignal;
    notify?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
  };
}

function toolRuntime(ctx: unknown, hosted: boolean): ToolRuntime {
  const request = (ctx as CallContext | undefined)?.mcpReq;
  const token = request?._meta?.progressToken;
  const notify = request?.notify;
  return {
    signal: request?.signal,
    ...(hosted ? { maxWaitSeconds: HOSTED_MAX_JOB_WAIT_SECONDS } : {}),
    ...(!hosted && token !== undefined && notify
      ? {
          progress: (update) =>
            notify({
              method: "notifications/progress",
              params: { progressToken: token, ...update },
            }),
        }
      : {}),
  };
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/**
 * Serve one Streamable HTTP request statelessly (D6). The caller has already
 * verified the bearer and resolved `opts`; this helper owns only the JSON-RPC
 * surface: non-POST → 405, unparsable → 400, batches → 400, else the SDK —
 * the 2026-07-28 path for requests that carry the per-request envelope, the
 * 2025 stateless path for every other client.
 */
export async function handleHostedRequest(
  request: Request,
  opts: MindGraphServerOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await request.text());
  } catch {
    return jsonRpcError(400, -32700, "Parse error: body must be a JSON-RPC message");
  }
  if (Array.isArray(parsedBody)) {
    return jsonRpcError(400, -32600, "JSON-RPC batches are not accepted");
  }
  // 2026-07-28 requests carry their protocol version and capabilities in a
  // per-request envelope and never send `initialize`. Everything else is a
  // 2025-era client and keeps the stateless JSON serving it has always had.
  if (!(await isLegacyRequest(request, parsedBody))) {
    const modern = createMcpHandler(() => createMindGraphServer(opts), {
      legacy: "reject",
      // Default response mode: one JSON body unless a handler emits a message
      // before its result. No tool does today; a tool that starts emitting
      // progress must also stop this function closing the handler on return.
    });
    try {
      return await modern.fetch(request, { parsedBody });
    } finally {
      await modern.close();
    }
  }
  const server = createMindGraphServer(opts);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}
