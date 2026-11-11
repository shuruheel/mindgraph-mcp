import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runClaudeHook, type HookClient } from "../src/claude-hooks.js";
import { previewCapture, readHookStats } from "../src/hook-core.js";
import {
  extractTranscriptTurns,
  promptRecallQuery,
  recallTermOverlap,
  redactSecrets,
  renderPromptRecall,
} from "../src/hook-memory.js";
import {
  installClaudeHooks,
  refreshOwnedClaudeHooks,
  uninstallClaudeHooks,
} from "../src/hook-installer.js";

const FIXTURE = path.join(__dirname, "fixtures", "claude-transcript.jsonl");
const cleanup: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindgraph-n17-"));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CONTEXT = {
  graph: {
    nodes: [
      {
        uid: "n1",
        node_type: "Decision",
        label: "Bound prompt recall",
        summary: "Five items,\n4,000 characters",
        source_documents: [{ uid: "d1", title: "Hermes README" }],
      },
      { uid: "c1", node_type: "Chunk", label: "chunk text" },
      { uid: "n2", node_type: { Custom: "Customer" }, label: "Voya" },
    ],
  },
  articles: [{ uid: "a1", label: "Recall design", content: "Article body" }],
};

type Rec = Record<string, unknown>;
function fake(recall: unknown = {}, ingest: (r: Rec) => Promise<unknown> = async () => ({})) {
  const requests: Rec[] = [];
  const ingests: Rec[] = [];
  const client: HookClient = {
    session: async () => ({ uid: "session-graph" }),
    plan: async () => ({}),
    async retrieveContext(request) {
      requests.push(request);
      return typeof recall === "function" ? (recall as () => Promise<unknown>)() : recall;
    },
    async ingestSession(request) {
      await ingest(request);
      ingests.push(request);
      return {};
    },
  };
  return { client, requests, ingests };
}

function promptInput(prompt: string) {
  return {
    session_id: "s-recall",
    cwd: os.tmpdir(),
    hook_event_name: "UserPromptSubmit",
    prompt,
  };
}

describe("UserPromptSubmit recall", () => {
  it("builds a keyword query and skips short prompts and slash commands", () => {
    expect(promptRecallQuery("How should we bound the prompt recall budget?")).toBe(
      "bound prompt recall budget",
    );
    expect(promptRecallQuery("fix it")).toBe("");
    expect(promptRecallQuery("/compact keep the recall notes")).toBe("");
    expect(promptRecallQuery("rotate token=supersecretvalue123 for the deploy")).not.toContain(
      "supersecret",
    );
  });

  it("renders one line per item with type, label, summary and source", () => {
    const block = renderPromptRecall(CONTEXT)!;
    expect(block.split("\n")).toEqual([
      "MindGraph recall (bounded):",
      "- [Decision] Bound prompt recall — Five items, 4,000 characters (source: Hermes README)",
      "- [Customer] Voya",
      "- [Article] Recall design — Article body",
    ]);
    expect(renderPromptRecall({ graph: { nodes: [] } })).toBeUndefined();
  });

  it("marks a superseded item in either wire shape", () => {
    const recall = (superseded: unknown) =>
      renderPromptRecall({ graph: { nodes: [{ uid: "n1", node_type: "Decision", label: "Ship Friday", superseded }] } });
    expect(recall({ head_uid: "n2", head_label: "Ship Monday" })).toContain("- [Decision] Ship Friday (superseded)");
    expect(recall(true)).toContain("- [Decision] Ship Friday (superseded)");
    expect(recall(false)).not.toContain("(superseded)");
    expect(recall(undefined)).not.toContain("(superseded)");
  });

  it("drops items below the relevance floor when the query is known", () => {
    // One shared word is not enough: the Article mentions only "recall".
    expect(renderPromptRecall(CONTEXT, "bound prompt recall")!.split("\n")).toEqual([
      "MindGraph recall (bounded):",
      "- [Decision] Bound prompt recall — Five items, 4,000 characters (source: Hermes README)",
    ]);
    const noise = {
      graph: {
        nodes: [
          {
            node_type: "Pattern",
            label: "Roadmap as motion imitating movement",
            summary: "The Roadmap became an example of diplomatic activity without substantive movement.",
          },
          { node_type: "Concept", label: "Workable criterion (n=4)", summary: "The criterion for n = 4." },
          { node_type: "Entity", label: "_active_session_uid" },
          {
            node_type: "Journal",
            label: "Roadmap review 2026-10-30",
            summary: "Queue re-ranked; the roadmap update moved Health first.",
          },
        ],
      },
    };
    // The real prompts that surfaced these lines in a live session.
    const roadmap = promptRecallQuery(
      "Can you make sure the roadmap is up to date without including unnecessary updates in it?",
    );
    expect(roadmap).toBe("roadmap date unnecessary updates");
    expect(renderPromptRecall(noise, roadmap)!.split("\n")).toEqual([
      "MindGraph recall (bounded):",
      "- [Journal] Roadmap review 2026-10-30 — Queue re-ranked; the roadmap update moved Health first.",
    ]);
    // No usable term (numbers and two-letter fragments never count): inject nothing.
    expect(renderPromptRecall(noise, promptRecallQuery("Yes, please build items 2-4."))).toBeUndefined();
    // One usable term is an acknowledgement, not a topic: inject nothing.
    const ahead = {
      graph: { nodes: [{ node_type: "Claim", label: "Enlightened ruler plans ahead", summary: "Lays plans well ahead." }] },
    };
    expect(promptRecallQuery("Yes, please go ahead.")).toBe("ahead");
    expect(renderPromptRecall(ahead, "ahead")).toBeUndefined();
    // Without a query the renderer keeps its old behaviour, minus bare entities.
    expect(renderPromptRecall(noise)!.split("\n")).toHaveLength(4);
    expect(recallTermOverlap("hook-core.ts lease", "src/hook-core.ts renews the lease")).toEqual({
      matched: 2,
      usable: 2,
    });
  });

  it("records per-event hook statistics for the session", async () => {
    const runtimeDir = tempDir();
    const { client } = fake(CONTEXT);
    await runClaudeHook(promptInput("How should we bound prompt recall?"), client, { runtimeDir });
    await runClaudeHook(promptInput("Something unrelated entirely to anything stored"), client, { runtimeDir });
    const stats = readHookStats(undefined, { runtimeDir })!;
    expect(stats.events.UserPromptSubmit.count).toBe(2);
    expect(stats.events.UserPromptSubmit.injectedChars).toBe(
      renderPromptRecall(CONTEXT, "bound prompt recall")!.length,
    );
    expect(readHookStats("no-such-session", { runtimeDir })).toBeUndefined();
  });

  it("bounds the block to 4,000 characters and 5 items", () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      uid: `n${i}`,
      node_type: "Claim",
      label: `claim ${i} ${"x".repeat(130)}`,
      summary: "y".repeat(500),
    }));
    const block = renderPromptRecall({ graph: { nodes } })!;
    expect(block.length).toBeLessThanOrEqual(4_000);
    expect(block.split("\n")).toHaveLength(6);
  });

  it("sends the Hermes prefetch shape, injects once, and dedups an unchanged block", async () => {
    const runtimeDir = tempDir();
    const { client, requests } = fake(CONTEXT);
    const first = await runClaudeHook(promptInput("How should we bound prompt recall?"), client, {
      runtimeDir,
    });
    expect(requests[0]).toEqual({
      query: "bound prompt recall",
      node_limit: 5,
      chunk_limit: 0,
      graph_expansion_limit: 3,
      graph_max_depth: 2,
    });
    expect(first).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: renderPromptRecall(CONTEXT, "bound prompt recall"),
      },
    });
    const second = await runClaudeHook(promptInput("Bound prompt recall again please"), client, {
      runtimeDir,
    });
    expect(second).toEqual({});
  });

  it("fails open on errors, timeouts and when disabled", async () => {
    const runtimeDir = tempDir();
    const failing = fake(() => Promise.reject(new Error("503")));
    expect(await runClaudeHook(promptInput("what about the deploy plan"), failing.client, { runtimeDir })).toEqual({});
    const hanging = fake(() => new Promise(() => undefined));
    expect(
      await runClaudeHook(promptInput("what about the deploy plan"), hanging.client, {
        runtimeDir,
        promptRecallTimeoutMs: 20,
      }),
    ).toEqual({});
    const disabled = fake(CONTEXT);
    expect(
      await runClaudeHook(promptInput("what about the deploy plan"), disabled.client, {
        runtimeDir,
        promptRecall: false,
      }),
    ).toEqual({});
    expect(disabled.requests).toHaveLength(0);
  });
});

describe("transcript capture", () => {
  it("extracts only user/assistant text and redacts secrets", () => {
    const turns = extractTranscriptTurns(fs.readFileSync(FIXTURE, "utf8"));
    expect(turns).toEqual([
      {
        role: "user",
        text: "How should we bound prompt recall? my key is mg_live_abcdefghijklmnopqrstuvwxyz123456",
      },
      { role: "assistant", text: "Cap it at five items and 4,000 characters." },
      { role: "assistant", text: "Done." },
    ]);
    expect(redactSecrets(turns[0].text)).toBe("How should we bound prompt recall? my key is [REDACTED]");
  });

  it("PreCompact ingests new turns once, tracks the offset, and never sends tool output", async () => {
    const runtimeDir = tempDir();
    const transcript = path.join(tempDir(), "s-cap.jsonl");
    fs.copyFileSync(FIXTURE, transcript);
    const { client, ingests } = fake();
    const input = {
      session_id: "s-cap",
      cwd: os.tmpdir(),
      hook_event_name: "PreCompact",
      trigger: "auto",
      transcript_path: transcript,
    };
    // Off by default: nothing is sent.
    expect(await runClaudeHook(input, client, { runtimeDir, agentId: "a1" })).toEqual({});
    expect(ingests).toHaveLength(0);

    await runClaudeHook(input, client, { runtimeDir, agentId: "a1", capture: true });
    expect(ingests).toHaveLength(1);
    expect(ingests[0]).toEqual({
      content:
        "User: How should we bound prompt recall? my key is [REDACTED]\n\n" +
        "Assistant: Cap it at five items and 4,000 characters.\n\nAssistant: Done.",
      title: "Claude Code session s-cap",
      session_uid: "session-graph",
      agent_id: "a1",
    });
    const sent = JSON.stringify(ingests);
    expect(sent).not.toContain("TOOL OUTPUT");
    expect(sent).not.toContain("cat ~/.secret");
    expect(sent).not.toContain("private reasoning");

    // Nothing new: no second ingest. New turns: only those are sent, at SessionEnd too.
    await runClaudeHook(input, client, { runtimeDir, agentId: "a1", capture: true });
    expect(ingests).toHaveLength(1);
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "One more question" } })}\n`,
    );
    expect(previewCapture(transcript, "s-cap", { runtimeDir, agentId: "a1" }).body?.content).toBe(
      "User: One more question",
    );
    await runClaudeHook(
      { ...input, hook_event_name: "SessionEnd", reason: "exit" },
      client,
      { runtimeDir, agentId: "a1", capture: true },
    );
    expect(ingests).toHaveLength(2);
    expect(ingests[1].content).toBe("User: One more question");
  });

  it("keeps the offset when ingest fails so the turns are retried", async () => {
    const runtimeDir = tempDir();
    const transcript = path.join(tempDir(), "s-fail.jsonl");
    fs.copyFileSync(FIXTURE, transcript);
    let fail = true;
    const { client, ingests: sent } = fake({}, async () => {
      if (fail) throw new Error("502");
    });
    const input = {
      session_id: "s-fail",
      cwd: os.tmpdir(),
      hook_event_name: "PreCompact",
      transcript_path: transcript,
    };
    expect(await runClaudeHook(input, client, { runtimeDir, capture: true })).toEqual({});
    fail = false;
    await runClaudeHook(input, client, { runtimeDir, capture: true });
    expect(sent).toHaveLength(1);
  });
});

describe("installer: prompt recall and capture flags", () => {
  type Settings = { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
  const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Settings;

  it("installs UserPromptSubmit by default and PreCompact only with capture", () => {
    const root = tempDir();
    const file = installClaudeHooks("project", root).path;
    let settings = read(file);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(5);
    expect(settings.hooks.PreCompact).toBeUndefined();
    expect(settings.hooks.SessionStart[0].hooks[0].timeout).toBe(30);
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(30);
    expect(JSON.stringify(settings)).not.toContain("mg_");

    installClaudeHooks("project", root, { promptRecall: false, capture: true });
    settings = read(file);
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    expect(settings.hooks.PreCompact[0].hooks[0].timeout).toBe(30);

    expect(uninstallClaudeHooks("project", root).removed).toBe(8);
    settings = read(file);
    expect(settings.hooks).toEqual({});
  });

  it("disabling recall keeps a foreign UserPromptSubmit hook", () => {
    const root = tempDir();
    const file = path.join(root, ".claude", "settings.json");
    const foreign = { hooks: [{ type: "command", command: "echo mine" }] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [foreign] } }));
    installClaudeHooks("project", root);
    expect(read(file).hooks.UserPromptSubmit).toHaveLength(2);
    installClaudeHooks("project", root, { promptRecall: false });
    expect(read(file).hooks.UserPromptSubmit).toEqual([foreign]);
  });

  it("self-healing refresh honors the stored choices in hooks.json", () => {
    const home = tempDir();
    const project = tempDir();
    installClaudeHooks("project", project, { promptRecall: false, capture: true });
    fs.mkdirSync(path.join(home, ".mindgraph"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".mindgraph", "hooks.json"),
      JSON.stringify({ promptRecall: false, capture: true }),
    );
    refreshOwnedClaudeHooks(project, home);
    const settings = read(path.join(project, ".claude", "settings.json"));
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    expect(settings.hooks.PreCompact).toHaveLength(1);
  });
});
