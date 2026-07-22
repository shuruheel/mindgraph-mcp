export type GovernanceGateResult =
  | { allowed: true }
  | {
      allowed: false;
      message: string;
      decision?: string;
      approval_uid?: string;
      policy?: string;
    };

type Capability = "unknown" | "supported" | "unsupported";
let capability: Capability = "unknown";

// `log` is discharged by the server's synchronous PolicyDecision write and
// `require_approval` is enforced by blocking with its durable handle. This
// standalone adapter has no trusted delivery channel for `notify`, so it must
// fail closed instead of pretending the duty ran.
const KNOWN_DUTIES = new Set(["log", "require_approval"]);

function headers(apiKey: string, orgId?: string): Record<string, string> {
  const value: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (orgId) value["x-mindgraph-org"] = orgId;
  return value;
}

function unsupportedResponse(status: number, body: string): boolean {
  if (status === 404 || status === 405) return true;
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("unknown governance action") ||
    lower.includes("unknown action") ||
    lower.includes("invalid_governance_action")
  );
}

/** Reset only for deterministic tests. */
export function resetGovernanceCapability(): void {
  capability = "unknown";
}

export async function checkMcpGovernance(
  toolName: string,
  args: Record<string, unknown>,
  config: {
    baseUrl: string;
    apiKey: string;
    orgId?: string;
    agentId: string;
    fetchImpl?: typeof fetch;
    disabled?: boolean;
  }
): Promise<GovernanceGateResult> {
  if (config.disabled || capability === "unsupported") return { allowed: true };
  const fetchImpl = config.fetchImpl ?? fetch;
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/agent/governance`, {
      method: "POST",
      headers: headers(config.apiKey, config.orgId),
      body: JSON.stringify({
        action: "check",
        act: "tool_invoke",
        agent_id: String(args.agent_id || config.agentId),
        target: { tool_name: toolName },
        context: { adapter: "mindgraph-mcp" },
        tier: "checkpoint",
      }),
    });
    body = await response.text();
  } catch (error) {
    return {
      allowed: false,
      message: `MindGraph governance could not establish permission: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!response.ok) {
    if (capability === "unknown" && unsupportedResponse(response.status, body)) {
      capability = "unsupported";
      return { allowed: true };
    }
    return {
      allowed: false,
      message: `MindGraph governance check failed (${response.status})`,
    };
  }
  capability = "supported";

  let decision: Record<string, unknown>;
  try {
    decision = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { allowed: false, message: "MindGraph governance returned an invalid decision" };
  }
  const obligations = Array.isArray(decision.obligations) ? decision.obligations : [];
  const unknownDuty = obligations.find((obligation) => {
    if (!obligation || typeof obligation !== "object") return true;
    const duty = (obligation as Record<string, unknown>).duty;
    return typeof duty !== "string" || !KNOWN_DUTIES.has(duty);
  });
  if (unknownDuty) {
    return {
      allowed: false,
      decision: String(decision.decision || "conditional"),
      message: "MindGraph governance returned an obligation this adapter cannot safely enforce",
    };
  }

  const verdict = String(decision.decision || "deny");
  if (verdict === "permit") return { allowed: true };
  const fired = Array.isArray(decision.fired_policies) ? decision.fired_policies : [];
  const first = fired[0] as Record<string, unknown> | undefined;
  const policy = first && typeof first.name === "string" ? first.name : undefined;
  const approvalUid =
    typeof decision.approval_uid === "string" ? decision.approval_uid : undefined;
  return {
    allowed: false,
    decision: verdict,
    approval_uid: approvalUid,
    policy,
    message:
      verdict === "conditional"
        ? `Approval is required${policy ? ` by policy ${policy}` : ""}${
            approvalUid ? ` (approval ${approvalUid})` : ""
          }`
        : `Denied by MindGraph governance${policy ? ` policy ${policy}` : ""}`,
  };
}
