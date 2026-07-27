import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkMcpGovernance, resetGovernanceCapability } from "../src/governance.js";

const config = {
  baseUrl: "https://api.example.test",
  apiKey: "mg_live_test",
  agentId: "agent-1",
};

describe("MCP governance checkpoint", () => {
  beforeEach(resetGovernanceCapability);

  it("preserves behavior against a governance-less server and caches the probe", async () => {
    const fetchImpl = vi.fn(async () => new Response("unknown action", { status: 400 }));
    expect(
      await checkMcpGovernance("mindgraph_retrieve", {}, { ...config, fetchImpl })
    ).toEqual({ allowed: true });
    expect(
      await checkMcpGovernance("mindgraph_capture", {}, { ...config, fetchImpl })
    ).toEqual({ allowed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the policy name on deny", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          decision: "deny",
          obligations: [],
          fired_policies: [{ name: "No external writes" }],
        }),
        { status: 200 }
      )
    );
    const result = await checkMcpGovernance("mindgraph_capture", {}, {
      ...config,
      fetchImpl,
    });
    expect(result).toMatchObject({
      allowed: false,
      decision: "deny",
      policy: "No external writes",
    });
  });

  it("returns checkpoint approval details without pretending it can park", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          decision: "conditional",
          approval_uid: "approval-1",
          obligations: [{ duty: "require_approval" }],
          fired_policies: [{ name: "PII egress" }],
        }),
        { status: 200 }
      )
    );
    const result = await checkMcpGovernance("mindgraph_ingest", {}, {
      ...config,
      fetchImpl,
    });
    expect(result).toMatchObject({
      allowed: false,
      decision: "conditional",
      approval_uid: "approval-1",
    });
  });

  // P44: "unsupported" is a fail-open. It used to latch for the life of the
  // process, so a server that gained governance — or a probe answered by a
  // broken deployment — was never gated again.
  it("re-probes after the unsupported lease expires instead of latching forever", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("unknown action", { status: 400 }))
      .mockResolvedValue(
        new Response(
          JSON.stringify({ decision: "deny", obligations: [], fired_policies: [] }),
          { status: 200 }
        )
      );

    expect(
      await checkMcpGovernance("mindgraph_retrieve", {}, { ...config, fetchImpl })
    ).toEqual({ allowed: true });
    expect(
      await checkMcpGovernance("mindgraph_retrieve", {}, { ...config, fetchImpl })
    ).toEqual({ allowed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      const afterLease = await checkMcpGovernance(
        "mindgraph_retrieve",
        {},
        { ...config, fetchImpl }
      );
      expect(afterLease.allowed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // P7: a blip on the probe is not a policy verdict.
  it("retries a transient failure before deciding, and permits once it clears", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream", { status: 503 }))
      .mockResolvedValue(
        new Response(
          JSON.stringify({ decision: "permit", obligations: [], fired_policies: [] }),
          { status: 200 }
        )
      );

    const result = await checkMcpGovernance("mindgraph_retrieve", {}, {
      ...config,
      fetchImpl,
      retryDelaysMs: [0, 0],
    });

    expect(result).toEqual({ allowed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed with an actionable message once the retries are exhausted", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    const result = await checkMcpGovernance("mindgraph_retrieve", {}, {
      ...config,
      fetchImpl,
      retryDelaysMs: [0, 0],
    });

    expect(result.allowed).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      message: expect.stringContaining("MINDGRAPH_GOVERNANCE=off"),
    });
  });

  it("does not mistake a refused credential for a server without governance", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));

    const result = await checkMcpGovernance("mindgraph_retrieve", {}, {
      ...config,
      fetchImpl,
    });

    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({
      message: expect.stringContaining("not permitted to evaluate"),
    });
    // Must not have latched: the next call probes again.
    await checkMcpGovernance("mindgraph_retrieve", {}, { ...config, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["notify", "redact"])(
    "fails closed on a %s obligation the adapter cannot enforce",
    async (duty) => {
      const fetchImpl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            decision: "conditional",
            obligations: [{ duty }],
            fired_policies: [],
          }),
          { status: 200 }
        )
      );
      const result = await checkMcpGovernance("mindgraph_retrieve", {}, {
        ...config,
        fetchImpl,
      });
      expect(result).toMatchObject({ allowed: false, decision: "conditional" });
      expect(result.message).toContain("cannot safely enforce");
    }
  );
});
