import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { MindGraph } from "mindgraph";
import { handleSyncTool } from "../src/sync-tool.js";
import { toolsForProfile } from "../src/tools.js";

const cleanup: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindgraph-sync-"));
  cleanup.push(root);
  execFileSync("git", ["init", "-q", root]);
  fs.mkdirSync(path.join(root, "memory"));
  fs.writeFileSync(path.join(root, "memory", "note.md"), "# Durable\n\nAtomic sync.\n");
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    async memorySync(request: Record<string, unknown>) {
      calls.push(request);
      return { state: "untracked" };
    },
  } as unknown as MindGraph;
  return { root, calls, client };
}

afterEach(() => {
  for (const root of cleanup.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("mindgraph_sync", () => {
  it("scans only repository memory providers and sends opaque repo identity", async () => {
    const { root, calls, client } = fixture();
    const result = await handleSyncTool(client, {
      action: "scan",
      invocation_context: { cwd: root },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].logical_path).toBe("memory/note.md");
    expect(body.repo_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(calls[0]).toMatchObject({
      action: "scan",
      provider: "claude_project",
      logical_path: "memory/note.md",
      file_present: true,
    });
    expect(JSON.stringify(calls[0])).not.toContain(root);
  });

  it("fans out only across explicitly configured workspace repositories", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "mindgraph-sync-workspace-"),
    );
    cleanup.push(workspace);
    const engine = path.join(workspace, "engine");
    const core = path.join(workspace, "core");
    const ignored = path.join(workspace, "ignored");
    for (const root of [engine, core, ignored]) {
      fs.mkdirSync(path.join(root, "memory"), { recursive: true });
      fs.writeFileSync(path.join(root, "memory", "note.md"), `# ${root}\n`);
    }
    fs.mkdirSync(path.join(workspace, ".mindgraph"));
    fs.writeFileSync(
      path.join(workspace, ".mindgraph", "workspace.json"),
      JSON.stringify({
        v: 1,
        repositories: [
          { repo_id: "engine", root: "engine" },
          { repo_id: "core", root: "core" },
        ],
      }),
    );
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      async memorySync(request: Record<string, unknown>) {
        calls.push(request);
        return { state: "untracked" };
      },
    } as unknown as MindGraph;

    const result = await handleSyncTool(client, {
      action: "scan",
      workspace: true,
      invocation_context: { cwd: workspace },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.repositories.map((item: { repo_id: string }) => item.repo_id)).toEqual([
      "engine",
      "core",
    ]);
    expect(calls.map((call) => call.repo_id)).toEqual(["engine", "core"]);
    expect(JSON.stringify(calls)).not.toContain(ignored);
  });

  it("loads begin content locally, strips cwd, and rejects path escape", async () => {
    const { root, calls, client } = fixture();
    await handleSyncTool(client, {
      action: "begin",
      logical_path: "memory/note.md",
      planned_fingerprints: ["a"],
      repo_space_uid: "space:repo",
      invocation_context: { cwd: root },
    });
    expect(calls[0].content).toContain("Atomic sync.");
    expect(calls[0].content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0]).not.toHaveProperty("invocation_context");

    const escaped = await handleSyncTool(client, {
      action: "begin",
      logical_path: "../outside.md",
      invocation_context: { cwd: root },
    });
    expect(escaped.isError).toBe(true);
    expect(escaped.content[0].text).toContain("escapes repository root");
  });

  it("hides coding tools in the general profile", () => {
    expect(toolsForProfile("general").map((tool) => tool.name)).not.toContain(
      "mindgraph_sync",
    );
    expect(toolsForProfile("general").map((tool) => tool.name)).not.toContain(
      "mindgraph_code",
    );
    expect(toolsForProfile("coding").map((tool) => tool.name)).toContain(
      "mindgraph_sync",
    );
  });
});
