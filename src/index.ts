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

const INSTRUCTIONS = `You have access to a persistent knowledge graph via MindGraph (6 tools).

## #1 RULE: Go straight to the user's topic

When the user asks about something, your FIRST and ONLY action should be a SINGLE \`mindgraph_retrieve\` call with action "context" and keyword terms from their message. Nothing else first.

**NEVER do any of these before addressing the user's topic:**
- Do NOT retrieve active_goals, open_questions, contradictions, or weak_claims
- Do NOT follow a "session lifecycle" or "warm-up" sequence
- Do NOT make multiple serial retrieve calls when one "context" call covers it

There is no session to open. There is no context to pre-load. Just search for what the user asked about.

**Example:** User says "Tell me about Indian philosophy and Taoism"
✓ CORRECT: \`mindgraph_retrieve({action: "context", query: "Indian philosophy Taoism"})\`
✗ WRONG: First retrieve active_goals, then open_questions, then search
✗ WRONG: \`mindgraph_retrieve({action: "context", query: "Tell me about Indian philosophy and Taoism"})\` — natural language won't match BM25

## Search strategy — keyword first, semantic as fallback

The default search uses BM25 keyword matching. Query with 1–3 discriminating terms (proper nouns, technical terms). Drop filler words.

**Keyword examples:**
- "What is Kissinger's view on NATO?" → query: \`"Kissinger NATO"\`
- "Tell me about async in Rust" → query: \`"Rust async runtime"\`
- "Implications of carbon tax?" → query: \`"carbon tax"\`

If keyword search returns no results, escalate:
1. Try synonyms (e.g. \`"global warming"\` instead of \`"climate change"\`)
2. Use \`action: "semantic"\` — vector similarity, natural language OK (e.g. \`"ways to manage stress"\` finds "mental health" nodes)
3. Use \`action: "hybrid"\` — combines BM25 + semantic for best coverage

## When to READ

- User asks about topic X → \`mindgraph_retrieve\` action "context", query "X keywords"
- User explicitly asks "what are my goals?" → action "active_goals"
- User explicitly asks about open questions → action "open_questions"
- Explore around a known node → action "neighborhood" with start_uid
- Find connections between nodes → action "path" with start_uid + end_uid

## When to WRITE

Capture knowledge when the user shares something worth remembering:
- People/orgs/places/events → \`mindgraph_capture\` action "entity"
- Quick notes, preferences → \`mindgraph_capture\` action "journal"
- Factual observations → \`mindgraph_capture\` action "observation"
- Claims with evidence → \`mindgraph_reason\` action "claim"
- Questions to track → \`mindgraph_reason\` action "open_question"
- Goals or projects → \`mindgraph_commit\` action "goal"/"project"
- Decisions → \`mindgraph_commit\` action "open_decision"
- Long-form content → \`mindgraph_ingest\`

## Tool tips

- \`capture\`: "entity"/"observation" for facts, "journal" for personal/informal
- \`reason\`: "claim" when evidence exists, "open_question"/"hypothesis" otherwise
- \`retrieve\`: "context" (FTS default) → "semantic" (conceptual fallback) → "hybrid" (both)
- \`retrieve\`: "neighborhood"/"chain"/"path"/"subgraph" for graph exploration
- Confidence: 0.9+ for facts, 0.5-0.8 for uncertain, <0.5 for speculation
- Don't narrate tool usage — capture naturally as part of conversation`;

// ── MCP Server ────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "mindgraph",
    version: "0.4.0",
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
              text: `Search my knowledge graph for everything related to "${topic}". Use context retrieval with short BM25 keyword queries (1–3 discriminating terms extracted from the topic, not full sentences). Try multiple keyword variations and synonyms to ensure broad coverage. Present a structured overview of what I know about this topic, highlighting any gaps or open questions.`,
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
              text: `Analyze the following conversation and capture all important information into my knowledge graph. Extract:\n- Named entities (people, organizations, places, events) → mindgraph_capture action "entity"\n- Factual claims and observations → mindgraph_capture action "observation" or mindgraph_reason action "claim"\n- Decisions made or pending → mindgraph_commit action "open_decision"\n- Goals or commitments mentioned → mindgraph_commit action "goal"/"project"\n- Open questions raised → mindgraph_reason action "open_question"\n- Any hypotheses or theories discussed → mindgraph_reason action "hypothesis"/"theory"\n\nConversation:\n${conversation}`,
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
          "BM25 keyword search across all nodes — pass 1–3 discriminating terms (e.g. 'Kissinger NATO'), not natural language sentences",
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
    const results = await client.search(query, { limit: 20 });
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
    `MindGraph MCP server v0.4.0 running on stdio (${BASE_URL})`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
