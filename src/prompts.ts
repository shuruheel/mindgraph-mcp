// The seven prompts the MCP server advertises, shared by the stdio entry and
// the hosted server. Pure data plus a dispatcher; no local state is read.

export const PROMPTS = [
  {
    name: "graph-summary",
    description:
      "Get a comprehensive summary of what's in your knowledge graph — entities, claims, goals, and open questions.",
    arguments: [],
  },
  {
    name: "active-goals",
    description:
      "Review your active goals, projects, and milestones with their current status.",
    arguments: [],
  },
  {
    name: "open-questions",
    description:
      "List all open questions and hypotheses that need investigation.",
    arguments: [],
  },
  {
    name: "review-contradictions",
    description:
      "Find and analyze contradictions in your knowledge graph — claims that conflict with each other.",
    arguments: [],
  },
  {
    name: "knowledge-about",
    description:
      "Retrieve everything the knowledge graph knows about a specific topic.",
    arguments: [
      {
        name: "topic",
        description: "The topic to search for",
        required: true,
      },
    ],
  },
  {
    name: "daily-briefing",
    description:
      "Get a daily briefing: active goals, recent knowledge, open questions, and pending decisions.",
    arguments: [],
  },
  {
    name: "capture-conversation",
    description:
      "Analyze the current conversation and capture all important entities, claims, decisions, and action items into the knowledge graph.",
    arguments: [
      {
        name: "conversation",
        description: "The conversation text to analyze and capture",
        required: true,
      },
    ],
  },
];

export type PromptMessages = {
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
};

export function getPrompt(
  name: string,
  args: Record<string, string> | undefined,
): PromptMessages {
  switch (name) {
    case "graph-summary":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Give me a comprehensive summary of my knowledge graph. Start by checking the graph stats, then retrieve my active goals, open questions, and any recent knowledge. Organize the summary by cognitive layer (Reality, Epistemic, Intent, Action, Memory).",
            },
          },
        ],
      };

    case "active-goals":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Review all my active goals, projects, and milestones. For each one, show its status, any linked decisions or tasks, and suggest next steps. Group them by project if applicable.",
            },
          },
        ],
      };

    case "open-questions":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "List all my open questions and hypotheses. For each one, check if there's any related evidence or claims in the graph that might help answer them. Prioritize by salience and suggest which ones I should investigate first.",
            },
          },
        ],
      };

    case "review-contradictions":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Search my knowledge graph for contradictions — claims that conflict with each other, or evidence that undermines existing beliefs. Also look for weak claims (low confidence) that might need more evidence. For each contradiction found, explain the conflict and suggest how to resolve it.",
            },
          },
        ],
      };

    case "knowledge-about": {
      const topic = args?.topic || "general";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Search my knowledge graph for everything related to "${topic}". Use context retrieval with short BM25 keyword queries (1–3 discriminating terms extracted from the topic, not full sentences). Try multiple keyword variations and synonyms to ensure broad coverage. Present a structured overview of what I know about this topic, highlighting any gaps or open questions.`,
            },
          },
        ],
      };
    }

    case "daily-briefing":
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "Give me a daily briefing. Check:\n1. Active goals and their progress\n2. Open decisions that need resolution\n3. Recent knowledge added in the last few days\n4. Open questions worth investigating\n5. Any pending approvals\n6. Weak claims that need more evidence\n\nKeep it concise and actionable — highlight what needs my attention today.",
            },
          },
        ],
      };

    case "capture-conversation": {
      const conversation = args?.conversation || "";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Analyze the following conversation and capture all important information into my knowledge graph. Extract:\n- Named entities (people, organizations, places, events) → mindgraph_capture action "entity"\n- Factual claims and observations → mindgraph_capture action "observation" or mindgraph_reason action "claim"\n- Decisions made or pending → mindgraph_commit action "open_decision"\n- Goals or commitments mentioned → mindgraph_commit action "goal"/"project"\n- Open questions raised → mindgraph_reason action "open_question"\n- Any hypotheses or theories discussed → mindgraph_reason action "hypothesis"/"theory"\n\nConversation:\n${conversation}`,
            },
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
