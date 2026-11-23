import { describe, expect, it, vi } from "vitest";
import { MindGraphError, type MindGraph } from "mindgraph";
import {
  handleNavigateTool,
  NAVIGATE_MOVES,
  NAVIGATE_TOOL,
  NavigationTokens,
  navigationSession,
} from "../src/navigate-tool.js";
import { requiredScopes } from "../src/hosted-tools.js";
import { handleTool, TOOLS } from "../src/tools.js";

type Rec = Record<string, unknown>;

/** A client with only the SDK's POST, as the published SDK 0.20 exposes it. */
function postClient(...responses: Array<Rec | Error>) {
  const sent: Array<{ path: string; body: Rec }> = [];
  const queue = [...responses];
  const post = vi.fn(async (path: string, body: Rec) => {
    sent.push({ path, body });
    const next = queue.shift() ?? {};
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { post } as unknown as MindGraph, sent, post };
}

function listing(extra: Rec = {}): Rec {
  return {
    move: "search",
    state: "found",
    shown: 1,
    more_available: 3,
    stopped: "item limit (1)",
    items: [
      {
        handle: "n:fix",
        uid: "fix",
        type: "Decision",
        title: "Ship 2.4.1",
        text: "Ship 2.4.1 to every tenant",
        reached: "search hit",
        standing: { state: "current" },
      },
    ],
    bad_handles: [],
    notes: [],
    next: [{ action: "more", token: "nv1.page2" }, { action: "follow", handles: ["n:fix"] }],
    token: "nv1.page2",
    budget_tokens: 4000,
    used_tokens: 80,
    text: 'search for "rollback"  ·  1 items shown, 3 more available\n\nnext: more {"token": …}  ·  follow [n:fix]',
    ...extra,
  };
}

function workingSet(token: string, extra: Rec = {}): Rec {
  return {
    graph: { nodes: [], edges: [] },
    context_text: "Decision: ship connector 2.4.1",
    used_tokens: 420,
    working_set: {
      token,
      turn: 2,
      reread: false,
      entered: [{ uid: "fix", label: "Ship 2.4.1" }],
      kept: [{ uid: "cause", label: "Pool limit" }],
      left: [{ uid: "old", label: "Roll back 2.4", reason: "faded" }],
      changed: [],
      strength: { nothing_strong: false },
      parameters: { rounds: 3, cue_decay: 0.7, cue_horizon_turns: 8, pool_min: 64, cues: 3, pins: 0, drops: 0 },
      ...extra,
    },
  };
}

describe("mindgraph_navigate definition", () => {
  it("is a read tool with a move enum and an output schema", () => {
    expect(TOOLS.map((tool) => tool.name)).toContain("mindgraph_navigate");
    const schema = NAVIGATE_TOOL.inputSchema as { properties: Rec; required: string[] };
    expect((schema.properties.move as { enum: string[] }).enum).toEqual([...NAVIGATE_MOVES]);
    expect(schema.required).toEqual(["move"]);
    expect(NAVIGATE_TOOL.outputSchema).toBeDefined();
    expect(NAVIGATE_TOOL.annotations?.readOnlyHint).toBe(true);
    expect(requiredScopes("mindgraph_navigate")).toEqual(["graph:read"]);
  });
});

describe("listing moves", () => {
  it("forwards only move arguments and returns the server text and JSON", async () => {
    const { client, sent } = postClient(listing());
    const result = await handleNavigateTool(
      client,
      {
        move: "follow",
        handles: ["n:cause"],
        direction: "out",
        depth: 2,
        agent_id: "agent-1",
        invocation_context: { harnessSessionId: "s1", cwd: "/repo" },
      },
      { tokens: new NavigationTokens() },
    );
    expect(sent).toEqual([
      { path: "/navigate", body: { action: "follow", handles: ["n:cause"], direction: "out", depth: 2 } },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("1 items shown");
    expect(result.structuredContent).toEqual(listing());
  });

  it("uses the SDK's navigate method when it has one", async () => {
    const navigate = vi.fn(async () => listing());
    const client = { navigate, post: vi.fn() } as unknown as MindGraph;
    await handleNavigateTool(client, { move: "search", query: "rollback" });
    expect(navigate).toHaveBeenCalledWith({ action: "search", query: "rollback" });
  });

  it("accepts a next entry copied as it is (action instead of move)", async () => {
    const { client, sent } = postClient(listing());
    await handleNavigateTool(client, { action: "follow", handles: ["n:fix"] });
    expect(sent[0].body).toEqual({ action: "follow", handles: ["n:fix"] });
  });

  it("refuses an unknown move without a request", async () => {
    const { client, post } = postClient();
    const result = await handleNavigateTool(client, { move: "jump" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "invalid_move" });
    expect(post).not.toHaveBeenCalled();
  });

  it("more continues the last move of the session with the held token", async () => {
    const tokens = new NavigationTokens();
    const { client, sent } = postClient(listing(), listing({ token: null, more_available: 0 }));
    const session = { invocation_context: { harnessSessionId: "s1" } };
    const first = await handleNavigateTool(client, { move: "search", query: "rollback", ...session }, { tokens });
    // Held, so the text does not spend the model's context on it.
    expect(first.content[0].text).not.toContain("nv1.page2");
    await handleNavigateTool(client, { move: "more", ...session }, { tokens });
    expect(sent[1].body).toEqual({ action: "more", token: "nv1.page2" });
    // The last page had nothing more: there is nothing left to continue.
    const done = await handleNavigateTool(client, { move: "more", ...session }, { tokens });
    expect(done.isError).toBe(true);
    expect(done.structuredContent).toMatchObject({ code: "nothing_to_continue" });
    expect(sent).toHaveLength(2);
  });

  it("an explicit token continues an earlier move", async () => {
    const tokens = new NavigationTokens();
    const { client, sent } = postClient(listing());
    await handleNavigateTool(client, { move: "more", token: "nv1.earlier" }, { tokens });
    expect(sent[0].body).toEqual({ action: "more", token: "nv1.earlier" });
  });

  it("without a store (hosted) the continuation is written into the text", async () => {
    const { client } = postClient(listing());
    const result = await handleNavigateTool(client, { move: "search", query: "rollback" });
    expect(result.content[0].text).toContain('more {"token": "nv1.page2"}');
    const none = await handleNavigateTool(postClient().client, { move: "more" });
    expect(none.structuredContent).toMatchObject({ code: "nothing_to_continue" });
  });

  it("an unbuilt move is a clear error, not a crash", async () => {
    const { client } = postClient(
      new MindGraphError("POST /navigate failed: 501", 501, {
        error: "the `check` move is not built yet",
        code: "move_not_built",
      }),
    );
    const result = await handleNavigateTool(client, { move: "check", handles: ["n:fix"] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "move_not_built", status: 501 });
    expect(result.content[0].text).toContain("not built on this server yet");
  });

  it("other server errors keep their code and status", async () => {
    const { client } = postClient(
      new MindGraphError("POST /navigate failed: 400", 400, {
        error: "This continuation can no longer be used. Repeat the move to start again.",
        code: "bad_continuation",
      }),
    );
    const result = await handleNavigateTool(client, { move: "more", token: "nv1.garbage" });
    expect(result.structuredContent).toMatchObject({ code: "bad_continuation", status: 400 });
  });
});

describe("context holds the working-set token per harness session", () => {
  it("sends the held token on the next call and never shows it", async () => {
    const tokens = new NavigationTokens();
    const { client, sent } = postClient(workingSet("ws1.a"), workingSet("ws1.b"));
    const session = { invocation_context: { harnessSessionId: "s1" } };
    const first = await handleNavigateTool(client, { move: "context", text: "pool limit", ...session }, { tokens });
    expect(sent[0].body).toEqual({ action: "context", text: "pool limit" });
    const text = first.content[0].text;
    expect(text).toContain("working set  ·  turn 2  ·  1 entered, 1 kept, 1 left  ·  420 of 2000 tokens");
    expect(text).toContain("[old] Roll back 2.4    faded");
    expect(text).toContain("Decision: ship connector 2.4.1");
    expect(text).not.toContain("ws1.a");
    const set = (first.structuredContent as Rec).working_set as Rec;
    expect(set.token).toBeUndefined();
    expect(set.token_held).toBe(true);

    await handleNavigateTool(client, { move: "context", focus: ["n:fix"], ...session }, { tokens });
    expect(sent[1].body).toEqual({ action: "context", focus: ["n:fix"], token: "ws1.a" });
  });

  it("keeps sessions apart and starts over on new_session", async () => {
    const tokens = new NavigationTokens();
    const { client, sent } = postClient(workingSet("ws1.a"), workingSet("ws1.x"), workingSet("ws1.b"));
    await handleNavigateTool(
      client,
      { move: "context", text: "one", invocation_context: { harnessSessionId: "s1" } },
      { tokens },
    );
    await handleNavigateTool(
      client,
      { move: "context", text: "two", invocation_context: { harnessSessionId: "s2" } },
      { tokens },
    );
    expect(sent[1].body.token).toBeUndefined();
    await handleNavigateTool(
      client,
      { move: "context", text: "three", new_session: true, invocation_context: { harnessSessionId: "s1" } },
      { tokens },
    );
    expect(sent[2].body).toEqual({ action: "context", text: "three" });
  });

  it("an unreadable held token is forgotten and the turn starts a new session", async () => {
    const tokens = new NavigationTokens();
    tokens.get("process").workingSet = "ws1.stale";
    const { client, sent } = postClient(
      new MindGraphError("POST /navigate failed: 400", 400, { code: "working_set_token_unreadable" }),
      workingSet("ws1.new"),
    );
    const result = await handleNavigateTool(client, { move: "context", text: "again" }, { tokens });
    expect(result.isError).toBeUndefined();
    expect(sent.map((s) => s.body.token)).toEqual(["ws1.stale", undefined]);
    expect(tokens.get("process").workingSet).toBe("ws1.new");
  });

  it("says when memory holds little, and names the token where nothing is held", async () => {
    const { client } = postClient(
      workingSet("ws1.h", { strength: { nothing_strong: true }, entered: [], kept: [], left: [] }),
    );
    const result = await handleNavigateTool(client, { move: "context", text: "zebra" });
    const text = result.content[0].text;
    expect(text).toContain("Nothing in memory is strongly related to this.");
    expect(text).toContain('Pass token "ws1.h" on your next context call');
    expect(((result.structuredContent as Rec).working_set as Rec).token).toBe("ws1.h");
  });
});

describe("dispatch", () => {
  it("hosted mode holds nothing; stdio holds per session", async () => {
    const { client, sent } = postClient(workingSet("ws1.h1"), workingSet("ws1.h2"));
    const args = { move: "context", text: "q", invocation_context: { harnessSessionId: "hosted-forged" } };
    await handleTool(client, "mindgraph_navigate", { ...args }, {}, { hosted: true });
    await handleTool(client, "mindgraph_navigate", { ...args }, {}, { hosted: true });
    expect(sent.map((s) => s.body.token)).toEqual([undefined, undefined]);
  });

  it("the session key comes from the adapter's invocation context", () => {
    expect(navigationSession({ invocation_context: { harnessSessionId: "abc" } })).toBe("harness:abc");
    expect(navigationSession({})).toBe("process");
    expect(navigationSession({ invocation_context: { harnessSessionId: "" } })).toBe("process");
  });

  it("the store forgets the least recently used session past its cap", () => {
    const tokens = new NavigationTokens();
    tokens.get("s0").workingSet = "keep";
    for (let i = 1; i <= 64; i++) {
      tokens.get("s0");
      tokens.get(`s${i}`).workingSet = `t${i}`;
    }
    expect(tokens.get("s0").workingSet).toBe("keep");
    expect(tokens.get("s1").workingSet).toBeUndefined();
  });
});

describe("over MCP", () => {
  async function connect(client: MindGraph) {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { buildMindGraphServer } = await import("../src/server.js");
    const server = buildMindGraphServer({
      client,
      serverVersion: "test",
      instructions: "",
      profile: "general",
      agentId: "agent-1",
      governance: { baseUrl: "https://api.example.test", apiKey: "mg_live_test", agentId: "agent-1", disabled: true },
      memory: { profile: "general" },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "navigate-test", version: "0" });
    await mcp.connect(clientSide);
    return mcp;
  }

  it("listing and context results pass the client's output-schema check", async () => {
    const { client } = postClient(listing(), workingSet("ws1.w"));
    const mcp = await connect(client);
    await mcp.listTools();
    const found = await mcp.callTool({ name: "mindgraph_navigate", arguments: { move: "search", query: "rollback" } });
    expect(found.isError).toBeFalsy();
    expect((found.structuredContent as Rec).state).toBe("found");
    const context = await mcp.callTool({ name: "mindgraph_navigate", arguments: { move: "context", text: "q" } });
    expect(context.isError).toBeFalsy();
    expect(((context.structuredContent as Rec).working_set as Rec).token_held).toBe(true);
    await mcp.close();
  });
});
