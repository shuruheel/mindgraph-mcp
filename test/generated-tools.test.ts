import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MindGraph } from "mindgraph";
import {
  clearGeneratedToolCache,
  getGeneratedTools,
  handleGeneratedTool,
  type GeneratedToolDescriptor,
} from "../src/generated-tools.js";

function descriptor(
  mapsTo: string,
  extra: Partial<GeneratedToolDescriptor> = {},
): GeneratedToolDescriptor {
  return {
    name: `s_schema_12345678__${mapsTo}_12345678`,
    description: mapsTo,
    schema_id: "schema-a",
    object_type: "Requirement",
    maps_to: mapsTo,
    input_schema: { type: "object" },
    ...extra,
  };
}

function payload(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("generated ontology tools", () => {
  beforeEach(() => clearGeneratedToolCache());

  it("passes validated filters through the SDK search method", async () => {
    const searchDomainObjects = vi.fn(async () => ({ items: [], has_more: false }));
    const client = { searchDomainObjects } as unknown as MindGraph;
    const filters = [{ field: "status", op: "eq", value: "open" }];

    const result = await handleGeneratedTool(
      client,
      descriptor("search"),
      { query: "dispatch", filters, limit: 10 },
    );

    expect(result.isError).toBeUndefined();
    expect(searchDomainObjects).toHaveBeenCalledWith("dispatch", {
      schema_id: "schema-a",
      object_types: ["Requirement"],
      filters,
      limit: 10,
    });
  });

  it("binds point and context reads to the descriptor schema and type", async () => {
    const getDomainObject = vi.fn(async () => ({ uid: "requirement-1" }));
    const getDomainObjectContext = vi.fn(async () => ({ rows: [] }));
    const client = {
      getDomainObject,
      getDomainObjectContext,
    } as unknown as MindGraph;

    await handleGeneratedTool(client, descriptor("object"), {
      uid: "requirement-1",
    });
    expect(getDomainObject).toHaveBeenCalledWith("requirement-1", {
      schema_id: "schema-a",
      object_type: "Requirement",
    });

    await handleGeneratedTool(client, descriptor("object_context"), {
      uid: "requirement-1",
      depth: 2,
    });
    expect(getDomainObjectContext).toHaveBeenCalledWith("requirement-1", 2, {
      schema_id: "schema-a",
      object_type: "Requirement",
    });
  });

  it("compiles a related descriptor to the UID anchor and declared role", async () => {
    const queryRelatedDomainObjects = vi.fn(async (request) => request);
    const client = { queryRelatedDomainObjects } as unknown as MindGraph;
    const result = await handleGeneratedTool(
      client,
      descriptor("related", {
        object_type: "Customer",
        relation: "REQUESTED_BY",
        entry_role: "target",
        far_type: "Requirement",
      }),
      { uid: "customer-1", limit: 50 },
    );

    expect(queryRelatedDomainObjects).toHaveBeenCalledWith(expect.objectContaining({
      schema_id: "schema-a",
      entry_type: "Customer",
      uid: "customer-1",
      relation: "REQUESTED_BY",
      entry_role: "target",
      far_type: "Requirement",
      limit: 50,
    }));
    expect(payload(result)).toMatchObject({ uid: "customer-1" });
  });

  it("binds the composite tool to its descriptor schema", async () => {
    const queryDomainStructured = vi.fn(async (request) => request);
    const client = { queryDomainStructured } as unknown as MindGraph;
    const result = await handleGeneratedTool(
      client,
      descriptor("structured_query", { object_type: "" }),
      { schema_id: "attacker-schema", select: "Requirement" },
    );

    expect(queryDomainStructured).toHaveBeenCalledWith({
      schema_id: "schema-a",
      select: "Requirement",
    });
    expect(payload(result)).toMatchObject({ schema_id: "schema-a" });
  });

  // P6: the adapter injects a default agent_id into every tool call, and the
  // composite forwarded the raw args verbatim. The server's request type is
  // deny_unknown_fields and the published input schema is
  // additionalProperties:false, so that one extra key 400'd every structured
  // query. The pre-existing test above passed only because its args happened
  // to contain nothing but keys the dispatcher overwrote.
  it("drops the injected agent_id instead of 400ing the whole structured query", async () => {
    const queryDomainStructured = vi.fn(async (request) => request);
    const client = { queryDomainStructured } as unknown as MindGraph;

    await handleGeneratedTool(
      client,
      descriptor("structured_query", { object_type: "" }),
      { select: "Requirement", agent_id: "mcp" },
    );

    const request = queryDomainStructured.mock.calls[0][0];
    expect(request).not.toHaveProperty("agent_id");
    expect(request).toEqual({ schema_id: "schema-a", select: "Requirement" });
  });

  it("forwards every field the composite tool publishes", async () => {
    const queryDomainStructured = vi.fn(async (request) => request);
    const client = { queryDomainStructured } as unknown as MindGraph;
    const args = {
      select: "Requirement",
      anchor: { type: "Customer", uid: "customer-1" },
      path: [{ relation: "REQUESTED_BY", entry_role: "target" }],
      where: [{ field: "status", op: "eq", value: "open" }],
      include: { provenance: true },
      page: { limit: 25, offset: 50 },
      aggregate: { op: "count", group_by: "status" },
      agent_id: "mcp",
      unexpected: "dropped",
    };

    await handleGeneratedTool(
      client,
      descriptor("structured_query", { object_type: "" }),
      args,
    );

    expect(queryDomainStructured).toHaveBeenCalledWith({
      schema_id: "schema-a",
      select: "Requirement",
      anchor: args.anchor,
      path: args.path,
      where: args.where,
      include: args.include,
      page: args.page,
      aggregate: args.aggregate,
    });
  });

  // P31: one transient manifest failure used to be cached as an authoritative
  // empty tool set for the full 5-minute TTL.
  it("keeps serving the last good manifest when the manifest fetch fails", async () => {
    const listOntologyTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [descriptor("search")] })
      .mockRejectedValue(new Error("ECONNRESET"));
    const client = { listOntologyTools } as unknown as MindGraph;

    const first = await getGeneratedTools(client);
    expect(first.tools).toHaveLength(1);

    // Expire the success TTL so the next call refetches and fails.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      const afterFailure = await getGeneratedTools(client);
      expect(afterFailure.tools).toHaveLength(1);
      expect(afterFailure.byName.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries after the failure cooldown rather than caching the failure", async () => {
    const listOntologyTools = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue({ tools: [descriptor("search")] });
    const client = { listOntologyTools } as unknown as MindGraph;

    expect((await getGeneratedTools(client)).tools).toHaveLength(0);
    // Inside the cooldown: no second request.
    expect((await getGeneratedTools(client)).tools).toHaveLength(0);
    expect(listOntologyTools).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 20 * 1000);
      expect((await getGeneratedTools(client)).tools).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    expect(listOntologyTools).toHaveBeenCalledTimes(2);
  });

  it("reports an actionable SDK compatibility error for graph-aware tools", async () => {
    const client = {} as MindGraph;
    const related = await handleGeneratedTool(
      client,
      descriptor("related", {
        relation: "REQUESTED_BY",
        entry_role: "target",
        far_type: "Requirement",
      }),
      { uid: "customer-1" },
    );
    const structured = await handleGeneratedTool(
      client,
      descriptor("structured_query", { object_type: "" }),
      { select: "Requirement" },
    );

    expect(related.isError).toBe(true);
    expect(payload(related)).toMatchObject({
      error: expect.stringContaining("graph-aware version"),
    });
    expect(structured.isError).toBe(true);
    expect(payload(structured)).toMatchObject({
      error: expect.stringContaining("graph-aware version"),
    });
  });

  it("rejects duplicate manifest names instead of overwriting dispatch", async () => {
    const duplicate = descriptor("search");
    const client = {
      listOntologyTools: vi.fn(async () => ({ tools: [duplicate, duplicate] })),
    } as unknown as MindGraph;
    await expect(getGeneratedTools(client)).rejects.toThrow(
      "duplicate generated ontology tool name",
    );
  });
});
