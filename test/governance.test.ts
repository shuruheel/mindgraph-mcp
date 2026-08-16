import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkMcpGovernance,
  governanceTarget,
  resetGovernanceCapability,
  toolMutability,
} from "../src/governance.js";

const config = {
  baseUrl: "https://api.example.test",
  apiKey: "mg_live_test",
  agentId: "agent-1",
};

describe("MCP governance checkpoint", () => {
  beforeEach(resetGovernanceCapability);

  it("classifies mixed-tool actions conservatively", () => {
    expect(toolMutability("mindgraph_plan", "get_plan")).toBe("read");
    expect(toolMutability("mindgraph_plan", "get_executions")).toBe("read");
    expect(toolMutability("mindgraph_plan", "create_task")).toBe("write");
    expect(toolMutability("mindgraph_plan", undefined)).toBe("write");
    expect(toolMutability("mindgraph_retrieve", "context")).toBe("read");
  });

  it("builds an action-aware target with deduplicated graph UIDs", () => {
    expect(
      governanceTarget("mindgraph_plan", {
        action: "checkpoint_iteration",
        task_uid: "task-1",
        execution_uid: "execution-1",
        related_uids: ["task-1", "symbol-1"],
      }),
    ).toEqual({
      tool_name: "mindgraph_plan",
      action: "checkpoint_iteration",
      mutability: "write",
      target_uids: ["task-1", "execution-1", "symbol-1"],
    });
  });

  it("sends action, mutability, and target_uids to the governance checkpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ decision: "permit", obligations: [], fired_policies: [] }),
        { status: 200 },
      ),
    );
    await checkMcpGovernance(
      "mindgraph_plan",
      {
        action: "complete_execution",
        execution_uid: "execution-1",
        produces_node_uid: "lesson-1",
      },
      { ...config, fetchImpl },
    );
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.target).toEqual({
      tool_name: "mindgraph_plan",
      action: "complete_execution",
      mutability: "write",
      target_uids: ["execution-1", "lesson-1"],
    });
  });

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
    // The refusal must read as CONNECTIVITY, not policy: the old wording
    // ("could not establish permission… set MINDGRAPH_GOVERNANCE=off")
    // steered callers toward disabling governance for a network blip that
    // disabling governance cannot fix.
    expect(result).toMatchObject({
      message: expect.stringContaining("unreachable"),
    });
    expect(String(result.message)).toContain("not a governance denial");
    expect(String(result.message)).not.toContain("MINDGRAPH_GOVERNANCE=off");
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
