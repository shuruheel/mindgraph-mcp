// mindgraph_code and mindgraph_sync read the local checkout and run git. They
// are listed only in the stdio coding profile, and a client can call a tool by
// name without listing it, so tools/call refuses them everywhere else; hosted
// mode also keeps the general tools off the host's filesystem. The clients are
// fakes; nothing here touches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/server";
import type { MindGraph } from "mindgraph";
import {
  buildMindGraphServer,
  createMindGraphServer,
  type MindGraphServerOptions,
} from "../src/server.js";
import { handleTool } from "../src/tools.js";

// Count every CodegraphAdapter built and every child process spawned (git
// runs only through the adapter's spawn); both still behave as before.
const probes = vi.hoisted(() => ({ adapters: 0, spawns: [] as string[] }));
vi.mock("../src/codegraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codegraph.js")>();
  class CountingAdapter extends actual.CodegraphAdapter {
    constructor(...args: ConstructorParameters<typeof actual.CodegraphAdapter>) {
      super(...args);
      probes.adapters += 1;
    }
  }
  return { ...actual, CodegraphAdapter: CountingAdapter };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, ...rest: unknown[]) => {
      probes.spawns.push(command);
      return (actual.spawn as (...a: unknown[]) => unknown)(command, ...rest);
    }) as typeof actual.spawn,
  };
});

const REFUSAL = {
  error:
    "mindgraph_code and mindgraph_sync run only in the local coding setup (npx -y mindgraph-mcp@latest install-code).",
  code: "not_available",
  retriable: false,
};
const SENTINEL = "sentinel-secret-7f3a";
const cleanup: string[] = [];

/** A directory holding a file whose content must never leave the host. */
function sentinelDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindgraph-local-only-"));
  cleanup.push(dir);
  fs.writeFileSync(path.join(dir, "secret.txt"), `${SENTINEL}\n`);
  return dir;
}

function makeClient() {
  return {
    memorySync: vi.fn(async (request: Record<string, unknown>) => ({ state: "untracked", request })),
    entity: vi.fn(async (request: Record<string, unknown>) => ({ uid: "node-1", label: request.label })),
    plan: vi.fn(async () => ({ uid: "task-1" })),
    commit: vi.fn(async () => ({ uid: "goal-1" })),
    listOntologyTools: vi.fn(async () => ({ tools: [] })),
  };
}
type FakeClient = ReturnType<typeof makeClient>;

function hostedServer(client: FakeClient, log?: (event: Record<string, unknown>) => void): Server {
  const opts: MindGraphServerOptions = {
    client: client as unknown as MindGraph,
    bearer: "api-token",
    baseUrl: "https://api.example.test",
    orgId: "org-1",
    agentId: "mcp:claude.ai:user-1",
    user: { id: "user-1" },
    profile: "general",
    harness: "hosted",
    serverVersion: "test",
    governanceDisabled: true,
    caches: { generatedTools: new Map(), governance: new Map() },
    log,
  };
  return createMindGraphServer(opts);
}

function stdioServer(client: FakeClient, profile: string): Server {
  return buildMindGraphServer({
    client: client as unknown as MindGraph,
    serverVersion: "test",
    instructions: "",
    profile,
    agentId: "agent-1",
    governance: { baseUrl: "https://api.example.test", apiKey: "mg_live_test", agentId: "agent-1", disabled: true },
    memory: { profile },
  });
}

async function call(server: Server, name: string, args: Record<string, unknown>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "local-only-test", version: "0" });
  await mcp.connect(clientSide);
  try {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { result, body: JSON.parse(text) as Record<string, unknown> };
  } finally {
    await mcp.close();
  }
}

beforeEach(() => {
  probes.adapters = 0;
  probes.spawns.length = 0;
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hosted mode refuses the local coding tools", () => {
  it("mindgraph_sync begin reads no file and sends nothing", async () => {
    const client = makeClient();
    const events: Array<Record<string, unknown>> = [];
    const dir = sentinelDir();
    const { result, body } = await call(hostedServer(client, (e) => events.push(e)), "mindgraph_sync", {
      action: "begin",
      repo: dir,
      logical_path: "secret.txt",
      invocation_context: { cwd: dir },
    });
    expect(result.isError).toBe(true);
    expect(body).toEqual(REFUSAL);
    expect(client.memorySync).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(probes.adapters).toBe(0);
    expect(probes.spawns).toEqual([]);
    expect(events).toEqual([
      { event: "tool_refused", tool: "mindgraph_sync", agent_id: "mcp:claude.ai:user-1", code: "not_available" },
    ]);
  });

  it("mindgraph_sync with repo '/' is refused the same way", async () => {
    const client = makeClient();
    const { body } = await call(hostedServer(client), "mindgraph_sync", {
      action: "begin",
      repo: "/",
      logical_path: "etc/hosts",
    });
    expect(body).toEqual(REFUSAL);
    expect(client.memorySync).not.toHaveBeenCalled();
    expect(probes.adapters).toBe(0);
  });

  it("mindgraph_code is refused", async () => {
    const client = makeClient();
    const { result, body } = await call(hostedServer(client), "mindgraph_code", {
      action: "anchor",
      code_refs: [{ path: "src/index.ts", symbol: "main" }],
      repo: "/",
    });
    expect(result.isError).toBe(true);
    expect(body).toEqual(REFUSAL);
    expect(client.entity).not.toHaveBeenCalled();
    expect(probes.adapters).toBe(0);
    expect(probes.spawns).toEqual([]);
  });

  it("a write with code_refs is kept, with a caveat and no adapter", async () => {
    const client = makeClient();
    const { result, body } = await call(hostedServer(client), "mindgraph_capture", {
      action: "entity",
      entity_type: "concept",
      label: "Retry policy",
      code_refs: [{ path: "src/retry.ts", symbol: "retry" }],
      repo: "/",
      invocation_context: { cwd: "/" },
    });
    expect(result.isError).toBeFalsy();
    expect(body).toEqual({
      result: { uid: "node-1", label: "Retry policy" },
      code_anchors: { wrote: false, caveat: "code refs resolve only in the local server" },
    });
    // Only the write itself: no code anchor and no relate edge.
    expect(client.entity).toHaveBeenCalledTimes(1);
    expect(client.entity.mock.calls[0][0]).toMatchObject({ action: "create" });
    expect(probes.adapters).toBe(0);
    expect(probes.spawns).toEqual([]);
  });

  it("mindgraph_plan create_task ignores repo and invocation_context", async () => {
    const client = makeClient();
    const dir = sentinelDir();
    const { result } = await call(hostedServer(client), "mindgraph_plan", {
      action: "create_task",
      label: "Fix the retry",
      scope_uids: ["space:shared"],
      repo: dir,
      invocation_context: { cwd: dir, repoId: "github.com/acme/api" },
    });
    expect(result.isError).toBeFalsy();
    expect(client.plan).toHaveBeenCalledTimes(1);
    expect(client.plan.mock.calls[0][0]).toMatchObject({ action: "create_task", scope_uids: ["space:shared"] });
    // No repository anchor was materialized.
    expect(client.entity).not.toHaveBeenCalled();
    expect(probes.adapters).toBe(0);
    expect(probes.spawns).toEqual([]);
  });
});

describe("stdio profiles", () => {
  it("the general profile refuses both tools by name", async () => {
    for (const name of ["mindgraph_code", "mindgraph_sync"]) {
      const client = makeClient();
      const dir = sentinelDir();
      const { result, body } = await call(stdioServer(client, "general"), name, {
        action: name === "mindgraph_sync" ? "begin" : "anchor",
        repo: dir,
        logical_path: "secret.txt",
        code_refs: [{ path: "secret.txt" }],
        invocation_context: { cwd: dir },
      });
      expect(result.isError, name).toBe(true);
      expect(body, name).toEqual(REFUSAL);
      expect(client.memorySync).not.toHaveBeenCalled();
      expect(client.entity).not.toHaveBeenCalled();
      expect(probes.adapters).toBe(0);
    }
  });

  it("the general profile resolves no code_refs on a write (no git, no codegraph, no repo-id file)", async () => {
    for (const name of ["mindgraph_capture", "mindgraph_commit", "mindgraph_plan"]) {
      const client = makeClient();
      const dir = sentinelDir();
      fs.mkdirSync(path.join(dir, ".git"));
      const args = {
        action: name === "mindgraph_capture" ? "entity" : name === "mindgraph_commit" ? "goal" : "create_task",
        entity_type: "concept",
        label: "x",
        repo_space_uid: "space:x",
        code_refs: [{ path: path.join(dir, "secret.txt"), symbol: "login" }],
        repo: dir,
        invocation_context: { cwd: dir },
      };
      const { result, body } = await call(stdioServer(client, "general"), name, args);
      expect(result.isError, name).toBeFalsy();
      expect(body.code_anchors, name).toEqual({
        wrote: false,
        caveat: "code refs resolve only in the local coding setup (npx -y mindgraph-mcp@latest install-code)",
      });
      expect(JSON.stringify(result), name).not.toContain(dir);
      expect(probes.adapters, name).toBe(0);
      expect(probes.spawns, name).toEqual([]);
      expect(fs.existsSync(path.join(dir, ".git", "mindgraph")), name).toBe(false);
    }
  });

  it("the general profile create_task ignores repo and invocation_context (no path oracle)", async () => {
    for (const repo of [sentinelDir(), "/nonexistent-mindgraph-path-oracle"]) {
      const client = makeClient();
      const { result } = await call(stdioServer(client, "general"), "mindgraph_plan", {
        action: "create_task",
        label: "t",
        scope_uids: ["space:shared"],
        repo,
        invocation_context: { cwd: repo, repoId: "github.com/acme/secret" },
      });
      expect(result.isError, repo).toBeFalsy();
      expect(client.plan.mock.calls[0][0]).toMatchObject({ action: "create_task", scope_uids: ["space:shared"] });
      expect(client.entity).not.toHaveBeenCalled();
      expect(probes.adapters).toBe(0);
      expect(probes.spawns).toEqual([]);
    }
  });

  it("the coding profile still runs mindgraph_sync and mindgraph_code", async () => {
    const client = makeClient();
    const dir = sentinelDir();
    const server = () => stdioServer(client, "coding");
    const sync = await call(server(), "mindgraph_sync", {
      action: "begin",
      repo: dir,
      logical_path: "secret.txt",
      invocation_context: { cwd: dir },
    });
    expect(sync.result.isError).toBeFalsy();
    expect(client.memorySync).toHaveBeenCalledTimes(1);
    expect(client.memorySync.mock.calls[0][0].content).toContain(SENTINEL);

    const code = await call(server(), "mindgraph_code", {
      action: "recall",
      code_refs: [{ path: "secret.txt" }],
      invocation_context: { cwd: dir },
    });
    expect(code.body.code).not.toBe("not_available");
    expect(probes.adapters).toBeGreaterThanOrEqual(2);
  });
});

describe("handleTool on its own (defence in depth)", () => {
  it("refuses the local coding tools unless told the profile is coding and not hosted", async () => {
    for (const runtime of [{}, { profile: "general" }, { profile: "coding", hosted: true }]) {
      for (const name of ["mindgraph_code", "mindgraph_sync"]) {
        const client = makeClient();
        const result = await handleTool(
          client as unknown as MindGraph,
          name,
          { action: "begin", repo: "/", logical_path: "etc/hosts" },
          {},
          runtime,
        );
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toEqual(REFUSAL);
        expect(client.memorySync).not.toHaveBeenCalled();
      }
    }
    expect(probes.adapters).toBe(0);
  });
});
