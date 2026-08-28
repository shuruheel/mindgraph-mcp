// ── Rendered tool output ──────────────────────────────────────────────
//
// The general read tools used to return the server's wire JSON verbatim,
// pretty-printed: full typed props with every null field, unbounded
// source-chunk offset arrays, curation edges, and retrieval-expansion
// metadata. A single live `retrieve context` call measured ~15k tokens for
// ~2k tokens of signal, and chat harnesses (ChatGPT desktop, Claude
// Desktop) burned that on every retrieval.
//
// This module renders read responses the way the dashboard chat formats the
// same endpoint for its model (mindgraph-dashboard chat route): articles
// first, nodes grouped by type with status/confidence/provenance tags, one
// short source quote, relationships as label lines. One deliberate
// difference: node UIDs stay in the output — MCP models chain follow-up
// tool calls by uid, where dashboard models cite by document title.
//
// Wire-shape notes (verified against mindgraph-server, adversarial review
// 2026-07-30): /retrieve text|semantic|hybrid|preferences return
// `[{node, score, legs?}]` (SearchResult — unwrapped here); /traverse
// top_k_paths returns `{paths: [{node_uids, labels, cost}]}`; context edges
// use SCREAMING_SNAKE edge types while traverse serializes PascalCase.
//
// Rendering is for MODELS reading context. Machine-parsed surfaces
// (mindgraph_plan, sync, code — the hooks re-sync fencing state from those
// payloads) are never rendered, and `format: "json"` is the per-call escape
// hatch back to the raw response.

const LABEL_MAX = 200;
const SUMMARY_MAX = 400;
const QUOTE_MAX = 180;
const ARTICLE_MAX = 6_000;
// A full ingestion chunk is 400-800 words (~5,200 chars max) — the clip must
// not defeat include_chunks' stated purpose (verbatim quotes, citations).
const CHUNK_MAX = 6_000;
const RELATIONSHIP_MAX = 40;
const RENDER_CHAR_BUDGET = 24_000;
const MIN_RENDER_CHAR_BUDGET = 512;
const BOUNDED_MARKER_RESERVE = 220;

// Curation-inbox data has its own surface (`merge_candidates`); shipping it
// as knowledge context confused models with reviewer metadata ("LLM review:
// related but distinct", similarity scores) — observed live. Context
// responses spell edge types SCREAMING_SNAKE; traverse serializes the enum
// PascalCase — match both.
const CURATION_EDGE_TYPES = new Set(["POSSIBLE_DUPLICATE", "PossibleDuplicate"]);
// Infra nodes render through their own sections (articles, source tags,
// document_index), not as graph knowledge.
const INFRA_NODE_TYPES = new Set(["Chunk", "Document", "Article"]);

type Rec = Record<string, unknown>;

/** A renderable section: heading + independent items, packed item-wise
 * against the budget so one oversized section can never blank the output. */
interface Section {
  heading: string;
  items: string[];
}

interface RenderState {
  bounded: boolean;
  omitted: number;
}

function obj(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Serde externally tags user-defined enum variants as `{Custom: "NAME"}`.
 * Hand-projected endpoint responses use the plain string. Model-facing output
 * must treat these as the same semantic value rather than leaking transport
 * punctuation or replacing a real relation with `?`. */
function edgeTypeName(value: unknown): string | undefined {
  return str(value) ?? str(obj(value)?.Custom);
}

function renderBudget(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return RENDER_CHAR_BUDGET;
  return Math.min(
    RENDER_CHAR_BUDGET,
    Math.max(MIN_RENDER_CHAR_BUDGET, Math.floor(requested)),
  );
}

function clip(value: unknown, max: number, state: RenderState): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  if (text.length <= max) return text;
  state.bounded = true;
  return `${text.slice(0, max - 1)}…`;
}

function isNodeShaped(value: unknown): value is Rec {
  const node = obj(value);
  // node_type may be an externally-tagged object ({"Custom":"Customer"}) on
  // serde-derived surfaces — presence of either form counts.
  return Boolean(
    node &&
      str(node.uid) &&
      (str(node.label) || str(node.node_type) || obj(node.node_type)),
  );
}

/** Display type for a node across BOTH wire families: retrieve-context
 * hand-projects (`node_type: "Customer"` string, bare props with top-level
 * fields), while serde-derived surfaces (ontology handlers) emit externally
 * tagged node_type ({"Custom":"Customer"}) and `_type`-tagged props with the
 * payload under `data`. */
function nodeDisplayType(node: Rec): string {
  const props = obj(node.props);
  const plain = str(node.node_type);
  // A literal "Custom" is the container, not the domain type — prefer the
  // specific type wherever any wire family carries it.
  return (
    (plain && plain !== "Custom" ? plain : undefined) ??
    str(obj(node.node_type)?.Custom) ??
    str(props?.object_type) ??
    str(props?.type_name) ??
    str(obj(props?.data)?.domain_type) ??
    plain ??
    "Node"
  );
}

function nodeFields(node: Rec): Rec | undefined {
  const props = obj(node.props);
  return obj(props?.fields) ?? obj(obj(props?.data)?.fields);
}

/** /retrieve search actions return SearchResult `{node, score, legs?}` —
 * unwrap to the node, carrying the score along for display. */
function unwrapSearchResult(value: unknown): Rec | undefined {
  if (isNodeShaped(value)) return value;
  const wrapper = obj(value);
  // /retrieve wraps as {node, score}; /ontology/objects/search wraps as
  // {object, score}; /ontology/query/structured rows wrap as {object,
  // related?}. All unwrap to the node, carrying the score when present.
  const inner = obj(wrapper?.node) ?? obj(wrapper?.object);
  if (inner && isNodeShaped(inner)) {
    const score = num(wrapper!.score);
    return score !== undefined ? { ...inner, retrieval_score: score } : inner;
  }
  return undefined;
}

/** Epistemics the raw JSON buries — without these a model states refuted or
 * superseded knowledge as current (the dashboard learned this live). */
function statusTag(node: Rec): string {
  const tags: string[] = [];
  if (node.superseded === true) {
    tags.push(
      node.superseded_by
        ? `SUPERSEDED by ${str(node.superseded_by)}`
        : "SUPERSEDED",
    );
  }
  const truth = str(node.truth_status) ?? str(obj(node.props)?.truth_status);
  if (truth && truth !== "accepted") tags.push(`truth: ${truth}`);
  if (node.currently_valid === false) tags.push("OUTSIDE ITS VALIDITY WINDOW");
  if (node.valid_at_time === false) tags.push("NOT VALID AT THE REQUESTED TIME");
  return tags.length > 0 ? ` [${tags.join("; ")}]` : "";
}

function firstQuote(node: Rec, state: RenderState): string | undefined {
  const chunks = Array.isArray(node.source_chunks) ? node.source_chunks : [];
  for (const raw of chunks) {
    const chunk = obj(raw);
    const quote = str(chunk?.quote) ?? str(obj(chunk?.anchor)?.exact);
    if (quote) return clip(quote, QUOTE_MAX, state);
  }
  return undefined;
}

function sourceTag(node: Rec): string | undefined {
  const docs = Array.isArray(node.source_documents) ? node.source_documents : [];
  const first = obj(docs[0]);
  const title = str(first?.title);
  if (!title) return undefined;
  const extra = docs.length > 1 ? ` (+${docs.length - 1} more)` : "";
  return `from: ${title}${extra}`;
}

function layer7Fields(node: Rec, state: RenderState): string | undefined {
  const fields = nodeFields(node);
  if (!fields) return undefined;
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  if (pairs.length === 0) return undefined;
  return clip(pairs.join("; "), SUMMARY_MAX, state);
}

function nodeSummaryText(node: Rec, state: RenderState): string | undefined {
  const props = obj(node.props);
  return (
    clip(node.summary, SUMMARY_MAX, state) ??
    clip(props?.content, SUMMARY_MAX, state) ??
    clip(props?.description, SUMMARY_MAX, state) ??
    clip(props?.definition, SUMMARY_MAX, state)
  );
}

function nodeLines(node: Rec, state: RenderState): string {
  const label = clip(node.label, LABEL_MAX, state) || "(unlabeled)";
  const type = nodeDisplayType(node);
  const confidence = num(node.confidence);
  const score = num(node.retrieval_score);
  const parenthetical = [
    type,
    confidence !== undefined ? `confidence ${confidence}` : undefined,
    score !== undefined ? `score ${Math.round(score * 100) / 100}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const head = `- **${label}** [${str(node.uid) || "?"}] (${parenthetical})${statusTag(node)}`;
  const summary = nodeSummaryText(node, state);
  const lines = [summary && summary !== label ? `${head}: ${summary}` : head];
  const fields = layer7Fields(node, state);
  if (fields) lines.push(`  - fields: ${fields}`);
  const quote = firstQuote(node, state);
  if (quote) lines.push(`  - source quote: "${quote}"`);
  const source = sourceTag(node);
  if (source) lines.push(`  - ${source}`);
  const believers = Array.isArray(node.believed_by) ? node.believed_by : [];
  if (believers.length > 0) {
    const rendered = believers
      .slice(0, 3)
      .map((raw) => {
        const believer = obj(raw);
        const conf = num(believer?.confidence);
        return `${str(believer?.agent_label) || "?"}${conf !== undefined ? ` (${conf})` : ""}`;
      })
      .join(", ");
    lines.push(`  - believed by: ${rendered}`);
  }
  return lines.join("\n");
}

function groupedNodeSections(
  nodes: Rec[],
  state: RenderState,
  headingPrefix = "",
): Section[] {
  const groups = new Map<string, Rec[]>();
  for (const node of nodes) {
    const type = nodeDisplayType(node);
    const group = groups.get(type) ?? [];
    group.push(node);
    groups.set(type, group);
  }
  const sections: Section[] = [];
  let first = true;
  for (const [type, group] of groups) {
    sections.push({
      heading: `${first ? headingPrefix : ""}### ${type}`,
      items: group.map((node) => nodeLines(node, state)),
    });
    first = false;
  }
  return sections;
}

function relationshipItems(
  edges: unknown[],
  labelByUid: Map<string, string>,
  state: RenderState,
  options?: { fallbackToUid?: boolean },
): string[] {
  const lines: string[] = [];
  for (const raw of edges) {
    const edge = obj(raw);
    if (!edge) continue;
    const type = edgeTypeName(edge.edge_type) || "?";
    const from = str(edge.from_uid);
    const to = str(edge.to_uid);
    if (CURATION_EDGE_TYPES.has(type)) continue;
    if (!from || !to || from === to) continue; // self-loops are data noise
    // Ontology surfaces reference endpoints outside the object list
    // (cognitive neighbors); dropping those edges lost real information —
    // fall back to the uid there rather than hiding the relation.
    const fromLabel = labelByUid.get(from) ?? (options?.fallbackToUid ? `[${from}]` : undefined);
    const toLabel = labelByUid.get(to) ?? (options?.fallbackToUid ? `[${to}]` : undefined);
    if (!fromLabel || !toLabel) continue;
    lines.push(`- ${fromLabel} —${type}→ ${toLabel}`);
  }
  if (lines.length > RELATIONSHIP_MAX) {
    state.bounded = true;
    const extra = lines.length - RELATIONSHIP_MAX;
    state.omitted += extra;
    return [...lines.slice(0, RELATIONSHIP_MAX), `- (+${extra} more relationships)`];
  }
  return lines;
}

/** Pack sections item-wise under the budget. A section whose heading fits
 * gets as many whole items as fit; the rest are counted, never cut mid-item.
 * Later sections still get a chance (no early break) — one oversized section
 * must never blank the rest of the output. */
function assemble(
  header: string,
  sections: Section[],
  state: RenderState,
  maxChars?: number,
): string {
  const budget = renderBudget(maxChars);
  // Always reserve room for a truthful truncation marker. This keeps the hard
  // bound even when the final accepted item ends exactly at the requested cap.
  const packingBudget = Math.max(header.length, budget - BOUNDED_MARKER_RESERVE);
  const lines: string[] = [header];
  let used = header.length;
  for (const section of sections) {
    if (section.items.length === 0 && !section.heading) continue;
    const headingCost = section.heading.length + 2;
    if (used + headingCost > packingBudget) {
      state.bounded = true;
      state.omitted += Math.max(1, section.items.length);
      continue;
    }
    let sectionUsed = 0;
    const kept: string[] = [];
    let dropped = 0;
    for (const item of section.items) {
      if (used + headingCost + sectionUsed + item.length + 1 > packingBudget) {
        dropped += 1;
        continue;
      }
      kept.push(item);
      sectionUsed += item.length + 1;
    }
    if (kept.length === 0 && section.items.length > 0) {
      state.bounded = true;
      state.omitted += dropped;
      continue;
    }
    if (dropped > 0) {
      state.bounded = true;
      state.omitted += dropped;
      const marker = `(+${dropped} more not shown)`;
      if (used + headingCost + sectionUsed + marker.length + 1 <= packingBudget) {
        kept.push(marker);
        sectionUsed += marker.length + 1;
      }
    }
    lines.push(
      section.items.length === 0
        ? section.heading
        : section.heading
          ? `${section.heading}\n${kept.join("\n")}`
          : kept.join("\n"),
    );
    used += headingCost + sectionUsed;
  }
  if (state.bounded) {
    lines.push(
      `…[rendered context bounded to ${budget} chars; ${state.omitted} item(s) omitted — fetch full node content by uid, narrow the query, raise max_output_chars, or pass format: "json" for the raw response]`,
    );
  }
  return lines.join("\n\n").slice(0, budget);
}

function policySections(payload: Rec, state: RenderState): Section[] {
  const policies = Array.isArray(payload.applicable_policies)
    ? payload.applicable_policies
    : [];
  if (policies.length === 0) return [];
  const items = policies
    .map((raw) => obj(raw))
    .filter((policy): policy is Rec => Boolean(policy))
    .map((policy) => {
      // prose_rules is Vec<String> on the wire.
      const rules = Array.isArray(policy.prose_rules)
        ? policy.prose_rules.map(String).join("; ")
        : policy.prose_rules;
      return `- ${str(policy.name) || "(unnamed policy)"}: ${clip(rules, SUMMARY_MAX, state) || "(structured rules apply)"}`;
    });
  return [{ heading: "## Applicable policies", items }];
}

function hiddenSections(payload: Rec): Section[] {
  const hidden = payload.hidden_item_count;
  if (hidden === undefined || hidden === null) return [];
  return [
    {
      heading: `Note: ${hidden} item(s) were hidden by access scoping.`,
      items: [],
    },
  ];
}

/** Render a /retrieve/context response. */
export function renderContext(response: unknown, maxChars?: number): string | undefined {
  const payload = obj(response);
  if (!payload) return undefined;
  const graph = obj(payload.graph);
  const rawNodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
  const shaped = rawNodes.filter(isNodeShaped);
  const nodes = shaped.filter((node) => !INFRA_NODE_TYPES.has(str(node.node_type) || ""));
  const infraOnly = shaped.length - nodes.length;
  const articles = Array.isArray(payload.articles) ? payload.articles : [];
  const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  const state: RenderState = { bounded: false, omitted: 0 };
  const sections: Section[] = [];
  if (articles.length > 0) {
    sections.push({
      heading: "## Knowledge articles",
      items: articles
        .map((raw) => obj(raw))
        .filter((article): article is Rec => Boolean(article))
        .map(
          (article) =>
            `### ${str(article.label) || "(untitled)"} [${str(article.uid) || "?"}]\n${clip(article.content, ARTICLE_MAX, state) || ""}`,
        ),
    });
  }
  if (nodes.length > 0) {
    sections.push(...groupedNodeSections(nodes, state, "## Knowledge graph\n\n"));
    const labelByUid = new Map<string, string>();
    for (const node of nodes) labelByUid.set(str(node.uid)!, str(node.label) || "?");
    const relationships = relationshipItems(
      Array.isArray(graph?.edges) ? graph!.edges : [],
      labelByUid,
      state,
    );
    if (relationships.length > 0) {
      sections.push({ heading: "## Relationships", items: relationships });
    }
  } else if (infraOnly > 0) {
    sections.push({
      heading: `Note: ${infraOnly} document/chunk node(s) matched — use action "document_index" or include_chunks for their content.`,
      items: [],
    });
  }
  if (chunks.length > 0) {
    sections.push({
      heading: "## Source excerpts",
      items: chunks
        .map((raw) => obj(raw))
        .filter((chunk): chunk is Rec => Boolean(chunk))
        .map(
          (chunk) =>
            `- [${str(chunk.chunk_uid) || "?"}] from "${str(chunk.document_title) || "unknown document"}": "${clip(chunk.content, CHUNK_MAX, state) || ""}"`,
        ),
    });
  }
  sections.push(...policySections(payload, state));
  sections.push(...hiddenSections(payload));
  if (sections.length === 0) {
    return "No results found for this search.";
  }
  if (nodes.length === 0 && articles.length === 0 && chunks.length === 0) {
    // Policies/hidden-count/infra notes still render — an access-filtered
    // result must not read as "nothing exists".
    return assemble(
      "# Retrieved context\n\nNo graph results matched this search.",
      sections,
      state,
      maxChars,
    );
  }
  return assemble("# Retrieved context", sections, state, maxChars);
}

/** Render any response whose payload is (or contains) a list of nodes —
 * bare GraphNode arrays and SearchResult `{node, score}` arrays alike. */
export function renderNodeList(
  response: unknown,
  title: string,
  limit?: number,
  maxChars?: number,
): string | undefined {
  let candidates: unknown[] = [];
  if (Array.isArray(response)) {
    candidates = response;
  } else {
    const payload = obj(response);
    if (!payload) return undefined;
    for (const key of ["nodes", "results", "items", "goals", "questions", "claims", "preferences", "documents"]) {
      const candidate = payload[key];
      if (Array.isArray(candidate) && candidate.some((entry) => unwrapSearchResult(entry))) {
        candidates = candidate;
        break;
      }
    }
  }
  let nodes = candidates
    .map(unwrapSearchResult)
    .filter((node): node is Rec => Boolean(node));
  if (nodes.length === 0) return undefined; // caller falls back to raw JSON
  const total = nodes.length;
  const state: RenderState = { bounded: false, omitted: 0 };
  // The server ignores limit for several unscoped structured queries (up to
  // its 200-row cap) — honor the caller's bound here.
  if (limit !== undefined && limit > 0 && nodes.length > limit) {
    state.omitted += nodes.length - limit;
    nodes = nodes.slice(0, limit);
    state.bounded = true;
  }
  const sections = groupedNodeSections(nodes, state);
  const shown = nodes.length;
  return assemble(
    `# ${title} (${shown === total ? total : `${shown} of ${total}`})`,
    sections,
    state,
    maxChars,
  );
}

/** Render a traversal response: nodes + edges, and paths.
 * top_k_paths wire: `{paths: [{node_uids, labels, cost}]}`. */
export function renderTraversal(response: unknown, maxChars?: number): string | undefined {
  const directSteps = Array.isArray(response) ? response : undefined;
  const payload = obj(response);
  if (!payload && !directSteps) return undefined;
  const body = payload ?? {};
  const container = obj(body.graph) ?? body;
  const rawNodes = Array.isArray(container.nodes) ? container.nodes : [];
  const nodes = rawNodes.filter(isNodeShaped);
  const paths = Array.isArray(body.paths) ? body.paths : [];
  const hasSteps = directSteps !== undefined || Object.hasOwn(body, "steps");
  const rawSteps = directSteps ?? (Array.isArray(body.steps) ? body.steps : []);
  if (nodes.length === 0 && paths.length === 0 && !hasSteps) return undefined;
  const state: RenderState = { bounded: false, omitted: 0 };
  const sections: Section[] = [];
  const labelByUid = new Map<string, string>();
  for (const node of nodes) labelByUid.set(str(node.uid)!, str(node.label) || "?");
  if (paths.length > 0) {
    const items = paths
      .map((raw) => obj(raw))
      .filter((path): path is Rec => Boolean(path))
      .map((path, index) => {
        const uids = Array.isArray(path.node_uids) ? path.node_uids.map(String) : [];
        const labels = Array.isArray(path.labels)
          ? path.labels.map(String)
          : Array.isArray(path.nodes)
            ? path.nodes.map((hop) => {
                const hopNode = obj(hop);
                return (
                  str(hopNode?.label) ||
                  labelByUid.get(str(hopNode?.uid) || "") ||
                  str(hop) ||
                  "?"
                );
              })
            : [];
        const route = labels.length > 0 ? labels.join(" → ") : uids.join(" → ") || "(path)";
        const cost = num(path.cost) ?? num(path.path_cost);
        const confidence = num(path.path_confidence);
        const meta = [
          cost !== undefined ? `cost ${cost}` : undefined,
          confidence !== undefined ? `confidence ${confidence}` : undefined,
        ].filter(Boolean);
        const head = `${index + 1}. ${route}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}`;
        // uids ride along when labels rendered — follow-up calls need them.
        return labels.length > 0 && uids.length > 0
          ? `${head}\n   uids: ${uids.join(" → ")}`
          : head;
      });
    sections.push({ heading: "## Paths", items });
  }
  if (hasSteps) {
    const stepItems = rawSteps
      .map((raw) => obj(raw))
      .filter((step): step is Rec => Boolean(step))
      .map((step) => {
        const depth = num(step.depth);
        const uid = str(step.node_uid) ?? str(step.uid) ?? str(step.edge_to_uid) ?? "?";
        const parent = str(step.parent_uid) ?? str(step.edge_from_uid);
        const label = str(step.label) || "(unlabeled)";
        const relation = edgeTypeName(step.edge_type);
        const role = str(step.traversal_role);
        const type = str(step.node_type) ?? str(obj(step.node_type)?.Custom);
        const cost = num(step.path_cost);
        const confidence = num(step.path_confidence);
        const prefix = [
          depth !== undefined ? `depth ${depth}` : undefined,
          role,
          relation ? `—${relation}→` : undefined,
        ].filter(Boolean).join(" ");
        const meta = [
          type,
          parent ? `parent ${parent}` : undefined,
          cost !== undefined ? `cost ${cost}` : undefined,
          confidence !== undefined ? `confidence ${confidence}` : undefined,
        ].filter(Boolean).join(", ");
        return `- ${prefix ? `${prefix}: ` : ""}**${label}** [${uid}]${meta ? ` (${meta})` : ""}`;
      });
    if (stepItems.length > 0) {
      sections.push({ heading: "## Traversal steps", items: stepItems });
    } else {
      const start = str(body.start_uid) || "?";
      const end = str(body.end_uid);
      const mode = str(body.mode);
      sections.push({
        heading:
          mode === "path" && end
            ? `No path found from [${start}] to [${end}].`
            : `No traversal steps returned from [${start}].`,
        items: [],
      });
    }
  }
  if (nodes.length > 0) {
    sections.push(...groupedNodeSections(nodes, state, "## Nodes\n\n"));
    const relationships = relationshipItems(
      Array.isArray(container.edges) ? container.edges : [],
      labelByUid,
      state,
    );
    if (relationships.length > 0) {
      sections.push({ heading: "## Relationships", items: relationships });
    }
  }
  const mode = str(body.mode);
  return assemble(
    `# Graph traversal${mode ? ` (${mode})` : ""}`,
    sections,
    state,
    maxChars,
  );
}

// ── Ontology (Layer 7) rendering ─────────────────────────────────────
//
// Wire shapes verified against mindgraph-server ontology_handlers.rs
// (QueryResponse) and a live /v1/ontology/schemas probe. `objects` are full
// GraphNodes (Custom nodes carry object_type + fields in props);
// cognitive_context is a category → NeighborNode[] map; provenance entries
// distinguish `anchor` (a located quotation) from `chunk_head` (context that
// MUST NOT be presented as a quote — server contract C10).

function neighborLine(value: unknown): string | undefined {
  const node = obj(value);
  if (!node) return undefined;
  const label = str(node.label) || "(unlabeled)";
  const uid = str(node.uid);
  const type = str(node.node_type);
  return `- ${label}${uid ? ` [${uid}]` : ""}${type ? ` (${type})` : ""}`;
}

/** Render an /ontology/query (or object-context-shaped) response. */
export function renderOntologyAnswer(response: unknown): string | undefined {
  const payload = obj(response);
  if (!payload) return undefined;
  const objects = Array.isArray(payload.objects)
    ? payload.objects.filter(isNodeShaped)
    : isNodeShaped(payload.object)
      ? [payload.object as Rec]
      : [];
  const cognitive = obj(payload.cognitive_context);
  const provenance = Array.isArray(payload.provenance) ? payload.provenance : [];
  const hasQuerySignature =
    Array.isArray(payload.objects) || obj(payload.confidence) !== undefined;
  const cognitiveEmpty =
    !cognitive || Object.values(cognitive).every((v) => !Array.isArray(v) || v.length === 0);
  if (objects.length === 0 && cognitiveEmpty && provenance.length === 0) {
    // A recognized-but-empty result renders honestly; an unknown shape
    // falls back to raw.
    return hasQuerySignature ? "No matching domain objects." : undefined;
  }
  const state: RenderState = { bounded: false, omitted: 0 };
  const sections: Section[] = [];
  if (objects.length > 0) {
    sections.push(...groupedNodeSections(objects, state));
  }
  const labelByUid = new Map<string, string>();
  for (const node of objects) labelByUid.set(str(node.uid)!, str(node.label) || "?");
  const graph = obj(payload.graph);
  for (const raw of Array.isArray(graph?.nodes) ? graph!.nodes : []) {
    const node = obj(raw);
    const uid = str(node?.uid);
    if (uid && !labelByUid.has(uid)) labelByUid.set(uid, str(node?.label) || "?");
  }
  // Cognitive neighbors carry labels too (object_context has NO graph key —
  // without this every relation line was dropped there).
  if (cognitive) {
    for (const rawNodes of Object.values(cognitive)) {
      if (!Array.isArray(rawNodes)) continue;
      for (const raw of rawNodes) {
        const node = obj(raw);
        const uid = str(node?.uid);
        if (uid && !labelByUid.has(uid)) labelByUid.set(uid, str(node?.label) || "?");
      }
    }
  }
  const relations = Array.isArray(payload.relations) ? payload.relations : [];
  const relationLines = relationshipItems(relations, labelByUid, state, { fallbackToUid: true });
  if (relationLines.length > 0) {
    sections.push({ heading: "## Relations", items: relationLines });
  }
  if (cognitive) {
    for (const [category, rawNodes] of Object.entries(cognitive)) {
      if (!Array.isArray(rawNodes) || rawNodes.length === 0) continue;
      const items = rawNodes
        .map(neighborLine)
        .filter((line): line is string => Boolean(line));
      if (items.length > 0) {
        sections.push({ heading: `### Cognitive context — ${category}`, items });
      }
    }
  }
  if (provenance.length > 0) {
    const items = provenance
      .map((raw) => obj(raw))
      .filter((entry): entry is Rec => Boolean(entry))
      .map((entry) => {
        const span = clip(entry.text_span, QUOTE_MAX, state) || "";
        const by = str(entry.ingested_by_name);
        const suffix = `${by ? ` (ingested by ${by})` : ""} [source ${str(entry.source_uid) || "?"}]`;
        // C10: chunk_head spans are context, never quotations.
        return str(entry.span_kind) === "anchor"
          ? `- "${span}"${suffix}`
          : `- context: ${span}${suffix}`;
      });
    sections.push({ heading: "## Sources", items });
  }
  const confidence = num(obj(payload.confidence)?.overall);
  const notes: string[] = [];
  if (confidence !== undefined) notes.push(`overall confidence ${confidence}`);
  if (payload.has_more === true) notes.push("more results exist (has_more)");
  if (payload.seed_cap_hit === true) notes.push("seed cap hit — narrow the query for a complete set");
  if (notes.length > 0) sections.push({ heading: `Note: ${notes.join("; ")}.`, items: [] });
  return assemble(
    `# Ontology results (${objects.length} object${objects.length === 1 ? "" : "s"})`,
    sections,
    state,
  );
}

/** Render paged domain-object lists: search / objects / related responses. */
export function renderObjectList(response: unknown, title: string): string | undefined {
  const payload = obj(response);
  if (!payload) return undefined;
  // `rows` counts only when its entries unwrap to nodes ({object, …} from
  // structured related queries) — tabular select rows (arrays/scalars) are
  // NOT an object list and must fall back to raw.
  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.rows) && payload.rows.some((row) => unwrapSearchResult(row))
      ? payload.rows
      : undefined;
  const items = (rawItems ?? [])
    .map(unwrapSearchResult)
    .filter((node): node is Rec => Boolean(node));
  if (items.length === 0) {
    // Distinguish a legitimately empty page from an unknown shape.
    return rawItems ? `# ${title} (0 results)` : undefined;
  }
  const state: RenderState = { bounded: false, omitted: 0 };
  const sections = groupedNodeSections(items, state);
  const total = num(payload.total_count);
  const truncations = Array.isArray(payload.truncation_reasons)
    ? payload.truncation_reasons.filter((reason) => typeof reason === "string")
    : [];
  const notes: string[] = [];
  if (payload.has_more === true) notes.push("more results exist");
  if (truncations.length > 0) notes.push(`truncated: ${truncations.join(", ")}`);
  if (notes.length > 0) sections.push({ heading: `Note: ${notes.join("; ")}.`, items: [] });
  const count = total !== undefined && total !== items.length
    ? `${items.length} of ${total}`
    : `${items.length}`;
  return assemble(`# ${title} (${count})`, sections, state);
}

// ── Jobs and synthesis signals ───────────────────────────────────────

const JOBS_RENDER_MAX = 20;

/** Render the ingestion jobs list, newest first, bounded. */
export function renderJobs(response: unknown): string | undefined {
  const jobs = Array.isArray(response) ? response : obj(response)?.jobs;
  if (!Array.isArray(jobs)) return undefined;
  if (jobs.length === 0) return "No ingestion jobs.";
  const state: RenderState = { bounded: false, omitted: 0 };
  const sorted = jobs
    .map((raw) => obj(raw))
    .filter((job): job is Rec => Boolean(job))
    .sort((a, b) => (num(b.created_at) ?? 0) - (num(a.created_at) ?? 0));
  const shown = sorted.slice(0, JOBS_RENDER_MAX);
  if (shown.length < sorted.length) state.bounded = true;
  const items = shown.map((job) => {
    const progress = obj(job.progress);
    const done = num(progress?.processed_chunks);
    const totalChunks = num(progress?.total_chunks);
    const bits = [
      str(job.status) || "?",
      done !== undefined && totalChunks !== undefined ? `${done}/${totalChunks} chunks` : undefined,
      num(progress?.nodes_created) !== undefined ? `${num(progress?.nodes_created)} nodes` : undefined,
      num(job.queue_position) !== undefined ? `queue #${num(job.queue_position)}` : undefined,
      str(job.error) ? `error: ${clip(job.error, 160, state)}` : undefined,
    ].filter(Boolean);
    return `- [${str(job.id) || "?"}] ${clip(job.title, 120, state) || "(untitled)"} — ${bits.join(", ")}`;
  });
  return assemble(
    `# Ingestion jobs (${shown.length}${shown.length < sorted.length ? ` of ${sorted.length}` : ""})`,
    [{ heading: "", items }],
    state,
  );
}

/** Render /synthesis/signals: named arrays of typed signal items. */
export function renderSignals(response: unknown): string | undefined {
  const payload = obj(response);
  if (!payload) return undefined;
  const state: RenderState = { bounded: false, omitted: 0 };
  const sections: Section[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const items = value
      .map((raw) => obj(raw))
      .filter((item): item is Rec => Boolean(item))
      .map((item) => {
        const fromLabel = str(item.from_label);
        const toLabel = str(item.to_label);
        const anyLabelKey = Object.keys(item).find(
          (k) => k.endsWith("_label") && str(item[k]),
        );
        const label =
          str(item.label) ??
          str(item.title) ??
          str(item.name) ??
          (fromLabel && toLabel ? `${fromLabel} ↔ ${toLabel}` : undefined) ??
          (anyLabelKey ? str(item[anyLabelKey]) : undefined) ??
          str(item.uid) ??
          str(item.target_uid) ??
          "(item)";
        const uid = str(item.uid) ?? str(item.target_uid);
        const numbers = Object.entries(item)
          .filter(([, v]) => typeof v === "number")
          .slice(0, 4)
          .map(([k, v]) => `${k} ${Math.round((v as number) * 100) / 100}`);
        const lists = Object.entries(item)
          .filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0)
          .slice(0, 2)
          .map(([k, v]) => `${k}: ${(v as unknown[]).length}`);
        const meta = [...numbers, ...lists].join(", ");
        return `- ${clip(label, 160, state)}${uid && uid !== label ? ` [${uid}]` : ""}${meta ? ` (${meta})` : ""}`;
      });
    if (items.length > 0) {
      sections.push({ heading: `## ${key.replace(/_/g, " ")}`, items });
    }
  }
  if (sections.length === 0) return undefined;
  return assemble("# Synthesis signals", sections, state);
}
