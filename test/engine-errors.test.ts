import { afterEach, describe, expect, it, vi } from "vitest";
import { MindGraph, MindGraphError } from "mindgraph";
import { handleTool } from "../src/tools.js";
import { handleGeneratedTool, type GeneratedToolDescriptor } from "../src/generated-tools.js";
import { toolError } from "../src/error-detail.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("engine errors through MCP", () => {
  it.each([
    [503, "query_admission_busy"], [422, "query_memory_budget_exceeded"],
    [504, "query_timeout"], [409, "query_cancelled"],
  ])("preserves %s/%s job failures through list rendering and raw status reads", async (status, code) => {
    const job = {
      id: "failed-job", title: "Example queries", status: "failed", created_at: 1,
      progress: { processed_chunks: 2, total_chunks: 5 },
      error: "legacy diagnostic",
      error_details: { message: "Safe terminal reason", code, status, retriable: false },
    };
    const fetcher = vi.fn(async (url: string | URL | Request, _options: RequestInit) => new Response(JSON.stringify(
      String(url).endsWith("/jobs/failed-job") ? job : [job],
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const client = new MindGraph({ baseUrl: "https://offline.invalid" });
    const rendered = await handleTool(client, "mindgraph_ingest", { action: "job_status" });
    expect(rendered.isError).not.toBe(true); // The status read succeeded; execution failed.
    expect(rendered.content[0].text).toContain("[failed-job]");
    expect(rendered.content[0].text).toContain("2/5 chunks");
    expect(rendered.content[0].text).toContain(`error: Safe terminal reason, code: ${code}, status: ${status}, retriable: false`);
    expect(rendered.content[0].text).not.toContain("legacy diagnostic");
    const raw = await handleTool(client, "mindgraph_ingest", { action: "job_status", format: "json" });
    expect(JSON.parse(raw.content[0].text)[0].error_details).toEqual(job.error_details);
    const single = await handleTool(client, "mindgraph_ingest", { action: "job_status", job_id: job.id });
    expect(JSON.parse(single.content[0].text).error_details).toEqual(job.error_details);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, options] of fetcher.mock.calls) {
      expect(options.method).toBe("GET");
    }
  });

  it.each([
    [503, "vector_index_rebuilding"], [503, "query_admission_busy"],
    [422, "query_memory_budget_exceeded"], [504, "query_timeout"], [409, "query_cancelled"],
  ])("keeps %s/%s as a structured failure with one transport attempt", async (status, code) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: "Operation failed", code, retriable: false,
    }), { status, headers: { "Retry-After": "1" } }));
    vi.stubGlobal("fetch", fetcher);
    const client = new MindGraph({ baseUrl: "https://offline.invalid" });
    const result = await handleTool(client, "mindgraph_memory", { action: "context", mode: "topic", query: "test" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ status, code, retriable: false });
    expect(payload).not.toHaveProperty("graph");
    expect(result.structuredContent).toEqual(payload);
  });

  it("generated ontology tools preserve the server code and retry guidance", async () => {
    const cause = new MindGraphError("Unavailable", 503, { code: "vector_index_rebuilding", retriable: false });
    const client = { searchDomainObjects: vi.fn().mockRejectedValue(cause) } as unknown as MindGraph;
    const desc: GeneratedToolDescriptor = {
      name: "generated", description: "search", schema_id: "schema-a",
      object_type: "Company", maps_to: "search", input_schema: {},
    };
    const result = await handleGeneratedTool(client, desc, { query: "test" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "vector_index_rebuilding", retriable: false, status: 503 });
  });

  it("keeps fencing state alongside additive guidance", () => {
    const result = toolError(new MindGraphError("Conflict", 409, {
      code: "lease_fenced", retriable: false, current_version: 7, current_epoch: 3,
      lease_expires_at: 123, lease_owner_agent_id: "agent",
    }));
    expect(result.structuredContent).toMatchObject({
      code: "lease_fenced", retriable: false, current_version: 7, current_epoch: 3,
      lease_expires_at: 123, lease_owner_agent_id: "agent",
    });
  });

  it("does not invent retry guidance for legacy errors", () => {
    const result = toolError(new MindGraphError("Busy", 503, "busy"), "tool_failed");
    expect(result.structuredContent).toMatchObject({ code: "tool_failed", status: 503 });
    expect(result.structuredContent).not.toHaveProperty("retriable");
  });
});
