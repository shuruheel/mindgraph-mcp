import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/server";
import type { MindGraph } from "mindgraph";
import { renderContext, renderResumeContext } from "./render.js";
import { WORKSPACE_RESUME_LIMIT, type RepositoryScope } from "./workspace-scope.js";

const RESULT_SCHEMA_VERSION = "mindgraph.memory.result.v1";
const DEFAULT_OUTPUT_CHARS = 8_000;
const MIN_OUTPUT_CHARS = 512;
const MAX_OUTPUT_CHARS = 24_000;
const HIDDEN_CONTEXT_NODE_TYPES = new Set(["Chunk", "Document", "Article"]);
const HIDDEN_CONTEXT_EDGE_TYPES = new Set(["POSSIBLE_DUPLICATE", "PossibleDuplicate"]);

type Rec = Record<string, unknown>;
type MemoryClient = Pick<MindGraph, "retrieveContext" | "plan"> &
  Partial<Pick<MindGraph, "getGoals" | "getOpenDecisions" | "retrieve">>;

export interface MemoryRuntimeConfig {
  serverVersion?: string;
  baseUrl?: string;
  profile?: string;
  harness?: string;
  orgId?: string;
  agentId?: string;
  /** Resolves the repositories the local workspace declares. Present only
   * where the server runs beside a checkout (stdio), never when hosted. */
  resolveWorkspaceScope?: (agentId: string) => Promise<RepositoryScope>;
}

export interface MemoryToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Rec;
  isError?: boolean;
}

export const MEMORY_TOOL: Tool = {
  name: "mindgraph_memory",
  description:
    "Read the portable MindGraph memory surface. Use action='context' with mode='brief' once at the start of a conversation for work in progress, active goals, open decisions and preferences; mode='resume' or 'continuity' for authoritative task-first work state, and mode='topic' with a short keyword query for prior knowledge relevant to the user's request. Use action='status' to inspect integration capabilities and limitations. This tool never writes; durable capture and correction use the existing typed MindGraph write tools.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "context"],
        description: "Read integration status or bounded memory context",
      },
      mode: {
        type: "string",
        enum: ["topic", "continuity", "resume", "brief"],
        description:
          "Context strategy. brief is the conversation-start orientation: work in progress, active goals, open decisions and stored preferences in one bounded call. topic uses query-shaped retrieval; continuity/resume use authoritative task-first resume_work.",
      },
      query: {
        type: "string",
        description:
          "Required for mode='topic': 1-3 discriminating BM25 keywords, not a full sentence",
      },
      project_uid: { type: "string", description: "Optional project scope" },
      task_uid: { type: "string", description: "Optional task scope for resume context" },
      session_uid: { type: "string", description: "Optional durable session scope" },
      scope_uids: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit graph scopes for continuity/resume",
      },
      scope: {
        type: "string",
        enum: ["workspace"],
        description:
          "For continuity/resume on a local server: select work across every repository the working directory's .mindgraph/workspace.json declares, and list the other eligible tasks grouped by repository",
      },
      node_types: {
        type: "array",
        items: { type: "string" },
        description: "Optional node-type filter for topic context",
      },
      layer: {
        type: "string",
        enum: ["reality", "epistemic", "intent", "action", "memory", "agent"],
        description: "Optional cognitive-layer filter for topic context",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 8,
        description: "Maximum direct graph items requested before bounded expansion",
      },
      include_chunks: {
        type: "boolean",
        default: false,
        description: "Include bounded source excerpts when topic summaries are insufficient",
      },
      include_documents: {
        type: "boolean",
        default: false,
        description: "Include bounded knowledge articles for topic context",
      },
      valid_at: {
        type: "string",
        description: "Optional ISO timestamp for time-aware topic retrieval",
      },
      graph_expansion_limit: {
        type: "integer",
        minimum: 0,
        maximum: 20,
        default: 3,
        description: "Bounded graph neighbors added after direct topic matches",
      },
      graph_max_depth: {
        type: "integer",
        minimum: 0,
        maximum: 5,
        default: 2,
        description: "Maximum graph-expansion depth for topic context",
      },
      max_output_chars: {
        type: "integer",
        minimum: MIN_OUTPUT_CHARS,
        maximum: MAX_OUTPUT_CHARS,
        default: DEFAULT_OUTPUT_CHARS,
        description:
          "Hard character budget for model-ready context; whole items are retained or omitted",
      },
      agent_id: { type: "string", description: "Agent identity" },
    },
    required: ["action"],
  },
  outputSchema: {
    type: "object",
    properties: {
      schema_version: { type: "string", const: RESULT_SCHEMA_VERSION },
      action: { type: "string", enum: ["status", "context"] },
      profile: { type: "string" },
      server: { type: "object" },
      integration: { type: "object" },
      capabilities: { type: "object" },
      degradation: { type: "array", items: { type: "object" } },
      context_id: { type: "string" },
      mode: { type: "string", enum: ["topic", "continuity", "resume", "brief"] },
      scope: { type: "object" },
      rendered_context: { type: "string" },
      rendered_hash: { type: "string" },
      items: { type: "array", items: { type: "object" } },
      retrieval_trace: { type: "object" },
      budget: { type: "object" },
      freshness: { type: "object" },
      warnings: { type: "array", items: { type: "object" } },
    },
    required: ["schema_version", "action"],
    oneOf: [
      {
        properties: { action: { const: "status" } },
        required: ["profile", "server", "integration", "scope", "capabilities", "degradation"],
      },
      {
        properties: { action: { const: "context" } },
        required: [
          "context_id",
          "mode",
          "scope",
          "rendered_context",
          "rendered_hash",
          "items",
          "retrieval_trace",
          "budget",
          "freshness",
          "warnings",
        ],
      },
    ],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function obj(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Rec)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outputBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_OUTPUT_CHARS;
  return Math.min(MAX_OUTPUT_CHARS, Math.max(MIN_OUTPUT_CHARS, Math.floor(value)));
}

function defined(values: Rec): Rec {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function memoryStatus(config: MemoryRuntimeConfig = {}): Rec {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    action: "status",
    profile: "M0",
    server: defined({
      name: "mindgraph-mcp",
      version: config.serverVersion ?? "unknown",
      base_url: config.baseUrl,
    }),
    integration: {
      adapter_state: "model_controlled",
      harness: config.harness ?? "generic",
      configured_tool_profile: config.profile ?? "general",
      automatic_capture: false,
      automatic_delivery: false,
      delivery_verification: "unsupported",
      curator_mode: "disabled",
    },
    scope: defined({ org_id: config.orgId, agent_id: config.agentId }),
    capabilities: {
      status: true,
      topic_context: true,
      authoritative_resume_context: true,
      bounded_rendering: true,
      structured_content: true,
      typed_explicit_writes: true,
      lifecycle_event_ingest: false,
      automatic_context_injection: false,
      curator_mutation: false,
    },
    degradation: [
      {
        code: "automatic_capture_unavailable",
        message: "M0 does not observe host lifecycle events; explicit typed write tools remain available.",
      },
      {
        code: "delivery_unverified",
        message: "A successful MCP read does not prove that the host injected or used the returned context.",
      },
      {
        code: "curator_disabled",
        message: "Curator proposals and autonomous mutation are not enabled in M0.",
      },
    ],
  };
}

function nodeType(node: Rec): string {
  const raw = node.node_type;
  if (typeof raw === "string") return raw;
  return text(obj(raw)?.Custom) ?? "Node";
}

function compactItem(raw: unknown, fallbackType?: string): Rec | undefined {
  const wrapper = obj(raw);
  if (!wrapper) return undefined;
  const value = obj(wrapper.node) ?? obj(wrapper.object) ?? wrapper;
  const uid = text(value.uid) ?? text(value.chunk_uid);
  if (!uid) return undefined;
  return defined({
    uid,
    type: fallbackType ?? nodeType(value),
    label: text(value.label) ?? text(value.document_title),
    truth_status: text(value.truth_status) ?? text(obj(value.props)?.truth_status),
    // `true` from /retrieve, an object naming the replacement from /retrieve/context.
    superseded: value.superseded ? true : undefined,
    currently_valid: value.currently_valid === false ? false : undefined,
    valid_at_time: value.valid_at_time === false ? false : undefined,
    retrieval_origin: text(value.retrieval_origin),
    retrieval_depth:
      typeof value.retrieval_depth === "number" ? value.retrieval_depth : undefined,
  });
}

function topicCandidates(raw: unknown): Rec[] {
  const payload = obj(raw);
  if (!payload) return [];
  const graph = obj(payload.graph);
  const items: Rec[] = [];
  for (const article of Array.isArray(payload.articles) ? payload.articles : []) {
    const item = compactItem(article, "Article");
    if (item) items.push(item);
  }
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const labels = new Map<string, string>();
  for (const node of rawNodes) {
    const item = compactItem(node);
    if (item) {
      if (HIDDEN_CONTEXT_NODE_TYPES.has(text(item.type) ?? "")) continue;
      items.push(item);
      const uid = text(item.uid);
      const label = text(item.label);
      if (uid && label) labels.set(uid, label);
    }
  }
  for (const rawEdge of Array.isArray(graph?.edges) ? graph.edges : []) {
    const edge = obj(rawEdge);
    const fromUid = text(edge?.from_uid);
    const toUid = text(edge?.to_uid);
    const edgeType = text(edge?.edge_type) ?? text(obj(edge?.edge_type)?.Custom);
    if (
      !fromUid ||
      !toUid ||
      !edgeType ||
      HIDDEN_CONTEXT_EDGE_TYPES.has(edgeType) ||
      !labels.has(fromUid) ||
      !labels.has(toUid)
    ) {
      continue;
    }
    items.push(
      defined({
        type: "Relationship",
        from_uid: fromUid,
        to_uid: toUid,
        edge_type: edgeType,
        from_label: labels.get(fromUid),
        to_label: labels.get(toUid),
      }),
    );
  }
  for (const chunk of Array.isArray(payload.chunks) ? payload.chunks : []) {
    const item = compactItem(chunk, "SourceExcerpt");
    if (item) items.push(item);
  }
  return items;
}

function resumeCandidates(raw: unknown): Rec[] {
  const payload = obj(raw);
  if (!payload) return [];
  const items: Rec[] = [];
  for (const key of ["task", "goal", "project", "plan", "active_execution", "lease"] as const) {
    const item = compactItem(payload[key], key);
    if (item) items.push(item);
  }
  for (const value of Array.isArray(payload.other_eligible) ? payload.other_eligible : []) {
    const item = compactItem(value, "Task");
    if (item) items.push(item);
  }
  for (const key of ["next_steps", "recent_executions", "blockers", "code_targets"] as const) {
    for (const value of Array.isArray(payload[key]) ? payload[key] : []) {
      const item = compactItem(value, key.replace(/s$/, ""));
      if (item) items.push(item);
    }
  }
  const knowledge = obj(payload.knowledge);
  for (const key of ["lessons", "risks"] as const) {
    for (const value of Array.isArray(knowledge?.[key]) ? knowledge[key] : []) {
      const item = compactItem(value, key.replace(/s$/, ""));
      if (item) items.push(item);
    }
  }
  return items;
}

const BRIEF_SECTION_ITEMS = 6;
/** The selected task plus five others: a chat brief is read every conversation. */
const BRIEF_WORK_LIMIT = 6;
/** Resume sections that only help a coding session. */
const BRIEF_DROPPED_WORK_SECTIONS = /^### (?:Code targets|Recent executions|Selection)\n(?:(?!### ).*\n?)*/gm;

function inferred(value: unknown): number {
  const node = obj(obj(value)?.node) ?? obj(value);
  return text(obj(node?.props)?.source) ? 1 : 0;
}

function updatedAt(value: unknown): number {
  const node = obj(obj(value)?.node) ?? obj(value);
  return typeof node?.updated_at === "number" ? node.updated_at : 0;
}
const BRIEF_LABEL_CHARS = 160;

function briefLine(item: Rec, detail?: string): string {
  const label = text(item.label) ?? "(unlabeled)";
  const shown =
    label.length > BRIEF_LABEL_CHARS ? `${label.slice(0, BRIEF_LABEL_CHARS - 1)}…` : label;
  return `- ${shown} [${String(item.uid)}]${detail ? ` — ${detail}` : ""}`;
}

/** One section: up to six items, the rest counted, never silently dropped. */
function briefSection(title: string, values: unknown, type: string): { text?: string; items: Rec[] } {
  const all = (Array.isArray(values) ? values : [])
    .map((value) => {
      const item = compactItem(value, type);
      if (!item) return undefined;
      const node = obj(obj(value)?.node) ?? obj(value);
      const status = text(obj(node?.props)?.status);
      return { item, status };
    })
    .filter((entry): entry is { item: Rec; status: string | undefined } => Boolean(entry));
  if (all.length === 0) return { items: [] };
  const shown = all.slice(0, BRIEF_SECTION_ITEMS);
  const more = all.length - shown.length;
  return {
    text: [
      `## ${title}${more > 0 ? ` (${shown.length} shown, ${more} more)` : ""}`,
      ...shown.map(({ item, status }) => briefLine(item, status)),
    ].join("\n"),
    items: shown.map(({ item }) => item),
  };
}

/**
 * The orientation a chat app reads at the start of a conversation, where no
 * hook can inject one: work in progress, active goals, open decisions and
 * stored preferences. Sections are read in parallel; one that fails is named
 * in `unavailable` and left out, so an empty section always means "none".
 */
async function conversationBrief(
  client: MemoryClient,
  args: Rec,
  agentId: string | undefined,
  budget: number,
): Promise<{ raw: Rec; rendered: string; candidates: Rec[]; unavailable: string[] } | undefined> {
  const scopeUids = Array.from(
    new Set([
      ...(Array.isArray(args.scope_uids) ? args.scope_uids.map(String) : []),
      ...(text(args.project_uid) ? [text(args.project_uid)!] : []),
    ]),
  );
  const [work, goals, decisions, preferences] = await Promise.allSettled([
    client.plan(
      defined({
        action: "resume_work",
        scope_uids: scopeUids.length > 0 ? scopeUids : undefined,
        limit: BRIEF_WORK_LIMIT,
        agent_id: agentId,
      }) as never,
    ),
    client.getGoals ? client.getGoals() : Promise.reject(new Error("unsupported")),
    client.getOpenDecisions ? client.getOpenDecisions() : Promise.reject(new Error("unsupported")),
    client.retrieve
      ? client.retrieve({ action: "preferences", k: BRIEF_SECTION_ITEMS + 2 } as never)
      : Promise.reject(new Error("unsupported")),
  ]);
  const settled = { work, goals, decisions, preferences };
  const unavailable = Object.entries(settled)
    .filter(([, result]) => result.status === "rejected")
    .map(([name]) => (name === "work" ? "work in progress" : name === "decisions" ? "open decisions" : name));
  if (unavailable.length === 4) return undefined;
  const value = <T>(result: PromiseSettledResult<T>) =>
    result.status === "fulfilled" ? result.value : undefined;

  const sections: string[] = [];
  const candidates: Rec[] = [];
  const workRaw = value(work);
  // Work gets half the budget; the three lists are short by construction.
  const workPayload = obj(workRaw);
  const hasWork =
    Boolean(obj(workPayload?.task)) ||
    (Array.isArray(workPayload?.other_eligible) && workPayload.other_eligible.length > 0);
  const workText = hasWork
    ? renderResumeContext(workRaw, Math.floor(budget / 2))
        // The resume renderer titles its own document; here it is one section.
        ?.replace(/^# Resume context[^\n]*\n+/, "")
        .replace(/^## /gm, "### ")
        .replace(BRIEF_DROPPED_WORK_SECTIONS, "")
        // No repository names when hosted, so the grouping label says nothing.
        .replace(/^- Other scopes: /gm, "- ")
        .trimEnd()
    : undefined;
  if (workText) {
    sections.push(`## Work in progress\n${workText}`);
    candidates.push(...resumeCandidates(workRaw));
  }
  // Goals and decisions arrive in storage order; most recently touched first.
  // Preferences arrive most salient first and keep that order.
  // A goal or decision extracted from an ingested document (`source:
  // "document"`) belongs to that document's subject, not to the member; a
  // graph with a few books in it had 30 of 53 goals of that kind.
  const recentFirst = (values: unknown) =>
    Array.isArray(values)
      ? values
          .filter((entry) => {
            const node = obj(obj(entry)?.node) ?? obj(entry);
            return text(obj(node?.props)?.source) !== "document";
          })
          // Stated directly (no `source`) before inferred from a transcript
          // (`source: "session"`); most recently touched first within each.
          .sort((a, b) => inferred(a) - inferred(b) || updatedAt(b) - updatedAt(a))
      : values;
  for (const [title, values, type] of [
    ["Active goals", recentFirst(value(goals)), "Goal"],
    ["Open decisions", recentFirst(value(decisions)), "Decision"],
    ["Preferences", value(preferences), "Preference"],
  ] as const) {
    const section = briefSection(title, values, type);
    if (section.text) sections.push(section.text);
    candidates.push(...section.items);
  }
  const body =
    sections.length > 0
      ? sections.join("\n\n")
      : "Nothing to orient on yet: no work in progress, active goals, open decisions or stored preferences.";
  const rendered =
    body.length > budget ? `${body.slice(0, Math.max(0, budget - 40)).trimEnd()}\n…[brief truncated to the output budget]` : body;
  return {
    raw: defined({
      work: workRaw,
      goals: value(goals),
      decisions: value(decisions),
      preferences: value(preferences),
    }),
    rendered,
    candidates,
    unavailable,
  };
}

function visibleItems(candidates: Rec[], rendered: string): Rec[] {
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const uid = text(item.uid);
    if (uid) {
      if (seen.has(uid) || !rendered.includes(`[${uid}]`)) return false;
      seen.add(uid);
      return true;
    }
    if (item.type === "Relationship") {
      const from = text(item.from_label);
      const to = text(item.to_label);
      const edgeType = text(item.edge_type);
      if (!from || !to || !edgeType) return false;
      const key = `${text(item.from_uid)}:${edgeType}:${text(item.to_uid)}`;
      if (seen.has(key) || !rendered.includes(`${from} —${edgeType}→ ${to}`)) return false;
      seen.add(key);
      return true;
    }
    return false;
  });
}

function latestTimestamp(value: unknown): string | undefined {
  let latest: string | undefined;
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    const record = obj(current);
    if (!record) return;
    for (const [key, item] of Object.entries(record)) {
      if (
        ["updated_at", "created_at", "completed_at", "started_at", "observed_at"].includes(key) &&
        typeof item === "string" &&
        !Number.isNaN(Date.parse(item)) &&
        (!latest || Date.parse(item) > Date.parse(latest))
      ) {
        latest = item;
      }
      visit(item);
    }
  };
  visit(value);
  return latest;
}

function contextWarnings(raw: unknown, rendered: string, available: number, returned: number): Rec[] {
  const warnings: Rec[] = [
    {
      code: "delivery_unverified",
      message: "The MCP server returned this context but cannot verify that the host injected or used it.",
    },
  ];
  const serialized = JSON.stringify(raw);
  if (available > returned || rendered.includes("item(s) omitted")) {
    warnings.push({
      code: "context_bounded",
      message: `${Math.max(0, available - returned)} structured item(s) were omitted from the rendered context.`,
    });
  }
  if (/"superseded":(?:true|\{)/.test(serialized)) {
    warnings.push({ code: "superseded_items_present", message: "Some retrieved items are superseded." });
  }
  if (/"currently_valid":false|"valid_at_time":false/.test(serialized)) {
    warnings.push({
      code: "validity_warning",
      message: "Some retrieved items are outside their current or requested validity window.",
    });
  }
  const payload = obj(raw);
  if (payload?.truncated === true || obj(payload?.truncation)) {
    const truncation = obj(payload?.truncation);
    if (payload?.truncated === true || Object.values(truncation ?? {}).some(Boolean)) {
      warnings.push({ code: "source_truncated", message: "The authoritative source reported truncated fields." });
    }
  }
  if (text(payload?.warning)) {
    warnings.push({ code: "source_warning", message: text(payload?.warning)! });
  }
  return warnings;
}

function error(message: string): MemoryToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export async function handleMemoryTool(
  client: MemoryClient,
  args: Rec,
  config: MemoryRuntimeConfig = {},
): Promise<MemoryToolResult> {
  const action = text(args.action);
  if (action === "status") {
    const status = memoryStatus({ ...config, agentId: text(args.agent_id) ?? config.agentId });
    return {
      content: [{ type: "text", text: JSON.stringify(status) }],
      structuredContent: status,
    };
  }
  if (action !== "context") {
    return error("action must be 'status' or 'context'");
  }

  const mode = text(args.mode) ?? (text(args.query) ? "topic" : undefined);
  if (!mode || !["topic", "continuity", "resume", "brief"].includes(mode)) {
    return error("action='context' requires mode='brief', 'topic', 'continuity', or 'resume'");
  }
  const budget = outputBudget(args.max_output_chars);
  const agentId = text(args.agent_id) ?? config.agentId;
  let raw: unknown;
  let rendered: string;
  let strategy: "retrieve_context" | "resume_work" | "brief";
  let candidates: Rec[];
  let workspace: RepositoryScope | undefined;
  let briefUnavailable: string[] = [];

  if (mode === "brief") {
    const brief = await conversationBrief(client, args, agentId, budget);
    if (!brief) {
      return error("The brief could not be read: every section failed. Try mode='resume' or mode='topic'.");
    }
    ({ raw, rendered, candidates } = brief);
    briefUnavailable = brief.unavailable;
    strategy = "brief";
  } else if (mode === "topic") {
    const query = text(args.query);
    if (!query) return error("mode='topic' requires a non-empty query of 1-3 discriminating keywords");
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(50, Math.max(1, Math.floor(args.limit)))
        : 8;
    const request = defined({
        query,
        project_uid: text(args.project_uid),
        node_limit: limit,
        node_types: Array.isArray(args.node_types) ? args.node_types.map(String) : undefined,
        layer: text(args.layer),
        chunk_limit: args.include_chunks === true ? limit : 0,
        article_limit: args.include_documents === true ? limit : 0,
        valid_at: text(args.valid_at),
        include_graph: true,
        graph_expansion_limit:
          typeof args.graph_expansion_limit === "number" ? args.graph_expansion_limit : 3,
        graph_max_depth: typeof args.graph_max_depth === "number" ? args.graph_max_depth : 2,
      }) as unknown as Parameters<MemoryClient["retrieveContext"]>[0];
    raw = await client.retrieveContext(request);
    rendered = renderContext(raw, budget) ?? "No results found for this search.";
    strategy = "retrieve_context";
    candidates = topicCandidates(raw);
  } else {
    if (args.scope !== undefined && args.scope !== "workspace") {
      return error("scope must be 'workspace' when given");
    }
    if (args.scope === "workspace") {
      if (!config.resolveWorkspaceScope) {
        return error(
          "scope='workspace' needs the local MindGraph MCP server, which reads .mindgraph/workspace.json beside the checkout; this server has no working directory. Pass scope_uids instead.",
        );
      }
      workspace = await config.resolveWorkspaceScope(agentId ?? "mcp");
      if (workspace.uids.length === 0) {
        // Unscoped would select from every task in the org and call it the
        // workspace.
        return error(
          `scope='workspace' resolved no repositories${workspace.failures.length > 0 ? ` (${workspace.failures.join("; ")})` : ""}`,
        );
      }
    }
    const scopeUids = Array.from(
      new Set([
        ...(Array.isArray(args.scope_uids) ? args.scope_uids.map(String) : []),
        ...(text(args.project_uid) ? [text(args.project_uid)!] : []),
        ...(workspace?.uids ?? []),
      ]),
    );
    raw = await client.plan(
      defined({
        action: "resume_work",
        task_uid: text(args.task_uid),
        session_uid: text(args.session_uid),
        scope_uids: scopeUids.length > 0 ? scopeUids : undefined,
        limit: workspace ? WORKSPACE_RESUME_LIMIT : 1,
        agent_id: agentId,
      }) as never,
    );
    rendered =
      renderResumeContext(raw, budget, workspace?.names) ??
      "No eligible work was found in the requested scope.";
    strategy = "resume_work";
    candidates = resumeCandidates(raw);
  }

  const items = visibleItems(candidates, rendered);
  const renderedHash = sha256(rendered);
  const scope = defined({
    org_id: config.orgId,
    agent_id: agentId,
    harness: config.harness ?? "generic",
    project_uid: text(args.project_uid),
    task_uid: text(args.task_uid),
    session_uid: text(args.session_uid),
    scope_uids: Array.isArray(args.scope_uids) ? args.scope_uids.map(String) : undefined,
    workspace_repositories: workspace ? Object.values(workspace.names).sort() : undefined,
  });
  const contextId = `ctx_${sha256(
    stableJson({ mode, scope, strategy, query: text(args.query), rendered_hash: renderedHash }),
  ).slice(0, 24)}`;
  const bounded = candidates.length > items.length || rendered.includes("item(s) omitted");
  const result: Rec = {
    schema_version: RESULT_SCHEMA_VERSION,
    action: "context",
    context_id: contextId,
    mode,
    scope,
    rendered_context: rendered,
    rendered_hash: renderedHash,
    items,
    retrieval_trace: defined({
      strategy,
      query: text(args.query),
      project_uid: text(args.project_uid),
      task_uid: text(args.task_uid),
      session_uid: text(args.session_uid),
      node_types: Array.isArray(args.node_types) ? args.node_types.map(String) : undefined,
      graph_expansion_limit: mode === "topic" ? (args.graph_expansion_limit ?? 3) : undefined,
      graph_max_depth: mode === "topic" ? (args.graph_max_depth ?? 2) : undefined,
      available_items: candidates.length,
      returned_items: items.length,
      omitted_items: Math.max(0, candidates.length - items.length),
    }),
    budget: {
      unit: "characters",
      requested_chars: budget,
      used_chars: rendered.length,
      available_items: candidates.length,
      returned_items: items.length,
      omitted_items: Math.max(0, candidates.length - items.length),
      bounded,
    },
    freshness: defined({
      valid_at: text(args.valid_at),
      latest_source_timestamp: latestTimestamp(raw),
    }),
    warnings: [
      ...contextWarnings(raw, rendered, candidates.length, items.length),
      ...(briefUnavailable.length > 0
        ? [
            {
              code: "brief_section_unavailable",
              message: `Not read, so absent from this brief (not evidence there are none): ${briefUnavailable.join(", ")}.`,
            },
          ]
        : []),
      ...(workspace && workspace.failures.length > 0
        ? [
            {
              code: "workspace_scope_partial",
              message: `${workspace.failures.length} declared repositories did not resolve and were left out: ${workspace.failures.join("; ")}`,
            },
          ]
        : []),
    ],
  };
  return {
    content: [{ type: "text", text: rendered }],
    structuredContent: result,
  };
}
