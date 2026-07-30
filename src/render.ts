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

/** /retrieve search actions return SearchResult `{node, score, legs?}` —
 * unwrap to the node, carrying the score along for display. */
function unwrapSearchResult(value: unknown): Rec | undefined {
  if (isNodeShaped(value)) return value;
  const wrapper = obj(value);
  const inner = obj(wrapper?.node);
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
  state: { bounded: boolean },
  headingPrefix = "",
): Section[] {
  const groups = new Map<string, Rec[]>();
  for (const node of nodes) {
    const type = str(node.node_type) || "Node";
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
  state: { bounded: boolean },
): string[] {
  const lines: string[] = [];
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
    if (!fromLabel || !toLabel) continue;
    lines.push(`- ${fromLabel} —${type}→ ${toLabel}`);
  }
  if (lines.length > RELATIONSHIP_MAX) {
    state.bounded = true;
    const extra = lines.length - RELATIONSHIP_MAX;
    return [...lines.slice(0, RELATIONSHIP_MAX), `- (+${extra} more relationships)`];
  }
  return lines;
}

/** Pack sections item-wise under the budget. A section whose heading fits
 * gets as many whole items as fit; the rest are counted, never cut mid-item.
 * Later sections still get a chance (no early break) — one oversized section
 * must never blank the rest of the output. */
function assemble(header: string, sections: Section[], state: { bounded: boolean }): string {
  const lines: string[] = [header];
  let used = header.length;
  for (const section of sections) {
    if (section.items.length === 0 && !section.heading) continue;
    const headingCost = section.heading.length + 2;
    if (used + headingCost > RENDER_CHAR_BUDGET) {
      state.bounded = true;
      continue;
    }
    let sectionUsed = 0;
    const kept: string[] = [];
    let dropped = 0;
    for (const item of section.items) {
      if (used + headingCost + sectionUsed + item.length + 1 > RENDER_CHAR_BUDGET) {
        dropped += 1;
        continue;
      }
      kept.push(item);
      sectionUsed += item.length + 1;
    }
    if (kept.length === 0 && section.items.length > 0) {
      state.bounded = true;
      continue;
    }
    if (dropped > 0) {
      state.bounded = true;
      const marker = `(+${dropped} more not shown)`;
      kept.push(marker);
      sectionUsed += marker.length + 1;
    }
    lines.push(
      section.items.length === 0
        ? section.heading
        : `${section.heading}\n${kept.join("\n")}`,
    );
    used += headingCost + sectionUsed;
  }
  if (state.bounded) {
    lines.push(
      "…[rendered context bounded — fetch full node content by uid, or pass format: \"json\" for the raw response]",
    );
  }
  return lines.join("\n\n");
}

function policySections(payload: Rec, state: { bounded: boolean }): Section[] {
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
export function renderContext(response: unknown): string | undefined {
  const payload = obj(response);
  if (!payload) return undefined;
  const graph = obj(payload.graph);
  const rawNodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
  const shaped = rawNodes.filter(isNodeShaped);
  const nodes = shaped.filter((node) => !INFRA_NODE_TYPES.has(str(node.node_type) || ""));
  const infraOnly = shaped.length - nodes.length;
  const articles = Array.isArray(payload.articles) ? payload.articles : [];
  const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  const state = { bounded: false };
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
    return assemble("# Retrieved context\n\nNo graph results matched this search.", sections, state);
  }
  return assemble("# Retrieved context", sections, state);
}

/** Render any response whose payload is (or contains) a list of nodes —
 * bare GraphNode arrays and SearchResult `{node, score}` arrays alike. */
export function renderNodeList(
  response: unknown,
  title: string,
  limit?: number,
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
  const state = { bounded: false };
  // The server ignores limit for several unscoped structured queries (up to
  // its 200-row cap) — honor the caller's bound here.
  if (limit !== undefined && limit > 0 && nodes.length > limit) {
    nodes = nodes.slice(0, limit);
    state.bounded = true;
  }
  const sections = groupedNodeSections(nodes, state);
  const shown = nodes.length;
  return assemble(
    `# ${title} (${shown === total ? total : `${shown} of ${total}`})`,
    sections,
    state,
  );
}

/** Render a traversal response: nodes + edges, and paths.
 * top_k_paths wire: `{paths: [{node_uids, labels, cost}]}`. */
export function renderTraversal(response: unknown): string | undefined {
  const payload = obj(response);
  if (!payload) return undefined;
  const container = obj(payload.graph) ?? payload;
  const rawNodes = Array.isArray(container.nodes) ? container.nodes : [];
  const nodes = rawNodes.filter(isNodeShaped);
  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  if (nodes.length === 0 && paths.length === 0) return undefined;
  const state = { bounded: false };
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
  return assemble("# Graph traversal", sections, state);
}
