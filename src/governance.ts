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

export type ToolMutability = "read" | "write";

const PLAN_READ_ACTIONS = new Set([
  "get_plan",
  "get_executions",
  "get_pending",
  "get_assessments",
  "resume_work",
]);
const ONTOLOGY_READ_ACTIONS = new Set([
  "list_schemas",
  "get_schema",
  "query",
  "search_objects",
  "list_objects",
  "get_object",
  "get_context",
  "list_proposals",
  "get_proposal",
]);

/** Conservative action-aware mutability for governance checks. */
export function toolMutability(
  toolName: string,
  action: string | undefined,
): ToolMutability {
  if (toolName === "mindgraph_retrieve") return "read";
  if (toolName === "mindgraph_plan") {
    return action && PLAN_READ_ACTIONS.has(action) ? "read" : "write";
  }
  if (toolName === "mindgraph_ingest") {
    return action === "job_status" ? "read" : "write";
  }
  if (toolName === "mindgraph_synthesize") {
    return action === "signals" ? "read" : "write";
  }
  if (toolName === "mindgraph_code") {
    return action === "anchor" ? "write" : "read";
  }
  if (toolName === "mindgraph_sync") {
    return action === "scan" || action === "status" ? "read" : "write";
  }
  if (toolName === "mindgraph_ontology") {
    return action && ONTOLOGY_READ_ACTIONS.has(action) ? "read" : "write";
  }
  // Generated ontology tools are reads, but their names are deployment-defined.
  // They carry one of these stable read suffixes from the manifest generator.
  if (
    /_(search|get|context|related|query)$/.test(toolName)
    && toolName !== "mindgraph_capture"
  ) {
    return "read";
  }
  return "write";
}

const UID_FIELDS = [
  "uid",
  "source_uid",
  "session_uid",
  "work_uid",
  "goal_uid",
  "project_uid",
  "task_uid",
  "plan_uid",
  "step_uid",
  "target_uid",
  "execution_uid",
  "executor_uid",
  "affordance_uid",
  "produces_node_uid",
  "filter_plan_uid",
  "parent_uid",
  "decision_uid",
  "chosen_option_uid",
  "governed_uid",
  "approval_uid",
  "requires_plan_uid",
  "start_uid",
  "end_uid",
] as const;
const UID_ARRAY_FIELDS = [
  "related_uids",
  "depends_on_uids",
  "summarizes_uids",
  "informs_uid",
  "target_uids",
  "anchor_uids",
  "scope_uids",
  "produces_node_uids",
] as const;

export function governanceTarget(
  toolName: string,
  args: Record<string, unknown>,
): {
  tool_name: string;
  action?: string;
  mutability: ToolMutability;
  target_uids: string[];
} {
  const action = typeof args.action === "string" ? args.action : undefined;
  const targetUids = new Set<string>();
  for (const field of UID_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.length > 0) targetUids.add(value);
  }
  for (const field of UID_ARRAY_FIELDS) {
    const value = args[field];
    if (!Array.isArray(value)) continue;
    for (const uid of value) {
      if (typeof uid === "string" && uid.length > 0) targetUids.add(uid);
    }
  }
  return {
    tool_name: toolName,
    ...(action ? { action } : {}),
    mutability: toolMutability(toolName, action),
    target_uids: [...targetUids],
  };
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
            target: governanceTarget(toolName, args),
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
