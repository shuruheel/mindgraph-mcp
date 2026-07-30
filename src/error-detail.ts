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

// Machine-readable conflict state (server ≥1.11.3 409 bodies). errorDetail()
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
