import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MindGraph } from "mindgraph";
import { TOOLS, handleTool } from "./tools.js";

// ── Configuration ─────────────────────────────────────────────────────

const API_KEY = process.env.MINDGRAPH_API_KEY;
const BASE_URL =
  process.env.MINDGRAPH_BASE_URL || "https://api.mindgraph.cloud";
const AGENT_ID = process.env.MINDGRAPH_AGENT_ID || "mcp";

if (!API_KEY) {
  console.error(
    "Error: MINDGRAPH_API_KEY environment variable is required.\n" +
      "Get your API key at https://mindgraph.cloud/dashboard/keys"
  );
  process.exit(1);
}

// ── MindGraph Client ──────────────────────────────────────────────────

const client = new MindGraph({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
});

// ── MCP Server ────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "mindgraph",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ── Tool Handlers ─────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Inject default agent_id if not provided
  const toolArgs = { ...((args as Record<string, unknown>) || {}) };
  if (!toolArgs.agent_id) {
    toolArgs.agent_id = AGENT_ID;
  }

  return handleTool(client, name, toolArgs);
});

// ── Resource Handlers (graph stats) ───────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "mindgraph://stats",
        name: "Graph Statistics",
        description:
          "Current knowledge graph statistics: node counts, edge counts, and layer distribution",
        mimeType: "application/json",
      },
      {
        uri: "mindgraph://goals",
        name: "Active Goals",
        description: "All active goals in the knowledge graph",
        mimeType: "application/json",
      },
      {
        uri: "mindgraph://questions",
        name: "Open Questions",
        description: "All open questions in the knowledge graph",
        mimeType: "application/json",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case "mindgraph://stats": {
      const stats = await client.stats();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }
    case "mindgraph://goals": {
      const goals = await client.getGoals();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(goals, null, 2),
          },
        ],
      };
    }
    case "mindgraph://questions": {
      const questions = await client.getOpenQuestions();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(questions, null, 2),
          },
        ],
      };
    }
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MindGraph MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
