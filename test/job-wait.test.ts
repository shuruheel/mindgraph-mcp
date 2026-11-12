import { describe, expect, it, vi } from "vitest";
import type { MindGraph } from "mindgraph";
import { clampWaitSeconds, jobProgress, waitForJob } from "../src/job-wait.js";
import { handleTool, TOOLS } from "../src/tools.js";

const job = (status: string, processed: number, extra: Record<string, unknown> = {}) => ({
  id: "job-1",
  status,
  progress: { total_chunks: 10, processed_chunks: processed, nodes_created: processed * 3, edges_created: 0 },
  ...extra,
});

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

describe("waitForJob", () => {
  it("polls until the job is terminal and reports each change once", async () => {
    const states = [job("pending", 0, { queue_position: 2 }), job("processing", 4), job("processing", 4), job("completed", 10)];
    const getJob = vi.fn(async () => states.shift()!);
    const progress = vi.fn(async () => {});
    const result = await waitForJob(getJob, 50, { progress }, fakeClock());
    expect(getJob).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ still_running: false, waited_seconds: 6 });
    expect(progress.mock.calls.map(([update]) => update)).toEqual([
      { progress: 0, total: 10, message: "pending: queued at position 2, 0 nodes" },
      { progress: 4, total: 10, message: "processing: 4 of 10 chunks, 12 nodes" },
      { progress: 10, total: 10, message: "completed: 10 of 10 chunks, 30 nodes" },
    ]);
  });

  it("returns still_running at the deadline instead of timing out", async () => {
    const getJob = vi.fn(async () => job("processing", 1));
    const result = await waitForJob(getJob, 5, {}, fakeClock());
    expect(result).toMatchObject({ still_running: true, waited_seconds: 5 });
    expect(getJob).toHaveBeenCalledTimes(4); // 0 s, 2 s, 4 s, 5 s
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const clock = fakeClock();
    const getJob = vi.fn(async () => job("processing", 1));
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      controller.abort();
    };
    const result = await waitForJob(getJob, 50, { signal: controller.signal }, { now: clock.now, sleep });
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(result.still_running).toBe(true);
  });

  it("a host that rejects progress does not fail the wait", async () => {
    const states = [job("processing", 1), job("completed", 10)];
    const result = await waitForJob(
      async () => states.shift()!,
      50,
      { progress: async () => Promise.reject(new Error("closed")) },
      fakeClock(),
    );
    expect(result.still_running).toBe(false);
  });

  it("does not wait on a response it cannot read a status from", async () => {
    const getJob = vi.fn(async () => ({ unexpected: true }));
    const result = await waitForJob(getJob, 50, {}, fakeClock());
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(result.still_running).toBe(false);
  });

  it("clamps wait_seconds to the transport's bound", () => {
    expect(clampWaitSeconds(undefined)).toBe(0);
    expect(clampWaitSeconds(-3)).toBe(0);
    expect(clampWaitSeconds(600)).toBe(50);
    expect(clampWaitSeconds(600, 25)).toBe(25);
    expect(clampWaitSeconds(12.9)).toBe(12);
    expect(jobProgress({ status: "x" })).toBeUndefined();
  });
});

describe("job_status wait_seconds through the tools", () => {
  const client = (getJob: () => Promise<unknown>) =>
    ({ getJob: vi.fn(getJob) }) as unknown as MindGraph & { getJob: ReturnType<typeof vi.fn> };

  it("without wait_seconds reads the job once, as before", async () => {
    const c = client(async () => job("processing", 2));
    const r = await handleTool(c, "mindgraph_ingest", { action: "job_status", job_id: "job-1" });
    expect(c.getJob).toHaveBeenCalledTimes(1);
    expect(JSON.parse(r.content[0].text)).toEqual(job("processing", 2));
  });

  it("with wait_seconds returns the finished job and how long it waited", async () => {
    const c = client(async () => job("completed", 10));
    const progress = vi.fn(async () => {});
    for (const tool of ["mindgraph_ingest", "mindgraph_synthesize"]) {
      const r = await handleTool(c, tool, { action: "job_status", job_id: "job-1", wait_seconds: 30 }, {}, { progress });
      const body = JSON.parse(r.content[0].text);
      expect(body.status).toBe("completed");
      expect(body.waited_seconds).toBe(0);
      expect(body.still_running).toBeUndefined();
    }
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("both tools advertise wait_seconds with the 50 s ceiling", () => {
    for (const name of ["mindgraph_ingest", "mindgraph_synthesize"]) {
      const schema = TOOLS.find((tool) => tool.name === name)!.inputSchema as {
        properties: Record<string, { maximum?: number }>;
      };
      expect(schema.properties.wait_seconds.maximum).toBe(50);
    }
  });
});

// ── End to end: progress notifications over a real MCP connection ─────
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGovernanceLatch } from "../src/governance.js";
import { createGeneratedToolsEntry } from "../src/generated-tools.js";
import { buildMindGraphServer, createMindGraphServer } from "../src/server.js";

describe("progress over the wire", () => {
  const graphClient = () => {
    const states = [job("processing", 3), job("completed", 10)];
    return {
      getJob: vi.fn(async () => states.shift() ?? job("completed", 10)),
      listOntologyTools: vi.fn(async () => ({ tools: [] })),
    };
  };
  const governance = {
    baseUrl: "https://api.example.test",
    apiKey: "k",
    orgId: "org-1",
    agentId: "agent-1",
    disabled: true,
    latch: createGovernanceLatch(),
    context: { harness: "generic" },
  };

  it("a local server sends progress to a caller that asked for it", async () => {
    const client = graphClient();
    const server = buildMindGraphServer({
      client: client as unknown as MindGraph,
      serverVersion: "test",
      instructions: "",
      profile: "general",
      agentId: "agent-1",
      governance: governance as never,
      memory: {},
      generatedTools: createGeneratedToolsEntry(),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "progress-test", version: "0" });
    await mcp.connect(clientSide);
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];
    const result = await mcp.callTool(
      { name: "mindgraph_ingest", arguments: { action: "job_status", job_id: "job-1", wait_seconds: 10 } },
      { onprogress: (update) => void seen.push(update) },
    );
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.status).toBe("completed");
    expect(seen.map((update) => [update.progress, update.total])).toEqual([
      [3, 10],
      [10, 10],
    ]);
    expect(seen[0].message).toBe("processing: 3 of 10 chunks, 9 nodes");
    await mcp.close();
  }, 15_000);

  it("the hosted server waits but sends no progress", async () => {
    const client = graphClient();
    const server = createMindGraphServer({
      client: client as unknown as MindGraph,
      bearer: "t",
      baseUrl: "https://api.example.test",
      orgId: "org-1",
      agentId: "mcp:host:user",
      user: { id: "user-1" },
      profile: "general",
      harness: "hosted",
      serverVersion: "test",
      governanceDisabled: true,
      caches: { generatedTools: new Map(), governance: new Map() },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "hosted-progress-test", version: "0" });
    await mcp.connect(clientSide);
    const seen: unknown[] = [];
    const result = await mcp.callTool(
      { name: "mindgraph_ingest", arguments: { action: "job_status", job_id: "job-1", wait_seconds: 10 } },
      { onprogress: (update) => void seen.push(update) },
    );
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).status).toBe("completed");
    expect(seen).toEqual([]);
    await mcp.close();
  }, 15_000);
});
