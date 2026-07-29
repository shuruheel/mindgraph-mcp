import { MindGraph } from "mindgraph";
import { errorDetail } from "./error-detail.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CODE_TOOL,
  attachCodeRefsToToolResult,
  handleCodeTool,
} from "./code-tool.js";
import { handleSyncTool, SYNC_TOOL } from "./sync-tool.js";

// ── Tool Definitions ──────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: "mindgraph_capture",
    description:
      "Capture knowledge into the graph. Use 'entity' for people/orgs/places/events/nations/concepts (auto-deduplicates — safe to call even if already exists), 'observation' for factual statements, 'source' for documents/URLs, 'snippet' for quotes from a source, and 'concept' for abstract ideas. Use 'journal' for quick personal notes and 'lesson' for a durable learning attributable to a session or source nodes. Prefer 'entity'/'observation' for objective facts, 'journal' for informal notes, and 'lesson' only for reusable knowledge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "entity",
            "observation",
            "source",
            "snippet",
            "concept",
            "journal",
            "lesson",
          ],
          description: "Type of knowledge to capture",
        },
        label: {
          type: "string",
          description: "Name, title, or brief heading",
        },
        summary: {
          type: "string",
          description: "Description or summary text (for entity/observation/source/snippet/concept)",
        },
        content: {
          type: "string",
          description: "Journal content/body text (for action=journal)",
        },
        session_uid: {
          type: "string",
          description: "Session UID that produced a lesson (for action=lesson)",
        },
        work_uid: {
          type: "string",
          description: "Durable Task/work UID this capture is relevant to",
        },
        execution_uid: {
          type: "string",
          description: "Material Execution that produced the lesson",
        },
        idempotency_key: {
          type: "string",
          description: "Stable retry key for an intentional capture",
        },
        supersedes_uid: {
          type: "string",
          description: "Earlier capture corrected or superseded by this one",
        },
        summarizes_uids: {
          type: "array",
          items: { type: "string" },
          description:
            "Source node UIDs the lesson was learned from (for action=lesson)",
        },
        entity_type: {
          type: "string",
          enum: ["person", "organization", "place", "event", "nation", "concept"],
          description: "Entity subtype (only for action=entity)",
        },
        source_uid: {
          type: "string",
          description: "Source node UID (for snippets)",
        },
        mood: {
          type: "string",
          description: "Emotional tone or mood tag (for action=journal)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Categorization tags (for action=journal)",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confidence score (0-1)",
        },
        salience: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Importance/salience score (0-1)",
        },
        props: {
          type: "object",
          description: "Type-specific properties (e.g. birth_date for person, coordinates for place)",
        },
        code_refs: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  repo: { type: "string" },
                  path: { type: "string" },
                  line: { type: "integer", minimum: 1 },
                  symbol: { type: "string" },
                  kind: { type: "string" },
                  language: { type: "string" },
                  signature: { type: "string" },
                },
              },
            ],
          },
          description: "Typed code targets to anchor and attach to the captured node",
        },
        repo: { type: "string", description: "Configured repository id or root" },
        repo_space_uid: {
          type: "string",
          description: "Writable shared repository/Project Space for new code anchors",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["action", "label"],
    },
  },
  {
    name: "mindgraph_reason",
    description:
      "Record reasoning, claims, and open questions. Use 'claim' when the user states something as true/false with reasoning — creates interconnected Claim + Evidence + Warrant nodes. Set confidence by evidence: 0.9+ for well-sourced, 0.5-0.8 for plausible, <0.5 for speculation. Use 'open_question' for questions worth tracking, 'hypothesis' for testable predictions, 'theory' for explanatory frameworks, 'anomaly' for things that don't fit, 'assumption' for unstated beliefs. Prefer 'claim' when evidence exists, other actions when it doesn't yet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "claim",
            "question",
            "open_question",
            "hypothesis",
            "theory",
            "paradigm",
            "anomaly",
            "assumption",
          ],
          description: "Type of reasoning to record",
        },
        label: {
          type: "string",
          description: "The claim, question, or hypothesis statement (used for non-claim actions, or as fallback for claim if claim object omitted)",
        },
        summary: {
          type: "string",
          description: "Expanded description or context (for non-claim actions)",
        },
        claim: {
          type: "object",
          properties: {
            label: { type: "string", description: "Claim statement" },
            content: { type: "string", description: "Detailed claim content" },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "How likely this claim is true (0-1)",
            },
          },
          required: ["label"],
          description: "The central claim being argued (for action=claim)",
        },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["label"],
          },
          description: "Supporting evidence items (for action=claim)",
        },
        warrant: {
          type: "object",
          properties: {
            label: { type: "string" },
            content: { type: "string" },
          },
          description: "Logical warrant connecting evidence to claim (for action=claim)",
        },
        argument: {
          type: "object",
          properties: {
            label: { type: "string" },
          },
          description: "Top-level argument container (for action=claim)",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confidence level (for non-claim actions)",
        },
        salience: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Importance score (for non-claim actions)",
        },
        props: {
          type: "object",
          description: "Type-specific properties",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "mindgraph_commit",
    description:
      "Track goals, projects, milestones, and decisions. Use 'goal' for desired outcomes ('I want to learn Rust'), 'project' for organized efforts, 'milestone' for checkpoints. Link milestones to projects and projects to goals via parent_uid. Use 'open_decision' when facing a choice ('Postgres vs SQLite?'), 'add_option'/'add_constraint' to build out alternatives, 'resolve_decision' to pick one, 'get_open_decisions' to review pending choices.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "goal",
            "project",
            "milestone",
            "open_decision",
            "add_option",
            "add_constraint",
            "resolve_decision",
            "get_open_decisions",
          ],
          description: "Commitment or decision action",
        },
        label: {
          type: "string",
          description: "Name of the goal, project, milestone, decision, option, or constraint",
        },
        summary: {
          type: "string",
          description: "Description, success criteria, or rationale",
        },
        parent_uid: {
          type: "string",
          description: "Parent goal/project UID to link under (for goal/project/milestone)",
        },
        decision_uid: {
          type: "string",
          description: "Decision UID (for add_option, add_constraint, resolve_decision)",
        },
        chosen_option_uid: {
          type: "string",
          description: "UID of the chosen option (for resolve_decision)",
        },
        informs_uid: {
          type: "array",
          items: { type: "string" },
          description: "Decision-time context UIDs to link with dated INFORMS edges",
        },
        as_of_date: {
          type: "string",
          description: "ISO 8601 date when the decision context was available",
        },
        session_id: {
          type: "string",
          description: "Session whose retrieval context informed the decision",
        },
        retrieval_trace_id: {
          type: "string",
          description: "Identifier of the decision-time retrieval trace",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        salience: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        props: {
          type: "object",
          description: "Type-specific properties (e.g. status, priority, deadline, horizon for goals)",
        },
        code_refs: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "object" }] },
          description: "Typed code targets to anchor and attach to the created commitment",
        },
        repo: { type: "string", description: "Configured repository id or root" },
        repo_space_uid: {
          type: "string",
          description: "Writable shared repository/Project Space for new code anchors",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "mindgraph_plan",
    description:
      "Authoritative durable engineering work and execution evidence. Use create_task/create_plan/add_step for work that must survive sessions; resume_work for the deterministic bounded brief; claim_task + heartbeat for the fenced lease; and start_iteration/checkpoint_iteration/block_task/complete_task/abandon_iteration for idempotent material attempts. Every composite write needs task version, Session, lease epoch, and an idempotency key. Use the harness-native todo list only for local coordination; never maintain the same authoritative Task in both systems.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
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
            "start_execution",
            "complete_execution",
            "fail_execution",
            "register_agent",
            "get_executions",
            // C33: governance WRITES are deliberately not exposed here.
            // `create_policy` let a model author the rules it is judged by;
            // `request_approval` + `resolve_approval` let it raise and then
            // clear its own gate, which defeats the human-in-the-loop control
            // entirely. Authoring and resolving happen in the dashboard, by a
            // person. `get_pending` stays — reading the queue is safe and is
            // what an agent needs in order to wait correctly.
            "get_pending",
            "create_flow",
            "add_procedure_step",
            "add_affordance",
            "add_control",
            "assess_risk",
            "get_assessments",
          ],
          description: "Planning, procedure, or governance action",
        },
        label: {
          type: "string",
          description: "Task, plan, step, flow, policy, or risk label",
        },
        summary: {
          type: "string",
          description: "Description",
        },
        plan_uid: {
          type: "string",
          description: "Plan UID (for create_plan execution link, add_step, get_plan)",
        },
        task_uid: {
          type: "string",
          description: "Task UID (for create_plan and graph-managed work actions)",
        },
        step_uid: {
          type: "string",
          description: "PlanStep UID for an iteration/checkpoint",
        },
        session_uid: {
          type: "string",
          description: "Durable Session UID that owns the task lease",
        },
        goal_uid: {
          type: "string",
          description: "Goal UID targeted by a task or plan",
        },
        target_uid: {
          type: "string",
          description:
            "Task/plan/step UID for update_status, or parent/target node for procedure and risk actions",
        },
        execution_uid: {
          type: "string",
          description: "Execution UID (required for complete_execution/fail_execution)",
        },
        executor_uid: {
          type: "string",
          description: "Agent node UID that executed the work",
        },
        affordance_uid: {
          type: "string",
          description: "Affordance invoked by start_execution",
        },
        produces_node_uid: {
          type: "string",
          description: "Node produced by a completed execution",
        },
        filter_plan_uid: {
          type: "string",
          description: "Restrict get_executions to one plan",
        },
        depends_on_uids: {
          type: "array",
          items: { type: "string" },
          description: "Plan-step UIDs that an added step depends on",
        },
        related_uids: {
          type: "array",
          items: { type: "string" },
          description: "Target node UIDs to link to created work or an execution",
        },
        status: {
          type: "string",
          description: "New status value (for update_status)",
        },
        task_status: {
          type: "string",
          description: "Task status requested by a checkpoint or abandon action",
        },
        step_status: {
          type: "string",
          description: "PlanStep status requested by a checkpoint",
        },
        execution_status: {
          type: "string",
          enum: ["completed", "failed", "abandoned"],
          description: "Terminal Execution status for checkpoint_iteration",
        },
        expected_version: {
          type: "number",
          description: "Current Task node version used as the optimistic fence",
        },
        lease_epoch: {
          type: "number",
          description: "Current monotonic task-lease epoch",
        },
        lease_ttl_secs: {
          type: "number",
          minimum: 1,
          description: "Requested server-time lease lifetime (default 300s)",
        },
        idempotency_key: {
          type: "string",
          description: "Caller-stable key required for every composite work mutation",
        },
        allow_takeover: {
          type: "boolean",
          description: "Governed claim override for a live lease owned by another agent",
        },
        release_lease: {
          type: "boolean",
          description: "Explicitly release or retain the lease after block/abandon/checkpoint",
        },
        override_reason: {
          type: "string",
          description: "Explicit completion reason when no terminal Execution evidence exists",
        },
        scope_uids: {
          type: "array",
          items: { type: "string" },
          description: "Ordinary target UIDs that bound deterministic resume selection",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 1,
          description: "Resume returns one authoritative Task",
        },
        input_snapshot: {
          type: "object",
          description: "Structured inputs captured when an execution starts",
        },
        output_snapshot: {
          type: "object",
          description: "Structured outputs captured when an execution completes or fails",
        },
        outcome: {
          type: "string",
          description: "Execution outcome",
        },
        error: {
          type: "string",
          description: "Execution error detail (for fail_execution)",
        },
        side_effects: {
          type: "array",
          items: { type: "string" },
          description: "Observable side effects of the execution",
        },
        next_action: {
          type: "string",
          description: "Recommended next action retained on terminal Execution evidence",
        },
        checkpoint_summary: {
          type: "string",
          description: "Bounded material-attempt checkpoint summary",
        },
        test_summary: {
          type: "string",
          description: "Test commands/results retained on the Execution",
        },
        produces_node_uids: {
          type: "array",
          items: { type: "string" },
          description: "Nodes produced by checkpoint_iteration",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        salience: {
          type: "number",
          minimum: 0,
          maximum: 1,
        },
        props: {
          type: "object",
          description: "Additional properties (e.g. likelihood, impact, mitigation for risks)",
        },
        code_refs: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "object" }] },
          description: "Typed code targets to anchor and attach to created work or execution",
        },
        repo: { type: "string", description: "Configured repository id or root" },
        repo_space_uid: {
          type: "string",
          description: "Writable shared repository/Project Space for new code anchors",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["action"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "mindgraph_retrieve",
    description:
      "Search and explore the knowledge graph. NOT for work state: for 'what was I working on' or resuming work, use mindgraph_plan action resume_work (structural, deterministic) — this tool is semantic/keyword recall over ALL knowledge. Use 'context' (default) for BM25 keyword retrieval plus bounded cheapest-first graph expansion — returns graph nodes only by default (labels, summaries, types, confidence); set include_chunks=true to also get full source text. Pass 1-3 discriminating keywords, not sentences. GOOD: 'Kissinger NATO'. BAD: 'What is Kissinger\\'s view on NATO?'. Use 'document_index' to list all ingested documents (titles, dates, UIDs) for orientation. Use 'semantic' when keywords return nothing — conceptual/fuzzy queries. Use 'hybrid' for keyword + semantic. Use 'text' for fast keyword-only. Use 'neighborhood'/'chain'/'path'/'subgraph' for graph traversal — traversal steps carry the cheapest witness path_cost (lower = stronger connection; sum of -ln(edge weight)), path_confidence, and witness depth. Use 'preferences' for advice or recommendation requests ('suggest a hotel', 'what should I read?') — it returns the user's stated/learned preferences relevant to the query (pass the topic as 'query'), so your answer reflects what they actually like instead of being generic. Other structured actions ('active_goals', 'open_questions', etc.) only when the user explicitly asks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "text",
            "context",
            "semantic",
            "hybrid",
            "active_goals",
            "open_questions",
            "weak_claims",
            "pending_approvals",
            "unresolved_contradictions",
            "stale_derivations",
            "preferences",
            "layer",
            "recent",
            "chain",
            "neighborhood",
            "path",
            "subgraph",
            "document_index",
          ],
          description: "Retrieval or traversal strategy",
        },
        query: {
          type: "string",
          description:
            "Search query — for 'text'/'context': 1-3 BM25 keywords, drop filler words. For 'semantic'/'hybrid': natural language is OK since it uses vector similarity.",
        },
        start_uid: {
          type: "string",
          description: "Starting node UID (for chain, neighborhood, path, subgraph)",
        },
        end_uid: {
          type: "string",
          description: "Target node UID (for path)",
        },
        max_depth: {
          type: "number",
          description: "Maximum traversal depth (for chain, neighborhood, path, subgraph)",
        },
        direction: {
          type: "string",
          enum: ["outgoing", "incoming", "both"],
          description: "Traversal direction (for neighborhood, subgraph)",
        },
        edge_types: {
          type: "array",
          items: { type: "string" },
          description: "Filter by edge types (for traversal actions)",
        },
        exclude_edge_types: {
          type: "array",
          items: { type: "string" },
          description: "Denylist edge types (for traversal actions)",
        },
        include_provenance: {
          type: "boolean",
          description: "Include ingestion/provenance edges in traversal (default false)",
        },
        max_nodes: {
          type: "number",
          description: "Global distinct-node traversal budget, including the seed (default 500)",
        },
        node_types: {
          type: "array",
          items: { type: "string" },
          description: "Filter by node types (e.g. ['Claim', 'Entity', 'Observation'])",
        },
        layer: {
          type: "string",
          enum: ["reality", "epistemic", "intent", "action", "memory", "agent"],
          description: "Filter by cognitive layer",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 27)",
        },
        offset: {
          type: "number",
          description: "Pagination offset (for stale_derivations)",
        },
        include_documents: {
          type: "boolean",
          description:
            "Include ingested documents and wiki articles in context results. The coding profile defaults these OFF so engineering questions aren't answered from unrelated ingested content; pass true when the question is about a document, spec, or article.",
        },
        include_chunks: {
          type: "boolean",
          description: "Include source document chunks in context results (default: false — set true to fetch full chunk text for citations or deep reading)",
        },
        include_graph: {
          type: "boolean",
          description: "Include graph nodes in context results (default: true)",
        },
        graph_expansion_limit: {
          type: "number",
          description: "Context-only graph expansion slots (default 3; set 0 for direct-only retrieval)",
        },
        graph_max_depth: {
          type: "number",
          description: "Context-only graph expansion hop limit (default 2)",
        },
        confidence_min: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Minimum confidence filter (for recent action)",
        },
        salience_min: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Minimum salience filter (for recent action)",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "mindgraph_ingest",
    description:
      "Ingest long-form content (articles, transcripts, documents, meeting notes) into the knowledge graph. The pipeline automatically chunks the text, extracts entities/claims/relationships via LLM, and deduplicates against existing nodes. Use 'chunk' for a single passage (synchronous), 'document' for full documents (async — returns a job ID), 'session' for conversation transcripts. Use 'job_status' to check progress. For short individual facts, use the specific cognitive tools instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["chunk", "document", "session", "job_status"],
          description: "Ingestion action",
        },
        content: {
          type: "string",
          description: "Text content to ingest (for chunk/document/session)",
        },
        title: {
          type: "string",
          description: "Document or session title",
        },
        source_uri: {
          type: "string",
          description: "Source URL or reference",
        },
        content_type: {
          type: "string",
          enum: ["article", "meeting_notes", "report", "journal", "transcript"],
          description:
            "Semantic type that drives default extraction layers. IMPORTANT: for conversation transcripts, use action 'session' OR content_type 'transcript' — otherwise Decisions, Options, and Constraints are NOT extracted.",
        },
        document_type: {
          type: "string",
          description: "Free-form document type label (e.g. 'note', 'spec').",
        },
        layers: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "reality",
              "epistemic",
              "intent",
              "action",
              "memory",
              "agent",
              "ontology",
            ],
          },
          description:
            "Cognitive layers to extract (defaults vary by action). 'ontology' is a targeting flag rather than a cognitive layer: include it only alongside ontology_schema_id, and list it alone to extract domain objects without any cognitive extraction.",
        },
        ontology_schema_id: {
          type: "string",
          description:
            "When set, run typed Layer-7 (domain-object) extraction against this schema in addition to the cognitive layers. This field alone drives domain-object extraction — listing 'ontology' in layers without it extracts nothing.",
        },
        participants: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              organization: { type: "string" },
              role: { type: "string" },
            },
            required: ["name"],
          },
          description:
            "Named conversation participants. Maps generic speaker labels ('Interviewer:') to real people so claims/demands attribute to the named person.",
        },
        occurred_at: {
          type: "string",
          description: "When the conversation/document occurred (ISO-8601).",
        },
        context: {
          type: "string",
          description: "Free-text context grounding attribution during extraction.",
        },
        document_uid: {
          type: "string",
          description:
            "chunk action: the parent Document uid, so this chunk joins that document's provenance chain.",
        },
        chunk_index: {
          type: "number",
          description: "chunk action: 0-based index of this chunk within its document.",
        },
        chunk_size: {
          type: "integer",
          minimum: 50,
          maximum: 32000,
          default: 2000,
          description:
            "Maximum tokens per chunk for document or session ingestion (default: 2000)",
        },
        chunk_overlap: {
          type: "number",
          minimum: 0,
          maximum: 0.9,
          default: 0.1,
          description:
            "Fractional overlap between adjacent chunks for document or session ingestion (default: 0.1; maximum: 0.9)",
        },
        job_id: {
          type: "string",
          description: "Job ID to check status (for job_status action)",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "mindgraph_synthesize",
    description:
      "Work with Projects — scoped document corpora — and run cross-document synthesis over them. Use 'signals' to mine structural signals (entity bridges, claim hubs, theory support gaps, concept clusters, analogy candidates, dialectical pairs) without any LLM calls; useful for orientation before a full synthesis. Use 'run' to spawn a background synthesis job that turns the top idea clusters into Article nodes linked via Covers edges. Both operate on a Project's corpus, where documents are linked to the Project via PartOfProject edges (create the project with mindgraph_commit action 'project', then link docs via the ingest flow or add_link). Use 'job_status' to poll a synthesis job.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["signals", "run", "job_status"],
          description: "Synthesis action",
        },
        project_uid: {
          type: "string",
          description: "UID of the Project node (required for signals/run)",
        },
        signals: {
          type: "string",
          description:
            "Comma-separated subset of signal names to compute, e.g. 'clustered_claim_hubs,dialectical_pairs'. If omitted, all signals run. (Only for action='signals'.)",
        },
        target_types: {
          type: "string",
          description:
            "Comma-separated node types used to filter entity_bridges and claim_hubs (e.g. 'Person,Organization,Theory'). (Only for action='signals'.)",
        },
        job_id: {
          type: "string",
          description: "Job ID to poll (for action='job_status')",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "mindgraph_ontology",
    description:
      "Work with the Operational Ontology (Layer 7) — workspace-specific domain objects typed by a user-approved schema (e.g. Client, Contract, Patient, Experiment). Use 'schemas'/'schema' to discover what object and relation types exist before anything else. Use 'query' for natural-language retrieval of typed objects with cognitive context (claims, decisions, risks about them) and source provenance; 'search' for hybrid search over objects; 'objects'/'object'/'object_context' to browse instances. Extraction proposes new objects/relations into a review queue rather than writing directly: use 'proposals'/'proposal' to inspect the queue, and 'approve'/'reject' ONLY when the user explicitly asks — proposal review is the human-in-the-loop boundary. Use 'link' to relate two existing objects, 'extract' to run schema-typed extraction over already-ingested sources.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "schemas",
            "schema",
            "query",
            "search",
            "objects",
            "object",
            "object_context",
            "proposals",
            "proposal",
            "approve",
            "reject",
            "link",
            "extract",
          ],
          description: "Ontology operation",
        },
        schema_id: {
          type: "string",
          description:
            "Ontology schema ID (required for query/objects/extract; optional filter for proposals). Get it from action='schemas'.",
        },
        query: {
          type: "string",
          description: "Natural-language query (for action=query) or search text (for action=search)",
        },
        object_types: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to these object type names, e.g. ['Client'] (for query/search)",
        },
        object_type: {
          type: "string",
          description: "Single object type name filter (for objects/proposals)",
        },
        uid: {
          type: "string",
          description: "Domain object UID (for object/object_context)",
        },
        depth: {
          type: "number",
          description: "Traversal depth for context (for query/object_context, default 1)",
        },
        include_cognitive_context: {
          type: "boolean",
          description: "Include linked cognitive nodes — claims, decisions, risks (for action=query, default true)",
        },
        include_sources: {
          type: "boolean",
          description: "Include source provenance entries (for action=query, default true)",
        },
        limit: {
          type: "number",
          description: "Max results (for query/search/objects/proposals)",
        },
        status: {
          type: "string",
          enum: ["pending", "approved", "approval_required", "rejected", "applied", "apply_failed"],
          description: "Review-status filter (for action=proposals, default 'pending')",
        },
        proposal_id: {
          type: "string",
          description: "Proposal ID (for proposal/approve/reject)",
        },
        feedback: {
          type: "string",
          description: "Reviewer feedback to record (for action=approve)",
        },
        reason: {
          type: "string",
          description: "Rejection reason (for action=reject)",
        },
        from_uid: {
          type: "string",
          description: "Source domain object UID (for action=link)",
        },
        to_uid: {
          type: "string",
          description: "Target domain object UID (for action=link)",
        },
        relation_type: {
          type: "string",
          description: "Relation type name from the schema (for action=link)",
        },
        fields: {
          type: "object",
          description: "Relation field values (for action=link)",
        },
        source_uids: {
          type: "array",
          items: { type: "string" },
          description: "Chunk/document UIDs to extract from (for action=extract)",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["action"],
    },
  },
  SYNC_TOOL,
  CODE_TOOL,
];

const INVOCATION_CONTEXT_SCHEMA = {
  type: "object",
  description:
    "Adapter-owned invocation context. Models should omit it; compatible hooks replace forged or absent values. cwd is consumed locally and never sent to the API.",
  properties: {
    harness: { type: "string", enum: ["claude-code", "codex", "generic"] },
    harnessSessionId: { type: "string" },
    harnessTurnId: { type: "string" },
    cwd: { type: "string" },
    repoId: { type: "string" },
    branch: { type: "string" },
    commit: { type: "string" },
    worktreeState: { type: "string", enum: ["clean", "dirty"] },
    model: { type: "string" },
    injectedBy: { type: "string", enum: ["hook", "mcp-process", "caller"] },
  },
};

for (const tool of TOOLS) {
  if (tool.name === "mindgraph_retrieve") continue;
  const schema = tool.inputSchema as {
    properties?: Record<string, unknown>;
  };
  if (schema.properties && !schema.properties.invocation_context) {
    schema.properties.invocation_context = INVOCATION_CONTEXT_SCHEMA;
  }
}

export function toolsForProfile(
  profile = process.env.MINDGRAPH_PROFILE || "general",
): Tool[] {
  if (profile === "coding") return TOOLS;
  return TOOLS.filter(
    (tool) => tool.name !== "mindgraph_code" && tool.name !== "mindgraph_sync",
  );
}

// ── Tool Handlers ─────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export async function handleTool(
  client: MindGraph,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    let result: ToolResult;
    switch (name) {
      case "mindgraph_capture":
        result = await handleCapture(client, args);
        break;
      case "mindgraph_reason":
        result = await handleReason(client, args);
        break;
      case "mindgraph_commit":
        result = await handleCommit(client, args);
        break;
      case "mindgraph_plan":
        result = await handlePlan(client, args);
        break;
      case "mindgraph_retrieve":
        result = await handleRetrieve(client, args);
        break;
      case "mindgraph_ingest":
        result = await handleIngest(client, args);
        break;
      case "mindgraph_synthesize":
        result = await handleSynthesize(client, args);
        break;
      case "mindgraph_ontology":
        result = await handleOntology(client, args);
        break;
      case "mindgraph_code":
        result = await handleCodeTool(client, args);
        break;
      case "mindgraph_sync":
        result = await handleSyncTool(client, args);
        break;
      default:
        result = err(`Unknown tool: ${name}`);
    }
    const action = typeof args.action === "string" ? args.action : "";
    const attach =
      name === "mindgraph_capture" ||
      (name === "mindgraph_commit" && action !== "get_open_decisions") ||
      (name === "mindgraph_plan" &&
        ![
          "get_plan",
          "get_executions",
          "get_pending",
          "get_assessments",
          "resume_work",
          "heartbeat",
        ].includes(action));
    return attach
      ? await attachCodeRefsToToolResult(client, result, args)
      : result;
  } catch (e: unknown) {
    // Propagate the server's typed error body (code, missing field, conflict
    // details) — the agent can only self-correct on errors it can see.
    return err(errorDetail(e));
  }
}

// ── Capture (+ Journal) ──────────────────────────────────────────────

async function handleCapture(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const {
    action,
    label,
    summary,
    content,
    session_uid,
    work_uid,
    execution_uid,
    idempotency_key,
    supersedes_uid,
    summarizes_uids,
    entity_type,
    source_uid,
    mood,
    tags,
    confidence,
    salience,
    props,
    agent_id,
  } = args as {
    action: string;
    label: string;
    summary?: string;
    content?: string;
    session_uid?: string;
    work_uid?: string;
    execution_uid?: string;
    idempotency_key?: string;
    supersedes_uid?: string;
    summarizes_uids?: string[];
    entity_type?: string;
    source_uid?: string;
    mood?: string;
    tags?: string[];
    confidence?: number;
    salience?: number;
    props?: Record<string, unknown>;
    agent_id?: string;
  };

  switch (action) {
    case "lesson":
      return ok(
        await client.distill({
          label,
          output_type: "lesson",
          summary,
          confidence,
          salience,
          session_uid,
          work_uid,
          execution_uid,
          idempotency_key,
          supersedes_uid,
          summarizes_uids,
          props,
          agent_id,
        } as any)
      );
    case "journal": {
      if (!content) return err("content is required for action=journal");
      const journalProps: Record<string, unknown> = { content };
      if (mood) journalProps.mood = mood;
      if (tags) journalProps.tags = tags;
      return ok(await client.journal(label, journalProps, { agent_id }));
    }
    case "entity": {
      const type = entity_type || "concept";
      const entityProps = { ...props };
      if (summary) entityProps.description = summary;

      switch (type) {
        case "person":
          return ok(await client.findOrCreatePerson(label, entityProps, agent_id));
        case "organization":
          return ok(await client.findOrCreateOrganization(label, entityProps, agent_id));
        case "nation":
          return ok(await client.findOrCreateNation(label, entityProps, agent_id));
        case "event":
          return ok(await client.findOrCreateEvent(label, entityProps, agent_id));
        case "place":
          return ok(await client.findOrCreatePlace(label, entityProps, agent_id));
        case "concept":
        default:
          return ok(await client.findOrCreateConcept(label, entityProps, agent_id));
      }
    }
    case "observation":
      return ok(
        await client.capture({
          action: "observation",
          label,
          summary,
          confidence,
          salience,
          props,
          agent_id,
        })
      );
    case "source":
      return ok(
        await client.capture({
          action: "source",
          label,
          summary,
          confidence,
          salience,
          props,
          agent_id,
        })
      );
    case "snippet":
      return ok(
        await client.capture({
          action: "snippet",
          label,
          summary,
          source_uid,
          confidence,
          salience,
          props,
          agent_id,
        } as any)
      );
    case "concept":
      return ok(
        await client.structure({
          action: "concept",
          label,
          summary,
          confidence,
          salience,
          props,
          agent_id,
        })
      );
    default:
      return err(`Unknown capture action: ${action}`);
  }
}

// ── Reason (Argue + Inquire) ─────────────────────────────────────────

async function handleReason(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const {
    action,
    label,
    summary,
    claim,
    evidence,
    warrant,
    argument,
    confidence,
    salience,
    props,
    agent_id,
  } = args as {
    action: string;
    label?: string;
    summary?: string;
    claim?: { label: string; content?: string; confidence?: number };
    evidence?: Array<{ label: string; description?: string }>;
    warrant?: { label: string; content?: string };
    argument?: { label: string };
    confidence?: number;
    salience?: number;
    props?: Record<string, unknown>;
    agent_id?: string;
  };

  if (action === "claim") {
    // Build claim object: prefer explicit claim, fall back to top-level label.
    // The server's ArgumentRequest carries prose in props ({label, confidence,
    // props}) — a top-level `content` key is silently dropped by serde, so
    // map the schema's content/description fields into props here (claims
    // landed with empty content in the 2026-07-29 live import).
    const claimObj = claim
      ? {
          label: claim.label,
          confidence: claim.confidence,
          ...(claim.content ? { props: { content: claim.content } } : {}),
        }
      : label
        ? { label, confidence }
        : null;
    if (!claimObj) return err("claim object or label is required for action=claim");
    return ok(
      await client.argue({
        claim: claimObj,
        evidence: evidence?.map((e) => ({
          label: e.label,
          ...(e.description ? { props: { description: e.description } } : {}),
        })),
        warrant: warrant
          ? {
              label: warrant.label,
              ...(warrant.content ? { props: { content: warrant.content } } : {}),
            }
          : undefined,
        argument,
        agent_id,
      } as any)
    );
  }

  // All other actions → inquire
  if (!label) return err(`label is required for action=${action}`);
  return ok(
    await client.inquire({
      action: action as any,
      label,
      summary,
      confidence,
      salience,
      props,
      agent_id,
    })
  );
}

// ── Commit (+ Decide) ────────────────────────────────────────────────

async function handleCommit(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const {
    action,
    label,
    summary,
    parent_uid,
    decision_uid,
    chosen_option_uid,
    informs_uid,
    as_of_date,
    session_id,
    retrieval_trace_id,
    confidence,
    salience,
    props,
    agent_id,
  } = args as {
    action: string;
    label?: string;
    summary?: string;
    parent_uid?: string;
    decision_uid?: string;
    chosen_option_uid?: string;
    informs_uid?: string[];
    as_of_date?: string;
    session_id?: string;
    retrieval_trace_id?: string;
    confidence?: number;
    salience?: number;
    props?: Record<string, unknown>;
    agent_id?: string;
  };

  switch (action) {
    case "goal":
    case "project":
    case "milestone":
      if (!label) return err(`label is required for action=${action}`);
      return ok(
        await client.commit({
          action: action as any,
          label,
          summary,
          parent_uid,
          confidence,
          salience,
          props,
          agent_id,
        } as any)
      );

    case "open_decision":
      if (!label) return err("label is required for open_decision");
      return ok(await client.openDecision(label, { summary, props, agent_id }));

    case "add_option":
      if (!decision_uid) return err("decision_uid is required for add_option");
      if (!label) return err("label is required for add_option");
      return ok(await client.addOption(decision_uid, label, { summary, props, agent_id }));

    case "add_constraint":
      if (!decision_uid) return err("decision_uid is required for add_constraint");
      return ok(
        await client.deliberate({
          action: "add_constraint",
          label,
          decision_uid,
          summary,
          props,
          agent_id,
        } as any)
      );

    case "resolve_decision":
      if (!decision_uid) return err("decision_uid is required for resolve_decision");
      if (!chosen_option_uid) return err("chosen_option_uid is required for resolve_decision");
      return ok(
        await client.resolveDecision(decision_uid, chosen_option_uid, {
          summary,
          props,
          informs_uid,
          as_of_date,
          session_id,
          retrieval_trace_id,
          agent_id,
        } as any)
      );

    case "get_open_decisions":
      return ok(await client.getOpenDecisions());

    default:
      return err(`Unknown commit action: ${action}`);
  }
}

// ── Plan (+ Action/Procedure/Risk) ───────────────────────────────────

async function handlePlan(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const {
    action,
    label,
    summary,
    plan_uid,
    task_uid,
    step_uid,
    session_uid,
    goal_uid,
    target_uid,
    execution_uid,
    executor_uid,
    affordance_uid,
    produces_node_uid,
    filter_plan_uid,
    depends_on_uids,
    related_uids,
    status,
    task_status,
    step_status,
    execution_status,
    expected_version,
    lease_epoch,
    lease_ttl_secs,
    idempotency_key,
    allow_takeover,
    release_lease,
    override_reason,
    scope_uids,
    limit,
    confidence,
    salience,
    input_snapshot,
    output_snapshot,
    side_effects,
    outcome,
    error,
    next_action,
    checkpoint_summary,
    test_summary,
    produces_node_uids,
    props,
    agent_id,
  } = args as {
    action: string;
    label?: string;
    summary?: string;
    plan_uid?: string;
    task_uid?: string;
    step_uid?: string;
    session_uid?: string;
    goal_uid?: string;
    target_uid?: string;
    execution_uid?: string;
    executor_uid?: string;
    affordance_uid?: string;
    produces_node_uid?: string;
    filter_plan_uid?: string;
    depends_on_uids?: string[];
    related_uids?: string[];
    status?: string;
    task_status?: string;
    step_status?: string;
    execution_status?: string;
    expected_version?: number;
    lease_epoch?: number;
    lease_ttl_secs?: number;
    idempotency_key?: string;
    allow_takeover?: boolean;
    release_lease?: boolean;
    override_reason?: string;
    scope_uids?: string[];
    limit?: number;
    confidence?: number;
    salience?: number;
    input_snapshot?: Record<string, unknown>;
    output_snapshot?: Record<string, unknown>;
    side_effects?: string[];
    outcome?: string;
    error?: string;
    next_action?: string;
    checkpoint_summary?: string;
    test_summary?: string;
    produces_node_uids?: string[];
    props?: Record<string, unknown>;
    agent_id?: string;
  };

  switch (action) {
    // Agent planning
    case "create_task":
    case "create_plan":
    case "add_step":
    case "update_status":
    case "get_plan":
    case "resume_work":
    case "claim_task":
    case "heartbeat":
    case "start_iteration":
    case "checkpoint_iteration":
    case "block_task":
    case "complete_task":
    case "abandon_iteration":
      return ok(
        await client.plan({
          action: action as any,
          label,
          summary,
          confidence,
          salience,
          goal_uid,
          plan_uid,
          task_uid,
          step_uid,
          session_uid,
          target_uid,
          depends_on_uids,
          related_uids,
          status,
          task_status,
          step_status,
          execution_status,
          execution_uid,
          expected_version,
          lease_epoch,
          lease_ttl_secs,
          idempotency_key,
          allow_takeover,
          release_lease,
          override_reason,
          scope_uids,
          limit,
          input_snapshot,
          output_snapshot,
          side_effects,
          outcome,
          error,
          next_action,
          checkpoint_summary,
          test_summary,
          produces_node_uids,
          props,
          agent_id,
        } as any)
      );

    // Execution tracking
    case "start_execution":
      return ok(
        await client.execution({
          action: "start",
          label,
          summary,
          confidence,
          salience,
          plan_uid,
          executor_uid,
          affordance_uid,
          related_uids,
          input_snapshot,
          props,
          agent_id,
        } as any)
      );
    case "complete_execution":
      return ok(
        await client.execution({
          action: "complete",
          execution_uid,
          produces_node_uid,
          output_snapshot,
          side_effects,
          outcome,
          props,
          agent_id,
        } as any)
      );
    case "fail_execution":
      return ok(
        await client.execution({
          action: "fail",
          execution_uid,
          output_snapshot,
          side_effects,
          outcome,
          error,
          props,
          agent_id,
        } as any)
      );
    case "register_agent":
      return ok(
        await client.execution({
          action: "register_agent",
          label,
          summary,
          confidence,
          salience,
          props,
          agent_id,
        } as any)
      );
    case "get_executions":
      return ok(
        await client.execution({
          action: "get_executions",
          filter_plan_uid,
          agent_id,
        } as any)
      );

    // Governance — read-only from MCP by design (C33). The write actions were
    // removed rather than repaired: `resolve_approval` here also sent
    // `task_uid` where the server requires `approval_uid`, and never sent
    // `approved` at all, so the server's `unwrap_or(false)` would have silently
    // DENIED every approval an agent tried to resolve. Wiring that correctly
    // would have meant building a working self-approval path — the hole itself.
    case "get_pending":
      return ok(await client.governance({ action: "get_pending", agent_id } as any));

    // Procedures (merged from mindgraph_action)
    case "create_flow":
    case "add_affordance":
    case "add_control":
      return ok(
        await client.procedure({
          action: action as any,
          label,
          summary,
          target_uid,
          props,
          agent_id,
        } as any)
      );
    case "add_procedure_step":
      return ok(
        await client.procedure({
          action: "add_step" as any,
          label,
          summary,
          target_uid,
          props,
          agent_id,
        } as any)
      );

    // Risk assessment (merged from mindgraph_action)
    case "assess_risk":
      return ok(
        await client.risk({
          action: "assess",
          label,
          summary,
          target_uid,
          props,
          agent_id,
        } as any)
      );
    case "get_assessments":
      return ok(
        await client.risk({
          action: "get_assessments",
          target_uid,
          agent_id,
        } as any)
      );

    default:
      return err(`Unknown plan action: ${action}`);
  }
}

// ── Retrieve (+ Traverse + Semantic/Hybrid) ──────────────────────────

async function handleRetrieve(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const {
    action,
    query,
    start_uid,
    end_uid,
    max_depth,
    direction,
    edge_types,
    exclude_edge_types,
    include_provenance,
    max_nodes,
    node_types,
    layer,
    limit,
    offset,
    include_chunks,
    include_documents,
    include_graph,
    graph_expansion_limit,
    graph_max_depth,
    confidence_min,
    salience_min,
    agent_id,
  } = args as {
    action: string;
    query?: string;
    start_uid?: string;
    end_uid?: string;
    max_depth?: number;
    direction?: string;
    edge_types?: string[];
    exclude_edge_types?: string[];
    include_provenance?: boolean;
    max_nodes?: number;
    node_types?: string[];
    layer?: string;
    limit?: number;
    offset?: number;
    include_chunks?: boolean;
    include_documents?: boolean;
    include_graph?: boolean;
    graph_expansion_limit?: number;
    graph_max_depth?: number;
    confidence_min?: number;
    salience_min?: number;
    agent_id?: string;
  };

  switch (action) {
    case "context":
      if (!query) return err("query is required for context retrieval");
      return ok(
        await client.retrieveContext({
          query,
          node_limit: limit,
          node_types,
          layer,
          chunk_limit: include_chunks ? (limit ?? 5) : 0,
          // Scoped by default, never walled: the coding profile drops the
          // document/article leg (the "Bob Work" class of noise) unless the
          // model opts in for a genuinely document-shaped question.
          ...(process.env.MINDGRAPH_PROFILE === "coding" && !include_documents
            ? { article_limit: 0 }
            : {}),
          include_graph,
          graph_expansion_limit: graph_expansion_limit ?? 3,
          graph_max_depth: graph_max_depth ?? 2,
        } as any)
      );

    case "text":
      if (!query) return err("query is required for text search");
      return ok(
        await client.retrieve({
          action: "text",
          query,
          limit,
          node_types,
          layer,
          agent_id,
        } as any)
      );

    case "semantic":
      if (!query) return err("query is required for semantic search");
      return ok(
        await client.retrieve({
          action: "semantic",
          query,
          k: limit,
          node_types,
          layer,
          agent_id,
        } as any)
      );

    case "hybrid":
      if (!query) return err("query is required for hybrid search");
      return ok(
        await client.retrieve({
          action: "hybrid",
          query,
          k: limit,
          node_types,
          layer,
          agent_id,
        } as any)
      );

    // Structured queries
    case "active_goals":
      return ok(await client.getGoals());

    case "open_questions":
      return ok(await client.getOpenQuestions());

    case "weak_claims":
      return ok(await client.getWeakClaims());

    case "pending_approvals":
      return ok(await client.getPendingApprovals());

    case "unresolved_contradictions":
      return ok(await client.getContradictions());

    case "stale_derivations":
      return ok(
        await client.retrieve({
          action: "stale_derivations",
          limit,
          offset,
        } as any)
      );

    case "preferences":
      // With a query, returns topic-relevant preferences (the semantic leg
      // bridges low lexical overlap); without one, all preferences, most
      // salient first.
      return ok(
        await client.retrieve({
          action: "preferences",
          ...(query ? { query, k: limit } : {}),
          limit,
          agent_id,
        } as any)
      );

    case "layer":
      if (!layer) return err("layer is required for layer retrieval");
      return ok(
        await client.retrieve({
          action: "layer",
          layer,
          limit,
          agent_id,
        } as any)
      );

    case "recent":
      return ok(
        await client.retrieve({
          action: "recent",
          limit,
          node_types,
          confidence_min,
          salience_min,
          agent_id,
        } as any)
      );

    // Document inventory
    case "document_index":
      return ok(
        await client.getNodes({
          node_type: "Document",
          limit: limit ?? 100,
        })
      );

    // Graph traversal
    case "chain":
      if (!start_uid) return err("start_uid is required for chain traversal");
      return ok(
        await client.traverse({
          action: "chain",
          start_uid,
          max_depth,
          exclude_edge_types,
          include_provenance,
          max_nodes,
        } as any)
      );

    case "neighborhood":
      if (!start_uid) return err("start_uid is required for neighborhood traversal");
      return ok(
        await client.traverse({
          action: "neighborhood",
          start_uid,
          max_depth,
          direction,
          edge_types,
          exclude_edge_types,
          include_provenance,
          max_nodes,
        } as any)
      );

    case "path":
      if (!start_uid) return err("start_uid is required for path traversal");
      if (!end_uid) return err("end_uid is required for path traversal");
      return ok(
        await client.traverse({
          action: "path",
          start_uid,
          end_uid,
          max_depth,
          direction,
          edge_types,
          exclude_edge_types,
          include_provenance,
          max_nodes,
        } as any)
      );

    case "subgraph":
      if (!start_uid) return err("start_uid is required for subgraph traversal");
      return ok(
        await client.traverse({
          action: "subgraph",
          start_uid,
          max_depth,
          direction,
          edge_types,
          exclude_edge_types,
          include_provenance,
          max_nodes,
        } as any)
      );

    default:
      return err(`Unknown retrieve action: ${action}`);
  }
}

// ── Ingest ────────────────────────────────────────────────────────────

async function handleIngest(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const {
    action,
    content,
    title,
    source_uri,
    source, // deprecated alias for source_uri (kept for cached tool schemas)
    content_type,
    document_type,
    layers,
    ontology_schema_id,
    participants,
    occurred_at,
    context,
    document_uid,
    chunk_index,
    chunk_size,
    chunk_overlap,
    job_id,
    agent_id,
  } = args as {
    action: string;
    content?: string;
    title?: string;
    source_uri?: string;
    source?: string;
    content_type?: string;
    document_type?: string;
    layers?: string[];
    ontology_schema_id?: string;
    participants?: Array<{ name: string; organization?: string; role?: string }>;
    occurred_at?: string;
    context?: string;
    document_uid?: string;
    chunk_index?: number;
    chunk_size?: number;
    chunk_overlap?: number;
    job_id?: string;
    agent_id?: string;
  };

  const src = source_uri ?? source;

  // C15: "ontology" is a targeting flag, not a cognitive layer. The server's
  // `cognitive_pass_layers` strips it and returns an empty extraction when the
  // list empties, so forwarding it raw produced a green job over an empty graph:
  // `["reality", "epistemic", "ontology"]` ran cognitive extraction but zero
  // domain-object extraction, and `["ontology"]` alone chunked, embedded, billed
  // and reported `nodes_created: 0` with no error at all. The dashboard already
  // performs this translation (ingest/layer-selection.ts); MCP was the only
  // client forwarding it unchanged.
  const targetsOntology = Array.isArray(layers) && layers.includes("ontology");
  const cognitiveLayers = targetsOntology
    ? (layers as string[]).filter((layer) => layer !== "ontology")
    : layers;
  if (targetsOntology && !ontology_schema_id) {
    return err(
      "layers included 'ontology' but no ontology_schema_id was supplied. " +
        "Typed Layer-7 extraction is driven by ontology_schema_id, not by the " +
        "layers list — pass the schema id, or drop 'ontology' from layers."
    );
  }
  // Only cognitive layers reach the server. Omit the list entirely when the
  // caller asked for domain objects alone, and say so with ontology_only, so
  // the server does not fall back to its per-document-type defaults.
  const forwardedLayers =
    Array.isArray(cognitiveLayers) && cognitiveLayers.length === 0
      ? undefined
      : cognitiveLayers;
  const ontologyOnly = targetsOntology && forwardedLayers === undefined;

  switch (action) {
    case "chunk":
      if (!content) return err("content is required for chunk ingestion");
      return ok(
        await client.ingestChunk({
          content,
          label: title,
          document_uid,
          chunk_index,
          // `/ingest/chunk` runs its ontology pass inline from
          // ontology_schema_id alone and has no ontology_only switch.
          layers: forwardedLayers,
          agent_id,
          ontology_schema_id,
        } as any)
      );

    case "document":
      if (!content) return err("content is required for document ingestion");
      return ok(
        await client.ingestDocument({
          content,
          title,
          source_uri: src,
          content_type,
          document_type,
          layers: forwardedLayers,
          ontology_schema_id,
          ...(ontologyOnly ? { ontology_only: true } : {}),
          participants,
          occurred_at,
          context,
          chunk_size,
          chunk_overlap,
          agent_id,
        } as any)
      );

    case "session":
      if (!content) return err("content is required for session ingestion");
      return ok(
        await client.ingestSession({
          content,
          title,
          layers: forwardedLayers,
          ontology_schema_id,
          ...(ontologyOnly ? { ontology_only: true } : {}),
          participants,
          occurred_at,
          context,
          chunk_size,
          chunk_overlap,
          agent_id,
        } as any)
      );

    case "job_status":
      if (job_id) {
        return ok(await client.getJob(job_id));
      }
      return ok(await client.listJobs());

    default:
      return err(`Unknown ingest action: ${action}`);
  }
}

async function handleSynthesize(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { action, project_uid, signals, target_types, job_id } =
    args as {
      action: string;
      project_uid?: string;
      signals?: string;
      target_types?: string;
      job_id?: string;
    };

  switch (action) {
    case "signals":
      if (!project_uid)
        return err("project_uid is required for action='signals'");
      return ok(
        await client.signals(project_uid, { signals, target_types })
      );

    case "run":
      if (!project_uid)
        return err("project_uid is required for action='run'");
      return ok(await client.runSynthesis(project_uid));

    case "job_status":
      if (!job_id) return err("job_id is required for action='job_status'");
      return ok(await client.getJob(job_id));

    default:
      return err(`Unknown synthesize action: ${action}`);
  }
}

// ── Ontology (Layer 7) ───────────────────────────────────────────────

async function handleOntology(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const {
    action,
    schema_id,
    query,
    object_types,
    object_type,
    uid,
    depth,
    include_cognitive_context,
    include_sources,
    limit,
    status,
    proposal_id,
    feedback,
    reason,
    from_uid,
    to_uid,
    relation_type,
    fields,
    source_uids,
    agent_id,
  } = args as {
    action: string;
    schema_id?: string;
    query?: string;
    object_types?: string[];
    object_type?: string;
    uid?: string;
    depth?: number;
    include_cognitive_context?: boolean;
    include_sources?: boolean;
    limit?: number;
    status?: string;
    proposal_id?: string;
    feedback?: string;
    reason?: string;
    from_uid?: string;
    to_uid?: string;
    relation_type?: string;
    fields?: Record<string, unknown>;
    source_uids?: string[];
    agent_id?: string;
  };

  switch (action) {
    case "schemas":
      return ok(await client.listOntologySchemas());

    case "schema":
      if (!schema_id) return err("schema_id is required for action='schema'");
      return ok(await client.getOntologySchema(schema_id));

    case "query": {
      if (!query) return err("query is required for action='query'");
      if (!schema_id) {
        return err(
          "schema_id is required for action='query' (use action='schemas' to find the active schema)"
        );
      }
      return ok(
        await client.queryOntology({
          query,
          schema_id,
          object_types,
          include_cognitive_context: include_cognitive_context ?? true,
          include_sources: include_sources ?? true,
          depth,
          limit,
        })
      );
    }

    case "search":
      if (!query) return err("query is required for action='search'");
      return ok(
        await client.searchDomainObjects(query, {
          schema_id,
          object_types,
          limit,
        })
      );

    case "objects":
      if (!schema_id) return err("schema_id is required for action='objects'");
      return ok(
        await client.listDomainObjects({ schema_id, object_type, limit })
      );

    case "object":
      if (!uid) return err("uid is required for action='object'");
      return ok(await client.getDomainObject(uid));

    case "object_context":
      if (!uid) return err("uid is required for action='object_context'");
      return ok(await client.getDomainObjectContext(uid, depth));

    case "proposals":
      return ok(
        await client.listOntologyProposals({
          status: status ?? "pending",
          schema_id,
          object_type,
          limit,
        })
      );

    case "proposal":
      if (!proposal_id) return err("proposal_id is required for action='proposal'");
      return ok(await client.getOntologyProposal(proposal_id));

    case "approve":
      if (!proposal_id) return err("proposal_id is required for action='approve'");
      return ok(await client.approveOntologyProposal(proposal_id, { feedback }));

    case "reject":
      if (!proposal_id) return err("proposal_id is required for action='reject'");
      return ok(await client.rejectOntologyProposal(proposal_id, reason));

    case "link": {
      if (!from_uid || !to_uid || !relation_type) {
        return err(
          "from_uid, to_uid, and relation_type are required for action='link'"
        );
      }
      return ok(
        await client.linkDomainObjects({
          from_uid,
          to_uid,
          relation_type,
          fields,
          agent_id,
        })
      );
    }

    case "extract": {
      if (!schema_id) return err("schema_id is required for action='extract'");
      if (!source_uids?.length) {
        return err("source_uids is required for action='extract'");
      }
      return ok(
        await client.extractOntology({
          ontology_schema_id: schema_id,
          source_uids,
        })
      );
    }

    default:
      return err(`Unknown ontology action: ${action}`);
  }
}
