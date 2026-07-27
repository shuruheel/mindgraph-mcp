import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MindGraph } from "mindgraph";
import { resetGovernanceCapability } from "../src/governance.js";
import { readGovernedResource, readResource } from "../src/resources.js";

const governance = {
  baseUrl: "https://api.example.test",
  apiKey: "mg_live_test",
  agentId: "agent-1",
};

function permitting() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ decision: "permit", obligations: [], fired_policies: [] }),
      { status: 200 },
    ),
  );
}

function denying() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        decision: "deny",
        obligations: [],
        fired_policies: [{ name: "No graph reads" }],
      }),
      { status: 200 },
    ),
  );
}

describe("MCP resource surface", () => {
  beforeEach(resetGovernanceCapability);

  // C42: `resources/read` returned the same rows as the governance-gated tools
  // with no check at all — the one request type that reached the graph ungated.
  it("refuses a denied read before touching the graph", async () => {
    const stats = vi.fn(async () => ({ nodes: 1 }));
    const client = { stats } as unknown as MindGraph;

    await expect(
      readGovernedResource(client, "mindgraph://stats", {
        ...governance,
        fetchImpl: denying(),
      }),
    ).rejects.toThrow(/No graph reads/);
    expect(stats).not.toHaveBeenCalled();
  });

  it("gates every resource, static and templated", async () => {
    const client = {
      stats: vi.fn(async () => ({})),
      getGoals: vi.fn(async () => []),
      getOpenQuestions: vi.fn(async () => []),
      getContradictions: vi.fn(async () => []),
      getOpenDecisions: vi.fn(async () => []),
      getNode: vi.fn(async () => ({})),
      getEdges: vi.fn(async () => []),
      search: vi.fn(async () => []),
      getNodes: vi.fn(async () => []),
    } as unknown as MindGraph;

    const uris = [
      "mindgraph://stats",
      "mindgraph://goals",
      "mindgraph://questions",
      "mindgraph://contradictions",
      "mindgraph://decisions",
      "mindgraph://node/node-1",
      "mindgraph://search/kissinger",
      "mindgraph://layer/reality",
    ];

    for (const uri of uris) {
      resetGovernanceCapability();
      await expect(
        readGovernedResource(client, uri, { ...governance, fetchImpl: denying() }),
      ).rejects.toThrow(/No graph reads/);
    }

    for (const method of Object.values(client as unknown as Record<string, unknown>)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("reads through and reports the resource uri as audit context when permitted", async () => {
    const fetchImpl = permitting();
    const client = { stats: vi.fn(async () => ({ nodes: 7 })) } as unknown as MindGraph;

    const result = await readGovernedResource(client, "mindgraph://stats", {
      ...governance,
      fetchImpl,
    });

    expect(JSON.parse(result.contents[0].text)).toEqual({ nodes: 7 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.target).toEqual({ tool_name: "mindgraph_retrieve" });
    expect(body.context).toMatchObject({
      adapter: "mindgraph-mcp",
      resource_uri: "mindgraph://stats",
    });
  });

  it("still dispatches each uri shape to its SDK method", async () => {
    const getNode = vi.fn(async () => ({ uid: "node-1" }));
    const getEdges = vi.fn(async () => []);
    const search = vi.fn(async () => [{ uid: "hit" }]);
    const getNodes = vi.fn(async () => [{ uid: "in-layer" }]);
    const client = { getNode, getEdges, search, getNodes } as unknown as MindGraph;

    await readResource(client, "mindgraph://node/node%2F1");
    expect(getNode).toHaveBeenCalledWith("node/1");
    expect(getEdges).toHaveBeenCalledWith({ from_uid: "node/1" });
    expect(getEdges).toHaveBeenCalledWith({ to_uid: "node/1" });

    await readResource(client, "mindgraph://search/Kissinger%20NATO");
    expect(search).toHaveBeenCalledWith("Kissinger NATO", { limit: 20 });

    await readResource(client, "mindgraph://layer/reality");
    expect(getNodes).toHaveBeenCalledWith({ layer: "reality", limit: 50 });

    await expect(readResource(client, "mindgraph://nope")).rejects.toThrow(
      "Unknown resource",
    );
  });
});
