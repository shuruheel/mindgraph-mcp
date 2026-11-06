import { describe, expect, it } from "vitest";
import { renderContext } from "../src/render.js";

describe("renderContext with server-side text (evidence plan R2)", () => {
  it("passes the server's context_text through unchanged", () => {
    const raw = {
      context_text: "Legend: …\nAs of: 2024-06-01\n## Dated evidence (earliest first)\n[2024-04-05] Claim — budget is $8,000 [current]",
      graph: { nodes: [{ uid: "a", label: "ignored", node_type: "Claim" }], edges: [] },
      used_tokens: 40,
      truncated: false,
    };
    expect(renderContext(raw)).toBe(raw.context_text);
  });

  it("applies the character budget as a guard on the server text", () => {
    const raw = { context_text: "x".repeat(1000), graph: { nodes: [], edges: [] } };
    const out = renderContext(raw, 600)!;
    expect(out.startsWith("x".repeat(600))).toBe(true);
    expect(out).toContain("[truncated to 600 characters]");
  });

  it("falls back to the local renderer when the server did not render", () => {
    const raw = { graph: { nodes: [{ uid: "a", label: "Pilot budget", node_type: "Concept", summary: "a concept" }], edges: [] } };
    const out = renderContext(raw)!;
    expect(out).toContain("Pilot budget");
  });
});
