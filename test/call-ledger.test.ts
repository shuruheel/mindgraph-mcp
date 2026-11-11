import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordPendingCall, resolvePendingCall } from "../src/call-ledger.js";

const dirs: string[] = [];
function runtime(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindgraph-call-ledger-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("H1 — hook fields reach the server beside the call, not inside it", () => {
  it("resolves by bare tool name and argument content, independent of key order", () => {
    const runtimeDir = runtime();
    recordPendingCall(
      "mcp__mindgraph__mindgraph_plan",
      { action: "heartbeat", task_uid: "t" },
      "session-a",
      { session_uid: "s", lease_epoch: 3 },
      { runtimeDir },
    );
    expect(
      resolvePendingCall("mindgraph_plan", { task_uid: "t", action: "heartbeat" }, { runtimeDir }),
    ).toEqual({ session_uid: "s", lease_epoch: 3 });
    // A different call gets nothing: fields never leak across calls.
    expect(
      resolvePendingCall("mindgraph_plan", { action: "heartbeat" }, { runtimeDir }),
    ).toBeUndefined();
    expect(
      resolvePendingCall("mindgraph_capture", { action: "heartbeat", task_uid: "t" }, { runtimeDir }),
    ).toBeUndefined();
  });

  it("fails closed when two sessions made the identical call", () => {
    // Failure prevented: session B's fenced call carrying session A's lease.
    const runtimeDir = runtime();
    const input = { action: "heartbeat" };
    recordPendingCall("mcp__mindgraph__mindgraph_plan", input, "session-a", { lease_epoch: 1 }, { runtimeDir, projectDir: "/a" });
    recordPendingCall("mcp__mindgraph__mindgraph_plan", input, "session-b", { lease_epoch: 2 }, { runtimeDir, projectDir: "/b" });
    expect(resolvePendingCall("mindgraph_plan", input, { runtimeDir, projectDir: "" })).toBeUndefined();
    // The project directory both processes are given can tell them apart.
    expect(resolvePendingCall("mindgraph_plan", input, { runtimeDir, projectDir: "/b" })).toEqual({ lease_epoch: 2 });
    // Two sessions in the same project stay ambiguous.
    recordPendingCall("mcp__mindgraph__mindgraph_plan", input, "session-c", { lease_epoch: 3 }, { runtimeDir, projectDir: "/b" });
    expect(resolvePendingCall("mindgraph_plan", input, { runtimeDir, projectDir: "/b" })).toBeUndefined();
  });

  it("a later hook run for the same call replaces the earlier fields", () => {
    const runtimeDir = runtime();
    const input = { action: "heartbeat" };
    recordPendingCall("mcp__mindgraph__mindgraph_plan", input, "session-a", { expected_version: 1 }, { runtimeDir });
    recordPendingCall("mcp__mindgraph__mindgraph_plan", input, "session-a", { expected_version: 2 }, { runtimeDir });
    expect(resolvePendingCall("mindgraph_plan", input, { runtimeDir })).toEqual({ expected_version: 2 });
  });

  it("expires a record so a stale lease is never applied to a much later call", () => {
    const runtimeDir = runtime();
    const input = { action: "heartbeat" };
    recordPendingCall("mcp__mindgraph__mindgraph_plan", input, "session-a", { lease_epoch: 1 }, { runtimeDir, now: () => 1_000 });
    expect(resolvePendingCall("mindgraph_plan", input, { runtimeDir, now: () => 1_000 + 9 * 60_000 })).toEqual({ lease_epoch: 1 });
    expect(resolvePendingCall("mindgraph_plan", input, { runtimeDir, now: () => 1_000 + 11 * 60_000 })).toBeUndefined();
  });

  it("keeps the runtime files private", () => {
    const runtimeDir = runtime();
    recordPendingCall("mcp__mindgraph__mindgraph_plan", {}, "session-a", { session_uid: "s" }, { runtimeDir });
    const dir = path.join(runtimeDir, "calls");
    const [file] = fs.readdirSync(dir);
    expect(fs.statSync(path.join(dir, file)).mode & 0o077).toBe(0);
  });
});

describe("H1 — the stdio server applies the recorded fields", () => {
  it("merges resolved fields over the model's arguments before dispatch", async () => {
    const { Client } = await import("@modelcontextprotocol/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/server");
    const { buildMindGraphServer } = await import("../src/server.js");
    const seen: Array<[string, Record<string, unknown>]> = [];
    const governed: string[] = [];
    const server = buildMindGraphServer({
      client: {} as never,
      serverVersion: "test",
      instructions: "",
      profile: "coding",
      agentId: "agent-1",
      governance: {
        baseUrl: "https://api.example.test",
        apiKey: "mg_live_test",
        agentId: "agent-1",
        // Capture what the server evaluates, then refuse: nothing reaches a graph.
        fetchImpl: (async (_url: unknown, init?: { body?: unknown }) => {
          governed.push(String(init?.body ?? ""));
          throw new Error("offline");
        }) as unknown as typeof fetch,
      },
      memory: { profile: "coding" },
      resolveHookFields: (name, args) => {
        seen.push([name, args]);
        return { agent_id: "from-hook" };
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "h1", version: "0" });
    await mcp.connect(clientSide);
    await mcp.callTool({ name: "mindgraph_memory", arguments: { action: "status" } });
    await mcp.close();
    // The resolver is keyed on exactly what the model sent.
    expect(seen).toEqual([["mindgraph_memory", { action: "status" }]]);
    // The governed call already carries the hook's field.
    expect(governed.length).toBeGreaterThan(0);
    expect(governed[0]).toContain("from-hook");
  });
});
