import { MindGraph } from "mindgraph";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ── Tool Definitions ──────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: "mindgraph_capture",
    description:
      "Capture knowledge into the graph. Use 'entity' for people/orgs/places/events/nations/concepts (auto-deduplicates — safe to call even if already exists), 'observation' for factual statements, 'source' for documents/URLs, 'snippet' for quotes from a source, 'concept' for abstract ideas. Use 'journal' for quick personal notes, preferences, reflections, moods — anything subjective or informal. Prefer 'entity'/'observation' for objective facts, 'journal' for personal notes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["entity", "observation", "source", "snippet", "concept", "journal"],
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
      "Agent-level task management, governance, and procedural knowledge. Use 'create_plan'/'create_task'/'add_step' for task breakdowns, 'update_status' for progress, 'get_plan' to review. Use 'create_flow'/'add_procedure_step'/'add_affordance'/'add_control' for workflows and procedures. Use 'assess_risk'/'get_assessments' for risk analysis. Use 'create_policy'/'request_approval'/'resolve_approval'/'get_pending' for governance. Prefer mindgraph_commit for user goals/projects; use this for agent-managed execution.",
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
            "start_execution",
            "complete_execution",
            "fail_execution",
            "create_policy",
            "request_approval",
            "resolve_approval",
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
          description: "Plan UID (for add_step, get_plan)",
        },
        task_uid: {
          type: "string",
          description: "Task/step UID (for update_status, execution actions, resolve_approval)",
        },
        target_uid: {
          type: "string",
          description: "Parent flow/step UID or target node (for procedure/risk actions)",
        },
        status: {
          type: "string",
          description: "New status value (for update_status)",
        },
        props: {
          type: "object",
          description: "Additional properties (e.g. likelihood, impact, mitigation for risks)",
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
    name: "mindgraph_retrieve",
    description:
      "Search and explore the knowledge graph. Use 'context' (default) for BM25 keyword retrieval — pass 1-3 discriminating keywords (proper nouns, technical terms), not sentences. GOOD: 'Kissinger NATO'. BAD: 'What is Kissinger\\'s view on NATO?'. Use 'semantic' when keywords return nothing — good for conceptual/fuzzy queries where user words differ from stored labels. Use 'hybrid' to combine keyword + semantic. Use 'text' for fast keyword-only lookup. Use 'neighborhood' to explore around a known node, 'chain' for reasoning chains, 'path' between two nodes, 'subgraph' for connected components. Other actions ('active_goals', 'open_questions', etc.) only when the user explicitly asks.",
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
            "layer",
            "recent",
            "chain",
            "neighborhood",
            "path",
            "subgraph",
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
          description: "Max results to return (default: 10)",
        },
        include_chunks: {
          type: "boolean",
          description: "Include source document chunks in context results (default: true)",
        },
        include_graph: {
          type: "boolean",
          description: "Include graph nodes in context results (default: true)",
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
        source: {
          type: "string",
          description: "Source URL or reference",
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
            ],
          },
          description: "Cognitive layers to extract (defaults vary by action)",
        },
        chunk_size: {
          type: "number",
          description: "Characters per chunk for document ingestion (default: 4000)",
        },
        chunk_overlap: {
          type: "number",
          description: "Overlap between chunks (default: 200)",
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
];

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
    switch (name) {
      case "mindgraph_capture":
        return await handleCapture(client, args);
      case "mindgraph_reason":
        return await handleReason(client, args);
      case "mindgraph_commit":
        return await handleCommit(client, args);
      case "mindgraph_plan":
        return await handlePlan(client, args);
      case "mindgraph_retrieve":
        return await handleRetrieve(client, args);
      case "mindgraph_ingest":
        return await handleIngest(client, args);
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message);
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
    // Build claim object: prefer explicit claim, fall back to top-level label
    const claimObj = claim || (label ? { label, confidence } : null);
    if (!claimObj) return err("claim object or label is required for action=claim");
    return ok(
      await client.argue({
        claim: claimObj,
        evidence,
        warrant,
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
          agent_id,
        })
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
    target_uid,
    status,
    props,
    agent_id,
  } = args as {
    action: string;
    label?: string;
    summary?: string;
    plan_uid?: string;
    task_uid?: string;
    target_uid?: string;
    status?: string;
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
      return ok(
        await client.plan({
          action: action as any,
          label,
          summary,
          plan_uid,
          task_uid,
          status,
          props,
          agent_id,
        } as any)
      );

    // Execution tracking
    case "start_execution":
      return ok(await client.execution({ action: "start", task_uid, agent_id } as any));
    case "complete_execution":
      return ok(await client.execution({ action: "complete", task_uid, agent_id } as any));
    case "fail_execution":
      return ok(await client.execution({ action: "fail", task_uid, agent_id } as any));

    // Governance
    case "create_policy":
      return ok(
        await client.governance({ action: "create_policy", label, summary, props, agent_id } as any)
      );
    case "request_approval":
      return ok(
        await client.governance({ action: "request_approval", label, summary, props, agent_id } as any)
      );
    case "resolve_approval":
      return ok(
        await client.governance({ action: "resolve_approval", task_uid, props, agent_id } as any)
      );
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
    node_types,
    layer,
    limit,
    include_chunks,
    include_graph,
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
    node_types?: string[];
    layer?: string;
    limit?: number;
    include_chunks?: boolean;
    include_graph?: boolean;
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
          k: limit,
          node_types,
          layer,
          include_chunks,
          include_graph,
        })
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

    // Graph traversal
    case "chain":
      if (!start_uid) return err("start_uid is required for chain traversal");
      return ok(
        await client.traverse({
          action: "chain",
          start_uid,
          max_depth,
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
  const { action, content, title, source, layers, chunk_size, chunk_overlap, job_id, agent_id } =
    args as {
      action: string;
      content?: string;
      title?: string;
      source?: string;
      layers?: string[];
      chunk_size?: number;
      chunk_overlap?: number;
      job_id?: string;
      agent_id?: string;
    };

  switch (action) {
    case "chunk":
      if (!content) return err("content is required for chunk ingestion");
      return ok(
        await client.ingestChunk({
          content,
          title,
          source,
          layers,
          agent_id,
        } as any)
      );

    case "document":
      if (!content) return err("content is required for document ingestion");
      return ok(
        await client.ingestDocument({
          content,
          title,
          source,
          layers,
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
          source,
          layers,
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
