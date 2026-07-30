// ── Rendered tool output ──────────────────────────────────────────────
//
// The general read tools used to return the server's wire JSON verbatim,
// pretty-printed: full typed props with every null field, unbounded
// source-chunk offset arrays, curation edges, and retrieval-expansion
// metadata. A single live `retrieve context` call measured ~11k tokens for
// ~1.2k tokens of signal, and chat harnesses (ChatGPT desktop, Claude
// Desktop) burned that on every retrieval.
//
// This module renders read responses the way the dashboard chat formats the
// same endpoint for its model (mindgraph-dashboard chat route): articles
// first, nodes grouped by type with status/confidence/provenance tags, one
// short source quote, relationships as label lines. One deliberate
// difference: node UIDs stay in the output — MCP models chain follow-up
// tool calls by uid, where dashboard models cite by document title.
//
// Rendering is for MODELS reading context. Machine-parsed surfaces
// (mindgraph_plan, sync, code — the hooks re-sync fencing state from those
// payloads) are never rendered, and `format: "json"` is the per-call escape
// hatch back to the raw response.

const LABEL_MAX = 200;
const SUMMARY_MAX = 400;
const QUOTE_MAX = 180;
const ARTICLE_MAX = 2_500;
const CHUNK_MAX = 1_200;
const RELATIONSHIP_MAX = 40;
const RENDER_CHAR_BUDGET = 24_000;

// Curation-inbox data has its own surface (`merge_candidates`); shipping it
// as knowledge context confused models with reviewer metadata ("LLM review:
// related but distinct", similarity scores) — observed live.
const CURATION_EDGE_TYPES = new Set(["POSSIBLE_DUPLICATE"]);
// Infra nodes render through their own sections (articles, source tags,
// document_index), not as graph knowledge.
const INFRA_NODE_TYPES = new Set(["Chunk", "Document", "Article"]);

type Rec = Record<string, unknown>;

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

function clip(value: unknown, max: number, state: { bounded: boolean }): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  if (text.length <= max) return text;
  state.bounded = true;
  return `${text.slice(0, max - 1)}…`;
}

function isNodeShaped(value: unknown): value is Rec {
  const node = obj(value);
  return Boolean(node && str(node.uid) && (str(node.label) || str(node.node_type)));
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

function firstQuote(node: Rec, state: { bounded: boolean }): string | undefined {
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

function layer7Fields(node: Rec, state: { bounded: boolean }): string | undefined {
  const fields = obj(obj(node.props)?.fields);
  if (!fields) return undefined;
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  if (pairs.length === 0) return undefined;
  return clip(pairs.join("; "), SUMMARY_MAX, state);
}

function nodeSummaryText(node: Rec, state: { bounded: boolean }): string | undefined {
  const props = obj(node.props);
  return (
    clip(node.summary, SUMMARY_MAX, state) ??
    clip(props?.content, SUMMARY_MAX, state) ??
    clip(props?.description, SUMMARY_MAX, state) ??
    clip(props?.definition, SUMMARY_MAX, state)
  );
}

function nodeLines(node: Rec, state: { bounded: boolean }): string {
  const label = clip(node.label, LABEL_MAX, state) || "(unlabeled)";
  const type = str(node.node_type) || "Node";
  const confidence = num(node.confidence);
  const head = `- **${label}** [${str(node.uid) || "?"}] (${type}${confidence !== undefined ? `, confidence ${confidence}` : ""})${statusTag(node)}`;
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

function groupedNodeSections(nodes: Rec[], state: { bounded: boolean }): string[] {
  const groups = new Map<string, Rec[]>();
  for (const node of nodes) {
    const type = str(node.node_type) || "Node";
    const group = groups.get(type) ?? [];
    group.push(node);
    groups.set(type, group);
  }
  const sections: string[] = [];
  for (const [type, group] of groups) {
    sections.push(`### ${type}\n${group.map((node) => nodeLines(node, state)).join("\n")}`);
  }
  return sections;
}

function relationshipLines(
  edges: unknown[],
  labelByUid: Map<string, string>,
  state: { bounded: boolean },
): string[] {
  const lines: string[] = [];
  let skippedUnknown = 0;
  for (const raw of edges) {
    const edge = obj(raw);
    if (!edge) continue;
    const type = str(edge.edge_type) || "?";
    const from = str(edge.from_uid);
    const to = str(edge.to_uid);
    if (CURATION_EDGE_TYPES.has(type)) continue;
    if (!from || !to || from === to) continue; // self-loops are data noise
    const fromLabel = labelByUid.get(from);
    const toLabel = labelByUid.get(to);
    if (!fromLabel || !toLabel) {
      skippedUnknown += 1;
      continue;
    }
    lines.push(`- ${fromLabel} —${type}→ ${toLabel}`);
  }
  if (lines.length > RELATIONSHIP_MAX) {
    state.bounded = true;
    const extra = lines.length - RELATIONSHIP_MAX;
    return [...lines.slice(0, RELATIONSHIP_MAX), `- (+${extra} more relationships)`];
  }
  if (skippedUnknown > 0 && lines.length === 0) return [];
  return lines;
}

/** Assemble sections whole under the budget; drop whole, never mid-item. */
function assemble(header: string, sections: string[], state: { bounded: boolean }): string {
  const lines: string[] = [header];
  let used = header.length;
  for (const section of sections) {
    if (used + section.length + 2 > RENDER_CHAR_BUDGET) {
      state.bounded = true;
      break;
    }
    lines.push(section);
    used += section.length + 2;
  }
  if (state.bounded) {
    lines.push(
      "…[rendered context bounded — fetch full node content by uid, or pass format: \"json\" for the raw response]",
    );
  }
  return lines.join("\n\n");
}

/** Render a /retrieve/context response. */
export function renderContext(response: unknown): string | undefined {
  const payload = obj(response);
  if (!payload) return undefined;
  const graph = obj(payload.graph);
  const rawNodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
  const nodes = rawNodes.filter(isNodeShaped).filter(
    (node) => !INFRA_NODE_TYPES.has(str(node.node_type) || ""),
  );
  const articles = Array.isArray(payload.articles) ? payload.articles : [];
  const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  const policies = Array.isArray(payload.applicable_policies)
    ? payload.applicable_policies
    : [];
  if (nodes.length === 0 && articles.length === 0 && chunks.length === 0) {
    return "No results found for this search.";
  }
  const state = { bounded: false };
  const sections: string[] = [];
  if (articles.length > 0) {
    const rendered = articles
      .map((raw) => obj(raw))
      .filter((article): article is Rec => Boolean(article))
      .map(
        (article) =>
          `### ${str(article.label) || "(untitled)"} [${str(article.uid) || "?"}]\n${clip(article.content, ARTICLE_MAX, state) || ""}`,
      );
    sections.push(`## Knowledge articles\n\n${rendered.join("\n\n---\n\n")}`);
  }
  if (nodes.length > 0) {
    sections.push(`## Knowledge graph\n\n${groupedNodeSections(nodes, state).join("\n\n")}`);
    const labelByUid = new Map<string, string>();
    for (const node of nodes) {
      labelByUid.set(str(node.uid)!, str(node.label) || "?");
    }
    const relationships = relationshipLines(
      Array.isArray(graph?.edges) ? graph!.edges : [],
      labelByUid,
      state,
    );
    if (relationships.length > 0) {
      sections.push(`## Relationships\n\n${relationships.join("\n")}`);
    }
  }
  if (chunks.length > 0) {
    const rendered = chunks
      .map((raw) => obj(raw))
      .filter((chunk): chunk is Rec => Boolean(chunk))
      .map(
        (chunk) =>
          `- [${str(chunk.chunk_uid) || "?"}] from "${str(chunk.document_title) || "unknown document"}": "${clip(chunk.content, CHUNK_MAX, state) || ""}"`,
      );
    sections.push(`## Source excerpts\n\n${rendered.join("\n")}`);
  }
  if (policies.length > 0) {
    const rendered = policies
      .map((raw) => obj(raw))
      .filter((policy): policy is Rec => Boolean(policy))
      .map(
        (policy) =>
          `- ${str(policy.name) || "(unnamed policy)"}: ${clip(policy.prose_rules, SUMMARY_MAX, state) || "(structured rules apply)"}`,
      );
    sections.push(`## Applicable policies\n\n${rendered.join("\n")}`);
  }
  const hidden = payload.hidden_item_count;
  if (hidden !== undefined && hidden !== null) {
    sections.push(`Note: ${hidden} item(s) were hidden by access scoping.`);
  }
  return assemble("# Retrieved context", sections, state);
}

/** Render any response whose payload is (or contains) a list of nodes. */
export function renderNodeList(response: unknown, title: string): string | undefined {
  let nodes: Rec[] = [];
  if (Array.isArray(response)) {
    nodes = response.filter(isNodeShaped);
  } else {
    const payload = obj(response);
    if (!payload) return undefined;
    for (const key of ["nodes", "results", "items", "goals", "questions", "claims", "preferences", "documents"]) {
      const candidate = payload[key];
      if (Array.isArray(candidate) && candidate.some(isNodeShaped)) {
        nodes = candidate.filter(isNodeShaped);
        break;
      }
    }
  }
  if (nodes.length === 0) return undefined; // caller falls back to raw JSON
  const state = { bounded: false };
  const sections = groupedNodeSections(nodes, state);
  return assemble(`# ${title} (${nodes.length})`, sections, state);
}

/** Render a traversal response: nodes + edges (+ per-path costs when present). */
export function renderTraversal(response: unknown): string | undefined {
  const payload = obj(response);
  if (!payload) return undefined;
  const container = obj(payload.graph) ?? payload;
  const rawNodes = Array.isArray(container.nodes) ? container.nodes : [];
  const nodes = rawNodes.filter(isNodeShaped);
  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  if (nodes.length === 0 && paths.length === 0) return undefined;
  const state = { bounded: false };
  const sections: string[] = [];
  const labelByUid = new Map<string, string>();
  for (const node of nodes) labelByUid.set(str(node.uid)!, str(node.label) || "?");
  if (paths.length > 0) {
    const rendered = paths
      .map((raw) => obj(raw))
      .filter((path): path is Rec => Boolean(path))
      .map((path, index) => {
        const hops = Array.isArray(path.nodes)
          ? path.nodes
              .map((hop) => {
                const hopNode = obj(hop);
                return str(hopNode?.label) || labelByUid.get(str(hopNode?.uid) || "") || str(hop as unknown as string) || "?";
              })
              .join(" → ")
          : "(path)";
        const cost = num(path.path_cost);
        const confidence = num(path.path_confidence);
        const meta = [
          cost !== undefined ? `cost ${cost}` : undefined,
          confidence !== undefined ? `confidence ${confidence}` : undefined,
        ].filter(Boolean);
        return `${index + 1}. ${hops}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}`;
      });
    sections.push(`## Paths\n\n${rendered.join("\n")}`);
  }
  if (nodes.length > 0) {
    sections.push(`## Nodes\n\n${groupedNodeSections(nodes, state).join("\n\n")}`);
    const relationships = relationshipLines(
      Array.isArray(container.edges) ? container.edges : [],
      labelByUid,
      state,
    );
    if (relationships.length > 0) {
      sections.push(`## Relationships\n\n${relationships.join("\n")}`);
    }
  }
  return assemble("# Graph traversal", sections, state);
}
