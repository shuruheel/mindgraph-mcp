// The MCP server wiring, shared by the stdio entry (`index.ts`) and the hosted
// mode (spec D5). This module has no load-time side effects: everything the
// handlers close over arrives in a `ServerWiring`, so a hosted route can build
// one Server per request.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MindGraph } from "mindgraph";
import {
  getGeneratedTools,
  handleGeneratedTool,
  type GeneratedToolsEntry,
} from "./generated-tools.js";
import { checkMcpGovernance, type GovernanceConfig } from "./governance.js";
import type { MemoryRuntimeConfig } from "./memory-tool.js";
import { getPrompt, PROMPTS } from "./prompts.js";
import { RESOURCES, RESOURCE_TEMPLATES, readGovernedResource } from "./resources.js";
import { handleTool, toolsForProfile } from "./tools.js";

export type { GeneratedToolsEntry };

/** Everything the request handlers close over. */
export interface ServerWiring {
  client: MindGraph;
  serverVersion: string;
  instructions: string;
  profile: string;
  /** Trusted agent identity: the default in stdio mode, the only one in hosted mode. */
  agentId: string;
  governance: GovernanceConfig;
  memory: MemoryRuntimeConfig;
  /** Manifest cache; omitted → the process-wide entry (stdio). */
  generatedTools?: GeneratedToolsEntry;
}

export function buildMindGraphServer(wiring: ServerWiring): Server {
  const { client } = wiring;
  const server = new Server(
    { name: "mindgraph", version: wiring.serverVersion },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: wiring.instructions,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Static tools + per-object-type read tools generated from the active
    // ontology (never throws — empty set if the manifest endpoint is absent).
    const generated = await getGeneratedTools(client, wiring.generatedTools);
    return { tools: [...toolsForProfile(wiring.profile), ...generated.tools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const rawArgs = { ...((args as Record<string, unknown>) || {}) };
    // Inject default agent_id if not provided. Static tools declare agent_id;
    // generated ontology tools do not, and their schemas reject it — so the
    // injected copy is kept separate from the args they receive.
    const toolArgs = { ...rawArgs };
    if (!toolArgs.agent_id) {
      toolArgs.agent_id = wiring.agentId;
    }

    const governance = await checkMcpGovernance(name, toolArgs, wiring.governance);
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

    return handleTool(client, name, toolArgs, wiring.memory);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: PROMPTS };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return getPrompt(name, args);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: RESOURCES };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: RESOURCE_TEMPLATES };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return readGovernedResource(
      client,
      request.params.uri,
      wiring.governance,
      wiring.memory,
    );
  });

  return server;
}
