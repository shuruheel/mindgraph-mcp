import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
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
      "Get your API key at https://mindgraph.cloud/dashboard/keys\n" +
      "Or run: npx mindgraph-mcp init"
  );
  process.exit(1);
}

// ── MindGraph Client ──────────────────────────────────────────────────

const client = new MindGraph({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
});

// ── Server Instructions ───────────────────────────────────────────────

const INSTRUCTIONS = `You have access to a persistent knowledge graph via MindGraph. This is the user's long-term memory — use it proactively.

## When to WRITE to the graph

Store knowledge whenever the user shares something worth remembering:
- **People, organizations, places, events** → \`mindgraph_capture\` with action "entity" and the appropriate entity_type
- **Quick notes, preferences, reflections, moods** → \`mindgraph_journal\`
- **Factual observations about the world** → \`mindgraph_capture\` with action "observation"
- **Claims that could be true or false** → \`mindgraph_argue\` (with evidence if available)
- **Questions to investigate later** → \`mindgraph_inquire\` with action "open_question"
- **Hypotheses or theories** → \`mindgraph_inquire\` with action "hypothesis" or "theory"
- **Goals or projects the user is working on** → \`mindgraph_commit\`
- **Decisions being made** → \`mindgraph_decide\` (open, add options, resolve)
- **Long-form content (articles, transcripts, documents)** → \`mindgraph_ingest\`

## When to READ from the graph

Retrieve context before answering questions that might benefit from prior knowledge:
- **"What do I know about X?"** → \`mindgraph_retrieve\` with action "hybrid" or "context"
- **"What are my goals?"** → \`mindgraph_retrieve\` with action "active_goals"
- **"What questions are open?"** → \`mindgraph_retrieve\` with action "open_questions"
- **Anything referencing past conversations or stored knowledge** → \`mindgraph_retrieve\` with action "context"
- **Before making claims about things the user has told you** → retrieve first to avoid contradictions

## Session management

- Open a session with \`mindgraph_session\` action "open" at the start of a substantial conversation
- Use action "trace" to mark key moments during the conversation
- Close the session with action "close" and a summary at the end

## Tool selection guide

- **mindgraph_capture vs mindgraph_journal**: Use \`capture\` for structured entities (people, orgs, places) and factual observations. Use \`journal\` for informal notes, preferences, reflections, and anything that's more about the user's inner state than external facts.
- **mindgraph_argue vs mindgraph_inquire**: Use \`argue\` when there's a specific claim with supporting evidence. Use \`inquire\` for open-ended questions, hypotheses without evidence yet, or theoretical frameworks.
- **mindgraph_commit vs mindgraph_plan**: Use \`commit\` for the user's goals, projects, and milestones. Use \`plan\` for agent-level task management and execution tracking.
- **mindgraph_retrieve "hybrid" vs "context"**: Use "hybrid" for quick keyword+semantic search. Use "context" for richer retrieval that follows graph edges from matching chunks to find connected entities and claims.
- **mindgraph_ingest**: Use for any content longer than a paragraph. It automatically extracts entities, claims, and relationships. For short facts, use the specific cognitive tools instead.

## Important behaviors

- Be proactive: if the user mentions a person, place, or organization you haven't captured yet, capture it
- Deduplicate: the graph handles entity deduplication automatically — don't worry about creating duplicates
- Confidence scores: use 0.9+ for things the user states as fact, 0.5-0.8 for uncertain claims, below 0.5 for speculation
- Don't narrate tool usage excessively — capture knowledge naturally as part of the conversation`;

// ── MCP Server ────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "mindgraph",
    version: "0.2.1",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
    instructions: INSTRUCTIONS,
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

// ── Prompts ───────────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: "graph-summary",
    description:
      "Get a comprehensive summary of what's in your knowledge graph — entities, claims, goals, and open questions.",
    arguments: [],
  },
  {
    name: "active-goals",
    description:
      "Review your active goals, projects, and milestones with their current status.",
    arguments: [],
  },
  {
    name: "open-questions",
    description:
      "List all open questions and hypotheses that need investigation.",
    arguments: [],
  },
  {
    name: "review-contradictions",
    description:
      "Find and analyze contradictions in your knowledge graph — claims that conflict with each other.",
    arguments: [],
  },
  {
    name: "knowledge-about",
    description:
      "Retrieve everything the knowledge graph knows about a specific topic.",
    arguments: [
      {
        name: "topic",
        description: "The topic to search for",
        required: true,
      },
    ],
  },
  {
    name: "daily-briefing",
    description:
      "Get a daily briefing: active goals, recent knowledge, open questions, and pending decisions.",
    arguments: [],
  },
  {
    name: "capture-conversation",
    description:
      "Analyze the current conversation and capture all important entities, claims, decisions, and action items into the knowledge graph.",
    arguments: [
      {
        name: "conversation",
        description: "The conversation text to analyze and capture",
        required: true,
      },
    ],
  },
];

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: PROMPTS };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "graph-summary":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Give me a comprehensive summary of my knowledge graph. Start by checking the graph stats, then retrieve my active goals, open questions, and any recent knowledge. Organize the summary by cognitive layer (Reality, Epistemic, Intent, Action, Memory).",
            },
          },
        ],
      };

    case "active-goals":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Review all my active goals, projects, and milestones. For each one, show its status, any linked decisions or tasks, and suggest next steps. Group them by project if applicable.",
            },
          },
        ],
      };

    case "open-questions":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "List all my open questions and hypotheses. For each one, check if there's any related evidence or claims in the graph that might help answer them. Prioritize by salience and suggest which ones I should investigate first.",
            },
          },
        ],
      };

    case "review-contradictions":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Search my knowledge graph for contradictions — claims that conflict with each other, or evidence that undermines existing beliefs. Also look for weak claims (low confidence) that might need more evidence. For each contradiction found, explain the conflict and suggest how to resolve it.",
            },
          },
        ],
      };

    case "knowledge-about": {
      const topic = args?.topic || "general";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Search my knowledge graph for everything related to "${topic}". Use both hybrid search and context retrieval to find entities, claims, evidence, questions, and any connected knowledge. Present a structured overview of what I know about this topic, highlighting any gaps or open questions.`,
            },
          },
        ],
      };
    }

    case "daily-briefing":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Give me a daily briefing. Check:\n1. Active goals and their progress\n2. Open decisions that need resolution\n3. Recent knowledge added in the last few days\n4. Open questions worth investigating\n5. Any pending approvals\n6. Weak claims that need more evidence\n\nKeep it concise and actionable — highlight what needs my attention today.",
            },
          },
        ],
      };

    case "capture-conversation": {
      const conversation = args?.conversation || "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Analyze the following conversation and capture all important information into my knowledge graph. Extract:\n- Named entities (people, organizations, places, events)\n- Factual claims and observations\n- Decisions made or pending\n- Goals or commitments mentioned\n- Open questions raised\n- Any hypotheses or theories discussed\n\nUse the appropriate MindGraph tools for each type of knowledge.\n\nConversation:\n${conversation}`,
            },
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// ── Static Resources ──────────────────────────────────────────────────

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
      {
        uri: "mindgraph://contradictions",
        name: "Contradictions",
        description: "Contradictory claims in the knowledge graph",
        mimeType: "application/json",
      },
      {
        uri: "mindgraph://decisions",
        name: "Open Decisions",
        description: "Unresolved decisions awaiting resolution",
        mimeType: "application/json",
      },
    ],
  };
});

// ── Resource Templates ────────────────────────────────────────────────

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        uriTemplate: "mindgraph://node/{uid}",
        name: "Graph Node",
        description:
          "Retrieve a specific node by its UID, including all properties, edges, and version history",
        mimeType: "application/json",
      },
      {
        uriTemplate: "mindgraph://search/{query}",
        name: "Search Results",
        description:
          "Full-text search across all nodes in the knowledge graph",
        mimeType: "application/json",
      },
      {
        uriTemplate: "mindgraph://layer/{layer}",
        name: "Layer Nodes",
        description:
          "List all nodes in a specific cognitive layer (reality, epistemic, intent, action, memory, agent)",
        mimeType: "application/json",
      },
    ],
  };
});

// ── Resource Reader (static + dynamic) ────────────────────────────────

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  // Static resources
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
    case "mindgraph://contradictions": {
      const contradictions = await client.getContradictions();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(contradictions, null, 2),
          },
        ],
      };
    }
    case "mindgraph://decisions": {
      const decisions = await client.getOpenDecisions();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(decisions, null, 2),
          },
        ],
      };
    }
  }

  // Dynamic resources: mindgraph://node/{uid}
  const nodeMatch = uri.match(/^mindgraph:\/\/node\/(.+)$/);
  if (nodeMatch) {
    const uid = decodeURIComponent(nodeMatch[1]);
    const node = await client.getNode(uid);
    const edges = await client.getEdges({ from_uid: uid });
    const inEdges = await client.getEdges({ to_uid: uid });
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            { node, outgoing_edges: edges, incoming_edges: inEdges },
            null,
            2
          ),
        },
      ],
    };
  }

  // Dynamic resources: mindgraph://search/{query}
  const searchMatch = uri.match(/^mindgraph:\/\/search\/(.+)$/);
  if (searchMatch) {
    const query = decodeURIComponent(searchMatch[1]);
    const results = await client.hybridSearch(query, { k: 20 });
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  // Dynamic resources: mindgraph://layer/{layer}
  const layerMatch = uri.match(/^mindgraph:\/\/layer\/(.+)$/);
  if (layerMatch) {
    const layer = decodeURIComponent(layerMatch[1]);
    const nodes = await client.getNodes({ layer, limit: 50 });
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(nodes, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ── Start ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `MindGraph MCP server v0.2.0 running on stdio (${BASE_URL})`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
