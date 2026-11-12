import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools.js";
import { MEMORY_TOOL } from "../src/memory-tool.js";

const root = path.resolve(__dirname, "..");
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

describe("MCP Registry metadata (server.json)", () => {
  const server = read("server.json");
  const pkg = read("package.json");

  it("carries the package's version everywhere, so a bump cannot miss it", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it("names the server as package.json's mcpName does (the registry's ownership check)", () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.packages[0].identifier).toBe(pkg.name);
  });

  it("stays inside the registry schema's length limits and lists both doors", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.remotes).toEqual([{ type: "streamable-http", url: "https://mindgraph.cloud/mcp" }]);
    expect(server.packages[0].transport).toEqual({ type: "stdio" });
  });

  it("ships the changelog in the npm tarball", () => {
    expect(pkg.files).toContain("CHANGELOG.md");
  });
});

describe("tool annotations", () => {
  it("every tool declares all four behaviour hints", () => {
    for (const tool of [...TOOLS, MEMORY_TOOL]) {
      const hints = tool.annotations ?? {};
      for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof hints[key], `${tool.name}.${key}`).toBe("boolean");
      }
    }
  });

  it("marks reads read-only and only the tool that can forget as destructive", () => {
    const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.annotations]));
    expect(byName.mindgraph_retrieve?.readOnlyHint).toBe(true);
    expect(byName.mindgraph_series_query?.readOnlyHint).toBe(true);
    const destructive = TOOLS.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);
    expect(destructive).toEqual(["mindgraph_remember"]);
  });
});
