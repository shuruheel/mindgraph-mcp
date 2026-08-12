import { MindGraph } from "mindgraph";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { errorDetail } from "./error-detail.js";
import {
  CodegraphAdapter,
  UnknownRepositoryError,
  codeRefIdentityKey,
  invocationCwd,
  repositoryIdentityKey,
  type CodeRef,
  type RepositoryIdentity,
  type ResolvedCodeRef,
} from "./codegraph.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type EntityResponse = {
  uid?: string;
  status?: "created" | "existing" | "absent" | "exists_but_inaccessible";
  created?: boolean;
};

type StoredCodeRef = Omit<ResolvedCodeRef, "repoRoot">;

export type CodeClient = {
  entity: (request: Record<string, unknown>) => Promise<EntityResponse>;
  traverse: (request: Record<string, unknown>) => Promise<unknown>;
  getNode: (uid: string) => Promise<{
    uid: string;
    props?: Record<string, unknown>;
  }>;
  getNodesBatch?: (uids: string[]) => Promise<
    Array<{ uid: string; props?: Record<string, unknown> }>
  >;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const err = (code: string, message: string, details?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, code, details }),
    },
  ],
  isError: true,
});

export const CODE_TOOL: Tool = {
  name: "mindgraph_code",
  description:
    "Resolve typed code references through the local codegraph index and join them to persistent MindGraph memory/work. anchor creates exact repository/code anchors; recall reads attached graph context; expand reads callers/callees; affected reads impact for a code ref or Task/Execution. Ambiguous refs return candidates without writing. Refs with a path route to the repository defining that file (nearest declared root in .mindgraph/workspace.json); bare symbols resolve against the current repository only — pass path or repo to target a sibling.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["anchor", "recall", "expand", "affected"],
      },
      code_refs: {
        type: "array",
        maxItems: 50,
        items: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                repo: { type: "string" },
                path: { type: "string" },
                line: { type: "integer", minimum: 1 },
                symbol: { type: "string" },
                kind: { type: "string" },
                language: { type: "string" },
                signature: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      anchor_uids: {
        type: "array",
        maxItems: 50,
        items: { type: "string" },
        description: "Already-materialized code anchor UIDs (codegraph is not required for recall)",
      },
      repo: {
        type: "string",
        description: "Configured repository id or repository root",
      },
      repo_space_uid: {
        type: "string",
        description:
          "Writable shared Project/repository Space for new anchors (anchor requires this, a workspace space_uid, or MINDGRAPH_CODE_SPACE_UID)",
      },
      task_uid: { type: "string" },
      execution_uid: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      agent_id: { type: "string" },
    },
    required: ["action"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export async function handleCodeTool(
  client: MindGraph,
  args: Record<string, unknown>,
  adapter = new CodegraphAdapter({ cwd: invocationCwd(args) }),
): Promise<ToolResult> {
  const codeClient = client as unknown as CodeClient;
  const action = args.action as string;
  const refs = Array.isArray(args.code_refs)
    ? (args.code_refs as Array<CodeRef | string>)
    : [];
  const anchorUids = Array.isArray(args.anchor_uids)
    ? (args.anchor_uids as string[])
    : [];
  const agentId = typeof args.agent_id === "string" ? args.agent_id : "mcp";
  // No implicit space: anchors written without an explicit shared space would
  // silently fragment repository identity across per-agent private spaces.
  const fallbackSpaceUid =
    typeof args.repo_space_uid === "string" ? args.repo_space_uid : undefined;
  const options = {
    repo: typeof args.repo === "string" ? args.repo : undefined,
    fallbackSpaceUid,
  };
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  try {
    switch (action) {
      case "anchor": {
        if (refs.length === 0) return err("missing_code_refs", "code_refs is required for anchor");
        const resolution = await adapter.resolveRefs(refs, options);
        const resolved = resolution.results.flatMap((result) =>
          result.resolved && result.repository
            ? [{ ref: result.resolved, repository: result.repository }]
            : [],
        );
        const unresolved = resolution.results.filter((result) => !result.resolved);
        if (resolved.length === 0) {
          return ok({ ...resolution, anchors: [], wrote: false });
        }
        const missingSpace = resolved.find(
          ({ repository }) =>
            typeof args.repo_space_uid !== "string" && !repository.spaceUid,
        );
        if (missingSpace) {
          return err(
            "missing_repository_space",
            `repo_space_uid, a workspace space_uid, or MINDGRAPH_CODE_SPACE_UID is required for ${missingSpace.repository.repoId}`,
          );
        }
        const repositoryAnchors = new Map<
          string,
          EntityResponse & { repository: RepositoryIdentity }
        >();
        for (const { repository } of resolved) {
          if (repositoryAnchors.has(repository.repoRoot)) continue;
          const spaceUid =
            typeof args.repo_space_uid === "string"
              ? args.repo_space_uid
              : repository.spaceUid!;
          const anchored = await anchorRepository(
            codeClient,
            repository,
            spaceUid,
            agentId,
          );
          repositoryAnchors.set(repository.repoRoot, {
            ...anchored,
            repository,
          });
        }
        const anchors = [];
        for (const { ref, repository } of resolved) {
          const repositoryAnchor = repositoryAnchors.get(repository.repoRoot)!;
          if (!repositoryAnchor.uid) continue;
          const spaceUid =
            typeof args.repo_space_uid === "string"
              ? args.repo_space_uid
              : repository.spaceUid!;
          const anchor = await anchorCodeRef(
            codeClient,
            ref,
            repositoryAnchor.uid,
            spaceUid,
            agentId,
          );
          anchors.push(anchor);
        }
        return ok({
          availability: resolution.availability,
          repository: repositoryAnchors.values().next().value,
          repositories: [...repositoryAnchors.values()],
          anchors,
          unresolved,
          wrote: anchors.some((anchor) => anchor.created),
        });
      }
      case "recall": {
        const materialized = new Set(anchorUids);
        let resolution:
          | Awaited<ReturnType<CodegraphAdapter["resolveRefs"]>>
          | undefined;
        if (refs.length > 0) {
          resolution = await adapter.resolveRefs(refs, options);
          for (const result of resolution.results) {
            if (!result.resolved) continue;
            const uid = await resolveMaterializedUid(codeClient, result.resolved, agentId);
            if (uid) materialized.add(uid);
          }
        }
        if (materialized.size === 0) {
          return ok({
            availability: resolution?.availability,
            anchors: [],
            context: [],
            unresolved: resolution?.results.filter((result) => !result.resolved) ?? [],
          });
        }
        const context = await Promise.all(
          [...materialized].map(async (uid) => ({
            anchor_uid: uid,
            graph: await codeClient.traverse({
              action: "neighborhood",
              start_uid: uid,
              depth: 2,
              max_nodes: Math.min(limit ?? 20, 20),
            }),
          })),
        );
        return ok({
          availability: resolution?.availability,
          anchors: [...materialized],
          context,
          unresolved: resolution?.results.filter((result) => !result.resolved) ?? [],
        });
      }
      case "expand": {
        const target = await resolveSingleTarget(
          codeClient,
          adapter,
          refs,
          anchorUids,
          options,
        );
        if ("error" in target) return target.error;
        const expanded = await adapter.expand(target.ref, limit);
        const joined = await joinMaterialized(
          codeClient,
          [...expanded.callers, ...expanded.callees],
          agentId,
          Math.min(limit ?? 20, 20),
        );
        return ok({ anchor: target.ref, ...expanded, materialized: joined });
      }
      case "affected": {
        const targetUid =
          typeof args.task_uid === "string"
            ? args.task_uid
            : typeof args.execution_uid === "string"
              ? args.execution_uid
              : undefined;
        let graphContext: unknown;
        const graphRefs: ResolvedCodeRef[] = [];
        let unavailableRepositories: string[] = [];
        if (targetUid) {
          graphContext = await codeClient.traverse({
            action: "neighborhood",
            start_uid: targetUid,
            depth: 2,
            max_nodes: 50,
          });
          const fromGraph = await codeRefsFromGraphContext(
            codeClient,
            adapter,
            graphContext,
          );
          graphRefs.push(...fromGraph.refs);
          unavailableRepositories = fromGraph.unavailable;
        }
        if (refs.length > 0 || anchorUids.length > 0) {
          const target = await resolveSingleTarget(
            codeClient,
            adapter,
            refs,
            anchorUids,
            options,
          );
          if ("error" in target) return target.error;
          graphRefs.unshift(target.ref);
        }
        const unique = uniqueRefs(graphRefs);
        if (unique.length === 0) {
          return ok({
            target_uid: targetUid,
            graph_context: graphContext,
            affected: [],
            degradation:
              unavailableRepositories.length > 0
                ? `attached code anchors reference repositories unavailable here: ${unavailableRepositories.join(", ")}`
                : "no materialized code anchors were attached",
            ...(unavailableRepositories.length > 0
              ? { unavailable_repositories: unavailableRepositories }
              : {}),
          });
        }
        const impacts = await Promise.all(
          unique.map(async (ref) => ({ anchor: ref, ...(await adapter.affected(ref, limit)) })),
        );
        const structural = uniqueRefs(impacts.flatMap((impact) => impact.affected));
        const joined = await joinMaterialized(
          codeClient,
          structural,
          agentId,
          Math.min(limit ?? 50, 50),
        );
        return ok({
          target_uid: targetUid,
          graph_context: graphContext,
          impacts,
          materialized: joined,
          ...(unavailableRepositories.length > 0
            ? { unavailable_repositories: unavailableRepositories }
            : {}),
        });
      }
      default:
        return err("unknown_action", `unknown mindgraph_code action: ${action}`);
    }
  } catch (cause) {
    if (cause instanceof UnknownRepositoryError) {
      return err("unknown_repository", cause.message);
    }
    return err("code_tool_failed", errorDetail(cause));
  }
}

/** Attach optional typed code refs to the primary nodes created by another
 * static MCP write. Degradation is returned alongside that write; it never
 * rewrites or rolls back the already-successful memory/work operation. */
export async function attachCodeRefsToToolResult(
  client: MindGraph,
  result: ToolResult,
  args: Record<string, unknown>,
  adapter?: CodegraphAdapter,
): Promise<ToolResult> {
  if (result.isError || !Array.isArray(args.code_refs) || args.code_refs.length === 0) {
    return result;
  }
  const original = JSON.parse(result.content[0]?.text ?? "null") as unknown;
  const targetUids = primaryUids(original);
  if (targetUids.length === 0) {
    return ok({
      result: original,
      code_anchors: {
        wrote: false,
        caveat: "the write response exposed no primary UID to attach",
      },
    });
  }
  const anchorResult = await handleCodeTool(
    client,
    {
      action: "anchor",
      code_refs: args.code_refs,
      repo: args.repo,
      repo_space_uid: args.repo_space_uid,
      agent_id: args.agent_id,
      // Keeps the default adapter anchored to the live session directory
      // rather than wherever the MCP server process was launched.
      invocation_context: args.invocation_context,
    },
    adapter,
  );
  const anchors = JSON.parse(anchorResult.content[0]?.text ?? "null") as {
    anchors?: EntityResponse[];
  };
  if (!anchorResult.isError) {
    const codeClient = client as unknown as CodeClient;
    const anchorUids = (anchors.anchors ?? []).flatMap((anchor) =>
      anchor.uid ? [anchor.uid] : [],
    );
    for (const targetUid of targetUids) {
      for (const anchorUid of anchorUids) {
        await codeClient.entity({
          action: "relate",
          source_uid: targetUid,
          target_uid: anchorUid,
          edge_type: args.action === "lesson" ? "ABOUT" : "RELEVANT_TO",
          agent_id: args.agent_id,
        });
      }
    }
  }
  return ok({ result: original, code_anchors: anchors });
}

export async function anchorRepository(
  client: CodeClient,
  repository: RepositoryIdentity,
  spaceUid: string,
  agentId: string,
): Promise<EntityResponse> {
  return client.entity({
    action: "create",
    label: repository.repoId,
    props: {
      entity_type: "repository",
      canonical_name: repository.repoId,
      identifiers: { repo_id: repository.repoId },
    },
    identity: {
      namespace: "external.code",
      key_version: 1,
      key: repositoryIdentityKey(repository),
    },
    identity_space_uid: spaceUid,
    agent_id: agentId,
  });
}

async function anchorCodeRef(
  client: CodeClient,
  ref: ResolvedCodeRef,
  repositoryUid: string,
  spaceUid: string,
  agentId: string,
): Promise<EntityResponse & { ref: ResolvedCodeRef }> {
  const response = await client.entity({
    action: "create",
    label: ref.qualifiedName,
    props: {
      entity_type: ref.kind === "file" ? "code_file" : "code_symbol",
      canonical_name: ref.qualifiedName,
      identifiers: {
        repo_id: ref.repoId,
        path: ref.path,
        qualified_name: ref.qualifiedName,
      },
      attributes: { code_ref: storedCodeRef(ref) },
    },
    identity: {
      namespace: "external.code",
      key_version: 1,
      key: codeRefIdentityKey(ref),
    },
    identity_space_uid: spaceUid,
    agent_id: agentId,
  });
  if (response.uid) {
    await client.entity({
      action: "relate",
      source_uid: response.uid,
      target_uid: repositoryUid,
      edge_type: "PART_OF",
      agent_id: agentId,
    });
  }
  return { ...response, ref };
}

async function resolveMaterializedUid(
  client: CodeClient,
  ref: ResolvedCodeRef,
  agentId: string,
): Promise<string | undefined> {
  const response = await client.entity({
    action: "resolve_identity",
    identity: {
      namespace: "external.code",
      key_version: 1,
      key: codeRefIdentityKey(ref),
    },
    agent_id: agentId,
  });
  return response.status === "existing" ? response.uid : undefined;
}

async function codeRefFromAnchor(
  client: CodeClient,
  adapter: CodegraphAdapter,
  uid: string,
): Promise<{ ref: ResolvedCodeRef } | { missingRepo: string } | undefined> {
  const node = await client.getNode(uid);
  const attributes = node.props?.attributes;
  if (!attributes || typeof attributes !== "object") return undefined;
  const codeRef = (attributes as Record<string, unknown>).code_ref;
  if (!isStoredCodeRef(codeRef)) return undefined;
  try {
    const repository = await adapter.resolveRepository(codeRef.repoId);
    return { ref: { ...codeRef, repoRoot: repository.repoRoot } };
  } catch (cause) {
    if (cause instanceof UnknownRepositoryError) {
      return { missingRepo: codeRef.repoId };
    }
    throw cause;
  }
}

async function resolveSingleTarget(
  client: CodeClient,
  adapter: CodegraphAdapter,
  refs: Array<CodeRef | string>,
  anchorUids: string[],
  options: { repo?: string; fallbackSpaceUid?: string },
): Promise<{ ref: ResolvedCodeRef } | { error: ToolResult }> {
  if (refs.length > 1 || anchorUids.length > 1) {
    return { error: err("ambiguous_target", "expand/affected accepts exactly one code target") };
  }
  if (anchorUids.length === 1) {
    const outcome = await codeRefFromAnchor(client, adapter, anchorUids[0]);
    if (!outcome) {
      return { error: err("invalid_anchor", "anchor UID does not contain a typed code_ref") };
    }
    if ("missingRepo" in outcome) {
      return {
        error: err(
          "repository_unavailable",
          `repository ${outcome.missingRepo} is not checked out here or declared in .mindgraph/workspace.json; expand/affected need its local index`,
        ),
      };
    }
    return { ref: outcome.ref };
  }
  if (refs.length !== 1) {
    return { error: err("missing_code_ref", "one code_ref or anchor_uid is required") };
  }
  const resolution = await adapter.resolveRefs(refs, options);
  const result = resolution.results[0];
  if (!result.resolved) {
    return {
      error: ok({
        availability: resolution.availability,
        result,
        wrote: false,
      }),
    };
  }
  return { ref: result.resolved };
}

async function joinMaterialized(
  client: CodeClient,
  refs: ResolvedCodeRef[],
  agentId: string,
  limit: number,
): Promise<Array<{ ref: ResolvedCodeRef; anchor_uid: string; graph: unknown }>> {
  const joined = [];
  for (const ref of uniqueRefs(refs).slice(0, limit)) {
    const uid = await resolveMaterializedUid(client, ref, agentId);
    if (!uid) continue;
    joined.push({
      ref,
      anchor_uid: uid,
      graph: await client.traverse({
        action: "neighborhood",
        start_uid: uid,
        depth: 2,
        max_nodes: 20,
      }),
    });
  }
  return joined;
}

async function codeRefsFromGraphContext(
  client: CodeClient,
  adapter: CodegraphAdapter,
  context: unknown,
): Promise<{ refs: ResolvedCodeRef[]; unavailable: string[] }> {
  const uids = new Set<string>();
  collectUids(context, uids);
  if (uids.size === 0) return { refs: [], unavailable: [] };
  const nodes = client.getNodesBatch
    ? await client.getNodesBatch([...uids])
    : await Promise.all([...uids].map((uid) => client.getNode(uid).catch(() => undefined)));
  const stored = nodes.flatMap((node) => {
    if (!node) return [];
    const attributes = node.props?.attributes;
    if (!attributes || typeof attributes !== "object") return [];
    const codeRef = (attributes as Record<string, unknown>).code_ref;
    return isStoredCodeRef(codeRef) ? [codeRef] : [];
  });
  const refs: ResolvedCodeRef[] = [];
  const unavailable = new Set<string>();
  for (const ref of stored) {
    try {
      const repository = await adapter.resolveRepository(ref.repoId);
      refs.push({ ...ref, repoRoot: repository.repoRoot });
    } catch (cause) {
      if (cause instanceof UnknownRepositoryError) {
        unavailable.add(ref.repoId);
      } else {
        throw cause;
      }
    }
  }
  return { refs, unavailable: [...unavailable].sort() };
}

function collectUids(value: unknown, uids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUids(item, uids));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === "string" &&
      ["uid", "node_uid", "neighbor_uid", "from_uid", "to_uid"].includes(key)
    ) {
      uids.add(child);
    } else {
      collectUids(child, uids);
    }
  }
}

function isStoredCodeRef(value: unknown): value is StoredCodeRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.repoId === "string" &&
    typeof ref.path === "string" &&
    typeof ref.language === "string" &&
    typeof ref.kind === "string" &&
    typeof ref.qualifiedName === "string" &&
    (typeof ref.signature === "string" || ref.signature === null) &&
    typeof ref.startLine === "number" &&
    typeof ref.endLine === "number"
  );
}

function storedCodeRef(ref: ResolvedCodeRef): StoredCodeRef {
  const { repoRoot: _localOnly, ...stored } = ref;
  return stored;
}

function uniqueRefs(refs: ResolvedCodeRef[]): ResolvedCodeRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.repoId}:${ref.path}:${ref.qualifiedName}:${ref.signature ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function primaryUids(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const keys = [
    "uid",
    "claim_uid",
    "goal_uid",
    "project_uid",
    "milestone_uid",
    "decision_uid",
    "task_uid",
    "plan_uid",
    "step_uid",
    "execution_uid",
    "lesson_uid",
  ];
  return [
    ...new Set(
      keys.flatMap((key) => (typeof object[key] === "string" ? [object[key] as string] : [])),
    ),
  ];
}
