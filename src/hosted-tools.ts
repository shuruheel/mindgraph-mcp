// Hosted-mode tool surface (spec D4/D5): the ChatGPT `search`/`fetch`
// contract, the `whoami` profile tool, per-tool OAuth scopes, annotations and
// the hosted server instructions. Nothing here reads process state.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MindGraphError, type MindGraph } from "mindgraph";
import { toolError } from "./error-detail.js";

export const EXPLORER_URL = "https://mindgraph.cloud/dashboard/explorer?uid=";
const SEARCH_LIMIT = 10;
const FETCH_TEXT_LIMIT = 32 * 1024;

export type Scope = "graph:read" | "graph:write" | "graph:evolve";

export interface HostedIdentity {
  user: { id: string; name?: string; email?: string };
  orgId: string;
  orgName?: string;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// ── Scopes and annotations ────────────────────────────────────────────

const READ_TOOLS = new Set([
  "mindgraph_retrieve",
  "mindgraph_memory",
  "mindgraph_series_query",
  "search",
  "fetch",
  "whoami",
]);
// `mindgraph_remember` carries the `forget` action (/memory/forget → evolve).
const EVOLVE_TOOLS = new Set(["mindgraph_remember"]);

/** The OAuth scopes a hosted tool needs (D4). Generated ontology tools are reads. */
export function requiredScopes(name: string, generated = false): Scope[] {
  if (generated || READ_TOOLS.has(name)) return ["graph:read"];
  if (EVOLVE_TOOLS.has(name)) return ["graph:write", "graph:evolve"];
  return ["graph:write"];
}

/** Copy a tool with its annotations and `_meta.securitySchemes` (never mutates). */
export function decorateHostedTool(tool: Tool, generated = false): Tool {
  const scopes = requiredScopes(tool.name, generated);
  const read = scopes.length === 1 && scopes[0] === "graph:read";
  return {
    ...tool,
    annotations: {
      ...tool.annotations,
      readOnlyHint: read,
      destructiveHint: scopes.includes("graph:evolve"),
      openWorldHint: false,
    },
    _meta: {
      ...tool._meta,
      securitySchemes: [{ type: "oauth2", scopes }],
    },
  };
}

// ── Tool definitions ──────────────────────────────────────────────────

const SEARCH_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Graph node uid; pass to fetch" },
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
        },
        required: ["id", "title", "url"],
      },
    },
  },
  required: ["results"],
};

const FETCH_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    text: { type: "string" },
    url: { type: "string" },
    metadata: {
      type: "object",
      properties: {
        layer: { type: "string" },
        type: { type: "string" },
        created_at: { type: "number" },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: { uid: { type: "string" }, title: { type: "string" } },
          },
        },
      },
    },
  },
  required: ["id", "title", "text", "url"],
};

export const HOSTED_TOOLS: Tool[] = [
  {
    name: "search",
    description:
      "Search the organization's knowledge graph (hybrid keyword + semantic). Returns up to 10 matching nodes with an id to pass to fetch.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    outputSchema: SEARCH_OUTPUT_SCHEMA,
  },
  {
    name: "fetch",
    description:
      "Fetch one graph node by the id returned from search: its title, full text (label, summary, properties), explorer URL and metadata with source documents. Document ids are not accepted.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Graph node uid from search" } },
      required: ["id"],
    },
    outputSchema: FETCH_OUTPUT_SCHEMA,
  },
  {
    name: "whoami",
    description:
      "The signed-in MindGraph member this connection acts as, and their organization.",
    inputSchema: { type: "object", properties: {} },
    _meta: { "openai/profile": true },
  },
];

export const HOSTED_TOOL_NAMES = new Set(HOSTED_TOOLS.map((tool) => tool.name));

// ── Handlers ──────────────────────────────────────────────────────────

/** The ChatGPT contract: structuredContent plus the same JSON as content[0].text. */
function twin(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

type ContextNode = Record<string, unknown> & {
  source_documents?: Array<{ uid: string; title: string }>;
};

async function contextNodes(
  client: MindGraph,
  query: string,
  nodeLimit: number,
): Promise<ContextNode[]> {
  const resp = await client.retrieveContext({
    query,
    node_limit: nodeLimit,
    article_limit: 0,
    chunk_limit: 0,
  });
  return (resp?.graph?.nodes ?? []) as ContextNode[];
}

function renderProps(props: Record<string, unknown> | undefined): string {
  if (!props) return "";
  return Object.entries(props)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

export async function handleHostedTool(
  name: string,
  args: Record<string, unknown>,
  client: MindGraph,
  identity: HostedIdentity,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "search": {
        const query = str(args.query).trim();
        if (!query) return err("query is required");
        const nodes = await contextNodes(client, query, SEARCH_LIMIT);
        const results = nodes.slice(0, SEARCH_LIMIT).map((node) => ({
          id: str(node.uid),
          title: str(node.label),
          url: `${EXPLORER_URL}${encodeURIComponent(str(node.uid))}`,
          snippet: str(node.summary),
        }));
        return twin({ results });
      }
      case "fetch": {
        const id = str(args.id).trim();
        if (!id) return err("id is required");
        let node;
        try {
          node = await client.getNode(id);
        } catch (e) {
          if (e instanceof MindGraphError && e.status === 404) {
            return err(
              `No graph node with id ${id}. fetch accepts the node ids returned by search; document ids are not supported.`,
            );
          }
          throw e;
        }
        const text = [node.label, node.summary, renderProps(node.props)]
          .filter((part) => part && part.length > 0)
          .join("\n\n")
          .slice(0, FETCH_TEXT_LIMIT);
        // The SDK has no document read and getNode carries no provenance;
        // source_documents only ride on /retrieve/context nodes, so one
        // context call anchored on the node's label supplies them.
        let sources: Array<{ uid: string; title: string }> = [];
        try {
          const hit = (await contextNodes(client, node.label, 5)).find(
            (candidate) => candidate.uid === node.uid,
          );
          sources = (hit?.source_documents ?? []).map(({ uid, title }) => ({ uid, title }));
        } catch {
          sources = [];
        }
        return twin({
          id: node.uid,
          title: node.label,
          text,
          url: `${EXPLORER_URL}${encodeURIComponent(node.uid)}`,
          metadata: {
            layer: node.layer,
            type: node.node_type,
            created_at: node.created_at,
            sources,
          },
        });
      }
      case "whoami":
        return twin({
          id: identity.user.id,
          name: identity.user.name ?? null,
          email: identity.user.email ?? null,
          organization: identity.orgName ?? identity.orgId,
          organization_id: identity.orgId,
        });
      default:
        return err(`Unknown hosted tool: ${name}`);
    }
  } catch (e: unknown) {
    return toolError(e);
  }
}

// ── Instructions ──────────────────────────────────────────────────────

/** The key sentence and the attribution rule sit inside the first 512 chars. */
export function hostedInstructions(): string {
  return `You have access to a persistent knowledge graph via MindGraph for the signed-in member's organization, plus any ontology tools generated by the active schema. Attribution rule: every call is attributed to the signed-in member — the server sets agent_id itself and ignores any agent_id you pass.

## Workflow: orient → answer → preserve

- Quick lookups: \`search\` (hybrid, 10 results) then \`fetch\` by id for the full node and its sources; \`whoami\` tells you who you act as.
- Resuming work or asking what was in progress: \`mindgraph_memory\` action \`context\`, mode \`resume\` or \`continuity\`.
- Topics that may depend on prior knowledge: \`mindgraph_memory\` action \`context\`, mode \`topic\`, with 1–3 discriminating keywords; escalate to \`mindgraph_retrieve\` (\`context\` → \`semantic\` → \`hybrid\`, or \`neighborhood\`/\`path\` for graph exploration) when the bounded result is insufficient.
- Answer from the bounded result. Treat superseded, refuted or out-of-validity items as warnings, not current facts. An isError result is a failed operation, not evidence of no matches; respect its retry guidance.
- Preserve selectively after a material durable change: entities, observations, journal notes and lessons → \`mindgraph_capture\`; claims and open questions → \`mindgraph_reason\`; goals, projects and decisions → \`mindgraph_commit\`; cross-session work → \`mindgraph_plan\`; free-form memories → \`mindgraph_remember\`; long-form content → \`mindgraph_ingest\`. Do not write ephemeral conversation, routine mechanics or unsupported guesses.
- If a write returns \`near_duplicate\`, choose \`reuse_uid\` or \`supersedes_uid\`; use \`confirm_new\` only for genuinely distinct facts.
- Confidence: 0.9+ for facts, 0.5–0.8 for uncertain, <0.5 for speculation. Don't narrate tool usage — capture naturally as part of conversation.`;
}
