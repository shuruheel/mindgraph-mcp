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
  "/agent/plan": [
    "create_task",
    "create_plan",
    "add_step",
    "update_status",
    "get_plan",
  ],
  "/agent/governance": [
    "create_policy",
    "set_budget",
    "request_approval",
    "resolve_approval",
    "get_pending",
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
