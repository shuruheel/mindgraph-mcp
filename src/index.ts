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

## Critical: minimize latency

- **Jump straight to the user's topic.** Do NOT pre-fetch goals, open questions, or other convenience queries unless the user specifically asks about them.
- **Parallelize tool calls.** When you need to search and capture at the same time, issue all calls in a single parallel batch — never serialize independent calls.
- **Sessions are optional.** Only open a session if the conversation is long and substantive. Never open a session as a first action — answer the user's question first, then open a session in the background if warranted.

## When to READ from the graph

Only retrieve when the user's message references or would benefit from stored knowledge:
- User asks about a topic → \`mindgraph_retrieve\` with action "context" and keyword query
- User asks about goals → \`mindgraph_retrieve\` with action "active_goals"
- User asks about open questions → \`mindgraph_retrieve\` with action "open_questions"
- Before asserting something the user previously told you → retrieve to check

Do NOT retrieve preemptively. If the user says "let's discuss X", search for X — don't also fetch goals, questions, and contradictions.

## Search query style

MindGraph uses **full-text search (BM25)**, not semantic/embedding search. Write queries as **short keyword phrases**, not natural language questions:
- GOOD: \`"Rust async runtime"\`, \`"project deadline March"\`, \`"Sarah engineering manager"\`
- BAD: \`"what do I know about async programming in Rust?"\`, \`"tell me about Sarah's role"\`

Use the most specific nouns and terms from the topic. Multiple keywords broaden recall across label, summary, and content fields.

## When to WRITE to the graph

Store knowledge whenever the user shares something worth remembering:
- **People, organizations, places, events** → \`mindgraph_capture\` with action "entity"
- **Quick notes, preferences, reflections, moods** → \`mindgraph_journal\`
- **Factual observations** → \`mindgraph_capture\` with action "observation"
- **Claims with evidence** → \`mindgraph_argue\`
- **Questions to track** → \`mindgraph_inquire\` with action "open_question"
- **Hypotheses or theories** → \`mindgraph_inquire\` with action "hypothesis" or "theory"
- **Goals or projects** → \`mindgraph_commit\`
- **Decisions** → \`mindgraph_decide\`
- **Long-form content** → \`mindgraph_ingest\`

## Tool selection guide

- **mindgraph_capture vs mindgraph_journal**: \`capture\` for structured entities and factual observations. \`journal\` for informal notes, preferences, and reflections.
- **mindgraph_argue vs mindgraph_inquire**: \`argue\` when there's evidence. \`inquire\` for open questions and hypotheses without evidence yet.
- **mindgraph_retrieve "text" vs "context"**: "text" for fast direct keyword lookup. "context" for richer retrieval that follows graph edges to connected entities and source chunks — best for RAG.
- **mindgraph_ingest**: For content longer than a paragraph. Automatically extracts entities, claims, and relationships.

## Important behaviors

- Be proactive about capturing: if the user mentions a person, place, or organization, capture it
- Deduplicate: the graph handles deduplication automatically
- Confidence scores: 0.9+ for stated facts, 0.5-0.8 for uncertain claims, below 0.5 for speculation
- Don't narrate tool usage — capture knowledge naturally as part of the conversation`;

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
              text: `Search my knowledge graph for everything related to "${topic}". Use context retrieval with keyword queries to find entities, claims, evidence, questions, and any connected knowledge. Try multiple keyword variations to ensure broad coverage. Present a structured overview of what I know about this topic, highlighting any gaps or open questions.`,
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
    `MindGraph MCP server v0.3.1 running on stdio (${BASE_URL})`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
