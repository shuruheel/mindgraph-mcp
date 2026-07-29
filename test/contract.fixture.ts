// Canonical contract fixture — the authoritative restatement of the
// "Cognitive Endpoint Actions" table + "SDK-Server Field Name Conventions"
// from /Users/shuruheel/Code/mindgraph/CLAUDE.md (R6-verified to match the
// server). The MCP server's tool schemas + dispatch are diffed against this so
// drift between the hand-maintained JSON Schemas and the canonical contract
// fails CI.
//
// This file contains NO behavior — it is data. When the server's action set
// legitimately changes, update this fixture and the CLAUDE.md table together.

/**
 * The exact, exhaustive set of valid `/retrieve` actions per CLAUDE.md.
 * Drift-prone: the TS SDK's RetrieveRequest.action type historically omits
 * `merge_candidates` and `curation_counts` (R4 divergence #3).
 */
export const RETRIEVE_ACTIONS = [
  "text",
  "semantic",
  "hybrid",
  "active_goals",
  "open_questions",
  "weak_claims",
  "pending_approvals",
  "unresolved_contradictions",
  "merge_candidates",
  "curation_counts",
  "stale_derivations",
  "preferences",
  "layer",
  "recent",
] as const;

/**
 * Valid actions for every action-dispatch cognitive endpoint, per the CLAUDE.md
 * "Cognitive Endpoint Actions (exhaustive)" table.
 * `/epistemic/argument` and `/memory/distill` are intentionally absent: they are
 * monolithic (no action field).
 */
export const ENDPOINT_ACTIONS: Record<string, readonly string[]> = {
  "/reality/capture": ["source", "snippet", "observation"],
  "/reality/entity": ["create", "alias", "resolve", "fuzzy_resolve", "merge", "relate"],
  "/epistemic/inquiry": [
    "hypothesis",
    "theory",
    "paradigm",
    "anomaly",
    "assumption",
    "question",
    "open_question",
  ],
  "/epistemic/structure": [
    "concept",
    "pattern",
    "mechanism",
    "model",
    "model_evaluation",
    "analogy",
    "inference_chain",
    "reasoning_strategy",
    "sensitivity_analysis",
    "theorem",
    "equation",
    "method",
    "experiment",
  ],
  "/intent/commitment": ["goal", "project", "milestone"],
  "/intent/deliberation": [
    "open_decision",
    "add_option",
    "add_constraint",
    "resolve",
    "get_open",
  ],
  "/action/procedure": ["create_flow", "add_step", "add_affordance", "add_control"],
  "/action/risk": ["assess", "get_assessments"],
  "/memory/session": ["open", "trace", "close", "journal"],
  "/memory/config": [
    "set_preference",
    "get_preferences",
    "set_policy",
    "get_policies",
  ],
  "/memory/sync": ["scan", "begin", "record", "finalize", "status", "abandon"],
  "/agent/plan": [
    "create_task",
    "create_plan",
    "add_step",
    "update_status",
    "get_plan",
    "resume_work",
    "claim_task",
    "heartbeat",
    "start_iteration",
    "checkpoint_iteration",
    "block_task",
    "complete_task",
    "abandon_iteration",
  ],
  "/agent/governance": [
    "create_policy",
    "set_budget",
    "request_approval",
    "resolve_approval",
    "get_pending",
    "check",
  ],
  "/agent/execution": [
    "start",
    "complete",
    "fail",
    "register_agent",
    "get_executions",
  ],
  "/retrieve": [...RETRIEVE_ACTIONS],
  "/traverse": ["chain", "neighborhood", "path", "subgraph"],
  "/evolve": [
    "update",
    "tombstone",
    "restore",
    "decay",
    "history",
    "snapshot",
    "tombstone_edge",
    "restore_edge",
    "tombstone_cascade",
  ],
};

/**
 * Monolithic endpoints — no `action` field, structured request body instead.
 */
export const MONOLITHIC_ENDPOINTS = ["/epistemic/argument", "/memory/distill"] as const;

/**
 * Field-name conventions enforced by the server (CLAUDE.md "SDK-Server Field
 * Name Conventions"). The MCP retrieve/traverse tool must use these names.
 */
export const FIELD_NAME_CONVENTIONS = {
  // Traverse start/end use start_uid / end_uid, never uid / from_uid / to_uid.
  traverseStart: "start_uid",
  traverseEnd: "end_uid",
  traverseForbidden: ["uid", "from_uid", "to_uid"],
} as const;

export interface WorkActionContractEntry {
  toolAction: string;
  endpoint: keyof typeof ENDPOINT_ACTIONS;
  serverAction: string;
  clientMethod: "plan" | "execution" | "governance" | "procedure" | "risk";
  mutability: "read" | "write";
  schemaFields: readonly string[];
}

/**
 * Mechanical schema-to-server contract for every `mindgraph_plan` action.
 *
 * `toolAction` is the ergonomic MCP action, `serverAction` is the exact REST
 * action passed to the SDK, and `schemaFields` are the complete action-specific
 * fields that the MCP schema must advertise. Keeping this as data makes a new
 * MCP action, a missing server action, or a silently dropped field fail CI.
 */
export const WORK_ACTION_CONTRACT: readonly WorkActionContractEntry[] = [
  {
    toolAction: "create_task",
    endpoint: "/agent/plan",
    serverAction: "create_task",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "label", "summary", "confidence", "salience", "goal_uid",
      "related_uids", "props", "agent_id",
    ],
  },
  {
    toolAction: "create_plan",
    endpoint: "/agent/plan",
    serverAction: "create_plan",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "label", "summary", "confidence", "salience", "goal_uid", "task_uid",
      "related_uids", "props", "agent_id",
    ],
  },
  {
    toolAction: "add_step",
    endpoint: "/agent/plan",
    serverAction: "add_step",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "label", "summary", "confidence", "salience", "plan_uid",
      "depends_on_uids", "props", "agent_id",
    ],
  },
  {
    toolAction: "update_status",
    endpoint: "/agent/plan",
    serverAction: "update_status",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: ["target_uid", "status", "agent_id"],
  },
  {
    toolAction: "get_plan",
    endpoint: "/agent/plan",
    serverAction: "get_plan",
    clientMethod: "plan",
    mutability: "read",
    schemaFields: ["plan_uid", "agent_id"],
  },
  {
    toolAction: "resume_work",
    endpoint: "/agent/plan",
    serverAction: "resume_work",
    clientMethod: "plan",
    mutability: "read",
    schemaFields: ["task_uid", "scope_uids", "session_uid", "limit", "agent_id"],
  },
  {
    toolAction: "claim_task",
    endpoint: "/agent/plan",
    serverAction: "claim_task",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "task_uid", "session_uid", "expected_version", "idempotency_key",
      "lease_ttl_secs", "allow_takeover", "summary", "agent_id",
    ],
  },
  {
    toolAction: "heartbeat",
    endpoint: "/agent/plan",
    serverAction: "heartbeat",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "task_uid", "session_uid", "expected_version", "lease_epoch",
      "idempotency_key", "lease_ttl_secs", "agent_id",
    ],
  },
  {
    toolAction: "start_iteration",
    endpoint: "/agent/plan",
    serverAction: "start_iteration",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "task_uid", "plan_uid", "step_uid", "session_uid", "expected_version",
      "lease_epoch", "idempotency_key", "lease_ttl_secs", "label", "summary",
      "input_snapshot", "props", "code_refs", "agent_id",
    ],
  },
  {
    toolAction: "checkpoint_iteration",
    endpoint: "/agent/plan",
    serverAction: "checkpoint_iteration",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "task_uid", "step_uid", "execution_uid", "session_uid", "expected_version",
      "lease_epoch", "idempotency_key", "lease_ttl_secs", "task_status",
      "step_status", "execution_status", "output_snapshot", "side_effects",
      "outcome", "error", "next_action", "checkpoint_summary", "test_summary",
      "produces_node_uids", "release_lease", "code_refs", "agent_id",
    ],
  },
  {
    toolAction: "block_task",
    endpoint: "/agent/plan",
    serverAction: "block_task",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "task_uid", "step_uid", "session_uid", "expected_version", "lease_epoch",
      "idempotency_key", "release_lease", "summary", "error", "agent_id",
    ],
  },
  {
    toolAction: "complete_task",
    endpoint: "/agent/plan",
    serverAction: "complete_task",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "task_uid", "step_uid", "execution_uid", "session_uid", "expected_version",
      "lease_epoch", "idempotency_key", "override_reason", "summary", "outcome",
      "agent_id",
    ],
  },
  {
    toolAction: "abandon_iteration",
    endpoint: "/agent/plan",
    serverAction: "abandon_iteration",
    clientMethod: "plan",
    mutability: "write",
    schemaFields: [
      "task_uid", "execution_uid", "session_uid", "expected_version",
      "lease_epoch", "idempotency_key", "release_lease", "task_status",
      "summary", "error", "next_action", "checkpoint_summary", "agent_id",
    ],
  },
  {
    toolAction: "start_execution",
    endpoint: "/agent/execution",
    serverAction: "start",
    clientMethod: "execution",
    mutability: "write",
    schemaFields: [
      "label", "summary", "confidence", "salience", "plan_uid",
      "executor_uid", "affordance_uid", "related_uids", "input_snapshot",
      "props", "agent_id",
    ],
  },
  {
    toolAction: "complete_execution",
    endpoint: "/agent/execution",
    serverAction: "complete",
    clientMethod: "execution",
    mutability: "write",
    schemaFields: [
      "execution_uid", "produces_node_uid", "output_snapshot", "side_effects",
      "outcome", "props", "agent_id",
    ],
  },
  {
    toolAction: "fail_execution",
    endpoint: "/agent/execution",
    serverAction: "fail",
    clientMethod: "execution",
    mutability: "write",
    schemaFields: [
      "execution_uid", "output_snapshot", "side_effects", "outcome", "error",
      "props", "agent_id",
    ],
  },
  {
    toolAction: "register_agent",
    endpoint: "/agent/execution",
    serverAction: "register_agent",
    clientMethod: "execution",
    mutability: "write",
    schemaFields: [
      "label", "summary", "confidence", "salience", "props", "agent_id",
    ],
  },
  {
    toolAction: "get_executions",
    endpoint: "/agent/execution",
    serverAction: "get_executions",
    clientMethod: "execution",
    mutability: "read",
    schemaFields: ["filter_plan_uid", "agent_id"],
  },
  {
    toolAction: "get_pending",
    endpoint: "/agent/governance",
    serverAction: "get_pending",
    clientMethod: "governance",
    mutability: "read",
    schemaFields: ["agent_id"],
  },
  {
    toolAction: "create_flow",
    endpoint: "/action/procedure",
    serverAction: "create_flow",
    clientMethod: "procedure",
    mutability: "write",
    schemaFields: ["label", "summary", "target_uid", "props", "agent_id"],
  },
  {
    toolAction: "add_procedure_step",
    endpoint: "/action/procedure",
    serverAction: "add_step",
    clientMethod: "procedure",
    mutability: "write",
    schemaFields: ["label", "summary", "target_uid", "props", "agent_id"],
  },
  {
    toolAction: "add_affordance",
    endpoint: "/action/procedure",
    serverAction: "add_affordance",
    clientMethod: "procedure",
    mutability: "write",
    schemaFields: ["label", "summary", "target_uid", "props", "agent_id"],
  },
  {
    toolAction: "add_control",
    endpoint: "/action/procedure",
    serverAction: "add_control",
    clientMethod: "procedure",
    mutability: "write",
    schemaFields: ["label", "summary", "target_uid", "props", "agent_id"],
  },
  {
    toolAction: "assess_risk",
    endpoint: "/action/risk",
    serverAction: "assess",
    clientMethod: "risk",
    mutability: "write",
    schemaFields: ["label", "summary", "target_uid", "props", "agent_id"],
  },
  {
    toolAction: "get_assessments",
    endpoint: "/action/risk",
    serverAction: "get_assessments",
    clientMethod: "risk",
    mutability: "read",
    schemaFields: ["target_uid", "agent_id"],
  },
] as const;

export const LESSON_CAPTURE_CONTRACT = {
  endpoint: "/memory/distill",
  serverAction: null,
  schemaFields: [
    "label",
    "summary",
    "confidence",
    "salience",
    "session_uid",
    "summarizes_uids",
    "props",
    "agent_id",
  ],
} as const;
