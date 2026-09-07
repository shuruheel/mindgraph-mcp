import { MindGraphError } from "mindgraph";

/** Server typed-error bodies must reach the model — it can only self-correct
 * on errors it can see (30 burned turns in the first live dogfood). */
export function errorDetail(e: unknown): string {
  if (e instanceof MindGraphError && e.body !== undefined) {
    const detail = typeof e.body === "string" ? e.body : JSON.stringify(e.body);
    return `${e.message} — ${detail}`;
  }
  return e instanceof Error ? e.message : String(e);
}

// Machine-readable conflict state (409 bodies on servers newer than
// 1.11.2 — mindgraph-rs #41). errorDetail()
// flattens the body into the error STRING for the model; these keys must
// ALSO survive as JSON siblings of `error`, or the hooks' ledger re-sync can
// never read them and a fenced session replays its stale epoch forever.
const CONFLICT_STATE_KEYS = [
  "current_version",
  "current_epoch",
  "lease_expires_at",
  "lease_owner_agent_id",
] as const;

/** Structured fencing state lifted from a typed error body, for spreading
 * into the tool error JSON alongside the prose. */
export function conflictState(e: unknown): Record<string, unknown> {
  if (!(e instanceof MindGraphError) || !e.body || typeof e.body !== "object") {
    return {};
  }
  const body = e.body as Record<string, unknown>;
  const lifted: Record<string, unknown> = {};
  for (const key of CONFLICT_STATE_KEYS) {
    if (body[key] !== undefined) lifted[key] = body[key];
  }
  return lifted;
}

/** Works with older SDKs too: inspect the preserved body, not new SDK getters. */
export function toolError(e: unknown, fallbackCode?: string) {
  const body = e instanceof MindGraphError && e.body && typeof e.body === "object" && !Array.isArray(e.body)
    ? e.body as Record<string, unknown> : {};
  const code = typeof body.code === "string" ? body.code : fallbackCode;
  const payload = {
    error: errorDetail(e),
    ...conflictState(e),
    ...(e instanceof MindGraphError ? { status: e.status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(typeof body.retriable === "boolean" ? { retriable: body.retriable } : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true as const,
  };
}
