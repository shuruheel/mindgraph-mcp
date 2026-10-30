// I7 / A9: the stdio package's `tools/list` must not change under the hosted
// refactor. The fixture was captured from the pre-refactor `index.ts` wiring
// (ListTools = toolsForProfile(PROFILE) + generated tools, empty here because
// the mock client has no manifest endpoint); the shared builder in stdio mode
// must reproduce it exactly. Regenerate deliberately with
// UPDATE_STDIO_FIXTURE=1 when a tool schema changes on purpose.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MindGraph } from "mindgraph";
import { buildMindGraphServer } from "../src/server.js";

const FIXTURE = new URL("./fixtures/stdio-tools-list.json", import.meta.url);

/** The stdio entry's wiring (index.ts) with its env-derived values stubbed. */
async function stdioToolsList(profile: string): Promise<unknown[]> {
  const client = {} as unknown as MindGraph;
  const server = buildMindGraphServer({
    client,
    serverVersion: "test",
    instructions: "",
    profile,
    agentId: "agent-1",
    governance: { baseUrl: "https://api.example.test", apiKey: "mg_live_test", agentId: "agent-1" },
    memory: { profile },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "parity", version: "0" });
  await mcp.connect(clientSide);
  const { tools } = await mcp.listTools();
  await mcp.close();
  return tools;
}

function render(lists: Record<string, unknown[]>): string {
  // One tool per line keeps the fixture diffable without a 3,000-line file.
  const body = Object.entries(lists)
    .map(
      ([profile, tools]) =>
        `  ${JSON.stringify(profile)}: [\n${tools
          .map((tool) => `    ${JSON.stringify(tool)}`)
          .join(",\n")}\n  ]`,
    )
    .join(",\n");
  return `{\n${body}\n}\n`;
}

describe("stdio tools/list parity (I7)", () => {
  it("matches the pre-refactor fixture for both profiles", async () => {
    const actual = render({
      general: await stdioToolsList("general"),
      coding: await stdioToolsList("coding"),
    });
    if (process.env.UPDATE_STDIO_FIXTURE) writeFileSync(FIXTURE, actual);
    expect(actual).toBe(readFileSync(FIXTURE, "utf8"));
  });
});
