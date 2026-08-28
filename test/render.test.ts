import { describe, expect, it } from "vitest";
import { renderContext, renderNodeList, renderTraversal } from "../src/render.js";

// Fixture modeled on a live prod retrieve-context specimen (2026-07-30): the
// raw JSON delivered ~11k tokens for ~1.2k tokens of signal — 20-entry
// source-chunk offset arrays, curation edges with reviewer metadata, a
// superseded node beside its successor, legacy "unknown. accepted" enum
// corruption, and ABOUT self-loops.
function specimen() {
  return {
    graph: {
      nodes: [
        {
          uid: "entity-1",
          label: "MindGraph",
          node_type: "Entity",
          confidence: 0.9,
          summary: "Semantic graph memory platform",
          props: { canonical_name: "MindGraph", attributes: null, identifiers: null },
          source_documents: [{ uid: "doc-1", title: "Strategy Transcript" }],
          source_chunks: Array.from({ length: 20 }, (_, index) => ({
            chunk_uid: `chunk-${index}`,
            char_start: index * 100,
            char_end: index * 100 + 99,
            page_start: null,
            page_end: null,
            quote: index === 3 ? "MindGraph lets AI systems reason over knowledge" : null,
            anchor: null,
          })),
        },
        {
          uid: "claim-1",
          label: "MindGraph improves institutional thinking",
          node_type: "Claim",
          confidence: 0.76,
          summary: "Better representations improve decisions",
          truth_status: "unknown. accepted", // legacy merge corruption — must stay visible
          props: { content: "Processing knowledge improves thinking.", truth_status: "unknown. accepted" },
          believed_by: [{ agent_uid: "agent-1", agent_label: "Shan", confidence: 0.8 }],
        },
        {
          uid: "obs-old",
          label: "MindGraph current product description (2026)",
          node_type: "Observation",
          confidence: 1,
          summary: "Old description",
          superseded: true,
          superseded_by: "obs-new",
          props: {},
        },
        {
          uid: "obs-new",
          label: "MindGraph built on mnestic engine",
          node_type: "Observation",
          confidence: 0.95,
          summary: "Current architecture relationship",
          props: {},
        },
        {
          uid: "custom-1",
          label: "ACME row",
          node_type: "Custom",
          confidence: 1,
          props: { fields: { region: "EMEA", arr: 120000, empty: null } },
        },
        {
          uid: "expanded-1",
          label: "Expanded neighbor",
          node_type: "Observation",
          confidence: 1,
          summary: "Came from graph expansion",
          props: {},
          retrieval_origin: "graph_expansion",
          retrieval_path_cost: 0.69,
          retrieval_depth: 1,
          retrieval_parent_uid: "entity-1",
        },
        { uid: "chunk-node", label: "raw chunk", node_type: "Chunk", props: {} },
      ],
      edges: [
        { uid: "e1", edge_type: "ABOUT", from_uid: "claim-1", to_uid: "entity-1", props: {} },
        // Self-loop — data noise, must not render.
        { uid: "e2", edge_type: "ABOUT", from_uid: "claim-1", to_uid: "claim-1", props: {} },
        // Curation-inbox edge — must not render as knowledge.
        {
          uid: "e3",
          edge_type: "POSSIBLE_DUPLICATE",
          from_uid: "obs-old",
          to_uid: "obs-new",
          props: { similarity: 0.82, method: "llm", rationale: "LLM review: related but distinct" },
        },
        { uid: "e4", edge_type: "SUPERSEDES", from_uid: "obs-new", to_uid: "obs-old", props: {} },
      ],
    },
    articles: [
      { uid: "article-1", label: "MindGraph Overview", content: "Compiled article body.", article_type: "entity" },
    ],
    chunks: [
      {
        chunk_uid: "chunk-3",
        content: "Full chunk text for citation.",
        score: 0.8,
        document_uid: "doc-1",
        document_title: "Strategy Transcript",
        chunk_index: 3,
      },
    ],
  };
}

describe("renderContext", () => {
  it("keeps signal (labels, uids, summaries, tags) and drops wire noise", () => {
    const text = renderContext(specimen())!;
    // Signal survives, uid included for follow-up tool calls.
    expect(text).toContain("**MindGraph** [entity-1] (Entity, confidence 0.9)");
    expect(text).toContain("Semantic graph memory platform");
    expect(text).toContain('source quote: "MindGraph lets AI systems reason over knowledge"');
    expect(text).toContain("from: Strategy Transcript");
    expect(text).toContain("believed by: Shan (0.8)");
    expect(text).toContain("### Claim");
    // Epistemics rendered, not buried — including legacy corruption verbatim.
    expect(text).toContain("[truth: unknown. accepted]");
    expect(text).toContain("[SUPERSEDED by obs-new]");
    // Layer-7 fields survive; null entries dropped.
    expect(text).toContain("fields: region: EMEA; arr: 120000");
    // Articles and chunks render as sections.
    expect(text).toContain("## Knowledge articles");
    expect(text).toContain("Compiled article body.");
    expect(text).toContain('from "Strategy Transcript": "Full chunk text for citation."');
    // Relationships as labels; curation edges and self-loops gone.
    expect(text).toContain("MindGraph improves institutional thinking —ABOUT→ MindGraph");
    expect(text).not.toContain("POSSIBLE_DUPLICATE");
    expect(text).not.toContain("LLM review");
    expect(text).not.toMatch(/—ABOUT→ MindGraph improves institutional thinking/);
    // Wire noise gone: chunk offsets, retrieval metadata, null props, infra nodes.
    expect(text).not.toContain("char_start");
    expect(text).not.toContain("chunk-7");
    expect(text).not.toContain("retrieval_path_cost");
    expect(text).not.toContain("tombstone");
    expect(text).not.toContain("raw chunk");
  });

  it("is dramatically smaller than the pretty JSON it replaces", () => {
    const raw = JSON.stringify(specimen(), null, 2);
    const text = renderContext(specimen())!;
    expect(text.length).toBeLessThan(raw.length / 3);
  });

  it("renders the empty case as prose", () => {
    expect(renderContext({ graph: { nodes: [], edges: [] } })).toBe(
      "No results found for this search.",
    );
  });

  it("bounds oversized content with a truthful marker, never mid-item cuts", () => {
    const big = specimen();
    big.articles = Array.from({ length: 30 }, (_, index) => ({
      uid: `article-${index}`,
      label: `Article ${index}`,
      content: "x".repeat(8_000),
      article_type: "entity",
    }));
    const text = renderContext(big)!;
    expect(text.length).toBeLessThan(26_000);
    expect(text).toContain("[rendered context bounded");
    // Per-item clip enforced (ARTICLE_MAX) — no unbounded runs survive.
    expect(text).not.toContain("x".repeat(6_100));
  });
});

describe("renderNodeList", () => {
  it("renders bare GraphNode arrays (structured lists)", () => {
    const text = renderNodeList(
      [
        { uid: "goal-1", label: "Land 3 design partners", node_type: "Goal", confidence: 0.9, props: {} },
        { uid: "goal-2", label: "Ship 0.16", node_type: "Goal", props: {} },
      ],
      "active goals",
    )!;
    expect(text).toContain("# active goals (2)");
    expect(text).toContain("**Land 3 design partners** [goal-1]");
  });

  it("returns undefined for payloads with nothing node-shaped (caller falls back to raw)", () => {
    expect(renderNodeList({ pairs: [{ claim_a: "x", claim_b: "y" }] }, "contradictions")).toBeUndefined();
    expect(renderNodeList({ count: 3 }, "counts")).toBeUndefined();
  });
});

describe("renderTraversal", () => {
  it("renders nodes, label relationships, and top-k paths with costs", () => {
    const text = renderTraversal({
      paths: [
        {
          nodes: [
            { uid: "a", label: "Start" },
            { uid: "b", label: "End" },
          ],
          path_cost: 1.4,
          path_confidence: 0.7,
        },
      ],
      nodes: [
        { uid: "a", label: "Start", node_type: "Entity", props: {} },
        { uid: "b", label: "End", node_type: "Entity", props: {} },
      ],
      edges: [{ uid: "e", edge_type: "RELATES_TO", from_uid: "a", to_uid: "b", props: {} }],
    })!;
    expect(text).toContain("1. Start → End (cost 1.4, confidence 0.7)");
    expect(text).toContain("Start —RELATES_TO→ End");
  });

  it("returns undefined for unrecognized shapes", () => {
    expect(renderTraversal({ something: true })).toBeUndefined();
  });

  it("renders the live PathStep wire shape and unwraps custom edge types", () => {
    // Captured from a live mindgraph-server neighborhood response during R13.
    const text = renderTraversal({
      mode: "neighborhood",
      start_uid: "decision-uid",
      steps: [
        {
          depth: 1,
          edge_from_uid: "decision-uid",
          edge_to_uid: "evidence-uid",
          edge_type: { Custom: "SUPPORTED_BY" },
          edge_uid: "edge-uid",
          label: "benchmark p99_latency_ms=180",
          node_type: "Observation",
          node_uid: "evidence-uid",
          parent_uid: "decision-uid",
          path_confidence: 1,
          path_cost: 0.6931471824645996,
          traversal_role: "outgoing",
        },
      ],
    })!;

    expect(text).toContain("# Graph traversal (neighborhood)");
    expect(text).toContain("depth 1 outgoing —SUPPORTED_BY→");
    expect(text).toContain("**benchmark p99_latency_ms=180** [evidence-uid]");
    expect(text).toContain("parent decision-uid");
    expect(text).toContain("cost 0.6931471824645996");
    expect(text).not.toContain('"Custom"');
  });

  it.each(["chain", "path", "subgraph"])(
    "renders live %s PathStep responses without raw fallback",
    (mode) => {
      const text = renderTraversal({
        mode,
        start_uid: "start-uid",
        end_uid: mode === "path" ? "end-uid" : undefined,
        steps: [
          {
            depth: 1,
            edge_from_uid: "start-uid",
            edge_to_uid: "end-uid",
            edge_type: "DependsOn",
            label: "End node",
            node_type: "Entity",
            node_uid: "end-uid",
            parent_uid: "start-uid",
            path_confidence: 0.9,
            path_cost: 0.2,
            traversal_role: "outgoing",
          },
        ],
      })!;

      expect(text).toContain(`# Graph traversal (${mode})`);
      expect(text).toContain("depth 1 outgoing —DependsOn→");
      expect(text).toContain("**End node** [end-uid]");
      expect(() => JSON.parse(text)).toThrow();
    },
  );

  it("unwraps custom edge types in nodes-and-edges traversal responses", () => {
    const text = renderTraversal({
      nodes: [
        { uid: "a", label: "Start", node_type: "Entity", props: {} },
        { uid: "b", label: "End", node_type: "Entity", props: {} },
      ],
      edges: [
        {
          uid: "edge-1",
          edge_type: { Custom: "SUPPORTED_BY" },
          from_uid: "a",
          to_uid: "b",
          props: {},
        },
      ],
    })!;

    expect(text).toContain("Start —SUPPORTED_BY→ End");
    expect(text).not.toContain("—?→");
  });

  it("renders an empty live path response as a result, not raw JSON", () => {
    expect(renderTraversal({
      mode: "path",
      start_uid: "a",
      end_uid: "z",
      steps: null,
    })).toContain("No path found from [a] to [z].");
  });

  it("honors a hard rendered-output budget and reports omitted steps", () => {
    const steps = Array.from({ length: 30 }, (_, index) => ({
      depth: index + 1,
      edge_from_uid: `node-${index}`,
      edge_to_uid: `node-${index + 1}`,
      edge_type: { Custom: "DEPENDS_ON" },
      label: `Dependency ${index} ${"detail ".repeat(8)}`,
      node_type: "Observation",
      node_uid: `node-${index + 1}`,
      parent_uid: `node-${index}`,
      traversal_role: "outgoing",
    }));

    const text = renderTraversal(
      { mode: "neighborhood", start_uid: "node-0", steps },
      700,
    )!;

    expect(text.length).toBeLessThanOrEqual(700);
    expect(text).toContain("rendered context bounded to 700 chars");
    expect(text).toMatch(/\d+ item\(s\) omitted/);
    expect(text).not.toContain('"Custom"');
  });
});

// Dispatch-level format contract lives here to keep all renderer behavior in
// one suite.
import { handleTool } from "../src/tools.js";
import { vi } from "vitest";
import type { MindGraph } from "mindgraph";

describe("retrieve format contract", () => {
  const contextResponse = {
    graph: {
      nodes: [{ uid: "n1", label: "Node One", node_type: "Entity", confidence: 1, props: {} }],
      edges: [],
    },
  };

  it("renders text by default", async () => {
    const client = {
      retrieveContext: vi.fn().mockResolvedValue(contextResponse),
    } as unknown as MindGraph;
    const result = await handleTool(client, "mindgraph_retrieve", {
      action: "context",
      query: "node",
    });
    expect(result.content[0].text).toContain("# Retrieved context");
    expect(result.content[0].text).toContain("**Node One** [n1]");
    expect(() => JSON.parse(result.content[0].text)).toThrow();
  });

  it("format: 'json' returns the raw server response", async () => {
    const client = {
      retrieveContext: vi.fn().mockResolvedValue(contextResponse),
    } as unknown as MindGraph;
    const result = await handleTool(client, "mindgraph_retrieve", {
      action: "context",
      query: "node",
      format: "json",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.graph.nodes[0].uid).toBe("n1");
  });

  it("passes max_output_chars to text rendering but never rewrites raw JSON", async () => {
    const largeResponse = {
      graph: {
        nodes: Array.from({ length: 20 }, (_, index) => ({
          uid: `n${index}`,
          label: `Node ${index} ${"description ".repeat(12)}`,
          node_type: "Observation",
          props: {},
        })),
        edges: [],
      },
    };
    const client = {
      retrieveContext: vi.fn().mockResolvedValue(largeResponse),
    } as unknown as MindGraph;
    const textResult = await handleTool(client, "mindgraph_retrieve", {
      action: "context",
      query: "node",
      max_output_chars: 700,
    });
    const jsonResult = await handleTool(client, "mindgraph_retrieve", {
      action: "context",
      query: "node",
      format: "json",
      max_output_chars: 700,
    });

    expect(textResult.content[0].text.length).toBeLessThanOrEqual(700);
    expect(textResult.content[0].text).toContain("bounded to 700 chars");
    expect(JSON.parse(jsonResult.content[0].text)).toEqual(largeResponse);
  });

  it("falls back to raw JSON when the renderer does not recognize the shape", async () => {
    const client = {
      retrieve: vi.fn().mockResolvedValue({ counts: { merge_candidates: 3 } }),
    } as unknown as MindGraph;
    const result = await handleTool(client, "mindgraph_retrieve", {
      action: "recent",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.counts.merge_candidates).toBe(3);
  });

  it("dispatch renders live traversal steps instead of returning raw wire JSON", async () => {
    const client = {
      traverse: vi.fn().mockResolvedValue({
        mode: "neighborhood",
        start_uid: "decision-uid",
        steps: [
          {
            depth: 1,
            edge_from_uid: "decision-uid",
            edge_to_uid: "evidence-uid",
            edge_type: { Custom: "SUPPORTED_BY" },
            label: "Decision evidence",
            node_type: "Observation",
            node_uid: "evidence-uid",
            parent_uid: "decision-uid",
            traversal_role: "outgoing",
          },
        ],
      }),
    } as unknown as MindGraph;

    const result = await handleTool(client, "mindgraph_retrieve", {
      action: "neighborhood",
      start_uid: "decision-uid",
    });

    expect(result.content[0].text).toContain("# Graph traversal (neighborhood)");
    expect(result.content[0].text).toContain("—SUPPORTED_BY→");
    expect(() => JSON.parse(result.content[0].text)).toThrow();
  });
});

// ── Regressions from the adversarial review (2026-07-30) — all fixtures
// below use the REAL wire shapes quoted from mindgraph-server. ────────────

describe("review regressions — real wire shapes", () => {
  it("unwraps SearchResult {node, score} arrays (text/semantic/hybrid/preferences wire)", () => {
    const wire = [
      {
        node: { uid: "n1", label: "MindGraph", node_type: "Entity", confidence: 1, props: {} },
        score: 0.874,
      },
      {
        node: { uid: "n2", label: "Claim about memory", node_type: "Claim", props: {} },
        score: 0.61,
      },
    ];
    const text = renderNodeList(wire, "Hybrid search: mindgraph")!;
    expect(text).toContain("**MindGraph** [n1] (Entity, confidence 1, score 0.87)");
    expect(text).toContain("**Claim about memory** [n2]");
  });

  it("renders top_k_paths' real wire: {paths: [{node_uids, labels, cost}]}", () => {
    const text = renderTraversal({
      mode: "top_k_paths",
      start_uid: "a",
      end_uid: "c",
      k: 2,
      paths: [
        { node_uids: ["a", "b", "c"], labels: ["Start", "Middle", "End"], cost: 1.39 },
        { node_uids: ["a", "c"], labels: ["Start", "End"], cost: 2.1 },
      ],
    })!;
    expect(text).toContain("1. Start → Middle → End (cost 1.39)");
    expect(text).toContain("uids: a → b → c");
    expect(text).toContain("2. Start → End (cost 2.1)");
  });

  it("an oversized single-type section packs item-wise instead of blanking the output", () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      uid: `node-${index}`,
      label: `${"L".repeat(170)} ${index}`,
      node_type: "Observation",
      props: { content: "s".repeat(390) },
    }));
    const text = renderNodeList(nodes, "Recently ingested")!;
    // Items render up to the budget; the remainder is counted, not silent.
    expect(text).toContain("[node-0]");
    expect(text).toMatch(/\(\+\d+ more not shown\)/);
    expect(text.length).toBeLessThan(26_000);
  });

  it("a later small section survives an oversized earlier section", () => {
    const big = {
      graph: {
        nodes: Array.from({ length: 60 }, (_, index) => ({
          uid: `node-${index}`,
          label: `${"L".repeat(170)} ${index}`,
          node_type: "Observation",
          props: { content: "s".repeat(390) },
        })),
        edges: [],
      },
      chunks: [
        {
          chunk_uid: "chunk-final",
          content: "small excerpt",
          score: 1,
          document_uid: "d",
          document_title: "Doc",
          chunk_index: 0,
        },
      ],
    };
    const text = renderContext(big)!;
    expect(text).toContain("chunk-final");
  });

  it("policy prose_rules (Vec<String> on the wire) render joined", () => {
    const text = renderContext({
      graph: { nodes: [{ uid: "n1", label: "X", node_type: "Entity", props: {} }], edges: [] },
      applicable_policies: [
        { uid: "p1", name: "Data policy", prose_rules: ["Never expose PII", "Log all access"] },
      ],
    })!;
    expect(text).toContain("- Data policy: Never expose PII; Log all access");
  });

  it("hidden_item_count and policies render even when the graph result is empty", () => {
    const text = renderContext({
      graph: { nodes: [], edges: [] },
      hidden_item_count: "1-9",
      applicable_policies: [{ uid: "p1", name: "Scope policy", prose_rules: ["Stay in project"] }],
    })!;
    expect(text).toContain("No graph results matched this search.");
    expect(text).toContain("hidden by access scoping");
    expect(text).toContain("Scope policy");
    expect(text).not.toBe("No results found for this search.");
  });

  it("infra-only matches explain themselves instead of claiming no results", () => {
    const text = renderContext({
      graph: {
        nodes: [{ uid: "d1", label: "Some Doc", node_type: "Document", props: {} }],
        edges: [],
      },
    })!;
    expect(text).toContain("document/chunk node(s) matched");
  });

  it("excludes PascalCase PossibleDuplicate edges (traverse wire format)", () => {
    const text = renderTraversal({
      nodes: [
        { uid: "a", label: "Old obs", node_type: "Observation", props: {} },
        { uid: "b", label: "New obs", node_type: "Observation", props: {} },
      ],
      edges: [
        { uid: "e1", edge_type: "PossibleDuplicate", from_uid: "a", to_uid: "b", props: {} },
        { uid: "e2", edge_type: "Supersedes", from_uid: "b", to_uid: "a", props: {} },
      ],
    })!;
    expect(text).not.toContain("PossibleDuplicate");
    expect(text).toContain("New obs —Supersedes→ Old obs");
  });

  it("caps rendered items at the caller's limit when the server ignores it", () => {
    const nodes = Array.from({ length: 30 }, (_, index) => ({
      uid: `goal-${index}`,
      label: `Goal ${index}`,
      node_type: "Goal",
      props: {},
    }));
    const text = renderNodeList(nodes, "active goals", 5)!;
    expect(text).toContain("# active goals (5 of 30)");
    expect(text).not.toContain("goal-7");
  });
});
