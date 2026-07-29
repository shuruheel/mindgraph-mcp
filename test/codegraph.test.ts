import fs from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { MindGraph } from "mindgraph";
import {
  attachCodeRefsToToolResult,
  handleCodeTool,
} from "../src/code-tool.js";
import { CodegraphAdapter } from "../src/codegraph.js";

const fakeBinary = resolve("test/fixtures/fake-codegraph.mjs");

function queryHit(overrides: Record<string, unknown> = {}) {
  return {
    node: {
      kind: "function",
      name: "target",
      qualifiedName: "module.target",
      filePath: "src/module.ts",
      language: "typescript",
      startLine: 10,
      endLine: 20,
      signature: "(value: string): Promise<void>",
      ...overrides,
    },
    score: 100,
  };
}

function adapterEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MINDGRAPH_CODEGRAPH_BIN: fakeBinary,
    MINDGRAPH_REPO_ID: "github.com/example/repo",
    ...extra,
  };
}

describe("CodegraphAdapter", () => {
  it("uses an explicit workspace map to route each ref to its defining sibling repo", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "mindgraph-workspace-"),
    );
    const engine = path.join(workspace, "engine");
    const core = path.join(workspace, "core");
    const unconfigured = path.join(workspace, "unconfigured");
    for (const root of [engine, core, unconfigured]) {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "module.ts"), "export {};\n");
    }
    fs.mkdirSync(path.join(workspace, ".mindgraph"));
    fs.writeFileSync(
      path.join(workspace, ".mindgraph", "workspace.json"),
      JSON.stringify({
        v: 1,
        workspace_id: "overlay",
        repositories: [
          {
            repo_id: "github.com/example/engine",
            root: "engine",
            space_uid: "space:repo:engine",
          },
          {
            repo_id: "github.com/example/core",
            root: "core",
            space_uid: "space:repo:core",
          },
        ],
      }),
    );
    try {
      const adapter = new CodegraphAdapter({
        env: adapterEnv({
          MINDGRAPH_REPO_ID: undefined,
          FAKE_CODEGRAPH_QUERY: JSON.stringify([queryHit()]),
        }),
        cwd: workspace,
      });
      const configured = await adapter.resolveRepositories();
      expect(configured.map((repo) => repo.repoId)).toEqual([
        "github.com/example/engine",
        "github.com/example/core",
      ]);
      expect(configured.map((repo) => repo.repoRoot)).not.toContain(
        unconfigured,
      );

      const result = await adapter.resolveRefs([
        {
          path: path.join(engine, "src", "module.ts"),
          symbol: "target",
        },
        {
          path: path.join(core, "src", "module.ts"),
          symbol: "target",
        },
      ]);
      expect(result.results.map((item) => item.resolved?.repoId)).toEqual([
        "github.com/example/engine",
        "github.com/example/core",
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes remote identity and persists a path-free clone fallback", async () => {
    const remoteRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "mindgraph-remote-id-"),
    );
    const localRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "mindgraph-local-id-"),
    );
    try {
      execFileSync("git", ["init", "-q", remoteRoot]);
      execFileSync("git", [
        "-C",
        remoteRoot,
        "remote",
        "add",
        "origin",
        "https://user:secret@GitHub.com/Example/Engine.git?token=hidden#fragment",
      ]);
      const remote = await new CodegraphAdapter({
        env: adapterEnv({ MINDGRAPH_REPO_ID: undefined }),
        cwd: remoteRoot,
      }).resolveRepository();
      expect(remote.repoId).toBe("github.com/Example/Engine");
      expect(remote.repoId).not.toContain("secret");
      expect(remote.repoId).not.toContain("token");

      execFileSync("git", ["init", "-q", localRoot]);
      const first = await new CodegraphAdapter({
        env: adapterEnv({ MINDGRAPH_REPO_ID: undefined }),
        cwd: localRoot,
      }).resolveRepository();
      const second = await new CodegraphAdapter({
        env: adapterEnv({ MINDGRAPH_REPO_ID: undefined }),
        cwd: localRoot,
      }).resolveRepository();
      expect(second.repoId).toBe(first.repoId);
      expect(first.repoId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(
        fs.readFileSync(
          path.join(localRoot, ".git", "mindgraph", "repository-id"),
          "utf8",
        ).trim(),
      ).toBe(first.repoId);
    } finally {
      fs.rmSync(remoteRoot, { recursive: true, force: true });
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it("resolves a typed overload by path and signature", async () => {
    const adapter = new CodegraphAdapter({
      env: adapterEnv({
        FAKE_CODEGRAPH_QUERY: JSON.stringify([
          queryHit(),
          queryHit({
            startLine: 30,
            endLine: 40,
            signature: "(value: number): Promise<void>",
          }),
        ]),
      }),
      cwd: process.cwd(),
    });
    const result = await adapter.resolveRefs([
      {
        path: "src/module.ts",
        symbol: "target",
        signature: "(value: number): Promise<void>",
      },
    ]);
    expect(result.results[0].resolved).toMatchObject({
      repoId: "github.com/example/repo",
      qualifiedName: "module.target",
      startLine: 30,
    });
  });

  it("returns candidates without choosing an ambiguous symbol", async () => {
    const adapter = new CodegraphAdapter({
      env: adapterEnv({
        FAKE_CODEGRAPH_QUERY: JSON.stringify([
          queryHit({ qualifiedName: "trait.target" }),
          queryHit({ qualifiedName: "impl.target", startLine: 30, endLine: 40 }),
        ]),
      }),
    });
    const result = await adapter.resolveRefs([{ symbol: "target" }]);
    expect(result.results[0].error).toBe("ambiguous");
    expect(result.results[0].candidates).toHaveLength(2);
    expect(result.results[0].resolved).toBeUndefined();
  });

  it("distinguishes stale, wrong-index, and timed-out states", async () => {
    const stale = new CodegraphAdapter({
      env: adapterEnv({
        FAKE_CODEGRAPH_STATUS: JSON.stringify({
          initialized: true,
          lastIndexed: "2026-07-27T00:00:00.000Z",
          pendingChanges: { added: 1, modified: 2, removed: 0 },
          worktreeMismatch: null,
          index: { state: "complete", pendingRefs: 1, reindexRecommended: true },
        }),
      }),
    });
    const staleResult = await stale.resolveRefs([{ symbol: "target" }]);
    expect(staleResult.availability.available).toBe(true);
    expect(staleResult.availability.stale).toBe(true);
    expect(staleResult.availability.caveats).toHaveLength(3);

    const wrong = new CodegraphAdapter({
      env: adapterEnv({
        FAKE_CODEGRAPH_STATUS: JSON.stringify({
          initialized: true,
          worktreeMismatch: { expected: "/a", actual: "/b" },
          index: { state: "complete" },
        }),
      }),
    });
    const wrongResult = await wrong.resolveRefs([{ symbol: "target" }]);
    expect(wrongResult.availability.reason).toBe("wrong_index");

    const timeout = new CodegraphAdapter({
      env: adapterEnv({ FAKE_CODEGRAPH_TIMEOUT: "1" }),
      timeoutMs: 25,
    });
    const timedOut = await timeout.resolveRefs([{ symbol: "target" }]);
    expect(timedOut.availability.reason).toBe("timeout");
  });

  it("caches status for sixty seconds", async () => {
    let now = 0;
    const env = adapterEnv();
    const adapter = new CodegraphAdapter({ env, now: () => now });
    const repository = await adapter.resolveRepository();
    const first = await adapter.availability(repository);
    env.FAKE_CODEGRAPH_STATUS = JSON.stringify({
      initialized: false,
      index: { state: "missing" },
    });
    const cached = await adapter.availability(repository);
    expect(cached).toEqual(first);
    now = 60_001;
    const refreshed = await adapter.availability(repository);
    expect(refreshed.reason).toBe("index_incomplete");
  });
});

describe("mindgraph_code", () => {
  it("does not write when resolution is ambiguous", async () => {
    const entity = vi.fn();
    const client = {
      entity,
      traverse: vi.fn(),
      getNode: vi.fn(),
    } as unknown as MindGraph;
    const adapter = new CodegraphAdapter({
      env: adapterEnv({
        FAKE_CODEGRAPH_QUERY: JSON.stringify([
          queryHit({ qualifiedName: "trait.target" }),
          queryHit({ qualifiedName: "impl.target", startLine: 30, endLine: 40 }),
        ]),
      }),
    });
    const result = await handleCodeTool(
      client,
      {
        action: "anchor",
        code_refs: [{ symbol: "target" }],
        repo_space_uid: "space:project:repo",
        agent_id: "agent",
      },
      adapter,
    );
    expect(result.isError).not.toBe(true);
    expect(entity).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.results[0].error).toBe("ambiguous");
    expect(payload.wrote).toBe(false);
  });

  it("anchors repository and symbol then relates them", async () => {
    const entity = vi
      .fn()
      .mockResolvedValueOnce({ uid: "repo-uid", created: true, status: "created" })
      .mockResolvedValueOnce({ uid: "symbol-uid", created: true, status: "created" })
      .mockResolvedValueOnce({ uid: "edge-uid" });
    const client = {
      entity,
      traverse: vi.fn(),
      getNode: vi.fn(),
    } as unknown as MindGraph;
    const adapter = new CodegraphAdapter({
      env: adapterEnv({
        FAKE_CODEGRAPH_QUERY: JSON.stringify([queryHit()]),
      }),
    });
    const result = await handleCodeTool(
      client,
      {
        action: "anchor",
        code_refs: [{ path: "src/module.ts", symbol: "target" }],
        repo_space_uid: "space:project:repo",
        agent_id: "agent",
      },
      adapter,
    );
    expect(result.isError).not.toBe(true);
    expect(entity).toHaveBeenCalledTimes(3);
    expect(entity.mock.calls[0][0]).toMatchObject({
      action: "create",
      identity: { namespace: "external.code", key_version: 1 },
      identity_space_uid: "space:project:repo",
    });
    expect(entity.mock.calls[2][0]).toEqual({
      action: "relate",
      source_uid: "symbol-uid",
      target_uid: "repo-uid",
      edge_type: "PART_OF",
      agent_id: "agent",
    });
  });

  it("anchors a multi-repo batch under each defining repository and space", async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "mindgraph-anchor-workspace-"),
    );
    const engine = path.join(workspace, "engine");
    const core = path.join(workspace, "core");
    for (const root of [engine, core]) {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "module.ts"), "export {};\n");
    }
    fs.mkdirSync(path.join(workspace, ".mindgraph"));
    fs.writeFileSync(
      path.join(workspace, ".mindgraph", "workspace.json"),
      JSON.stringify({
        v: 1,
        repositories: [
          {
            repo_id: "engine",
            root: "engine",
            space_uid: "space:engine",
          },
          { repo_id: "core", root: "core", space_uid: "space:core" },
        ],
      }),
    );
    let symbols = 0;
    const entity = vi.fn(async (request: Record<string, unknown>) => {
      if (request.action === "relate") return { uid: `edge-${symbols}` };
      const props = request.props as Record<string, unknown>;
      if (props.entity_type === "repository") {
        return {
          uid: `repo-${(props.identifiers as Record<string, unknown>).repo_id}`,
          created: true,
        };
      }
      symbols += 1;
      return { uid: `symbol-${symbols}`, created: true };
    });
    const client = {
      entity,
      traverse: vi.fn(),
      getNode: vi.fn(),
    } as unknown as MindGraph;
    try {
      const adapter = new CodegraphAdapter({
        env: adapterEnv({
          MINDGRAPH_REPO_ID: undefined,
          FAKE_CODEGRAPH_QUERY: JSON.stringify([queryHit()]),
        }),
        cwd: workspace,
      });
      const result = await handleCodeTool(
        client,
        {
          action: "anchor",
          code_refs: [
            {
              path: path.join(engine, "src", "module.ts"),
              symbol: "target",
            },
            {
              path: path.join(core, "src", "module.ts"),
              symbol: "target",
            },
          ],
          agent_id: "agent",
        },
        adapter,
      );
      expect(result.isError).not.toBe(true);
      const creates = entity.mock.calls
        .map(([request]) => request as Record<string, unknown>)
        .filter((request) => request.action === "create");
      expect(creates).toHaveLength(4);
      expect(
        creates.map((request) => request.identity_space_uid),
      ).toEqual([
        "space:engine",
        "space:core",
        "space:engine",
        "space:core",
      ]);
      expect(JSON.stringify(creates)).not.toContain(workspace);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("attaches lesson code targets with ABOUT rather than generic relevance", async () => {
    const entity = vi
      .fn()
      .mockResolvedValueOnce({ uid: "repo-uid", created: true })
      .mockResolvedValueOnce({ uid: "symbol-uid", created: true })
      .mockResolvedValueOnce({ uid: "part-of-edge" })
      .mockResolvedValueOnce({ uid: "about-edge" });
    const client = {
      entity,
      traverse: vi.fn(),
      getNode: vi.fn(),
    } as unknown as MindGraph;
    const adapter = new CodegraphAdapter({
      env: adapterEnv({
        FAKE_CODEGRAPH_QUERY: JSON.stringify([queryHit()]),
      }),
    });
    const result = await attachCodeRefsToToolResult(
      client,
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ uid: "lesson-uid" }),
          },
        ],
      },
      {
        action: "lesson",
        code_refs: [{ path: "src/module.ts", symbol: "target" }],
        repo_space_uid: "space:project:repo",
        agent_id: "agent",
      },
      adapter,
    );
    expect(result.isError).not.toBe(true);
    expect(entity).toHaveBeenLastCalledWith({
      action: "relate",
      source_uid: "lesson-uid",
      target_uid: "symbol-uid",
      edge_type: "ABOUT",
      agent_id: "agent",
    });
  });
});
