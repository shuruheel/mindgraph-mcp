import { describe, expect, it, vi, afterEach } from "vitest";
import { MindGraph, MindGraphError } from "mindgraph";
import {
  documentStatusProgress,
  isDocumentStatusPayload,
  parseRetryAfterMs,
  waitForDocumentStatus,
  type DocumentStatusPayload,
  type RawDocumentStatusResponse,
} from "../src/job-wait.js";
import { handleTool, TOOLS } from "../src/tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeStatus(overrides: Partial<DocumentStatusPayload> = {}): DocumentStatusPayload {
  return {
    contract: "document-status.v1",
    document_uid: "doc-1",
    document_version: 2,
    generation_id: "gen_01",
    attempt_id: "att_01",
    job_id: "job_01",
    job_available: true,
    processing_status: "processing",
    attempt_state: "running",
    content_revision: "sha256:abc",
    pipeline_digest: "sha256:def",
    readiness: {
      lexical: "ready",
      vector: "not_ready",
      extraction: "not_ready",
    },
    observed_at: "2026-11-22T04:00:00Z",
    error: null,
    ...overrides,
  };
}

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

describe("waitForDocumentStatus (MCP bounded read-only helper)", () => {
  it("polls until target dimension is ready, pins attempt_id, and reports progress once per change", async () => {
    const states = [
      makeStatus({ readiness: { lexical: "ready", vector: "not_ready", extraction: "not_ready" } }),
      makeStatus({ readiness: { lexical: "ready", vector: "ready", extraction: "not_ready" } }),
      makeStatus({
        attempt_state: "completed",
        processing_status: "completed",
        readiness: { lexical: "ready", vector: "ready", extraction: "ready" },
      }),
    ];
    const getStatus = vi.fn(async () => states.shift()!);
    const progress = vi.fn(async () => {});
    const outcome = await waitForDocumentStatus(
      "doc-1",
      getStatus,
      50,
      { until: "extraction" },
      { progress },
      fakeClock(),
    );
    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") {
      expect(outcome.waited_seconds).toBe(4);
      expect(outcome.status.readiness.extraction).toBe("ready");
    }
    expect(progress.mock.calls.map(([u]) => u)).toEqual([
      { progress: 1, total: 3, message: "running: lexical=ready, vector=not_ready, extraction=not_ready" },
      { progress: 2, total: 3, message: "running: lexical=ready, vector=ready, extraction=not_ready" },
      { progress: 3, total: 3, message: "completed: lexical=ready, vector=ready, extraction=ready" },
    ]);
  });

  it("returns document_superseded when attempt_id changes", async () => {
    const states = [
      makeStatus({ attempt_id: "att_01", attempt_state: "running" }),
      makeStatus({
        attempt_id: "att_02",
        attempt_state: "completed",
        readiness: { lexical: "ready", vector: "ready", extraction: "ready" },
      }),
    ];
    const outcome = await waitForDocumentStatus(
      "doc-1",
      async () => states.shift()!,
      50,
      {},
      {},
      fakeClock(),
    );
    expect(outcome).toMatchObject({
      kind: "error",
      code: "document_superseded",
      expected_attempt_id: "att_01",
      observed_attempt_id: "att_02",
    });
  });

  it("handles legacy attempt_id: null, not_requested, and terminal incomplete strictly via attempt_state", async () => {
    const legacy = await waitForDocumentStatus(
      "doc-1",
      async () =>
        makeStatus({
          attempt_id: null,
          generation_id: null,
          attempt_state: null,
          readiness: { lexical: "unknown", vector: "unknown", extraction: "unknown" },
        }),
      10,
      {},
      {},
      fakeClock(),
    );
    expect(legacy).toMatchObject({ kind: "error", code: "readiness_unknown" });

    const notReq = await waitForDocumentStatus(
      "doc-1",
      async () =>
        makeStatus({ readiness: { lexical: "ready", vector: "not_requested", extraction: "not_ready" } }),
      10,
      { until: "vector" },
      {},
      fakeClock(),
    );
    expect(notReq).toMatchObject({
      kind: "error",
      code: "readiness_not_requested",
      dimension: "vector",
    });

    // Stale processing_status='processing' with terminal attempt_state='interrupted' -> document_incomplete
    const incomplete = await waitForDocumentStatus(
      "doc-1",
      async () =>
        makeStatus({
          processing_status: "processing",
          attempt_state: "interrupted",
          readiness: { lexical: "ready", vector: "not_ready", extraction: "not_ready" },
        }),
      10,
      { until: "extraction" },
      {},
      fakeClock(),
    );
    expect(incomplete).toMatchObject({
      kind: "error",
      code: "document_incomplete",
      dimension: "extraction",
    });

    // Active attempt_state='running' with stale processing_status='failed' keeps waiting until ready
    const states = [
      makeStatus({ processing_status: "failed", attempt_state: "running" }),
      makeStatus({
        processing_status: "completed",
        attempt_state: "completed",
        readiness: { lexical: "ready", vector: "ready", extraction: "ready" },
      }),
    ];
    const recovered = await waitForDocumentStatus(
      "doc-1",
      async () => states.shift()!,
      10,
      { until: "extraction" },
      {},
      fakeClock(),
    );
    expect(recovered.kind).toBe("ready");
  });

  it("retries 409 status_changed transparently and returns still_running at bounded deadline", async () => {
    let calls = 0;
    const outcome = await waitForDocumentStatus(
      "doc-1",
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new MindGraphError("conflict", 409, { code: "status_changed", retriable: true });
        }
        return makeStatus({
          attempt_state: "completed",
          readiness: { lexical: "ready", vector: "ready", extraction: "ready" },
        });
      },
      10,
      {},
      {},
      fakeClock(),
    );
    expect(outcome.kind).toBe("ready");
    expect(calls).toBe(2);

    const runningOutcome = await waitForDocumentStatus(
      "doc-1",
      async () => makeStatus({ attempt_state: "running" }),
      5,
      {},
      {},
      fakeClock(),
    );
    expect(runningOutcome).toMatchObject({ kind: "still_running", waited_seconds: 5 });
  });

  it("stops immediately on AbortSignal without issuing writes", async () => {
    const controller = new AbortController();
    const clock = fakeClock();
    const getStatus = vi.fn(async () => makeStatus({ attempt_state: "running" }));
    const outcome = await waitForDocumentStatus(
      "doc-1",
      getStatus,
      50,
      {},
      { signal: controller.signal },
      {
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms);
          controller.abort();
        },
      },
    );
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("still_running");
    expect(documentStatusProgress(makeStatus()).total).toBe(3);
  });
});

describe("mindgraph_ingest action='document_status' dispatch", () => {
  it("advertises document_status, attempt_id, and until in mindgraph_ingest schema", () => {
    const schema = TOOLS.find((t) => t.name === "mindgraph_ingest")!.inputSchema as {
      properties: Record<string, { enum?: string[]; maximum?: number }>;
    };
    expect(schema.properties.action.enum).toContain("document_status");
    expect(schema.properties.until.enum).toEqual(["lexical", "vector", "extraction"]);
    expect(schema.properties.attempt_id).toBeTruthy();
    expect(schema.properties.wait_seconds.maximum).toBe(50);
  });

  it("requires document_uid and reads status via getDocumentStatus without writes", async () => {
    const status = makeStatus({
      attempt_state: "completed",
      processing_status: "completed",
      readiness: { lexical: "ready", vector: "ready", extraction: "ready" },
    });
    const client = {
      getDocumentStatus: vi.fn(async () => status),
      cancelJob: vi.fn(),
      deleteDocument: vi.fn(),
      ingestDocument: vi.fn(),
      embedAll: vi.fn(),
    } as unknown as MindGraph & {
      getDocumentStatus: ReturnType<typeof vi.fn>;
      cancelJob: ReturnType<typeof vi.fn>;
      deleteDocument: ReturnType<typeof vi.fn>;
      ingestDocument: ReturnType<typeof vi.fn>;
      embedAll: ReturnType<typeof vi.fn>;
    };

    const missing = await handleTool(client, "mindgraph_ingest", { action: "document_status" });
    expect(missing.isError).toBe(true);
    expect(client.getDocumentStatus).not.toHaveBeenCalled();

    const immediate = await handleTool(client, "mindgraph_ingest", {
      action: "document_status",
      document_uid: "doc-1",
    });
    expect(immediate.isError).toBeFalsy();
    expect(JSON.parse(immediate.content[0].text)).toEqual(status);
    expect(client.getDocumentStatus).toHaveBeenCalledWith("doc-1", { signal: undefined });

    const waited = await handleTool(client, "mindgraph_ingest", {
      action: "document_status",
      document_uid: "doc-1",
      attempt_id: "att_01",
      until: "extraction",
      wait_seconds: 10,
    });
    expect(waited.isError).toBeFalsy();
    expect(JSON.parse(waited.content[0].text)).toMatchObject({
      contract: "document-status.v1",
      waited_seconds: 0,
    });

    // Zero mutating/cancel calls ever sent
    expect(client.cancelJob).not.toHaveBeenCalled();
    expect(client.deleteDocument).not.toHaveBeenCalled();
    expect(client.ingestDocument).not.toHaveBeenCalled();
    expect(client.embedAll).not.toHaveBeenCalled();
  });

  it("returns structured isError payload on document_superseded during bounded wait", async () => {
    const client = {
      getDocumentStatus: vi.fn(async () => makeStatus({ attempt_id: "att_02" })),
    } as unknown as MindGraph;

    const result = await handleTool(client, "mindgraph_ingest", {
      action: "document_status",
      document_uid: "doc-1",
      attempt_id: "att_01",
      wait_seconds: 10,
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      code: "document_superseded",
      document_uid: "doc-1",
      expected_attempt_id: "att_01",
      observed_attempt_id: "att_02",
      retriable: false,
    });
    expect(body.last_status.attempt_id).toBe("att_02");
  });

  it("falls back cleanly to client.request GET when running against mindgraph 0.18.0 (immediate and wait_seconds > 0)", async () => {
    const status = makeStatus({
      document_uid: "doc/x",
      attempt_state: "completed",
      readiness: { lexical: "ready", vector: "ready", extraction: "ready" },
    });
    const client = {
      request: vi.fn(async () => status),
    } as unknown as MindGraph & { request: ReturnType<typeof vi.fn> };

    const res = await handleTool(client, "mindgraph_ingest", {
      action: "document_status",
      document_uid: "doc/x",
    });
    expect(res.isError).toBeFalsy();
    expect(client.request).toHaveBeenCalledWith("GET", "/ingest/document/doc%2Fx/status");
    expect(JSON.parse(res.content[0].text)).toEqual(status);

    const waited = await handleTool(client, "mindgraph_ingest", {
      action: "document_status",
      document_uid: "doc/x",
      wait_seconds: 5,
    });
    expect(waited.isError).toBeFalsy();
    expect(JSON.parse(waited.content[0].text)).toMatchObject({
      contract: "document-status.v1",
      waited_seconds: 0,
    });
  });

  it("honors Retry-After clamping on 429/503/200, excludes terminal 503 codes, rejects missing attempt_id, and handles pre-aborted signal", async () => {
    const baseNow = Date.UTC(2026, 10, 22, 4, 0, 0);
    expect(parseRetryAfterMs("3", baseNow)).toBe(3_000);
    expect(parseRetryAfterMs("Sun, 22 Nov 2026 04:00:04 GMT", baseNow)).toBe(4_000);
    expect(isDocumentStatusPayload({ contract: "document-status.v1", document_uid: "d", readiness: { lexical: "ready", vector: "ready", extraction: "ready" } })).toBe(false);

    // 429 with Retry-After: 3 sleeps 3000ms, 200 running with HTTP-date +2s sleeps 2000ms, then ready
    let now = baseNow;
    const sleeps: number[] = [];
    const clock = {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    };
    const rawSeq: RawDocumentStatusResponse[] = [
      { status: 429, body: { code: "rate_limited" }, retryAfter: "3" },
      {
        status: 200,
        body: makeStatus({ attempt_state: "running" }),
        retryAfter: new Date(baseNow + 5_000).toUTCString(), // +2s after 3s sleep
      },
      {
        status: 200,
        body: makeStatus({
          attempt_state: "completed",
          readiness: { lexical: "ready", vector: "ready", extraction: "ready" },
        }),
        retryAfter: null,
      },
    ];
    let i = 0;
    const okOut = await waitForDocumentStatus(
      "doc-1",
      async () => rawSeq[i++],
      20,
      {},
      {},
      clock,
    );
    expect(okOut.kind).toBe("ready");
    expect(sleeps).toEqual([3_000, 2_000]);

    // Retry-After >= remaining returns still_running immediately without exceeding wait_seconds
    now = baseNow;
    const clampedSleeps: number[] = [];
    const running = makeStatus({ attempt_state: "running" });
    let j = 0;
    const seq2: RawDocumentStatusResponse[] = [
      { status: 200, body: running, retryAfter: null },
      { status: 503, body: { code: "overloaded" }, retryAfter: "60" },
    ];
    const clampedOut = await waitForDocumentStatus(
      "doc-1",
      async () => seq2[j++],
      5,
      {},
      {},
      {
        now: () => now,
        sleep: async (ms: number) => {
          clampedSleeps.push(ms);
          now += ms;
        },
      },
    );
    expect(clampedOut).toMatchObject({ kind: "still_running", status: running });
    expect(clampedSleeps).toEqual([2_000]);
    expect(now - baseNow).toBeLessThanOrEqual(5_000);

    // Terminal 503 code propagates immediately without retry
    let terminalCalls = 0;
    await expect(
      waitForDocumentStatus(
        "doc-1",
        async () => {
          terminalCalls += 1;
          return { status: 503, body: { code: "vector_index_rebuilding" }, retryAfter: "1" };
        },
        10,
        {},
        {},
        fakeClock(),
      ),
    ).rejects.toMatchObject({ status: 503, code: "vector_index_rebuilding" });
    expect(terminalCalls).toBe(1);

    // Non-status_changed 409 propagates immediately
    await expect(
      waitForDocumentStatus(
        "doc-1",
        async () => ({ status: 409, body: { code: "other_conflict" }, retryAfter: null }),
        10,
        {},
        {},
        fakeClock(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "other_conflict" });

    // Terminal unknown readiness with non-null attempt_id -> readiness_unknown
    const unknownOut = await waitForDocumentStatus(
      "doc-1",
      async () =>
        makeStatus({
          attempt_id: "att_01",
          attempt_state: "completed",
          readiness: { lexical: "unknown", vector: "unknown", extraction: "unknown" },
        }),
      10,
      {},
      {},
      fakeClock(),
    );
    expect(unknownOut).toMatchObject({ kind: "error", code: "readiness_unknown" });

    // Pre-aborted AbortSignal sends 0 polls
    const preAbort = new AbortController();
    preAbort.abort();
    const zeroFetch = vi.fn(async () => makeStatus());
    await expect(
      waitForDocumentStatus("doc-1", zeroFetch, 10, {}, { signal: preAbort.signal }, fakeClock()),
    ).rejects.toMatchObject({ code: "document_wait_cancelled" });
    expect(zeroFetch).not.toHaveBeenCalled();
  });

  it("real MindGraph client uses single-shot fetch bounded by wait_seconds (no inner 503 retry overrun)", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        fetchCalls.push(String(input));
        if (fetchCalls.length === 1) {
          return new Response(JSON.stringify(makeStatus({ attempt_state: "running" })), {
            status: 200,
            headers: { "Content-Type": "application/json", "Retry-After": "60" },
          });
        }
        return new Response(JSON.stringify(makeStatus()), { status: 200 });
      }),
    );
    const realClient = new MindGraph({ baseUrl: "https://api.example.test", apiKey: "k" });
    const t0 = Date.now();
    const res = await handleTool(realClient, "mindgraph_ingest", {
      action: "document_status",
      document_uid: "doc-1",
      wait_seconds: 2,
    });
    const elapsed = Date.now() - t0;
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.still_running).toBe(true);
    expect(fetchCalls).toEqual(["https://api.example.test/ingest/document/doc-1/status"]);
    expect(elapsed).toBeLessThan(1_000);
  });
});
