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
