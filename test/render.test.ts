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
      content: "x".repeat(3_000),
      article_type: "entity",
    }));
    const text = renderContext(big)!;
    expect(text.length).toBeLessThan(26_000);
    expect(text).toContain("[rendered context bounded");
    expect(text).not.toContain("x".repeat(2_600));
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
});
