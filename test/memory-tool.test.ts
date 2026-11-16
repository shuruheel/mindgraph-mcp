import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MindGraph } from "mindgraph";
import { toolMutability } from "../src/governance.js";
import {
  handleMemoryTool,
  MEMORY_TOOL,
  memoryStatus,
} from "../src/memory-tool.js";

function client(overrides: Record<string, unknown> = {}) {
  return {
    retrieveContext: vi.fn(async () => ({ graph: { nodes: [], edges: [] } })),
    plan: vi.fn(async () => ({ action: "resume_work", status: "no_eligible_work", task: null })),
    ...overrides,
  } as unknown as Pick<MindGraph, "retrieveContext" | "plan"> & Record<string, ReturnType<typeof vi.fn>>;
}

describe("mindgraph_memory M0 contract", () => {
  it("is a strictly read-only, idempotent status/context surface", () => {
    const properties = (MEMORY_TOOL.inputSchema as {
      properties: { action: { enum: string[] } };
    }).properties;
    expect(properties.action.enum).toEqual(["status", "context", "open", "index"]);
    expect(MEMORY_TOOL.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(MEMORY_TOOL.outputSchema).toBeDefined();
    expect(toolMutability("mindgraph_memory", "status")).toBe("read");
    expect(toolMutability("mindgraph_memory", "context")).toBe("read");
  });

  it("reports explicit M0 capabilities without claiming automatic delivery or curation", async () => {
    const c = client();
    const result = await handleMemoryTool(c, { action: "status", agent_id: "agent-1" }, {
      serverVersion: "0.test",
      baseUrl: "https://api.example.test",
      profile: "coding",
      harness: "codex",
      orgId: "org-1",
    });
    const status = result.structuredContent!;
    expect(status).toEqual(memoryStatus({
      serverVersion: "0.test",
      baseUrl: "https://api.example.test",
      profile: "coding",
      harness: "codex",
      orgId: "org-1",
      agentId: "agent-1",
    }));
    expect(status).toMatchObject({
      schema_version: "mindgraph.memory.result.v1",
      action: "status",
      profile: "M0",
      integration: {
        automatic_capture: false,
        automatic_delivery: false,
        delivery_verification: "unsupported",
        curator_mode: "disabled",
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual(status);
    expect(c.retrieveContext).not.toHaveBeenCalled();
    expect(c.plan).not.toHaveBeenCalled();
  });

  it("returns a stable, hashed, structured envelope for bounded topic context", async () => {
    const retrieveContext = vi.fn(async () => ({
      graph: {
        nodes: [
          {
            uid: "claim-1",
            node_type: "Claim",
            label: "Graph state aids continuation",
            summary: "A scoped claim.",
            confidence: 0.8,
            updated_at: "2026-09-03T12:00:00Z",
          },
          {
            uid: "evidence-1",
            node_type: "Observation",
            label: "Observed continuation result",
            summary: "A bounded observation.",
          },
        ],
        edges: [
          { from_uid: "evidence-1", to_uid: "claim-1", edge_type: "SUPPORTS" },
        ],
      },
      articles: [],
      chunks: [],
    }));
    const c = client({ retrieveContext });
    const args = {
      action: "context",
      mode: "topic",
      query: "graph continuation",
      project_uid: "project-1",
      max_output_chars: 2_000,
      agent_id: "agent-1",
    };
    const first = await handleMemoryTool(c, args, { harness: "generic", orgId: "org-1" });
    const second = await handleMemoryTool(c, args, { harness: "generic", orgId: "org-1" });
    const envelope = first.structuredContent!;
    const rendered = first.content[0].text;
    expect(retrieveContext).toHaveBeenCalledWith(expect.objectContaining({
      query: "graph continuation",
      project_uid: "project-1",
      node_limit: 8,
      article_limit: 0,
      include_graph: true,
      graph_expansion_limit: 3,
      graph_max_depth: 2,
      format: "text",
      max_tokens: 500,
    }));
    expect(retrieveContext.mock.calls[0][0]).not.toHaveProperty("chunk_limit");
    expect(envelope).toMatchObject({
      action: "context",
      mode: "topic",
      rendered_context: rendered,
      rendered_hash: createHash("sha256").update(rendered).digest("hex"),
      retrieval_trace: {
        strategy: "retrieve_context",
        available_items: 3,
        returned_items: 3,
        omitted_items: 0,
      },
      budget: { requested_chars: 2_000, used_chars: rendered.length, bounded: false },
      freshness: { latest_source_timestamp: "2026-09-03T12:00:00Z" },
    });
    expect(envelope.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ uid: "claim-1", type: "Claim" }),
      expect.objectContaining({ uid: "evidence-1", type: "Observation" }),
      expect.objectContaining({
        type: "Relationship",
        from_uid: "evidence-1",
        to_uid: "claim-1",
        edge_type: "SUPPORTS",
      }),
    ]));
    expect(envelope.context_id).toMatch(/^ctx_[a-f0-9]{24}$/);
    expect(second.structuredContent?.context_id).toBe(envelope.context_id);
    expect(envelope.warnings).toContainEqual(expect.objectContaining({ code: "delivery_unverified" }));
  });

  it("uses authoritative resume_work for resume and continuity modes", async () => {
    const plan = vi.fn(async () => ({
      action: "resume_work",
      selection_reason: "explicit task scope",
      task: {
        uid: "task-1",
        node_type: "Task",
        label: "Implement M0",
        summary: "Add the portable read workflow.",
      },
      next_steps: [
        { uid: "step-1", node_type: "Step", label: "Run conformance tests" },
      ],
      blockers: [],
      knowledge: { lessons: [], risks: [] },
      recent_executions: [],
      code_targets: [],
      truncation: { steps: false, executions: false },
    }));
    const c = client({ plan });
    for (const mode of ["resume", "continuity"] as const) {
      const result = await handleMemoryTool(c, {
        action: "context",
        mode,
        task_uid: "task-1",
        project_uid: "project-1",
        agent_id: "agent-1",
      });
      expect(result.content[0].text).toContain("# Resume context");
      expect(result.content[0].text).toContain("[task-1]");
      expect(result.structuredContent).toMatchObject({
        mode,
        retrieval_trace: { strategy: "resume_work" },
      });
    }
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({
      action: "resume_work",
      task_uid: "task-1",
      scope_uids: ["project-1"],
      limit: 1,
      agent_id: "agent-1",
    }));
    expect(c.retrieveContext).not.toHaveBeenCalled();
  });

  it("enforces the hard output bound and reports omitted structured items", async () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      uid: `claim-${index}`,
      node_type: "Claim",
      label: `Claim ${index}`,
      summary: "x".repeat(390),
    }));
    const c = client({
      retrieveContext: vi.fn(async () => ({ graph: { nodes, edges: [] } })),
    });
    const result = await handleMemoryTool(c, {
      action: "context",
      mode: "topic",
      query: "claims",
      max_output_chars: 512,
    });
    expect(result.content[0].text.length).toBeLessThanOrEqual(512);
    expect(result.structuredContent?.budget).toMatchObject({ bounded: true });
    expect(result.structuredContent?.warnings).toContainEqual(
      expect.objectContaining({ code: "context_bounded" }),
    );
  });

  it("warns about superseded items in the /retrieve/context shape", async () => {
    const c = client({
      retrieveContext: vi.fn(async () => ({
        graph: {
          nodes: [
            {
              uid: "old",
              node_type: "Observation",
              label: "Budget is $5,000",
              superseded: { by: ["new"], heads: ["new"], head_uid: "new", head_label: "Budget is $8,000" },
            },
          ],
          edges: [],
        },
      })),
    });
    const result = await handleMemoryTool(c, { action: "context", mode: "topic", query: "budget" });
    expect(result.content[0].text).toContain("SUPERSEDED by Budget is $8,000");
    expect(result.structuredContent?.warnings).toContainEqual(
      expect.objectContaining({ code: "superseded_items_present" }),
    );
    expect(JSON.stringify(result.structuredContent)).toContain('"superseded":true');
  });

  it("returns actionable errors for missing or invalid context intent", async () => {
    const c = client();
    const missingQuery = await handleMemoryTool(c, { action: "context", mode: "topic" });
    expect(missingQuery.isError).toBe(true);
    expect(missingQuery.content[0].text).toContain("requires a non-empty query");

    const missingMode = await handleMemoryTool(c, { action: "context" });
    expect(missingMode.isError).toBe(true);
    expect(missingMode.content[0].text).toContain("requires mode");

    const mutatingAction = await handleMemoryTool(c, { action: "observe" });
    expect(mutatingAction.isError).toBe(true);
    expect(mutatingAction.content[0].text).toContain("status");
    expect(c.retrieveContext).not.toHaveBeenCalled();
    expect(c.plan).not.toHaveBeenCalled();
  });
});

describe("tool-selection conformance", () => {
  const actionEnum = (name: string): string[] => {
    if (name !== MEMORY_TOOL.name) return [];
    return ((MEMORY_TOOL.inputSchema as { properties: { action: { enum: string[] } } })
      .properties.action.enum);
  };

  it.each([
    ["inspect integration support", "status"],
    ["retrieve prior topic knowledge", "context"],
    ["resume authoritative work", "context"],
    ["continue a scoped task", "context"],
  ])("supports the high-level read intent %s", (_intent, action) => {
    expect(actionEnum("mindgraph_memory")).toContain(action);
  });

  it.each([
    ["capture a durable fact", "observe"],
    ["record a checkpoint", "checkpoint"],
    ["inspect curator proposals", "proposals"],
    ["autonomously mutate memory", "mutate"],
  ])("does not blur the read-only surface with %s", (_intent, action) => {
    expect(actionEnum("mindgraph_memory")).not.toContain(action);
  });
});

describe("mode='brief' (conversation-start orientation)", () => {
  const config = { serverVersion: "0.test", baseUrl: "https://api.example.test", orgId: "org-1", agentId: "mcp:host:user" };
  const node = (uid: string, label: string, props: Record<string, unknown> = {}) => ({ uid, label, node_type: "X", props });

  it("reads work, goals, decisions and preferences in one call and renders them by section", async () => {
    const c = client({
      plan: vi.fn(async () => ({
        action: "resume_work",
        status: "eligible",
        task: { uid: "task-1", label: "Ship the connector", props: { status: "in_progress" } },
        other_eligible: [{ uid: "task-2", label: "Write the listing", status: "todo", scope_uids: [] }],
        eligible_total: 2,
      })),
      getGoals: vi.fn(async () => [node("goal-1", "Reach 100 connected apps", { status: "active" })]),
      getOpenDecisions: vi.fn(async () => [node("dec-1", "Which directory first?")]),
      retrieve: vi.fn(async () => [{ node: node("pref-1", "Prefers short answers"), score: 0.9 }]),
    });
    const result = await handleMemoryTool(c, { action: "context", mode: "brief", project_uid: "proj-1" }, config);
    expect(result.isError).toBeFalsy();
    expect(c.plan).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resume_work", limit: 6, scope_uids: ["proj-1"], agent_id: "mcp:host:user" }),
    );
    expect(c.retrieve).toHaveBeenCalledWith(expect.objectContaining({ action: "preferences" }));
    const text = result.content[0].text;
    expect(text).toContain("## Work in progress");
    expect(text).toContain("[task-1]");
    expect(text).toContain("## Active goals\n- Reach 100 connected apps [goal-1] — active");
    expect(text).toContain("## Open decisions\n- Which directory first? [dec-1]");
    expect(text).toContain("## Preferences\n- Prefers short answers [pref-1]");
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.mode).toBe("brief");
    expect(structured.retrieval_trace.strategy).toBe("brief");
    expect(structured.items.map((item: { uid: string }) => item.uid)).toEqual(
      expect.arrayContaining(["task-1", "goal-1", "dec-1", "pref-1"]),
    );
    expect(structured.warnings.map((w: { code: string }) => w.code)).not.toContain("brief_section_unavailable");
  });

  it("names a section that failed instead of presenting it as empty", async () => {
    const c = client({
      getGoals: vi.fn(async () => {
        throw new Error("503");
      }),
      getOpenDecisions: vi.fn(async () => []),
      retrieve: vi.fn(async () => []),
    });
    const result = await handleMemoryTool(c, { action: "context", mode: "brief" }, config);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Nothing to orient on yet");
    const warning = (result.structuredContent as Record<string, any>).warnings.find(
      (w: { code: string }) => w.code === "brief_section_unavailable",
    );
    expect(warning.message).toContain("goals");
    expect(warning.message).not.toContain("preferences");
  });

  it("counts what a long section leaves out", async () => {
    const goals = Array.from({ length: 9 }, (_, index) => node(`goal-${index}`, `Goal ${index}`));
    const c = client({
      getGoals: vi.fn(async () => goals),
      getOpenDecisions: vi.fn(async () => []),
      retrieve: vi.fn(async () => []),
    });
    const text = (await handleMemoryTool(c, { action: "context", mode: "brief" }, config)).content[0].text;
    expect(text).toContain("## Active goals (6 shown, 3 more)");
    expect(text).toContain("[goal-5]");
    expect(text).not.toContain("[goal-6]");
  });

  it("lists the member's own goals most recent first, without document-extracted ones or coding-only sections", async () => {
    const c = client({
      plan: vi.fn(async () => ({
        action: "resume_work",
        status: "eligible",
        task: { uid: "task-1", label: "Ship", props: {} },
        other_eligible: [{ uid: "task-2", label: "Next", status: "todo", scope_uids: [] }],
        code_targets: [{ uid: "repo-1", label: "github.com/x/y", node_type: "Entity" }],
        selection_reason: "blocked",
      })),
      getGoals: vi.fn(async () => [
        { ...node("goal-old", "Old goal"), updated_at: 10 },
        { ...node("goal-new", "New goal"), updated_at: 20 },
        { ...node("goal-inferred", "Inferred from a transcript", { source: "session" }), updated_at: 99 },
        { ...node("goal-doc", "A goal a book's subject had", { source: "document" }), updated_at: 30 },
      ]),
      getOpenDecisions: vi.fn(async () => []),
      retrieve: vi.fn(async () => []),
    });
    const text = (await handleMemoryTool(c, { action: "context", mode: "brief" }, config)).content[0].text;
    expect(text.indexOf("[goal-new]")).toBeLessThan(text.indexOf("[goal-old]"));
    expect(text.indexOf("[goal-old]")).toBeLessThan(text.indexOf("[goal-inferred]"));
    expect(text).not.toContain("[goal-doc]");
    expect(text).toContain("- Next [task-2]");
    expect(text).not.toContain("Other scopes");
    expect(text).not.toContain("Code targets");
    expect(text).not.toContain("### Selection");
  });

  it("is an error only when every section fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    const c = client({ plan: failing, getGoals: failing, getOpenDecisions: failing, retrieve: failing });
    const result = await handleMemoryTool(c, { action: "context", mode: "brief" }, config);
    expect(result.isError).toBe(true);
  });

  it("stays inside the output budget", async () => {
    const goals = Array.from({ length: 6 }, (_, index) => node(`goal-${index}`, "x".repeat(400)));
    const c = client({
      getGoals: vi.fn(async () => goals),
      getOpenDecisions: vi.fn(async () => goals.map((g) => ({ ...g, uid: `d-${g.uid}` }))),
      retrieve: vi.fn(async () => []),
    });
    const text = (await handleMemoryTool(c, { action: "context", mode: "brief", max_output_chars: 600 }, config)).content[0].text;
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain("brief truncated");
  });
});

describe("mindgraph_memory topic mode on server-rendered text (RD2)", () => {
  const graph = {
    nodes: [
      { uid: "claim-1", node_type: "Claim", label: "Pilot budget is $8,000", summary: "The current budget." },
      { uid: "obs-1", node_type: "Observation", label: "Budget was raised", summary: "An observation." },
      { uid: "obs-2", node_type: "Observation", label: "Travel was discussed", summary: "Off topic." },
    ],
    edges: [{ from_uid: "obs-1", to_uid: "claim-1", edge_type: "SUPPORTS" }],
  };
  const articles = [{ uid: "art-1", label: "Budget overview", content: "How the budget changed." }];
  const serverText = [
    "Legend: dates are when something was said.",
    "Now: 2026-11-16",
    "## Undated",
    "[undated] Claim — Pilot budget is $8,000: The current budget.",
    "[undated] Observation — Budget was raised",
    "## Background",
    "[article] Budget overview",
    "How the budget changed.",
  ].join("\n");
  const topic = { action: "context", mode: "topic", query: "pilot budget" };

  it.each([
    [{}, undefined],
    [{ include_chunks: true }, 8],
    [{ include_chunks: true, limit: 4 }, 4],
    [{ include_chunks: false }, 0],
  ])("sends a text read with %j and chunk_limit %s on the wire", async (extra, expected) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, options: RequestInit) => {
        bodies.push(JSON.parse(String(options.body)));
        return new Response(JSON.stringify({ graph: { nodes: [], edges: [] } }), { status: 200 });
      }),
    );
    try {
      const { MindGraph } = await import("mindgraph");
      const real = new MindGraph({ baseUrl: "https://offline.invalid" });
      await handleMemoryTool(real, { ...topic, ...extra });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bodies).toHaveLength(1);
    if (expected === undefined) expect(bodies[0]).not.toHaveProperty("chunk_limit");
    else expect(bodies[0].chunk_limit).toBe(expected);
    // The default 8,000-character budget at four characters per token.
    expect(bodies[0]).toMatchObject({ query: "pilot budget", format: "text", max_tokens: 2000, article_limit: 0 });
  });

  it("returns the server text and exactly the items it lists", async () => {
    const c = client({
      retrieveContext: vi.fn(async () => ({
        graph,
        articles,
        context_text: serverText,
        used_tokens: 60,
        truncated: true,
        omitted: { nodes: 1, chunks: 0, articles: 0, conflicts: 0, node_details: 1 },
        rendered: { nodes: ["claim-1", "obs-1"], brief_nodes: ["obs-1"], chunks: [], articles: ["art-1"] },
      })),
    });
    const result = await handleMemoryTool(c, topic);
    const envelope = result.structuredContent!;
    expect(result.content[0].text).toBe(serverText);
    expect(envelope.rendered_context).toBe(serverText);
    expect(envelope.items).toEqual([
      expect.objectContaining({ uid: "claim-1", type: "Claim" }),
      expect.objectContaining({ uid: "obs-1", type: "Observation", brief: true }),
      expect.objectContaining({ uid: "art-1", type: "Article" }),
    ]);
    expect((envelope.items as Record<string, unknown>[])[0]).not.toHaveProperty("brief");
    expect(envelope.budget).toMatchObject({
      available_items: 4,
      returned_items: 3,
      omitted_items: 1,
      bounded: true,
    });
    expect(envelope.retrieval_trace).toMatchObject({
      rendering: "server",
      available_items: 4,
      returned_items: 3,
      omitted_items: 1,
      server_omitted: { nodes: 1, node_details: 1 },
    });
    const codes = (envelope.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).toContain("context_bounded");
    // The server's `truncated` is its text budget, not truncated source fields.
    expect(codes).not.toContain("source_truncated");
  });

  it("is unbounded when the server wrote everything", async () => {
    const c = client({
      retrieveContext: vi.fn(async () => ({
        graph: { nodes: graph.nodes.slice(0, 2), edges: graph.edges },
        context_text: serverText,
        truncated: false,
        omitted: { nodes: 0, chunks: 0, articles: 0, conflicts: 0, node_details: 0 },
        rendered: { nodes: ["claim-1", "obs-1"], brief_nodes: [], chunks: [], articles: [] },
      })),
    });
    const envelope = (await handleMemoryTool(c, topic)).structuredContent!;
    expect(envelope.items).toHaveLength(2);
    expect(envelope.budget).toMatchObject({ omitted_items: 0, bounded: false });
    const codes = (envelope.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).not.toContain("context_bounded");
  });

  it("drops listed items the character budget cut from the server text", async () => {
    const long = `${serverText.split("\n").slice(0, 4).join("\n")}\n${"filler ".repeat(120)}\n[undated] Observation — Budget was raised`;
    const c = client({
      retrieveContext: vi.fn(async () => ({
        graph,
        context_text: long,
        truncated: false,
        omitted: { nodes: 0, chunks: 0, articles: 0, conflicts: 0, node_details: 0 },
        rendered: { nodes: ["claim-1", "obs-1"], brief_nodes: [], chunks: [], articles: [] },
      })),
    });
    const result = await handleMemoryTool(c, { ...topic, max_output_chars: 512 });
    const envelope = result.structuredContent!;
    expect(result.content[0].text).toContain("[truncated to 512 characters]");
    expect((envelope.items as Array<{ uid: string }>).map((item) => item.uid)).toEqual(["claim-1"]);
    expect(envelope.budget).toMatchObject({ bounded: true });
  });

  it("renders locally, as before, when the server does not list what it rendered", async () => {
    const json = { graph, articles: [], chunks: [{ chunk_uid: "c-1", content: "Source text about the budget.", document_title: "Session 1" }] };
    const older = { ...json, context_text: serverText, used_tokens: 60, truncated: true, omitted: { nodes: 0 } };
    const before = await handleMemoryTool(client({ retrieveContext: vi.fn(async () => ({ ...json, chunks: [] })) }), topic);
    const after = await handleMemoryTool(client({ retrieveContext: vi.fn(async () => older) }), topic);
    // A JSON read without include_chunks carried no source excerpts; an older
    // server's text read may, and its text and accounting are set aside.
    expect(after.content[0].text).toBe(before.content[0].text);
    expect(after.structuredContent).toEqual(before.structuredContent);
    expect(after.content[0].text).toContain("[claim-1]");
    expect(after.content[0].text).not.toContain("Source text about the budget.");
    expect(after.structuredContent?.retrieval_trace).not.toHaveProperty("rendering");
    const items = after.structuredContent?.items as Array<{ type: string }>;
    expect(items.some((item) => item.type === "Relationship")).toBe(true);

    const withChunks = await handleMemoryTool(
      client({ retrieveContext: vi.fn(async () => older) }),
      { ...topic, include_chunks: true },
    );
    expect(withChunks.content[0].text).toContain("Source text about the budget.");
  });
});
