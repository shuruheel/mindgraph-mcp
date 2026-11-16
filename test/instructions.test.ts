// Claude Code keeps only the first 4,096 characters of a server's
// instructions. Until 0.28 the coding profile sent 6,391 and its coding block
// (resume-first, mindgraph_code, what to write) was the part that got cut.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { MindGraph } from "mindgraph";
import {
  INSTRUCTION_HARNESSES,
  INSTRUCTION_PROFILES,
  buildInstructions,
  instructionSections,
  renderInstructions,
} from "../src/instructions.js";
import { hostedInstructions } from "../src/hosted-tools.js";
import { ALWAYS_LOAD_META_KEY } from "../src/memory-tool.js";
import { buildMindGraphServer } from "../src/server.js";
import { formatVersionSkewNote } from "../src/hook-installer.js";
import { CONSENT_OFF_INSTRUCTION } from "../src/instructions.js";
import { handleCodeTool } from "../src/code-tool.js";
import type { CodegraphAdapter } from "../src/codegraph.js";

const HOST_LIMIT = 4_000;
/** Claude Code's actual cut; HOST_LIMIT leaves room below it for the note. */
const CLAUDE_CODE_CUT = 4_096;
// index.ts appends this when the hook runner and server versions differ;
// long pre-release versions give the longest note it can send.
const LONGEST_SKEW_NOTE = formatVersionSkewNote("999.999.999-rc.99", "999.999.999-rc.99");
const CODING_LIMIT = 3_800;
const CODING_BLOCK_END = 2_000;

describe("server instructions fit the host's cut", () => {
  for (const profile of INSTRUCTION_PROFILES) {
    for (const harness of INSTRUCTION_HARNESSES) {
      it(`${profile} / ${harness} renders at most ${HOST_LIMIT} characters`, () => {
        const rendered = renderInstructions(profile, harness);
        expect(rendered.text).toBe(buildInstructions(profile, harness));
        expect(rendered.text.length).toBeLessThanOrEqual(HOST_LIMIT);
        // Offsets are what the coding assertions rely on: prove they index
        // the rendered text exactly.
        const sections = instructionSections(profile, harness);
        expect(rendered.sections.map((section) => section.id)).toEqual(
          sections.map((section) => section.id),
        );
        rendered.sections.forEach((section, index) => {
          expect(rendered.text.slice(section.start, section.end)).toBe(
            sections[index].text,
          );
        });
        expect(rendered.sections.at(-1)!.end).toBe(rendered.text.length);
        // With the version-skew note appended the whole string still fits,
        // so the note telling the user to re-run install-hooks is never cut.
        expect(
          `${rendered.text}\n\n${LONGEST_SKEW_NOTE}`.length,
        ).toBeLessThanOrEqual(CLAUDE_CODE_CUT);
        // The coding server also appends the off line where MindGraph is
        // not on; with both, nothing is cut.
        expect(
          `${rendered.text}\n\n${CONSENT_OFF_INSTRUCTION}\n\n${LONGEST_SKEW_NOTE}`.length,
        ).toBeLessThanOrEqual(CLAUDE_CODE_CUT);
      });
    }
  }

  it("an unknown profile renders as general", () => {
    expect(buildInstructions("something-else", "generic")).toBe(
      buildInstructions("general", "generic"),
    );
  });

  it("the hosted instructions stay under the cut too", () => {
    expect(hostedInstructions().length).toBeLessThanOrEqual(HOST_LIMIT);
  });

  for (const harness of INSTRUCTION_HARNESSES) {
    it(`coding / ${harness}: at most ${CODING_LIMIT} characters, coding block first and done before ${CODING_BLOCK_END}`, () => {
      const rendered = renderInstructions("coding", harness);
      expect(rendered.text.length).toBeLessThanOrEqual(CODING_LIMIT);
      const ids = rendered.sections.map((section) => section.id);
      const coding = rendered.sections.find((section) => section.id === "coding")!;
      expect(coding).toBeDefined();
      // Only the one-line intro may precede it.
      expect(ids.slice(0, 2)).toEqual(["intro", "coding"]);
      expect(coding.end).toBeLessThan(CODING_BLOCK_END);
      const block = rendered.text.slice(coding.start, coding.end);
      expect(block).toContain("mode `resume`");
      expect(block).toContain("`mindgraph_code`");
      expect(block).toContain(harness);
      // Recall takes refs inside code_refs; top-level path/symbol is ignored.
      expect(block).toContain("`code_refs: [{path, symbol}]`");
      // A settled decision is resolved, not left as an open one.
      expect(block).toContain("`resolve_decision`");
      // Harnesses whose SessionStart hook injects the brief say to use it.
      const injectsBrief = harness === "claude-code" || harness === "codex";
      expect(block.includes('"MindGraph durable work brief"')).toBe(injectsBrief);
    });
  }

  it("general profiles never mention the coding-only tools", () => {
    for (const harness of INSTRUCTION_HARNESSES) {
      const text = buildInstructions("general", harness);
      expect(text).not.toContain("mindgraph_code");
      expect(text).not.toContain("mindgraph_sync");
    }
  });

  it("no profile tells the model to combine node-type filters", () => {
    // Two or more node_types plus graph expansion returns HTTP 500 on the
    // server today; the old coding block recommended exactly that.
    for (const profile of INSTRUCTION_PROFILES) {
      for (const harness of INSTRUCTION_HARNESSES) {
        expect(buildInstructions(profile, harness)).not.toContain("node_types");
      }
    }
  });
});

async function listTools(profile: string): Promise<Array<{ name: string; _meta?: Record<string, unknown> }>> {
  const server = buildMindGraphServer({
    client: {} as unknown as MindGraph,
    serverVersion: "test",
    instructions: buildInstructions(profile, "claude-code"),
    profile,
    agentId: "agent-1",
    governance: { baseUrl: "https://api.example.test", apiKey: "mg_live_test", agentId: "agent-1" },
    memory: { profile },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "always-load", version: "0" });
  await mcp.connect(clientSide);
  const { tools } = await mcp.listTools();
  await mcp.close();
  return tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
}

describe("always-loaded tool hint", () => {
  it("tools/list marks mindgraph_memory, and only it, as always loaded", async () => {
    for (const profile of INSTRUCTION_PROFILES) {
      const tools = await listTools(profile);
      const hinted = tools
        .filter((tool) => tool._meta?.[ALWAYS_LOAD_META_KEY] === true)
        .map((tool) => tool.name);
      expect(hinted).toEqual(["mindgraph_memory"]);
      for (const tool of tools) {
        if (tool.name !== "mindgraph_memory") {
          expect(tool._meta?.[ALWAYS_LOAD_META_KEY]).toBeUndefined();
        }
      }
    }
    expect(ALWAYS_LOAD_META_KEY).toBe("anthropic/alwaysLoad");
  });

  it("the always-loaded description does not order a brief at every conversation start", async () => {
    for (const profile of INSTRUCTION_PROFILES) {
      const memory = (await listTools(profile)).find(
        (tool) => tool.name === "mindgraph_memory",
      ) as { description?: string } | undefined;
      expect(memory?.description).toBeDefined();
      expect(memory!.description).not.toContain("once at the start of a conversation");
      expect(memory!.description).toContain("mode='resume'");
    }
  });
});

describe("routes the coding instructions name", () => {
  it("the brief the coding block points to is the header the SessionStart hook writes", () => {
    const hookCore = readFileSync(new URL("../src/hook-core.ts", import.meta.url), "utf8");
    expect(hookCore).toContain('"MindGraph durable work brief (authoritative');
    expect(buildInstructions("coding", "claude-code")).toContain('"MindGraph durable work brief"');
  });

  it("recall without code_refs or anchor_uids is an error, not an empty success", async () => {
    const adapter = {
      resolveRefs: async () => {
        throw new Error("must not resolve");
      },
    } as unknown as CodegraphAdapter;
    const result = await handleCodeTool(
      {} as unknown as MindGraph,
      { action: "recall", path: "src/a.ts", symbol: "f" },
      adapter,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing_code_refs");
  });
});
