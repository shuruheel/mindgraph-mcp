// `mindgraph_navigate`: one tool, one `move` argument, wrapping the server's
// `POST /navigate` (recursive-navigation spec D8, D10, D11, D14, D19).
//
// Listing moves return the server's rendered `text` as the content and its
// JSON as `structuredContent`. Two tokens are kept here, per harness session,
// so the model does not carry them:
// - the working-set token of `context` (D14, D19): sent on the session's next
//   `context` call;
// - the continuation of the last listing move (D11): `more` without a token
//   continues it. The server's text names `more` without the token, so a
//   model that reads only the text could not continue otherwise.
// In hosted mode one process serves many members and conversations and no
// harness session is known, so nothing is held: the token is shown in the
// text and the model passes it back.
import type { Tool } from "@modelcontextprotocol/server";
import { MindGraphError, type MindGraph } from "mindgraph";
import { toolError } from "./error-detail.js";

export const NAVIGATE_MOVES = [
  "search",
  "open",
  "around",
  "follow",
  "walk",
  "lookup",
  "context",
  "more",
  "check",
] as const;
export type NavigateMove = (typeof NAVIGATE_MOVES)[number];

/** Arguments forwarded to the server as they are; everything else stays here. */
const FORWARDED = [
  "query",
  "source",
  "node_types",
  "handles",
  "relations",
  "direction",
  "depth",
  "window",
  "rounds",
  "range",
  "name",
  "token",
  "text",
  "focus",
  "pin",
  "drop",
  "valid_at",
  "budget_tokens",
  "limit",
  "project_uid",
] as const;

/** The server's default budget for `context` (D18), for the header line. */
const CONTEXT_DEFAULT_BUDGET = 2_000;
/** Kept items listed by title before the rest are counted. */
const KEPT_SHOWN = 8;
/** Sessions one process remembers tokens for. */
const MAX_SESSIONS = 64;

type Rec = Record<string, unknown>;

export interface NavigateToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Rec;
  isError?: boolean;
}

const HANDLES = {
  type: "array",
  items: { type: "string" },
  maxItems: 32,
} as const;

export const NAVIGATE_TOOL: Tool = {
  name: "mindgraph_navigate",
  description:
    "Navigate the knowledge graph one move at a time, by handles. Every result lists items as [handle] title, a line of text, how the item was reached and whether it still stands (current, superseded by [handle], withdrawn), then a `next:` line of moves valid from there. A handle is a type letter and the full uid (n: item, c: source text, e: entity, d: document); copy it exactly. " +
    "Moves: `search` (query; source items|text|both) finds a starting point. `walk` (handles you chose; rounds 1-4) spreads from those items and returns what is most strongly connected, each with its path. `follow` (handles; relations, direction out|in|both, depth 1-3) lists linked items. `around` (a c: handle; window 1-3) reads the passages before and after a passage, or what was extracted from it. `open` (handles; range [start,end] for part of a long text) reads items in full. `lookup` (name) finds the item an identifier or name denotes. `more` continues the last move past its budget; this server keeps its token, so pass `token` only to continue an earlier move. `check` (handles) says whether a conclusion still stands; servers without it answer that it is not built. " +
    "`context` (text: what was just said; focus, pin, drop: handles) reads the session's working set: what entered, what stayed and what left since the last call. This server keeps the working-set token for the session; set new_session to start over. " +
    "Typical flow: search with a few keywords, walk or follow from the hits that matter, around or open to read the source, then answer or say the record does not answer. Every move is a read; note evidence worth keeping with the write tools.",
  inputSchema: {
    type: "object" as const,
    properties: {
      move: {
        type: "string",
        enum: [...NAVIGATE_MOVES],
        description: "The move to make",
      },
      query: { type: "string", description: "search: a few discriminating keywords" },
      source: {
        type: "string",
        enum: ["items", "text", "both"],
        description: "search: items, source text passages, or both (default)",
      },
      node_types: {
        type: "array",
        items: { type: "string" },
        description: "search: limit items to these node types",
      },
      handles: {
        ...HANDLES,
        description: "open, around, follow, walk, check: the handles to start from",
      },
      relations: {
        type: "array",
        items: { type: "string" },
        description: "follow, walk, context: limit to these link types",
      },
      direction: {
        type: "string",
        enum: ["out", "in", "both"],
        description: "follow: link direction (default both)",
      },
      depth: { type: "integer", minimum: 1, maximum: 3, description: "follow: hops (default 1)" },
      window: {
        type: "integer",
        minimum: 1,
        maximum: 3,
        description: "around: passages on each side (default 1)",
      },
      rounds: {
        type: "integer",
        minimum: 1,
        maximum: 4,
        description: "walk (default 3), context: rounds of the spreading walk",
      },
      range: {
        type: "array",
        items: { type: "integer", minimum: 0 },
        minItems: 2,
        maxItems: 2,
        description: "open: a character range [start, end) of each item's text",
      },
      name: { type: "string", description: "lookup: the identifier or name" },
      token: {
        type: "string",
        description:
          "more: the continuation of an earlier move (omit to continue the last one). context: omit; pass it only when a result asks you to",
      },
      text: { type: "string", description: "context: what the user or you just said; omit to re-read this turn" },
      focus: { ...HANDLES, description: "context: items you judge relevant" },
      pin: { ...HANDLES, description: "context: items to keep in the working set" },
      drop: { ...HANDLES, description: "context: items to remove from the working set" },
      new_session: {
        type: "boolean",
        description: "context: start a new working set instead of continuing this session's",
      },
      valid_at: { type: "string", description: "context: the world-time point of the read (ISO-8601)" },
      budget_tokens: {
        type: "integer",
        maximum: 8000,
        description: "Token budget of the result (default 4000; context 2000)",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Items to show (default 20)" },
      project_uid: { type: "string", description: "Restrict the move to a corpus Project's sources" },
    },
    required: ["move"],
  },
  outputSchema: {
    type: "object",
    properties: {
      move: { type: "string" },
      from: { type: "array", items: { type: "string" } },
      state: { type: "string" },
      shown: { type: "integer" },
      more_available: { type: "integer" },
      stopped: { type: ["string", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            handle: { type: "string" },
            uid: { type: "string" },
            type: { type: "string" },
            title: { type: "string" },
            text: { type: "string" },
            reached: { type: "string" },
            standing: { type: "object" },
            score: { type: "number" },
            range: { type: "array", items: { type: "integer" } },
          },
        },
      },
      bad_handles: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } },
      next: { type: "array", items: { type: "object" } },
      token: { type: ["string", "null"] },
      budget_tokens: { type: "integer" },
      used_tokens: { type: "integer" },
      text: { type: "string" },
      context_text: { type: "string" },
      working_set: { type: "object" },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

interface HeldTokens {
  workingSet?: string;
  more?: string;
}

/**
 * The tokens this process holds, per harness session. Bounded: past
 * {@link MAX_SESSIONS} the session used longest ago is forgotten.
 */
export class NavigationTokens {
  private readonly sessions = new Map<string, HeldTokens>();

  get(session: string): HeldTokens {
    const held = this.sessions.get(session);
    if (held) {
      // Most recently used last, so the first key is the one to evict.
      this.sessions.delete(session);
      this.sessions.set(session, held);
      return held;
    }
    const fresh: HeldTokens = {};
    this.sessions.set(session, fresh);
    while (this.sessions.size > MAX_SESSIONS) {
      this.sessions.delete(this.sessions.keys().next().value as string);
    }
    return fresh;
  }
}

/** The process-wide store of the stdio server. */
export const PROCESS_NAVIGATION_TOKENS = new NavigationTokens();

/** The harness session a call belongs to: the adapter's session id when a
 * hook supplied one, else the process (a stdio server serves one session). */
export function navigationSession(args: Rec): string {
  const context = args.invocation_context;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    const id = (context as Rec).harnessSessionId;
    if (typeof id === "string" && id.length > 0) return `harness:${id}`;
  }
  return "process";
}

type NavigateClient = {
  navigate?: (body: Rec) => Promise<unknown>;
  post?: (path: string, body: unknown) => Promise<unknown>;
};

/** `client.navigate` where the SDK has it; otherwise the SDK's own POST, so
 * this works with an SDK published before the method. */
async function sendNavigate(client: MindGraph, body: Rec): Promise<Rec> {
  const c = client as unknown as NavigateClient;
  let response: unknown;
  if (typeof c.navigate === "function") {
    response = await c.navigate.call(client, body);
  } else if (typeof c.post === "function") {
    response = await c.post.call(client, "/navigate", body);
  } else {
    throw new Error("This version of the MindGraph SDK cannot send navigation requests.");
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("The server returned no navigation result.");
  }
  return response as Rec;
}

function errorCode(e: unknown): string | undefined {
  const body = e instanceof MindGraphError ? e.body : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const code = (body as Rec).code;
  return typeof code === "string" ? code : undefined;
}

function fail(message: string, code: string, extra: Rec = {}): NavigateToolResult {
  const payload = { error: message, code, retriable: false, ...extra };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function changeLine(item: unknown, mark?: string): string {
  const rec = (item && typeof item === "object" ? item : {}) as Rec;
  const uid = str(rec.uid) ?? "?";
  const label = str(rec.label);
  const line = label ? `[${uid}] ${label}` : `[${uid}]`;
  return mark ? `${line}    ${mark}` : line;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The S1b change list above the server's rendered context. */
export function renderWorkingSet(
  response: Rec,
  budget: number,
  tokenNote?: string,
): string {
  const set = (response.working_set ?? {}) as Rec;
  const entered = list(set.entered);
  const kept = list(set.kept);
  const left = list(set.left);
  const changed = list(set.changed);
  const used = typeof response.used_tokens === "number" ? response.used_tokens : undefined;
  const header = [
    "working set",
    `turn ${typeof set.turn === "number" ? set.turn : "?"}${set.reread === true ? " (re-read)" : ""}`,
    `${entered.length} entered, ${kept.length} kept, ${left.length} left`,
    ...(used !== undefined ? [`${used} of ${budget} tokens`] : []),
  ].join("  ·  ");
  const lines = [header];
  const strength = (set.strength ?? {}) as Rec;
  if (strength.nothing_strong === true) {
    lines.push("", "Nothing in memory is strongly related to this.");
  }
  if (entered.length > 0) lines.push("", "entered", ...entered.map((item) => changeLine(item)));
  if (kept.length > 0) {
    lines.push("", "kept", ...kept.slice(0, KEPT_SHOWN).map((item) => changeLine(item)));
    if (kept.length > KEPT_SHOWN) lines.push(`… ${kept.length - KEPT_SHOWN} more`);
  }
  if (left.length > 0) {
    lines.push(
      "",
      "left",
      ...left.map((item) => changeLine(item, str((item as Rec)?.reason) ?? "faded")),
    );
  }
  if (changed.length > 0) {
    lines.push(
      "",
      "changed",
      ...changed.map((item) => changeLine(item, str((item as Rec)?.standing))),
    );
  }
  const pinsNotShown = list(set.pins_not_shown);
  if (pinsNotShown.length > 0) {
    lines.push("", `${pinsNotShown.length} pinned item(s) not shown`);
  }
  const body = str(response.context_text);
  if (body) lines.push("", body.trimEnd());
  lines.push("", "steer: focus [handle] · pin [handle] · drop [handle] · widen (rounds)");
  if (tokenNote) lines.push(tokenNote);
  return lines.join("\n");
}

function moveBody(move: NavigateMove, args: Rec): Rec {
  const body: Rec = { action: move };
  for (const key of FORWARDED) {
    if (args[key] !== undefined && args[key] !== null) body[key] = args[key];
  }
  return body;
}

export interface NavigateRuntime {
  /** Where this door keeps tokens; absent (hosted) means nothing is held. */
  tokens?: NavigationTokens;
}

export async function handleNavigateTool(
  client: MindGraph,
  args: Rec,
  runtime: NavigateRuntime = {},
): Promise<NavigateToolResult> {
  // `next` entries from the server name the move `action`; accept either.
  const move = (args.move ?? args.action) as string | undefined;
  if (!move || !(NAVIGATE_MOVES as readonly string[]).includes(move)) {
    return fail(
      `move must be one of ${NAVIGATE_MOVES.join(", ")}`,
      "invalid_move",
    );
  }
  const held = runtime.tokens?.get(navigationSession(args));
  try {
    if (move === "context") return await contextMove(client, args, held);
    const body = moveBody(move as NavigateMove, args);
    if (move === "more" && body.token === undefined) {
      if (!held?.more) {
        return fail(
          "There is no move to continue: the last move had nothing more, or none was made in this session. Repeat a move, then call more.",
          "nothing_to_continue",
        );
      }
      body.token = held.more;
    }
    const response = await sendNavigate(client, body);
    const token = str(response.token);
    if (held) held.more = token;
    let text = str(response.text) ?? JSON.stringify(response);
    if (token && !held) {
      // Nothing is held here: the model needs the token itself.
      text = text.replace('more {"token": …}', `more {"token": "${token}"}`);
    }
    return { content: [{ type: "text", text }], structuredContent: response };
  } catch (e: unknown) {
    if (e instanceof MindGraphError && e.status === 501) {
      return fail(
        `The \`${move}\` move is not built on this server yet. For whether a claim is still supported, use mindgraph_retrieve action epistemic_support.`,
        errorCode(e) ?? "move_not_built",
        { status: 501 },
      );
    }
    return toolError(e);
  }
}

async function contextMove(
  client: MindGraph,
  args: Rec,
  held: HeldTokens | undefined,
): Promise<NavigateToolResult> {
  const body = moveBody("context", args);
  if (args.new_session === true) {
    if (held) held.workingSet = undefined;
    delete body.token;
  }
  const fromStore = body.token === undefined && args.new_session !== true && held?.workingSet;
  if (fromStore) body.token = held!.workingSet;
  let response: Rec;
  try {
    response = await sendNavigate(client, body);
  } catch (e: unknown) {
    if (!fromStore || errorCode(e) !== "working_set_token_unreadable") throw e;
    // The held token is ours to manage: forget it and start the session over
    // when there is text to start from.
    held!.workingSet = undefined;
    if (body.text === undefined) throw e;
    const fresh: Rec = { ...body };
    delete fresh.token;
    response = await sendNavigate(client, fresh);
  }
  const set = response.working_set as Rec | undefined;
  const token = str(set?.token);
  const budget =
    typeof args.budget_tokens === "number" ? args.budget_tokens : CONTEXT_DEFAULT_BUDGET;
  let structured: Rec = response;
  let tokenNote: string | undefined;
  if (token && held) {
    held.workingSet = token;
    // The door holds it; the model never needs to see it (D14).
    const shown: Rec = { ...set!, token_held: true };
    delete shown.token;
    structured = { ...response, working_set: shown };
  } else if (token) {
    tokenNote = `Pass token "${token}" on your next context call of this conversation.`;
  }
  return {
    content: [{ type: "text", text: renderWorkingSet(response, budget, tokenNote) }],
    structuredContent: structured,
  };
}
