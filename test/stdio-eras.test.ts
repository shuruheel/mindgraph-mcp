// The stdio entry serves both protocol eras from one factory: a 2026-07-28
// host (per-request envelope, `server/discover`, no handshake) and a 2025-era
// host (`initialize`). Spawns the built bundle, as a real host does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ENTRY = path.join(__dirname, "..", "dist", "index.js");
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function connect(mode: "auto" | "legacy") {
  // A private HOME keeps the hook-runner refresh away from the real one; the
  // base URL refuses connections, so nothing leaves the machine.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mindgraph-stdio-era-"));
  cleanup.push(home);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      MINDGRAPH_API_KEY: "mg_live_test_not_a_real_key",
      MINDGRAPH_BASE_URL: "http://127.0.0.1:9",
      MINDGRAPH_GOVERNANCE: "off",
    },
    stderr: "ignore",
  });
  const mcp = new Client({ name: "era-test", version: "0" }, { versionNegotiation: { mode } });
  await mcp.connect(transport);
  return mcp;
}

describe.runIf(fs.existsSync(ENTRY))("stdio entry protocol eras", () => {
  it("serves a 2026-07-28 host", async () => {
    const mcp = await connect("auto");
    expect(mcp.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toContain("mindgraph_memory");
    await mcp.close();
  }, 20_000);

  it("serves a 2025-era host through initialize", async () => {
    const mcp = await connect("legacy");
    expect(mcp.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toContain("mindgraph_memory");
    await mcp.close();
  }, 20_000);
});
