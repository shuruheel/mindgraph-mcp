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
