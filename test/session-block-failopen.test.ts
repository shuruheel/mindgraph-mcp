import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaudeHook } from "../src/claude-hooks.js";
import { readHookStats } from "../src/hook-core.js";
import { consentOn, makeRepo, pinned, tempDir } from "./fixtures/consent.js";

// The block renderer throws: the hook falls back to the work state alone.
vi.mock("../src/session-block.js", async (original) => ({
  ...(await original<typeof import("../src/session-block.js")>()),
  renderSessionBlock: () => {
    throw new Error("render failed");
  },
}));

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("session block fail-open", () => {
  it("injects the work state within the remaining budget and counts the failure", async () => {
    const base = tempDir("mindgraph-block-");
    cleanup.push(base);
    const root = makeRepo(path.join(base, "acme-api"));
    const runtimeDir = path.join(base, "runtime");
    const node = (i: number) => ({ uid: `n${i}`, node_type: "Claim", label: `${"z".repeat(300)} ${i}` });
    const many = Array.from({ length: 5 }, (_, i) => node(i));
    const out = await runClaudeHook(
      { session_id: "s1", cwd: root, hook_event_name: "SessionStart", source: "startup" },
      {
        entity: async () => ({ uid: "repository-1", status: "existing" }),
        session: async () => ({ uid: "session-graph" }),
        plan: async () => ({
          status: "ok",
          task: { uid: "t1", label: "Task" },
          goal: node(9),
          next_steps: many,
          blockers: many,
          knowledge: many,
        }),
        memoryList: async () => ({ items: [], next_cursor: null }),
      },
      {
        runtimeDir,
        consent: consentOn(root, [pinned(root)]),
        claudeConfigPath: path.join(root, "none.json"),
        budgetTokens: 400,
      },
    );
    const context = (out.hookSpecificOutput as { additionalContext: string }).additionalContext;
    expect(context).toContain("MindGraph durable work brief");
    // 400 tokens leave the 2,000-character floor for work state, never the
    // fixed 9,000 characters this path once used.
    expect(context.length).toBeGreaterThan(1_500);
    expect(context.length).toBeLessThanOrEqual(2_000);
    const stats = readHookStats("s1", { runtimeDir })!;
    expect(stats.failOpen).toBe(1);
    expect(stats.lastFailOpen?.reason).toBe("session block: render failed");
  });
});
