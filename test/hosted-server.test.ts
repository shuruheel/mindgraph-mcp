// Hosted mode (spec D4/D5/D6, acceptance A9): the per-request factory, the
// ChatGPT search/fetch contract, the attribution overwrite, per-org caches and
// the stateless Streamable HTTP helper. The client is mocked; nothing here
// touches the network.
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MindGraph, MindGraphError } from "mindgraph";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createMindGraphServer,
  handleHostedRequest,
  type MindGraphServerOptions,
} from "../src/server.js";
import { toolsForProfile } from "../src/tools.js";

const NODE = {
  uid: "node-1",
  label: "Kissinger",
  summary: "Former US Secretary of State",
  node_type: "Person",
  layer: "reality",
  confidence: 0.9,
  salience: 0.5,
  props: { born: 1923, empty: "" },
  created_at: 1700000000,
  updated_at: 1700000000,
  tombstone_at: null,
};

function generatedDescriptor(suffix: string) {
  return {
    name: `s_schema_${suffix}__requirement_search_${suffix}`,
    description: "search requirements",
    schema_id: `schema-${suffix}`,
    object_type: "Requirement",
    maps_to: "search",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    retrieveContext: vi.fn(async () => ({
      graph: {
        nodes: [{ ...NODE, source_documents: [{ uid: "doc-1", title: "Memoirs" }] }],
        edges: [],
      },
    })),
    getNode: vi.fn(async (uid: string) => {
      if (uid !== NODE.uid) throw new MindGraphError("not found", 404, { error: "not found" });
      return NODE;
    }),
    journal: vi.fn(async (label: string, props: unknown, opts: unknown) => ({ label, props, opts })),
    listOntologyTools: vi.fn(async () => ({ tools: [generatedDescriptor("aaaa")] })),
    ...overrides,
  };
}

function makeCaches(): MindGraphServerOptions["caches"] {
  return { generatedTools: new Map(), governance: new Map() };
}

function makeOpts(
  client: ReturnType<typeof makeClient>,
  extra: Partial<MindGraphServerOptions> = {},
): MindGraphServerOptions {
  return {
    client: client as unknown as MindGraph,
    bearer: "api-token",
    baseUrl: "https://api.example.test",
    orgId: "org-1",
    orgName: "Acme",
    agentId: "mcp:claude.ai:user-1",
    user: { id: "user-1", name: "Ada", email: "ada@example.test" },
    profile: "general",
    harness: "hosted",
    serverVersion: "test",
    governanceDisabled: true,
    caches: makeCaches(),
    ...extra,
  };
}

async function connect(opts: MindGraphServerOptions): Promise<Client> {
  const server = createMindGraphServer(opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "hosted-test", version: "0" });
  await mcp.connect(clientSide);
  return mcp;
}

type Decorated = Tool & { _meta?: Record<string, unknown> };

describe("hosted tools/list (A9)", () => {
  it("equals general + generated + search/fetch/whoami, each with annotations and securitySchemes", async () => {
    const mcp = await connect(makeOpts(makeClient()));
    const { tools } = await mcp.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      ...toolsForProfile("general").map((tool) => tool.name),
      generatedDescriptor("aaaa").name,
      "search",
      "fetch",
      "whoami",
    ]);
    expect(names).not.toContain("mindgraph_code");
    expect(names).not.toContain("mindgraph_sync");
    for (const tool of tools as Decorated[]) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations?.openWorldHint).toBe(false);
      const schemes = tool._meta?.securitySchemes as Array<{ type: string; scopes: string[] }>;
      expect(schemes, tool.name).toHaveLength(1);
      expect(schemes[0].type).toBe("oauth2");
      expect(schemes[0].scopes.length).toBeGreaterThan(0);
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool as Decorated]));
    const scopes = (name: string) =>
      (byName.get(name)!._meta!.securitySchemes as Array<{ scopes: string[] }>)[0].scopes;
    expect(byName.get("search")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(scopes("search")).toEqual(["graph:read"]);
    expect(scopes(generatedDescriptor("aaaa").name)).toEqual(["graph:read"]);
    expect(byName.get("mindgraph_capture")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(scopes("mindgraph_capture")).toEqual(["graph:write"]);
    expect(byName.get("mindgraph_remember")!.annotations?.destructiveHint).toBe(true);
    expect(scopes("mindgraph_remember")).toEqual(["graph:write", "graph:evolve"]);
    expect(byName.get("whoami")!._meta?.["openai/profile"]).toBe(true);
    expect(byName.get("search")!.outputSchema).toBeDefined();
    expect(byName.get("fetch")!.outputSchema).toBeDefined();
    // The static tool objects are shared with stdio and must stay undecorated.
    expect((toolsForProfile("general")[0] as Decorated).annotations).toBeUndefined();
    await mcp.close();
  });

  it("puts the key sentence and the attribution rule in the first 512 characters", async () => {
    const mcp = await connect(makeOpts(makeClient()));
    const head = String(mcp.getInstructions() ?? "").slice(0, 512);
    expect(head).toContain("persistent knowledge graph via MindGraph");
    expect(head).toContain("agent_id");
    await mcp.close();
  });
});

describe("search / fetch / whoami (D5)", () => {
  it("search returns structuredContent and the identical text twin", async () => {
    const client = makeClient();
    const mcp = await connect(makeOpts(client));
    const result = await mcp.callTool({ name: "search", arguments: { query: "Kissinger" } });
    expect(client.retrieveContext).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Kissinger", node_limit: 10, article_limit: 0, chunk_limit: 0 }),
    );
    const structured = result.structuredContent as { results: Array<Record<string, string>> };
    expect(structured.results).toEqual([
      {
        id: "node-1",
        title: "Kissinger",
        url: "https://mindgraph.cloud/dashboard/explorer?uid=node-1",
        snippet: "Former US Secretary of State",
      },
    ]);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe(JSON.stringify(structured));
    await mcp.close();
  });

  it("fetch renders the node with sources from one anchored context call", async () => {
    const client = makeClient();
    const mcp = await connect(makeOpts(client));
    const result = await mcp.callTool({ name: "fetch", arguments: { id: "node-1" } });
    expect(client.getNode).toHaveBeenCalledWith("node-1");
    expect(client.retrieveContext).toHaveBeenCalledTimes(1);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      id: "node-1",
      title: "Kissinger",
      url: "https://mindgraph.cloud/dashboard/explorer?uid=node-1",
      metadata: {
        layer: "reality",
        type: "Person",
        created_at: 1700000000,
        sources: [{ uid: "doc-1", title: "Memoirs" }],
      },
    });
    expect(structured.text).toBe("Kissinger\n\nFormer US Secretary of State\n\nborn: 1923");
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe(JSON.stringify(structured));
    await mcp.close();
  });

  it("fetch rejects ids that are not graph nodes with a clear error", async () => {
    const mcp = await connect(makeOpts(makeClient()));
    const result = await mcp.callTool({ name: "fetch", arguments: { id: "doc-1" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0].text).toContain("document ids are not supported");
    await mcp.close();
  });

  it("whoami reports the signed-in member from the options, never the graph", async () => {
    const client = makeClient();
    const mcp = await connect(makeOpts(client));
    const result = await mcp.callTool({ name: "whoami", arguments: {} });
    expect(result.structuredContent).toEqual({
      id: "user-1",
      name: "Ada",
      email: "ada@example.test",
      organization: "Acme",
      organization_id: "org-1",
    });
    expect(client.retrieveContext).not.toHaveBeenCalled();
    expect(client.getNode).not.toHaveBeenCalled();
    await mcp.close();
  });
});

describe("attribution (D4)", () => {
  it("overwrites agent_id even when the model supplies one, keeping it only as metadata", async () => {
    const client = makeClient();
    const log = vi.fn();
    // Governance on, so the checkpoint body (identity + context) is observable.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ decision: "permit", obligations: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const mcp = await connect(makeOpts(client, { governanceDisabled: false, log }));
    try {
      await mcp.callTool({
        name: "mindgraph_capture",
        arguments: { action: "journal", label: "note", content: "note", agent_id: "attacker" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const captured = client.journal.mock.calls[0][2] as Record<string, unknown>;
    expect(captured.agent_id).toBe("mcp:claude.ai:user-1");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.example.test/agent/governance");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer api-token");
    const probe = JSON.parse(String(init.body));
    expect(probe.agent_id).toBe("mcp:claude.ai:user-1");
    expect(probe.context).toMatchObject({ harness: "hosted", requested_agent_id: "attacker" });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "mindgraph_capture", requested_agent_id: "attacker" }),
    );
    await mcp.close();
  });
});

describe("per-org caches", () => {
  it("keeps one generated-tools entry and one governance latch per org", async () => {
    const caches = makeCaches();
    const clientA = makeClient();
    const clientB = makeClient({
      listOntologyTools: vi.fn(async () => ({ tools: [generatedDescriptor("bbbb")] })),
    });
    const orgA = await connect(makeOpts(clientA, { caches, orgId: "org-a", governanceDisabled: false }));
    const orgB = await connect(makeOpts(clientB, { caches, orgId: "org-b", governanceDisabled: false }));
    const namesA = (await orgA.listTools()).tools.map((tool) => tool.name);
    const namesB = (await orgB.listTools()).tools.map((tool) => tool.name);
    expect(namesA).toContain(generatedDescriptor("aaaa").name);
    expect(namesA).not.toContain(generatedDescriptor("bbbb").name);
    expect(namesB).toContain(generatedDescriptor("bbbb").name);
    expect([...caches.generatedTools.keys()].sort()).toEqual(["org-a", "org-b"]);
    expect([...caches.governance.keys()].sort()).toEqual(["org-a", "org-b"]);
    // A second server for the same org reuses the entry: no refetch.
    const again = await connect(makeOpts(clientA, { caches, orgId: "org-a" }));
    await again.listTools();
    expect(clientA.listOntologyTools).toHaveBeenCalledTimes(1);
    expect(caches.generatedTools.size).toBe(2);
    await Promise.all([orgA.close(), orgB.close(), again.close()]);
  });
});

describe("handleHostedRequest (D6)", () => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const rpc = (body: unknown) =>
    new Request("https://mindgraph.cloud/mcp", { method: "POST", headers, body: JSON.stringify(body) });

  it("rejects a JSON-RPC array with 400 before the SDK sees it", async () => {
    const client = makeClient();
    const response = await handleHostedRequest(
      rpc([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
      makeOpts(client),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32600);
    expect(client.listOntologyTools).not.toHaveBeenCalled();
  });

  it("rejects an unparsable body with 400 and non-POST with 405", async () => {
    const bad = new Request("https://mindgraph.cloud/mcp", { method: "POST", headers, body: "{" });
    expect((await handleHostedRequest(bad, makeOpts(makeClient()))).status).toBe(400);
    const get = new Request("https://mindgraph.cloud/mcp", { method: "GET", headers });
    const response = await handleHostedRequest(get, makeOpts(makeClient()));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("answers tools/list statelessly as a JSON response", async () => {
    const response = await handleHostedRequest(
      rpc({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
      makeOpts(makeClient()),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = await response.json();
    expect(body.id).toBe(7);
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("search");
    expect(names).toContain("whoami");
  });
});
