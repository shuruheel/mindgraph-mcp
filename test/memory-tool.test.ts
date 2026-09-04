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
    expect(properties.action.enum).toEqual(["status", "context"]);
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
      chunk_limit: 0,
      article_limit: 0,
      include_graph: true,
      graph_expansion_limit: 3,
      graph_max_depth: 2,
    }));
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
