import { MindGraph } from "mindgraph";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ── Tool Definitions ──────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: "mindgraph_session",
    description:
      "Manage conversation sessions. ALWAYS open a session at the start of a substantial conversation (label it with the topic). Use 'trace' to bookmark key moments (decisions made, important facts shared). Close the session at the end with a summary of what was discussed. Sessions enable the graph to track conversation continuity and trigger knowledge distillation on close.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["open", "trace", "close"],
          description: "Session lifecycle action",
        },
        label: {
          type: "string",
          description: "Session or trace label (required for open/trace)",
        },
        session_uid: {
          type: "string",
          description: "Session UID (required for trace/close)",
        },
        summary: {
          type: "string",
          description: "Session summary (used on close)",
        },
        props: {
          type: "object",
          description: "Additional properties",
        },
        agent_id: {
          type: "string",
          description: "Agent identity for multi-agent systems",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "mindgraph_journal",
    description:
      "Quick, informal capture for the user's inner world: preferences ('I prefer dark mode'), reflections ('I've been thinking about...'), moods, daily notes, and anything subjective. Use this instead of mindgraph_capture when the content is personal/informal rather than a structured fact about the external world. Good for: likes/dislikes, feelings, habits, reminders-to-self, freeform notes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: {
          type: "string",
          description: "Brief title for the journal entry",
        },
        content: {
          type: "string",
          description: "The journal content/body text",
        },
        mood: {
          type: "string",
          description: "Emotional tone or mood tag",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Categorization tags",
        },
        session_uid: {
          type: "string",
          description: "Link to an active session",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["label", "content"],
    },
  },
  {
    name: "mindgraph_capture",
    description:
      "Capture structured facts about the external world into the Reality layer. Use proactively whenever the user mentions a named entity. Actions: 'entity' for people/orgs/places/events/nations/concepts (auto-deduplicates — safe to call even if already exists), 'observation' for factual statements about the world, 'source' for documents/URLs/references, 'snippet' for direct quotes from a source. Prefer this over mindgraph_journal when the content is an objective fact rather than a personal note.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["entity", "observation", "source", "snippet", "concept"],
          description: "Type of reality to capture",
        },
        label: {
          type: "string",
          description: "Name or title",
        },
        summary: {
          type: "string",
          description: "Description or summary text",
        },
        entity_type: {
          type: "string",
          enum: [
            "person",
            "organization",
            "place",
            "event",
            "nation",
            "concept",
          ],
          description: "Entity subtype (only for action=entity)",
        },
        source_uid: {
          type: "string",
          description: "Source node UID (for snippets)",
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
    name: "mindgraph_argue",
    description:
      "Record a claim WITH supporting evidence. Use when the user states something as true/false and provides reasoning or sources. Creates interconnected Claim + Evidence + Warrant nodes. Set confidence based on evidence strength: 0.9+ for well-sourced facts, 0.5-0.8 for plausible claims, below 0.5 for speculation. Prefer mindgraph_inquire instead when there's a question or hypothesis WITHOUT evidence yet.",
    inputSchema: {
      type: "object" as const,
      properties: {
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
          description: "The central claim being argued",
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
          description: "Supporting evidence items",
        },
        warrant: {
          type: "object",
          properties: {
            label: { type: "string" },
            content: { type: "string" },
          },
          description: "Logical warrant connecting evidence to claim",
        },
        argument: {
          type: "object",
          properties: {
            label: { type: "string" },
          },
          description: "Top-level argument container",
        },
        agent_id: {
          type: "string",
          description: "Agent identity",
        },
      },
      required: ["claim"],
    },
  },
  {
    name: "mindgraph_inquire",
    description:
      "Record things that need investigation or are uncertain. Use 'open_question' when the user asks something worth tracking ('How does X work?'), 'hypothesis' for testable predictions, 'theory' for explanatory frameworks, 'anomaly' for things that don't fit existing understanding, 'assumption' for unstated beliefs worth surfacing. These stay in the graph as open items until resolved. Prefer mindgraph_argue instead when there IS evidence to attach.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "question",
            "open_question",
            "hypothesis",
            "theory",
            "paradigm",
            "anomaly",
            "assumption",
          ],
          description: "Type of epistemic inquiry",
        },
        label: {
          type: "string",
          description: "The question, hypothesis, or theory statement",
        },
        summary: {
          type: "string",
          description: "Expanded description or context",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confidence level (0-1)",
        },
        salience: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Importance score (0-1)",
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
      required: ["action", "label"],
    },
  },
  {
    name: "mindgraph_commit",
    description:
      "Track the user's goals, projects, and milestones. Use 'goal' when the user expresses a desired outcome ('I want to learn Rust'), 'project' for organized efforts ('my blog redesign'), 'milestone' for checkpoints ('launch MVP by March'). Link milestones to projects and projects to goals via parent_uid. These appear in daily briefings and active goals queries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["goal", "project", "milestone"],
          description: "Type of commitment",
        },
        label: {
          type: "string",
          description: "Name of the goal, project, or milestone",
        },
        summary: {
          type: "string",
          description: "Description and success criteria",
        },
        parent_uid: {
          type: "string",
          description: "Parent goal/project UID to link under",
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
          description:
            "Type-specific properties (e.g. status, priority, deadline, horizon for goals)",
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
    name: "mindgraph_decide",
    description:
      "Track decisions through their lifecycle. Use 'open_decision' when the user faces a choice ('Should I use Postgres or SQLite?'), 'add_option' to record each alternative, 'add_constraint' for requirements or dealbreakers, 'resolve' when a choice is made. Use 'get_open' to review pending decisions. This creates a structured decision record that can be referenced later.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["open_decision", "add_option", "add_constraint", "resolve", "get_open"],
          description: "Decision lifecycle action",
        },
        label: {
          type: "string",
          description: "Decision, option, or constraint label",
        },
        summary: {
          type: "string",
          description: "Description or rationale",
        },
        decision_uid: {
          type: "string",
          description: "Decision UID (for add_option, add_constraint, resolve)",
        },
        chosen_option_uid: {
          type: "string",
          description: "UID of the chosen option (for resolve)",
        },
        props: {
          type: "object",
          description: "Additional properties",
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
    name: "mindgraph_action",
    description:
      "Record procedural knowledge and risk assessments. Use 'create_flow' for workflows/processes, 'add_step' for individual steps in a flow, 'add_affordance' for capabilities ('this API supports batch operations'), 'add_control' for guardrails/constraints. Use 'assess_risk' when the user identifies a risk or potential problem. Less commonly used than capture/argue/commit — reach for this when the conversation is about HOW to do something.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "create_flow",
            "add_step",
            "add_affordance",
            "add_control",
            "assess_risk",
            "get_assessments",
          ],
          description: "Action layer operation",
        },
        label: {
          type: "string",
          description: "Flow, step, affordance, control, or risk label",
        },
        summary: {
          type: "string",
          description: "Description",
        },
        target_uid: {
          type: "string",
          description: "Parent flow/step UID or target node for risk assessment",
        },
        props: {
          type: "object",
          description: "Type-specific properties (e.g. likelihood, impact, mitigation for risks)",
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
      "Agent-level task management and governance. Use 'create_plan'/'create_task'/'add_step' for breaking down work into trackable items, 'update_status' to mark progress, 'start_execution'/'complete_execution'/'fail_execution' for execution tracking. Use 'create_policy' and 'request_approval' for governance workflows. Prefer mindgraph_commit for the user's goals/projects; use mindgraph_plan for agent-managed task breakdowns and execution.",
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
          ],
          description: "Agent layer operation",
        },
        label: {
          type: "string",
          description: "Task, plan, step, or policy label",
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
          description: "Task/step UID (for update_status, execution actions)",
        },
        status: {
          type: "string",
          description: "New status value (for update_status)",
        },
        props: {
          type: "object",
          description: "Additional properties",
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
      "Search and query the knowledge graph. ALWAYS retrieve before answering questions about previously stored knowledge. Actions: 'context' for rich retrieval (follows graph edges — best for RAG), 'hybrid' for fast keyword+semantic search, 'text' for exact keyword match, 'semantic' for meaning-based search. Convenience queries: 'active_goals', 'open_questions', 'weak_claims', 'pending_approvals', 'unresolved_contradictions'. Use 'layer' to browse a specific cognitive layer, 'recent' for latest additions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "hybrid",
            "semantic",
            "text",
            "context",
            "active_goals",
            "open_questions",
            "weak_claims",
            "pending_approvals",
            "unresolved_contradictions",
            "layer",
            "recent",
          ],
          description: "Retrieval strategy",
        },
        query: {
          type: "string",
          description: "Search query (for hybrid, semantic, text, context)",
        },
        layer: {
          type: "string",
          enum: [
            "reality",
            "epistemic",
            "intent",
            "action",
            "memory",
            "agent",
          ],
          description: "Layer filter (for layer action)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 10)",
        },
        node_type: {
          type: "string",
          description: "Filter by node type",
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
      case "mindgraph_session":
        return await handleSession(client, args);
      case "mindgraph_journal":
        return await handleJournal(client, args);
      case "mindgraph_capture":
        return await handleCapture(client, args);
      case "mindgraph_argue":
        return await handleArgue(client, args);
      case "mindgraph_inquire":
        return await handleInquire(client, args);
      case "mindgraph_commit":
        return await handleCommit(client, args);
      case "mindgraph_decide":
        return await handleDecide(client, args);
      case "mindgraph_action":
        return await handleAction(client, args);
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

// ── Session ───────────────────────────────────────────────────────────

async function handleSession(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { action, label, session_uid, summary, props, agent_id } = args as {
    action: string;
    label?: string;
    session_uid?: string;
    summary?: string;
    props?: Record<string, unknown>;
    agent_id?: string;
  };

  switch (action) {
    case "open": {
      if (!label) return err("label is required for open");
      const result = await client.session({
        action: "open",
        label,
        summary,
        props,
        agent_id,
      });
      return ok(result);
    }
    case "trace": {
      if (!session_uid) return err("session_uid is required for trace");
      if (!label) return err("label is required for trace");
      const result = await client.session({
        action: "trace",
        label,
        session_uid,
        props,
        agent_id,
      });
      return ok(result);
    }
    case "close": {
      if (!session_uid) return err("session_uid is required for close");
      const result = await client.session({
        action: "close",
        session_uid,
        summary,
        agent_id,
      } as any);
      return ok(result);
    }
    default:
      return err(`Unknown session action: ${action}`);
  }
}

// ── Journal ───────────────────────────────────────────────────────────

async function handleJournal(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { label, content, mood, tags, session_uid, agent_id } = args as {
    label: string;
    content: string;
    mood?: string;
    tags?: string[];
    session_uid?: string;
    agent_id?: string;
  };

  const props: Record<string, unknown> = { content };
  if (mood) props.mood = mood;
  if (tags) props.tags = tags;

  const result = await client.journal(
    label,
    props,
    { session_uid, agent_id }
  );
  return ok(result);
}

// ── Capture ───────────────────────────────────────────────────────────

async function handleCapture(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const {
    action,
    label,
    summary,
    entity_type,
    source_uid,
    confidence,
    salience,
    props,
    agent_id,
  } = args as {
    action: string;
    label: string;
    summary?: string;
    entity_type?: string;
    source_uid?: string;
    confidence?: number;
    salience?: number;
    props?: Record<string, unknown>;
    agent_id?: string;
  };

  switch (action) {
    case "entity": {
      // Use typed entity creation for specific types
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

// ── Argue ─────────────────────────────────────────────────────────────

async function handleArgue(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { claim, evidence, warrant, argument, agent_id } = args as {
    claim: { label: string; content?: string; confidence?: number };
    evidence?: Array<{ label: string; description?: string }>;
    warrant?: { label: string; content?: string };
    argument?: { label: string };
    agent_id?: string;
  };

  const result = await client.argue({
    claim,
    evidence,
    warrant,
    argument,
    agent_id,
  } as any);
  return ok(result);
}

// ── Inquire ───────────────────────────────────────────────────────────

async function handleInquire(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { action, label, summary, confidence, salience, props, agent_id } =
    args as {
      action: string;
      label: string;
      summary?: string;
      confidence?: number;
      salience?: number;
      props?: Record<string, unknown>;
      agent_id?: string;
    };

  const result = await client.inquire({
    action: action as any,
    label,
    summary,
    confidence,
    salience,
    props,
    agent_id,
  });
  return ok(result);
}

// ── Commit ────────────────────────────────────────────────────────────

async function handleCommit(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { action, label, summary, parent_uid, confidence, salience, props, agent_id } =
    args as {
      action: string;
      label: string;
      summary?: string;
      parent_uid?: string;
      confidence?: number;
      salience?: number;
      props?: Record<string, unknown>;
      agent_id?: string;
    };

  const result = await client.commit({
    action: action as any,
    label,
    summary,
    parent_uid,
    confidence,
    salience,
    props,
    agent_id,
  } as any);
  return ok(result);
}

// ── Decide ────────────────────────────────────────────────────────────

async function handleDecide(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { action, label, summary, decision_uid, chosen_option_uid, props, agent_id } =
    args as {
      action: string;
      label?: string;
      summary?: string;
      decision_uid?: string;
      chosen_option_uid?: string;
      props?: Record<string, unknown>;
      agent_id?: string;
    };

  switch (action) {
    case "open_decision":
      if (!label) return err("label is required for open_decision");
      return ok(await client.openDecision(label, { summary, props, agent_id }));
    case "add_option":
      if (!decision_uid) return err("decision_uid is required");
      if (!label) return err("label is required for add_option");
      return ok(
        await client.addOption(decision_uid, label, { summary, props, agent_id })
      );
    case "add_constraint":
      if (!decision_uid) return err("decision_uid is required");
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
    case "resolve":
      if (!decision_uid) return err("decision_uid is required");
      if (!chosen_option_uid) return err("chosen_option_uid is required");
      return ok(
        await client.resolveDecision(decision_uid, chosen_option_uid, {
          summary,
          agent_id,
        })
      );
    case "get_open":
      return ok(await client.getOpenDecisions());
    default:
      return err(`Unknown decide action: ${action}`);
  }
}

// ── Action ────────────────────────────────────────────────────────────

async function handleAction(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { action, label, summary, target_uid, props, agent_id } = args as {
    action: string;
    label?: string;
    summary?: string;
    target_uid?: string;
    props?: Record<string, unknown>;
    agent_id?: string;
  };

  switch (action) {
    case "create_flow":
    case "add_step":
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
      return err(`Unknown action: ${action}`);
  }
}

// ── Plan ──────────────────────────────────────────────────────────────

async function handlePlan(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { action, label, summary, plan_uid, task_uid, status, props, agent_id } =
    args as {
      action: string;
      label?: string;
      summary?: string;
      plan_uid?: string;
      task_uid?: string;
      status?: string;
      props?: Record<string, unknown>;
      agent_id?: string;
    };

  switch (action) {
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
    case "start_execution":
      return ok(
        await client.execution({
          action: "start",
          task_uid,
          agent_id,
        } as any)
      );
    case "complete_execution":
      return ok(
        await client.execution({
          action: "complete",
          task_uid,
          agent_id,
        } as any)
      );
    case "fail_execution":
      return ok(
        await client.execution({
          action: "fail",
          task_uid,
          agent_id,
        } as any)
      );
    case "create_policy":
      return ok(
        await client.governance({
          action: "create_policy",
          label,
          summary,
          props,
          agent_id,
        } as any)
      );
    case "request_approval":
      return ok(
        await client.governance({
          action: "request_approval",
          label,
          summary,
          props,
          agent_id,
        } as any)
      );
    case "resolve_approval":
      return ok(
        await client.governance({
          action: "resolve_approval",
          task_uid,
          props,
          agent_id,
        } as any)
      );
    case "get_pending":
      return ok(
        await client.governance({
          action: "get_pending",
          agent_id,
        } as any)
      );
    default:
      return err(`Unknown plan action: ${action}`);
  }
}

// ── Retrieve ──────────────────────────────────────────────────────────

async function handleRetrieve(
  client: MindGraph,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { action, query, layer, limit, node_type, agent_id } = args as {
    action: string;
    query?: string;
    layer?: string;
    limit?: number;
    node_type?: string;
    agent_id?: string;
  };

  switch (action) {
    case "context":
      if (!query) return err("query is required for context retrieval");
      return ok(await client.retrieveContext({ query, k: limit }));

    case "hybrid":
      if (!query) return err("query is required for hybrid search");
      return ok(
        await client.hybridSearch(query, {
          k: limit,
          node_types: node_type ? [node_type] : undefined,
        })
      );

    case "semantic":
      if (!query) return err("query is required for semantic search");
      return ok(
        await client.retrieve({
          action: "semantic",
          query,
          limit,
          node_type,
          agent_id,
        } as any)
      );

    case "text":
      if (!query) return err("query is required for text search");
      return ok(await client.search(query, { limit, node_type }));

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
          node_type,
          agent_id,
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
