import { describe, expect, it, vi } from "vitest";
import { MindGraph, MindGraphError } from "mindgraph";
import type { OnDecision } from "../src/consent.js";
import { clientWithSpace, repositorySpace, withRepositorySpace } from "../src/repository-space.js";
import { handleTool } from "../src/tools.js";

const SPACE = "space:project:demo";

function decision(space: string | null = SPACE): OnDecision {
  return {
    state: "on",
    reason: "consented",
    directory: "/work/demo/src",
    root: "/work",
    kind: "workspace",
    repo: { root: "/work/demo", repo_id: "github.com/acme/demo", space_uid: space },
    space_uid: space,
    repositories: [],
    storeAcknowledged: true,
  };
}

function fakeClient() {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push([name, args]);
      return { uid: "n1" };
    });
  const client = {
    distill: record("distill"),
    capture: record("capture"),
    commit: record("commit"),
    deliberate: record("deliberate"),
    plan: record("plan"),
    journal: record("journal"),
    openDecision: record("openDecision"),
    addOption: record("addOption"),
    entity: record("entity"),
    memoryConfig: record("memoryConfig"),
  };
  return { client, calls, mg: client as unknown as MindGraph };
}

describe("clientWithSpace", () => {
  it("adds the Space to exactly the writes the server accepts it on", async () => {
    const { mg, calls } = fakeClient();
    const c = clientWithSpace(mg, SPACE);
    await c.distill({ output_type: "lesson", label: "l" } as never);
    await c.distill({ output_type: "skill", label: "s" } as never);
    for (const action of ["observation", "source", "snippet", "entity"]) {
      await c.capture({ action, label: action } as never);
    }
    for (const action of ["goal", "project", "milestone"]) {
      await c.commit({ action, label: action } as never);
    }
    for (const action of ["add_constraint", "resolve", "get_open"]) {
      await c.deliberate({ action } as never);
    }
    await c.plan({ action: "create_task", label: "t" } as never);
    await c.plan({ action: "update_status", target_uid: "t" } as never);
    await c.journal("j", { content: "x" }, { agent_id: "a" });
    await c.openDecision("d", { summary: "s" });
    await c.addOption("d1", "o", undefined);
    await c.entity({ action: "create", label: "e" } as never);

    const spaced = calls.map(([name, args]) => {
      const last = args[args.length - 1] as Record<string, unknown> | undefined;
      const req = (name === "distill" || name === "capture" || name === "commit" || name === "deliberate" || name === "plan" || name === "entity")
        ? (args[0] as Record<string, unknown>)
        : last;
      const label = (req?.action ?? req?.output_type ?? name) as string;
      return `${name}:${label}:${req?.space_uid ?? "-"}`;
    });
    expect(spaced).toEqual([
      `distill:lesson:${SPACE}`,
      "distill:skill:-",
      `capture:observation:${SPACE}`,
      `capture:source:${SPACE}`,
      `capture:snippet:${SPACE}`,
      "capture:entity:-",
      `commit:goal:${SPACE}`,
      `commit:project:${SPACE}`,
      `commit:milestone:${SPACE}`,
      `deliberate:add_constraint:${SPACE}`,
      "deliberate:resolve:-",
      "deliberate:get_open:-",
      `plan:create_task:${SPACE}`,
      "plan:update_status:-",
      `journal:journal:${SPACE}`,
      `openDecision:openDecision:${SPACE}`,
      `addOption:addOption:${SPACE}`,
      "entity:create:-",
    ]);
    // Other arguments pass through untouched.
    expect(calls[14][1].slice(0, 2)).toEqual(["j", { content: "x" }]);
    expect(calls[14][1][2]).toEqual({ agent_id: "a", space_uid: SPACE });
    expect(calls[16][1].slice(0, 2)).toEqual(["d1", "o"]);
  });
});

describe("repositorySpace", () => {
  it("comes only from a local consent decision with a pinned Space", () => {
    expect(repositorySpace({ consent: decision() })).toBe(SPACE);
    expect(repositorySpace({ consent: decision(), hosted: true })).toBeUndefined();
    expect(repositorySpace({ consent: decision(null) })).toBeUndefined();
    expect(repositorySpace({})).toBeUndefined();
  });
});

describe("withRepositorySpace", () => {
  const missing = () => new MindGraphError("No Space", 404, { code: "scope_not_found" });

  it("creates an unknown Space once, by directory name, and retries the write", async () => {
    const { client, mg } = fakeClient();
    const write = vi
      .fn()
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce("written");
    await expect(withRepositorySpace(mg, { consent: decision("space:project:once") }, write)).resolves.toBe(
      "written",
    );
    expect(write).toHaveBeenCalledTimes(2);
    expect(client.memoryConfig).toHaveBeenCalledTimes(1);
    expect(client.memoryConfig.mock.calls[0][0]).toEqual({
      action: "ensure_space",
      space_uid: "space:project:once",
      label: "repository demo",
    });
  });

  it("keeps the write's own error when the Space cannot be created", async () => {
    const { client, mg } = fakeClient();
    client.memoryConfig.mockRejectedValueOnce(new MindGraphError("unknown action", 400, { code: "unknown_action" }));
    const original = missing();
    const write = vi.fn().mockRejectedValue(original);
    await expect(withRepositorySpace(mg, { consent: decision("space:project:refused") }, write)).rejects.toBe(
      original,
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never retries other errors, and writes unchanged without a pinned Space", async () => {
    const { client, mg } = fakeClient();
    const forbidden = new MindGraphError("read-only", 403, { code: "space_write_forbidden" });
    const write = vi.fn().mockRejectedValue(forbidden);
    await expect(withRepositorySpace(mg, { consent: decision("space:project:ro") }, write)).rejects.toBe(forbidden);
    expect(client.memoryConfig).not.toHaveBeenCalled();

    const plain = vi.fn().mockResolvedValue("ok");
    await withRepositorySpace(mg, { consent: decision(null) }, plain);
    expect(plain.mock.calls[0][0]).toBe(mg);
  });
});

describe("handleTool", () => {
  it("sends the consented Space on a Lesson and ignores one the model supplies", async () => {
    const { client, mg } = fakeClient();
    const result = await handleTool(
      mg,
      "mindgraph_capture",
      { action: "lesson", label: "Use the pristine deploy copy", space_uid: "space:org" },
      {},
      { consent: decision() },
    );
    expect(result.isError).toBeFalsy();
    expect(client.distill).toHaveBeenCalledTimes(1);
    expect((client.distill.mock.calls[0][0] as Record<string, unknown>).space_uid).toBe(SPACE);
  });

  it("sends nothing extra outside a consented coding call", async () => {
    const { client, mg } = fakeClient();
    await handleTool(mg, "mindgraph_commit", { action: "goal", label: "Ship" }, {}, {});
    expect((client.commit.mock.calls[0][0] as Record<string, unknown>).space_uid).toBeUndefined();
  });
});
