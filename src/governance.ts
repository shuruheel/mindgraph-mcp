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

// An "unsupported" verdict is a fail-open: we stop gating because the server
// told us it has no governance to gate with. Latching that for the life of the
// process means a server that gains governance — or a probe that was answered
// by a broken deployment — never starts being enforced again. The latch is
// therefore a lease, not a decision, and re-probes when it expires.
const UNSUPPORTED_LEASE_MS = 5 * 60 * 1000;
let unsupportedUntil = 0;
let unsupportedLogged = false;

// A blip on the probe must not read as a policy verdict. Transient conditions
// are retried before the gate fails closed; anything still failing after the
// last attempt is a real failure and is refused.
const DEFAULT_RETRY_DELAYS_MS = [150, 600];

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  unsupportedUntil = 0;
  unsupportedLogged = false;
}

export interface GovernanceConfig {
  baseUrl: string;
  apiKey: string;
  orgId?: string;
  agentId: string;
  fetchImpl?: typeof fetch;
  disabled?: boolean;
  /** Extra audit context merged into the check — e.g. the resource URI. */
  context?: Record<string, unknown>;
  /** Overridden only by tests, to keep the retry path fast. */
  retryDelaysMs?: number[];
}

export async function checkMcpGovernance(
  toolName: string,
  args: Record<string, unknown>,
  config: GovernanceConfig
): Promise<GovernanceGateResult> {
  if (config.disabled) return { allowed: true };
  if (capability === "unsupported") {
    if (Date.now() < unsupportedUntil) return { allowed: true };
    // Lease expired — probe again rather than stay ungoverned forever.
    capability = "unknown";
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const retryDelays = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let response: Response | undefined;
  let body = "";
  let lastFailure = "";

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const candidate = await fetchImpl(
        `${config.baseUrl.replace(/\/$/, "")}/agent/governance`,
        {
          method: "POST",
          headers: headers(config.apiKey, config.orgId),
          body: JSON.stringify({
            action: "check",
            act: "tool_invoke",
            agent_id: String(args.agent_id || config.agentId),
            target: { tool_name: toolName },
            context: { adapter: "mindgraph-mcp", ...config.context },
            tier: "checkpoint",
          }),
        }
      );
      const candidateBody = await candidate.text();
      if (isTransientStatus(candidate.status) && attempt < retryDelays.length) {
        lastFailure = `HTTP ${candidate.status}`;
        await sleep(retryDelays[attempt]);
        continue;
      }
      response = candidate;
      body = candidateBody;
      break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      if (attempt < retryDelays.length) {
        await sleep(retryDelays[attempt]);
        continue;
      }
    }
  }

  if (!response) {
    // Unreachable after retries. The adapter cannot tell "permitted" from
    // "denied", so it refuses — an unevaluated policy is not a permit.
    return {
      allowed: false,
      message:
        `MindGraph governance could not establish permission after ` +
        `${retryDelays.length + 1} attempts (${lastFailure}). ` +
        `Set MINDGRAPH_GOVERNANCE=off to run this adapter ungoverned.`,
    };
  }

  if (!response.ok) {
    if (capability === "unknown" && unsupportedResponse(response.status, body)) {
      capability = "unsupported";
      unsupportedUntil = Date.now() + UNSUPPORTED_LEASE_MS;
      if (!unsupportedLogged) {
        unsupportedLogged = true;
        console.error(
          `[mindgraph-mcp] This MindGraph server does not implement the governance ` +
            `checkpoint (HTTP ${response.status}); tool calls proceed ungoverned. ` +
            `Re-probing every ${Math.round(UNSUPPORTED_LEASE_MS / 60000)} minutes.`
        );
      }
      return { allowed: true };
    }
    if (response.status === 401 || response.status === 403) {
      // Distinct from "no governance here": the server has a checkpoint and
      // refused this credential. Failing open would hand the caller exactly
      // the bypass the policy exists to prevent.
      return {
        allowed: false,
        message:
          `This credential is not permitted to evaluate MindGraph governance ` +
          `(HTTP ${response.status}). Use a user-scoped API key, or set ` +
          `MINDGRAPH_GOVERNANCE=off to run this adapter ungoverned.`,
      };
    }
    return {
      allowed: false,
      message: `MindGraph governance check failed (${response.status})`,
    };
  }
  capability = "supported";
  unsupportedLogged = false;

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
