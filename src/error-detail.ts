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
