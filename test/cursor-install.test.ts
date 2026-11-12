import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cursorConfigPath,
  installCursor,
  uninstallCursor,
} from "../src/cursor-install.js";

describe("install-cursor", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mg-cursor-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const read = () =>
    JSON.parse(fs.readFileSync(cursorConfigPath(home), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };

  it("writes a coding-profile stdio entry to the user-level file, owner-only", () => {
    const result = installCursor({ apiKey: "mg_test", agentId: "cursor:me", homeDir: home });
    expect(result).toEqual({ file: path.join(home, ".cursor", "mcp.json"), updated: false });
    expect(read().mcpServers.mindgraph).toEqual({
      command: "npx",
      args: ["-y", "mindgraph-mcp@latest"],
      env: {
        MINDGRAPH_API_KEY: "mg_test",
        MINDGRAPH_PROFILE: "coding",
        MINDGRAPH_HARNESS: "cursor",
        MINDGRAPH_AGENT_ID: "cursor:me",
      },
    });
    expect(fs.statSync(result.file).mode & 0o777).toBe(0o600);
  });

  it("keeps other servers and unrelated keys, and reports a replacement", () => {
    const file = cursorConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        other: true,
        mcpServers: { firecrawl: { command: "npx" }, mindgraph: { url: "https://mindgraph.cloud/mcp" } },
      }),
    );
    const result = installCursor({ apiKey: "mg_test", baseUrl: "http://localhost:18790", homeDir: home });
    expect(result.updated).toBe(true);
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(config.other).toBe(true);
    expect(config.mcpServers.firecrawl).toEqual({ command: "npx" });
    expect(config.mcpServers.mindgraph.env.MINDGRAPH_BASE_URL).toBe("http://localhost:18790");
    expect(config.mcpServers.mindgraph.env.MINDGRAPH_AGENT_ID).toBeUndefined();
  });

  it("refuses a file that is not a JSON object and leaves it as it was", () => {
    const file = cursorConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "[]");
    expect(() => installCursor({ apiKey: "mg_test", homeDir: home })).toThrow(/not a JSON object/);
    expect(fs.readFileSync(file, "utf8")).toBe("[]");
  });

  it("uninstall removes only the mindgraph entry", () => {
    installCursor({ apiKey: "mg_test", homeDir: home });
    const file = cursorConfigPath(home);
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.mcpServers.firecrawl = { command: "npx" };
    fs.writeFileSync(file, JSON.stringify(config));
    expect(uninstallCursor(home)).toBe(true);
    expect(read().mcpServers).toEqual({ firecrawl: { command: "npx" } });
    expect(uninstallCursor(home)).toBe(false);
  });

  it("uninstall with no file reports nothing removed", () => {
    expect(uninstallCursor(home)).toBe(false);
  });
});
