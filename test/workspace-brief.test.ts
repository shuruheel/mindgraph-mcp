import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MindGraph } from "mindgraph";
import { runClaudeHook, type HookClient } from "../src/claude-hooks.js";
import { CodegraphAdapter } from "../src/codegraph.js";
import { handleMemoryTool } from "../src/memory-tool.js";
import { renderResumeContext } from "../src/render.js";
import { resolveRepositoryScope } from "../src/workspace-scope.js";

const cleanup: string[] = [];
function tempDir(prefix: string): string {
  // realpath: macOS tmp is a symlink, and the adapter compares real paths.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** parent/ws/.mindgraph/workspace.json declaring parent/ws/{a,b}. */
function workspaceUnderParent(): { parent: string; workspace: string } {
  const parent = tempDir("mindgraph-h2-parent-");
  const workspace = path.join(parent, "ws");
  for (const repo of ["a", "b"]) {
    fs.mkdirSync(path.join(workspace, repo, ".git"), { recursive: true });
  }
  fs.mkdirSync(path.join(workspace, ".mindgraph"));
  fs.writeFileSync(
    path.join(workspace, ".mindgraph", "workspace.json"),
    JSON.stringify({
      v: 1,
      workspace_id: "h2",
      repositories: [
        { root: "a", repo_id: "example/a" },
        { root: "b", repo_id: "example/b" },
      ],
    }),
  );
  return { parent, workspace };
}

const WORKSPACE_BRIEF = {
  action: "resume_work",
  task: { uid: "task-b1", label: "Ship the B change", version: 2, props: { status: "pending" } },
  selection_reason: "pending",
  task_scope_uids: ["uid:example/b"],
  other_eligible: [
    { uid: "task-a1", label: "Fix A", status: "in_progress", priority: "high", scope_uids: ["uid:example/a"] },
    { uid: "task-b2", label: "Tidy B", status: "pending", priority: null, scope_uids: ["uid:example/b"] },
    { uid: "task-a2", label: "Document A", status: "pending", scope_uids: ["uid:example/a"] },
  ],
  eligible_total: 6,
};

function hookClient(resume: Record<string, unknown>) {
  const plans: Array<Record<string, unknown>> = [];
  const client = {
    async session() {
      return { uid: "session-graph" };
    },
    async plan(request: Record<string, unknown>) {
      plans.push(request);
      return request.action === "resume_work" ? resume : {};
    },
    async entity(request: Record<string, unknown>) {
      const key = (request.identity as { key: { repo_id: string } }).key;
      return { status: "existing", uid: `uid:${key.repo_id}` };
    },
  } as unknown as HookClient;
  return { client, plans };
}

async function sessionStart(cwd: string, client: HookClient): Promise<string> {
  const output = await runClaudeHook(
    { hook_event_name: "SessionStart", session_id: `h2-${path.basename(cwd)}`, cwd, source: "startup" },
    client,
    { agentId: "h2-agent", runtimeDir: tempDir("mindgraph-h2-runtime-") },
  );
  return JSON.stringify(output);
}

describe("H2 — the work brief covers the workspace, not one folder", () => {
  it("from the directory above a workspace, lists the other eligible work by repository", async () => {
    // Failure prevented: a session started in the parent of the checkouts
    // was told no durable work exists, or shown one task and nothing else.
    const { parent } = workspaceUnderParent();
    const { client, plans } = hookClient(WORKSPACE_BRIEF);
    const context = await sessionStart(parent, client);

    const resume = plans.find((request) => request.action === "resume_work")!;
    expect([...(resume.scope_uids as string[])].sort()).toEqual(["uid:example/a", "uid:example/b"]);
    expect(resume.limit).toBeGreaterThan(1);

    expect(context).toContain("Ship the B change [task-b1]");
    expect(context).toContain("Repository: example/b");
    expect(context).toContain("Other eligible work in this scope (3 shown, 2 more not listed");
    // Grouped by repository, in the order the server ranked the work.
    const order = ["example/a:", "Fix A [task-a1] — in_progress, priority high", "Document A [task-a2] — pending", "example/b:", "Tidy B [task-b2] — pending"];
    let at = -1;
    for (const piece of order) {
      const next = context.indexOf(piece, at + 1);
      expect(next, piece).toBeGreaterThan(at);
      at = next;
    }
  });

  it("from the workspace root and from inside a declared repository, uses the same scope", async () => {
    const { workspace } = workspaceUnderParent();
    for (const cwd of [workspace, path.join(workspace, "a")]) {
      const { client, plans } = hookClient(WORKSPACE_BRIEF);
      await sessionStart(cwd, client);
      const resume = plans.find((request) => request.action === "resume_work")!;
      expect([...(resume.scope_uids as string[])].sort()).toEqual(["uid:example/a", "uid:example/b"]);
    }
  });

  it("a single repository asks for one task and renders no list", async () => {
    const root = tempDir("mindgraph-h2-single-");
    fs.mkdirSync(path.join(root, ".git"));
    const { client, plans } = hookClient({ ...WORKSPACE_BRIEF, other_eligible: [], eligible_total: 1 });
    const context = await sessionStart(root, client);
    const resume = plans.find((request) => request.action === "resume_work")!;
    expect(resume.scope_uids).toHaveLength(1);
    expect(resume).not.toHaveProperty("limit");
    expect(context).not.toContain("Other eligible work");
    expect(context).not.toContain("Repository:");
  });

  it("a server that predates the list still yields the one-task brief", async () => {
    const { parent } = workspaceUnderParent();
    const { task, selection_reason } = WORKSPACE_BRIEF;
    const { client } = hookClient({ action: "resume_work", task, selection_reason });
    const context = await sessionStart(parent, client);
    expect(context).toContain("Ship the B change [task-b1]");
    expect(context).not.toContain("Other eligible work");
  });

  it("only the brief looks one level down: code routing keeps the upward search", async () => {
    // Failure prevented: a code ref or a sync scan run from a parent folder
    // silently reaching into a workspace the caller never named.
    const { parent } = workspaceUnderParent();
    expect(await new CodegraphAdapter({ cwd: parent, env: {} }).resolveRepositories()).toEqual([]);
    const found = await new CodegraphAdapter({ cwd: parent, env: {}, childWorkspaces: true }).resolveRepositories();
    expect(found.map((repository) => repository.repoId).sort()).toEqual(["example/a", "example/b"]);
    // Two levels down is out of reach.
    const grandparent = tempDir("mindgraph-h2-grandparent-");
    fs.cpSync(parent, path.join(grandparent, "nested"), { recursive: true });
    expect(
      await new CodegraphAdapter({ cwd: grandparent, env: {}, childWorkspaces: true }).resolveRepositories(),
    ).toEqual([]);
  });
});

describe("H2 — repository uids are remembered per tenant", () => {
  function countingClient() {
    let lookups = 0;
    const client = {
      async entity(request: Record<string, unknown>) {
        lookups += 1;
        const key = (request.identity as { key: { repo_id: string } }).key;
        return { status: "existing", uid: `uid:${key.repo_id}` };
      },
    };
    return { client, lookups: () => lookups };
  }

  it("a second run asks the server nothing; another tenant or an expired entry asks again", async () => {
    // Failure prevented: a uid resolved under one API key or organization
    // scoping a resume in another, which would find no work there.
    const { workspace } = workspaceUnderParent();
    const dir = tempDir("mindgraph-h2-cache-");
    let now = 1_000_000;
    const cache = (tenant: string) => ({ dir, tenant, now: () => now });
    const { client, lookups } = countingClient();

    const first = await resolveRepositoryScope(workspace, client, "agent", { cache: cache("t1") });
    expect(lookups()).toBe(2);
    const second = await resolveRepositoryScope(workspace, client, "agent", { cache: cache("t1") });
    expect(lookups()).toBe(2);
    expect(second).toEqual(first);
    expect(second.names).toEqual({ "uid:example/a": "example/a", "uid:example/b": "example/b" });
    expect(fs.statSync(path.join(dir, "repository-scopes.json")).mode & 0o077).toBe(0);

    await resolveRepositoryScope(workspace, client, "agent", { cache: cache("t2") });
    expect(lookups()).toBe(4);

    now += 13 * 60 * 60 * 1000;
    await resolveRepositoryScope(workspace, client, "agent", { cache: cache("t2") });
    expect(lookups()).toBe(6);

    // No cache named: every run resolves.
    await resolveRepositoryScope(workspace, client, "agent");
    expect(lookups()).toBe(8);
  });

  it("a failed lookup is not remembered", async () => {
    const { workspace } = workspaceUnderParent();
    const dir = tempDir("mindgraph-h2-cache-");
    let fail = true;
    const client = {
      async entity(request: Record<string, unknown>) {
        const key = (request.identity as { key: { repo_id: string } }).key;
        if (fail && key.repo_id === "example/a") throw new Error("403");
        return { status: "existing", uid: `uid:${key.repo_id}` };
      },
    };
    const partial = await resolveRepositoryScope(workspace, client, "agent", { cache: { dir, tenant: "t" } });
    expect(partial.uids).toEqual(["uid:example/b"]);
    expect(partial.failures).toEqual(["example/a: 403"]);
    fail = false;
    const whole = await resolveRepositoryScope(workspace, client, "agent", { cache: { dir, tenant: "t" } });
    expect([...whole.uids].sort()).toEqual(["uid:example/a", "uid:example/b"]);
    expect(whole.failures).toEqual([]);
  });
});

describe("H2 — mindgraph_memory resume accepts scope: workspace", () => {
  const names = { "uid:example/a": "example/a", "uid:example/b": "example/b" };
  function memoryClient(resume: unknown = WORKSPACE_BRIEF) {
    return {
      retrieveContext: vi.fn(),
      plan: vi.fn(async () => resume),
    } as unknown as Pick<MindGraph, "retrieveContext" | "plan"> & Record<string, ReturnType<typeof vi.fn>>;
  }

  it("resolves the declared repositories, asks for the list and renders it", async () => {
    const c = memoryClient();
    const result = await handleMemoryTool(
      c,
      { action: "context", mode: "resume", scope: "workspace" },
      {
        agentId: "agent-1",
        resolveWorkspaceScope: async () => ({ uids: Object.keys(names), names, failures: ["example/c: 403"] }),
      },
    );
    expect(result.isError).toBeFalsy();
    const request = c.plan.mock.calls[0][0] as Record<string, unknown>;
    expect(request.scope_uids).toEqual(Object.keys(names));
    expect(request.limit).toBeGreaterThan(1);
    const text = result.content[0].text;
    expect(text).toContain("## Other eligible work (3 shown, 2 more not listed)");
    expect(text).toContain("- example/a: Fix A [task-a1] — in_progress, priority high");
    const structured = result.structuredContent as {
      items: Array<{ uid: string }>;
      scope: { workspace_repositories: string[] };
      warnings: Array<{ code: string }>;
    };
    expect(structured.items.map((item) => item.uid)).toEqual(
      expect.arrayContaining(["task-b1", "task-a1", "task-b2", "task-a2"]),
    );
    expect(structured.scope.workspace_repositories).toEqual(["example/a", "example/b"]);
    // A repository that failed to resolve is reported, not silently dropped.
    expect(structured.warnings.map((warning) => warning.code)).toContain("workspace_scope_partial");
  });

  it("refuses where there is no checkout, and when nothing resolves", async () => {
    const hosted = await handleMemoryTool(memoryClient(), { action: "context", mode: "resume", scope: "workspace" }, {});
    expect(hosted.isError).toBe(true);
    expect(hosted.content[0].text).toContain("local MindGraph MCP server");

    // Failure prevented: an empty scope sent as "no scope" would select from
    // every task in the org and present it as the workspace.
    const c = memoryClient();
    const empty = await handleMemoryTool(
      c,
      { action: "context", mode: "resume", scope: "workspace" },
      { resolveWorkspaceScope: async () => ({ uids: [], names: {}, failures: ["example/a: 403"] }) },
    );
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain("example/a: 403");
    expect(c.plan).not.toHaveBeenCalled();
  });

  it("without scope, the request and the output are unchanged", async () => {
    const c = memoryClient({ ...WORKSPACE_BRIEF, other_eligible: [] });
    const result = await handleMemoryTool(c, { action: "context", mode: "resume" }, {
      resolveWorkspaceScope: async () => {
        throw new Error("must not be called");
      },
    });
    expect((c.plan.mock.calls[0][0] as Record<string, unknown>).limit).toBe(1);
    expect(result.content[0].text).not.toContain("Other eligible work");
  });

  it("a scoped miss reports the count the server sends", () => {
    // The server sends a number; the renderer read it as an array, so the
    // note never appeared.
    expect(
      renderResumeContext({ action: "resume_work", task: null, status: "no_eligible_work", scoped_out_tasks: 4 }),
    ).toContain("4 task(s) exist outside the requested scope");
  });
});
