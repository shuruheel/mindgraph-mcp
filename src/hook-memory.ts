import fs from "node:fs";

/**
 * Per-prompt recall and transcript capture for the Claude Code hooks (N17).
 *
 * Mirrors the Hermes provider: `prefetch` is a bounded topic recall through
 * `/retrieve/context` (5 items, 4,000 characters) for the current message,
 * and `on_pre_compress`/`on_session_end` ingest the user and assistant text
 * turns as a session transcript through `/ingest/session`. Tool calls and
 * tool output are never sent; secrets are redacted before anything leaves
 * the machine.
 */

export const PROMPT_RECALL_LIMIT = 5;
export const PROMPT_RECALL_MAX_CHARS = 4_000;
export const MIN_PROMPT_RECALL_CHARS = 12;
/** Upper bound on one transcript ingest; the most recent turns are kept. */
export const CAPTURE_MAX_CHARS = 200_000;

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our please should so that the their them then there these they this to us was we were " +
    "what when where which who why will with would you your about just also any some tell know want need " +
    "let lets like get got make " +
    // Function words that matched unrelated memory on their own (0.24.0).
    "yes no not ok okay sure may might must up down out off over under again after before while " +
    "without within including include use using used keep now next here than very more most " +
    "other each both all one two been being am done going go"
  ).split(" "),
);
const WORD = /[A-Za-z0-9][A-Za-z0-9_.\-/#+]*/g;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(?:mg|sk|pk|rk)[_-](?:live[_-]|test[_-]|ant[_-]|proj[_-])?[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]"],
  [
    /\b((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*)["']?[^\s"',;]{8,}["']?/gi,
    "$1[REDACTED]",
  ],
];

/** Redact obvious secrets (API keys, tokens, private keys, key=value
 * credentials). Pattern-based and deliberately conservative: it catches
 * key-shaped strings, not every secret a person could type. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Whether `text` holds anything `redactSecrets` would redact. Used by the
 * notes import to leave a note out entirely rather than send it redacted. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some(([pattern]) => new RegExp(pattern.source, pattern.flags).test(text));
}

/** Discriminating keywords for BM25 topic recall (port of Hermes
 * `topic_query`): a full sentence dilutes the query with words every node
 * shares. Returns "" for prompts too short or slash commands. */
export function promptRecallQuery(prompt: unknown, maxTerms = 8): string {
  if (typeof prompt !== "string") return "";
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_PROMPT_RECALL_CHARS || trimmed.startsWith("/")) return "";
  const seen = new Set<string>();
  for (const match of redactSecrets(trimmed.slice(0, 600)).matchAll(WORD)) {
    const key = match[0].toLowerCase().replace(/^[.\-/]+|[.\-/]+$/g, "");
    if (key.length < 2 || STOPWORDS.has(key) || key === "redacted" || seen.has(key)) continue;
    seen.add(key);
    if (seen.size >= maxTerms) break;
  }
  return [...seen].join(" ");
}

/** The `/retrieve/context` request Hermes `prefetch` sends. */
export function promptRecallRequest(query: string): Record<string, unknown> {
  return {
    query,
    node_limit: PROMPT_RECALL_LIMIT,
    chunk_limit: 0,
    graph_expansion_limit: 3,
    graph_max_depth: 2,
  };
}

/** Alphanumeric parts of a text, lowercased: `hook-core.ts` → hook, core, ts. */
function wordParts(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const sameWord = (left: string, right: string): boolean =>
  left === right ||
  (left.length >= 4 && right.length >= 4 && (left.startsWith(right) || right.startsWith(left)));

/** How many distinct query terms a recalled item actually mentions. A term
 * counts when one of its parts of three or more characters appears in the
 * text as a word (or as the stem of one: `update` ~ `updates`). Bare numbers
 * and two-letter fragments never count: "items 2-4" matched "n = 4". */
export function recallTermOverlap(query: string, text: string): { matched: number; usable: number } {
  const hay = wordParts(text);
  let matched = 0;
  let usable = 0;
  for (const term of new Set(query.split(/\s+/).filter(Boolean))) {
    const parts = wordParts(term).filter((part) => part.length >= 3 && !/^\d+$/.test(part));
    if (parts.length === 0) continue;
    usable += 1;
    if (parts.some((part) => hay.some((word) => sameWord(word, part)))) matched += 1;
  }
  return { matched, usable };
}

/** Relevance floor for an every-prompt injection: an item must mention two
 * distinct query terms. A single shared word let book notes about "the
 * Roadmap" answer an engineering prompt, and a prompt that yields only one
 * usable term is nearly always an acknowledgement ("Yes, please go ahead"
 * recalled passages containing "ahead"), so it injects nothing. */
function relevant(query: string | undefined, text: string): boolean {
  if (query === undefined) return true;
  const { matched, usable } = recallTermOverlap(query, text);
  return usable >= 2 && matched >= 2;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const oneLine = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const INFRA_TYPES = new Set(["Chunk", "Document", "Article", "Session"]);

function nodeType(node: Rec): string {
  const plain = str(node.node_type);
  return (
    (plain && plain !== "Custom" ? plain : undefined) ??
    str(rec(node.node_type)?.Custom) ??
    plain ??
    "Node"
  );
}

/** Render a `/retrieve/context` response as a compact recall block: one line
 * per item (type, label, one-line summary, source document title), at most
 * PROMPT_RECALL_LIMIT items and PROMPT_RECALL_MAX_CHARS characters. Returns
 * undefined when nothing is worth injecting. With `query` (the keywords the
 * request was built from) items below the relevance floor are dropped. With
 * `shown`, it receives one entry per rendered line, in order: the item's uid
 * (or label) and its space as the response reported it ("" when absent). */
export function renderPromptRecall(
  response: unknown,
  query?: string,
  shown?: Array<[string, string]>,
): string | undefined {
  const payload = rec(response);
  if (!payload) return undefined;
  const lines: string[] = [];
  const items: Array<[string, string]> = [];
  const spaceOf = (item: Rec): string => str(item.space_uid) ?? str(rec(item.props)?.space_uid) ?? "";
  const nodes = Array.isArray(rec(payload.graph)?.nodes) ? (rec(payload.graph)!.nodes as unknown[]) : [];
  for (const raw of nodes) {
    const node = rec(raw);
    if (!node || lines.length >= PROMPT_RECALL_LIMIT) continue;
    const type = nodeType(node);
    if (INFRA_TYPES.has(type)) continue;
    const props = rec(node.props);
    const label = str(node.label) ?? str(props?.label) ?? str(props?.name);
    if (!label) continue;
    const summary = str(node.summary) ?? str(props?.summary) ?? str(props?.description) ?? str(props?.content);
    const informative = summary && summary !== label ? summary : undefined;
    // A bare entity name (`_active_session_uid`, a file path) tells the model
    // nothing and takes one of five slots.
    if (!informative && type === "Entity") continue;
    if (!relevant(query, `${label} ${informative ?? ""}`)) continue;
    const docs = Array.isArray(node.source_documents) ? node.source_documents : [];
    const source = str(rec(docs[0])?.title);
    let line = `- [${type}] ${oneLine(label, 140)}`;
    // `true` from /retrieve, an object naming the replacement from /retrieve/context.
    if (node.superseded) line += " (superseded)";
    if (summary && summary !== label) line += ` — ${oneLine(summary, 240)}`;
    if (source) line += ` (source: ${oneLine(source, 100)})`;
    lines.push(line);
    items.push([str(node.uid) ?? label, spaceOf(node)]);
  }
  const articles = Array.isArray(payload.articles) ? payload.articles : [];
  for (const raw of articles) {
    const article = rec(raw);
    if (!article || lines.length >= PROMPT_RECALL_LIMIT) continue;
    const label = str(article.label);
    if (!label) continue;
    const content = str(article.content);
    if (!relevant(query, `${label} ${content ?? ""}`)) continue;
    lines.push(`- [Article] ${oneLine(label, 140)}${content ? ` — ${oneLine(content, 240)}` : ""}`);
    items.push([str(article.uid) ?? label, spaceOf(article)]);
  }
  if (lines.length === 0) return undefined;
  let block = "MindGraph recall (bounded):";
  for (const [i, line] of lines.entries()) {
    if (block.length + 1 + line.length > PROMPT_RECALL_MAX_CHARS) break;
    block += `\n${line}`;
    shown?.push(items[i]);
  }
  return block;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/** Text of a transcript message, or undefined when it carries none. Only
 * `text` blocks count: tool_use, tool_result, thinking and image blocks are
 * skipped entirely. */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => rec(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block!.text as string);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Harness-injected text that is not conversation: slash-command echoes,
 * local command output, and system reminders. */
function stripHarnessNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-(stdout|stderr)>[\s\S]*?<\/local-command-\1>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .trim();
}

/** Extract user and assistant text turns from Claude Code JSONL transcript
 * lines. Tool calls and tool results, meta lines, sidechains (subagents) and
 * compaction summaries are excluded. */
export function extractTranscriptTurns(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Rec | undefined;
    try {
      entry = rec(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || (entry.type !== "user" && entry.type !== "assistant")) continue;
    if (entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true) continue;
    const message = rec(entry.message);
    const raw = messageText(message?.content);
    if (!raw) continue;
    const text = stripHarnessNoise(raw);
    if (!text) continue;
    turns.push({ role: entry.type, text });
  }
  return turns;
}

/** Render turns the way Hermes renders a session batch ("User: …" /
 * "Assistant: …"), redacted and bounded to the most recent CAPTURE_MAX_CHARS. */
export function renderTranscript(turns: TranscriptTurn[]): string {
  const rendered = turns
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${redactSecrets(turn.text)}`)
    .join("\n\n");
  if (rendered.length <= CAPTURE_MAX_CHARS) return rendered;
  const tail = rendered.slice(rendered.length - CAPTURE_MAX_CHARS);
  const start = tail.search(/\n\n(User|Assistant): /);
  return start >= 0 ? tail.slice(start + 2) : tail;
}

/** Read complete JSONL lines appended after `offset` bytes. Returns the text
 * and the new offset (end of the last complete line). A transcript that
 * shrank below the stored offset (rewritten file) is read from the start. */
export function readTranscriptSince(
  file: string,
  offset = 0,
): { text: string; nextOffset: number } {
  const buffer = fs.readFileSync(file);
  const start = offset > buffer.length ? 0 : offset;
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < start) return { text: "", nextOffset: start };
  return {
    text: buffer.subarray(start, lastNewline + 1).toString("utf8"),
    nextOffset: lastNewline + 1,
  };
}

/** The exact `/ingest/session` body capture would send, or undefined when
 * there is no new text. Shared by the hook and `hooks preview`. */
export function buildCaptureRequest(
  transcriptPath: string,
  sessionId: string,
  offset: number,
  ids: { sessionUid?: string; agentId?: string },
): { body?: Record<string, unknown>; nextOffset: number; turns: number } {
  const { text, nextOffset } = readTranscriptSince(transcriptPath, offset);
  const turns = extractTranscriptTurns(text);
  const content = renderTranscript(turns);
  if (!content) return { nextOffset, turns: 0 };
  return {
    body: {
      content,
      title: `Claude Code session ${sessionId}`,
      ...(ids.sessionUid ? { session_uid: ids.sessionUid } : {}),
      ...(ids.agentId ? { agent_id: ids.agentId } : {}),
    },
    nextOffset,
    turns: turns.length,
  };
}

// ---- Per-turn session curator hook helpers (Step S5) -------------------------

export const CURATOR_MAX_TURN_CHARS = 3_000;
export const CURATOR_DEFAULT_MAX_TURNS_PER_DISPATCH = 4;
export const CURATOR_TARGET_WRITE_RATE = 0.55;
export const CURATOR_THROTTLE_WARMUP_TURNS = 8;

export interface CuratorTurnPair {
  user: string;
  assistant: string;
}

export interface CuratorThrottleState {
  turnsEvaluated: number;
  acceptedOps: number;
}

const ACK_PHRASE =
  "(?:yes|yeah|yep|yup|no|nope|ok|okay|sure|thanks|thank you|got it|sounds good|looks good|lgtm|continue|proceed|go ahead|do it|run it|ship it|next|done|approved|merge|stop|cancel|please|let'?s go|let'?s start)";
const TRIVIAL_CODING_ACK = new RegExp(`^${ACK_PHRASE}(?:[,;\\s]+${ACK_PHRASE})*[.!?, ]*$`, "i");

const DURABLE_INTENT_SIGNAL =
  /\b(?:decid(?:e|ed|ing|ion)|prefer(?:s|red|ence)?|constraint|standing rule|always|never|must not|do not|don'?t|forget|retract|remove|delete|instead|switch(?:ed|ing)? to|replac(?:e|ed|ing)|chang(?:e|ed|ing) to|no longer|deprecated|requirement|policy|architecture|freeze|frozen|pin(?:ned)?|agreed|lesson|invariant|budget|cap|deadline|target|rollout|shadow|consent)\b/i;

function clipCuratorText(text: string, maxChars: number): string {
  const scrubbed = redactSecrets(text).trim();
  if (scrubbed.length <= maxChars) return scrubbed;
  return `${scrubbed.slice(0, maxChars)}\n...[truncated]`;
}

/** Pair user/assistant text turns into curator turn pairs with secret redaction
 * and per-side length caps. Tool calls/output are already excluded by
 * `extractTranscriptTurns`. */
export function pairTranscriptTurns(
  turns: TranscriptTurn[],
  maxChars = CURATOR_MAX_TURN_CHARS,
): CuratorTurnPair[] {
  const pairs: CuratorTurnPair[] = [];
  let curUser: string | undefined;
  let asstParts: string[] = [];

  const flush = (): void => {
    if (curUser !== undefined) {
      const user = clipCuratorText(curUser, maxChars);
      const assistant = clipCuratorText(asstParts.join("\n"), maxChars);
      if (user) pairs.push({ user, assistant });
    }
    curUser = undefined;
    asstParts = [];
  };

  for (const turn of turns) {
    if (turn.role === "user") {
      flush();
      curUser = turn.text;
    } else if (curUser !== undefined) {
      asstParts.push(turn.text);
    }
  }
  flush();
  return pairs;
}

export function isTrivialCodingAck(userText: string): boolean {
  const trimmed = userText.trim();
  return trimmed.length === 0 || (trimmed.length <= 28 && TRIVIAL_CODING_ACK.test(trimmed));
}

export function hasDurableIntentSignal(pair: CuratorTurnPair): boolean {
  return DURABLE_INTENT_SIGNAL.test(pair.user);
}

/** Decide whether a coding-session turn should be sent to `POST /curator/turn`.
 * Always skips empty turns and trivial acknowledgements, always admits turns
 * with explicit durable/update/retraction user cues, and throttles routine
 * engineering turns once session write rate reaches `CURATOR_TARGET_WRITE_RATE`
 * (keeping coding-session writes <= 60/100 turns). */
export function shouldCurateTurn(
  pair: CuratorTurnPair,
  state: CuratorThrottleState,
): { send: boolean; reason: "trivial_ack" | "durable_signal" | "write_rate_throttle" | "eligible" } {
  if (isTrivialCodingAck(pair.user)) {
    return { send: false, reason: "trivial_ack" };
  }
  if (hasDurableIntentSignal(pair)) {
    return { send: true, reason: "durable_signal" };
  }
  if (
    state.turnsEvaluated >= CURATOR_THROTTLE_WARMUP_TURNS &&
    state.acceptedOps / Math.max(1, state.turnsEvaluated) >= CURATOR_TARGET_WRITE_RATE
  ) {
    return { send: false, reason: "write_rate_throttle" };
  }
  return { send: true, reason: "eligible" };
}

export interface PreparedCuratorTurns {
  requests: Array<{
    seq: number;
    pair: CuratorTurnPair;
    body: Record<string, unknown>;
  }>;
  nextOffset: number;
  evaluated: number;
  throttled: number;
  lastPair?: CuratorTurnPair;
  nextSeq: number;
}

/** Build bounded `POST /curator/turn` payloads from transcript bytes appended
 * since `offset`, applying secret redaction, coding-session write throttling,
 * and shadow (`dry_run: true`) vs live (`dry_run: false`) mode. */
export function buildCuratorTurnRequests(
  transcriptPath: string,
  sessionId: string,
  offset: number,
  opts: {
    spaceUid?: string;
    sessionUid?: string;
    dryRun: boolean;
    promptVersion?: string;
    startSeq?: number;
    prevTurn?: CuratorTurnPair;
    throttleState?: CuratorThrottleState;
    maxTurnsPerDispatch?: number;
    nowIso?: string;
  },
): PreparedCuratorTurns {
  const { text, nextOffset } = readTranscriptSince(transcriptPath, offset);
  const pairs = pairTranscriptTurns(extractTranscriptTurns(text));
  const maxTurns = opts.maxTurnsPerDispatch ?? CURATOR_DEFAULT_MAX_TURNS_PER_DISPATCH;
  const startSeq = opts.startSeq ?? 0;
  const nowIso = opts.nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const promptVersion = opts.promptVersion ?? "v3";
  const throttle = {
    turnsEvaluated: opts.throttleState?.turnsEvaluated ?? 0,
    acceptedOps: opts.throttleState?.acceptedOps ?? 0,
  };

  let prev = opts.prevTurn;
  let seq = startSeq;
  let throttled = 0;
  const requests: PreparedCuratorTurns["requests"] = [];

  for (const pair of pairs) {
    const verdict = shouldCurateTurn(pair, throttle);
    throttle.turnsEvaluated += 1;
    seq += 1;
    if (!verdict.send) {
      throttled += 1;
      prev = pair;
      continue;
    }
    const body: Record<string, unknown> = {
      ...(opts.spaceUid ? { space_uid: opts.spaceUid } : {}),
      session_uid: opts.sessionUid || `claude-code:${sessionId}`,
      idempotency_key: `mcp-curator:${sessionId}:${seq}`,
      occurred_at: nowIso,
      ...(prev ? { prev_turn: { user: prev.user, assistant: prev.assistant, occurred_at: nowIso } } : {}),
      turn: { user: pair.user, assistant: pair.assistant },
      prompt_version: promptVersion,
      dry_run: opts.dryRun,
    };
    requests.push({ seq, pair, body });
    prev = pair;
  }

  // Bound per-hook dispatch to the most recent `maxTurns` selected turns so
  // hooks remain fast and non-blocking even after long uninterrupted bursts.
  const bounded = requests.length > maxTurns ? requests.slice(requests.length - maxTurns) : requests;
  throttled += requests.length - bounded.length;

  return {
    requests: bounded,
    nextOffset,
    evaluated: pairs.length,
    throttled,
    lastPair: prev,
    nextSeq: seq,
  };
}
