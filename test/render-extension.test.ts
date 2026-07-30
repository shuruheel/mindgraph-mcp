import { describe, expect, it, vi } from "vitest";
import {
  renderJobs,
  renderObjectList,
  renderOntologyAnswer,
  renderSignals,
} from "../src/render.js";
import { handleTool } from "../src/tools.js";
import { getGeneratedTools, clearGeneratedToolCache, handleGeneratedTool } from "../src/generated-tools.js";
import type { MindGraph } from "mindgraph";

// Fixtures follow the VERIFIED wire shapes: ontology_handlers.rs
// QueryResponse (objects: Vec<GraphNode>, NeighborNode/NeighborEdge,
// ProvenanceEntry with span_kind anchor|chunk_head), search
// {items,total_count,truncation_reasons}, SDK Job, SignalsResponse.

describe("renderOntologyAnswer", () => {
  const response = {
    objects: [
      {
        uid: "cust-1",
        label: "ACME Corp",
        node_type: "Custom",
        confidence: 1,
        props: { object_type: "Customer", fields: { region: "EMEA", arr: 120000 } },
      },
    ],
    relations: [
      { edge_uid: "r1", from_uid: "cust-1", to_uid: "req-1", edge_type: "HAS_REQUIREMENT", traversal_role: "outgoing", depth: 1 },
    ],
    cognitive_context: {
      claims: [{ uid: "claim-1", label: "ACME renewal is at risk", node_type: "Claim", layer: "epistemic", depth: 1 }],
      risks: [],
    },
    external_refs: [],
    graph: { nodes: [{ uid: "req-1", label: "SSO requirement", node_type: "Custom", layer: "ontology", depth: 1 }], edges: [] },
    provenance: [
      { node_uid: "cust-1", source_uid: "doc-1", text_span: "ACME signed the enterprise contract", span_kind: "anchor", ingested_by_name: "Shan" },
      { node_uid: "cust-1", source_uid: "doc-2", text_span: "Meeting notes from Q2 review covering multiple accounts", span_kind: "chunk_head" },
    ],
    confidence: { overall: 0.82 },
    returned_count: 1,
    has_more: false,
    seed_cap_hit: false,
  };

  it("renders objects with their domain type, relations, context, and confidence", () => {
    const text = renderOntologyAnswer(response)!;
    expect(text).toContain("### Customer");
    expect(text).toContain("**ACME Corp** [cust-1] (Customer, confidence 1)");
    expect(text).toContain("fields: region: EMEA; arr: 120000");
    expect(text).toContain("ACME Corp —HAS_REQUIREMENT→ SSO requirement");
    expect(text).toContain("### Cognitive context — claims");
    expect(text).toContain("ACME renewal is at risk [claim-1] (Claim)");
    expect(text).toContain("overall confidence 0.82");
  });

  it("C10: anchor spans quote, chunk_head spans are context and never quoted", () => {
    const text = renderOntologyAnswer(response)!;
    expect(text).toContain('- "ACME signed the enterprise contract" (ingested by Shan) [source doc-1]');
    expect(text).toContain("- context: Meeting notes from Q2 review");
    expect(text).not.toContain('"Meeting notes');
  });

  it("returns undefined for unknown shapes", () => {
    expect(renderOntologyAnswer({ something: true })).toBeUndefined();
  });
});

describe("renderObjectList", () => {
  it("renders items with totals and truncation reasons", () => {
    const text = renderObjectList(
      {
        // TRUE search wire: items are {object, score} wrappers
        // (ontology_handlers.rs:1347-1350) — bare nodes here previously
        // green-lit a renderer that told models "(0 results)" on real hits.
        items: [
          { object: { uid: "c1", label: "ACME", node_type: { Custom: "Customer" }, props: { _type: "Custom", type_name: "Customer", data: { fields: { region: "EMEA" } } } }, score: 0.9 },
          { object: { uid: "c2", label: "Globex", node_type: { Custom: "Customer" }, props: { _type: "Custom", type_name: "Customer", data: {} } }, score: 0.7 },
        ],
        returned_count: 2,
        total_count: 41,
        total_count_exact: true,
        has_more: true,
        truncation_reasons: ["seed_cap"],
      },
      "Customer search: corp",
    )!;
    expect(text).toContain("# Customer search: corp (2 of 41)");
    expect(text).toContain("### Customer"); // serde-tagged type resolved
    expect(text).toContain("**ACME** [c1] (Customer, score 0.9)");
    expect(text).toContain("fields: region: EMEA");
    expect(text).toContain("more results exist");
    expect(text).toContain("truncated: seed_cap");
  });

  it("renders an honest empty page and rejects unknown shapes", () => {
    expect(renderObjectList({ items: [], has_more: false }, "Customers")).toBe("# Customers (0 results)");
    expect(renderObjectList({ rows: [[1, 2]] }, "structured")).toBeUndefined();
  });
});

describe("renderJobs", () => {
  it("renders newest-first, bounded, with progress and errors", () => {
    const jobs = Array.from({ length: 25 }, (_, index) => ({
      id: `job-${index}`,
      title: `Ingest ${index}`,
      status: index === 24 ? "failed" : "completed",
      progress: { total_chunks: 10, processed_chunks: 10, nodes_created: 42, edges_created: 10 },
      result: null,
      error: index === 24 ? "boom" : null,
      created_at: 1000 + index,
    }));
    const text = renderJobs(jobs)!;
    expect(text).toContain("# Ingestion jobs (20 of 25)");
    expect(text).toContain("[job-24] Ingest 24 — failed, 10/10 chunks, 42 nodes, error: boom");
    expect(text).toContain("[job-23] Ingest 23 — completed, 10/10 chunks, 42 nodes");
    expect(text).not.toContain("[job-2]"); // oldest five dropped
    expect(text).toContain("…[rendered context bounded");
  });

  it("handles the empty list", () => {
    expect(renderJobs([])).toBe("No ingestion jobs.");
  });
});

describe("renderSignals", () => {
  it("renders named signal arrays as sections with labels, uids, and numbers", () => {
    const text = renderSignals({
      project_uid: "proj-1",
      documents: [{ uid: "d1", title: "Q2 Strategy", chunk_count: 12 }],
      entity_bridges: [{ uid: "e1", label: "ACME", document_count: 3, score: 0.91 }],
      claim_hubs: [],
    })!;
    expect(text).toContain("## documents");
    expect(text).toContain("Q2 Strategy");
    expect(text).toContain("## entity bridges");
    expect(text).toContain("ACME [e1]");
    expect(text).toContain("score 0.91");
    expect(text).not.toContain("claim_hubs");
  });

  it("returns undefined when nothing renders", () => {
    expect(renderSignals({ project_uid: "p" })).toBeUndefined();
  });
});

describe("dispatch: ontology + jobs + format contract", () => {
  const queryResponse = {
    objects: [{ uid: "o1", label: "Obj", node_type: "Custom", props: { object_type: "Customer" } }],
    relations: [], cognitive_context: {}, external_refs: [],
    graph: { nodes: [], edges: [] }, provenance: [], confidence: { overall: 1 },
    returned_count: 1, has_more: false, seed_cap_hit: false,
  };

  it("ontology query renders by default; format json returns compact raw", async () => {
    const client = { queryOntology: vi.fn().mockResolvedValue(queryResponse) } as unknown as MindGraph;
    const rendered = await handleTool(client, "mindgraph_ontology", { action: "query", query: "q", schema_id: "s1" });
    expect(rendered.content[0].text).toContain("# Ontology results (1 object)");
    const raw = await handleTool(client, "mindgraph_ontology", { action: "query", query: "q", schema_id: "s1", format: "json" });
    expect(JSON.parse(raw.content[0].text).objects[0].uid).toBe("o1");
    expect(raw.content[0].text).not.toContain('\n  "'); // compact, not pretty
  });

  it("job_status without job_id renders the bounded list", async () => {
    const client = { listJobs: vi.fn().mockResolvedValue([{ id: "j1", title: "T", status: "completed", progress: { total_chunks: 1, processed_chunks: 1, nodes_created: 2, edges_created: 0 }, result: null, error: null, created_at: 5 }]) } as unknown as MindGraph;
    const result = await handleTool(client, "mindgraph_ingest", { action: "job_status" });
    expect(result.content[0].text).toContain("# Ingestion jobs (1)");
  });
});

describe("generated tools: schema injection + rendering", () => {
  const descriptor = (over: Record<string, unknown>) => ({
    name: "search_customer",
    description: "d",
    schema_id: "s1",
    object_type: "Customer",
    maps_to: "search",
    input_schema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
    ...over,
  });

  it("injects format into read-tool schemas but not structured_query", async () => {
    clearGeneratedToolCache();
    const client = {
      listOntologyTools: vi.fn().mockResolvedValue({
        tools: [
          descriptor({}),
          descriptor({ name: "structured_query_x", maps_to: "structured_query", input_schema: { type: "object", properties: { select: { type: "string" } }, additionalProperties: false } }),
        ],
      }),
    } as unknown as MindGraph;
    const { tools } = await getGeneratedTools(client);
    const search = tools.find((tool) => tool.name === "search_customer")!;
    const structured = tools.find((tool) => tool.name === "structured_query_x")!;
    expect((search.inputSchema.properties as Record<string, unknown>).format).toBeDefined();
    expect((structured.inputSchema.properties as Record<string, unknown>).format).toBeUndefined();
    clearGeneratedToolCache();
  });

  it("search renders wire-shaped results and structured_query stays raw", async () => {
    const client = {
      searchDomainObjects: vi.fn().mockResolvedValue({
        items: [{ object: { uid: "c1", label: "ACME", node_type: { Custom: "Customer" }, props: { _type: "Custom", type_name: "Customer", data: {} } }, score: 1 }],
        returned_count: 1, total_count: 1, total_count_exact: true, has_more: false, truncation_reasons: [],
      }),
      queryDomainStructured: vi.fn().mockResolvedValue({ rows: [["ACME", 3]], columns: ["name", "count"] }),
    } as unknown as MindGraph;
    const rendered = await handleGeneratedTool(client as never, descriptor({}) as never, { query: "acme" });
    expect(rendered.content[0].text).toContain("**ACME** [c1]");
    const structured = await handleGeneratedTool(
      client as never,
      descriptor({ name: "sq", maps_to: "structured_query" }) as never,
      { select: "Customer" },
    );
    expect(JSON.parse(structured.content[0].text).rows[0][0]).toBe("ACME");
  });
});

describe("renderOntologyAnswer empty result", () => {
  it("renders an honest no-results line for a recognized empty QueryResponse", () => {
    expect(
      renderOntologyAnswer({
        objects: [], relations: [], cognitive_context: {}, external_refs: [],
        graph: { nodes: [], edges: [] }, provenance: [], confidence: { overall: 0 },
        returned_count: 0, has_more: false, seed_cap_hit: false,
      }),
    ).toBe("No matching domain objects.");
  });
});


// ── Wire-truth regressions (adversarial review round 2) ─────────────────

describe("wire-truth regressions", () => {
  it("serde-tagged Custom nodes render their domain type and data.fields", () => {
    const text = renderNodeList(
      [
        {
          uid: "c1",
          label: "ACME",
          node_type: { Custom: "Customer" },
          props: { _type: "Custom", type_name: "Customer", layer: "ontology", data: { domain_type: "Customer", fields: { region: "EMEA", arr: 5 } } },
        },
      ],
      "objects",
    )!;
    expect(text).toContain("### Customer");
    expect(text).not.toContain("### Node");
    expect(text).toContain("fields: region: EMEA; arr: 5");
  });

  it("object_context (no graph key) renders relations via cognitive labels and uid fallback", () => {
    const text = renderOntologyAnswer({
      object: { uid: "cust-1", label: "ACME", node_type: { Custom: "Customer" }, props: { _type: "Custom", type_name: "Customer", data: {} } },
      relations: [
        { edge_uid: "e1", from_uid: "claim-1", to_uid: "cust-1", edge_type: "ABOUT", traversal_role: "incoming", depth: 1 },
        { edge_uid: "e2", from_uid: "cust-1", to_uid: "mystery-9", edge_type: "HAS_REQUIREMENT", traversal_role: "outgoing", depth: 1 },
      ],
      cognitive_context: {
        claims: [{ uid: "claim-1", label: "ACME renewal at risk", node_type: "Claim", layer: "epistemic", depth: 1 }],
      },
      sources: [],
      provenance: [],
    })!;
    expect(text).toContain("ACME renewal at risk —ABOUT→ ACME");
    expect(text).toContain("ACME —HAS_REQUIREMENT→ [mystery-9]"); // uid fallback beats dropping
  });

  it("related_* structured responses ({rows: [{object}]}) render", () => {
    const text = renderObjectList(
      {
        plan: {},
        rows: [
          { object: { uid: "r1", label: "SSO requirement", node_type: { Custom: "Requirement" }, props: { _type: "Custom", type_name: "Requirement", data: {} } } },
        ],
        relations: [],
        provenance: [],
        total_count: 1,
      },
      "Requirement related via HAS_REQUIREMENT",
    )!;
    expect(text).toContain("**SSO requirement** [r1] (Requirement)");
  });

  it("signals identify claim hubs and dialectical pairs by their real label keys", () => {
    const text = renderSignals({
      project_uid: "p",
      claim_hubs: [{ target_uid: "t1", target_label: "Institutional memory thesis", claim_count: 14 }],
      dialectical_pairs: [{ from_uid: "a", from_label: "Memory as retrieval", to_uid: "b", to_label: "Memory as reasoning" }],
    })!;
    expect(text).toContain("Institutional memory thesis [t1] (claim_count 14)");
    expect(text).toContain("Memory as retrieval ↔ Memory as reasoning");
    expect(text).not.toContain("(item)");
  });
});
