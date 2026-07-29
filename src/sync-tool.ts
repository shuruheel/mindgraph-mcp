import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MindGraph } from "mindgraph";
import { CodegraphAdapter, type RepositoryIdentity } from "./codegraph.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type InvocationContext = {
  cwd?: string;
  repoId?: string;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const err = (code: string, message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ code, error: message }) }],
  isError: true,
});

export const SYNC_TOOL: Tool = {
  name: "mindgraph_sync",
  description:
    "Transactional one-way project memory-file sync. scan/status are reads; begin/record/finalize/abandon are writes. Discovery and hashing are automatic; semantic assertions are deliberately supplied through record. This never writes graph state back to files.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["scan", "begin", "record", "finalize", "status", "abandon"],
      },
      paths: { type: "array", items: { type: "string" } },
      workspace: {
        type: "boolean",
        description:
          "For scan only: fan out across repositories explicitly listed in .mindgraph/workspace.json",
      },
      repo: {
        type: "string",
        description: "Configured repository id, name, or root",
      },
      logical_path: { type: "string" },
      content: { type: "string" },
      content_hash: { type: "string" },
      source_uid: { type: "string" },
      execution_uid: { type: "string" },
      assertion_fingerprint: { type: "string" },
      planned_fingerprints: { type: "array", items: { type: "string" } },
      current_fingerprints: { type: "array", items: { type: "string" } },
      source_selector: { type: "object" },
      capture_type: {
        type: "string",
        enum: ["lesson", "journal", "claim", "decision", "risk"],
      },
      label: { type: "string" },
      summary: { type: "string" },
      props: { type: "object" },
      expected_execution_version: { type: "integer", minimum: 1 },
      baseline_version: { type: "integer", minimum: 1 },
      repo_space_uid: { type: "string" },
      repo_id: { type: "string" },
      provider: { type: "string", enum: ["claude_project", "explicit"] },
      file_present: { type: "boolean" },
      agent_id: { type: "string" },
      invocation_context: {
        type: "object",
        description: "Adapter-owned; hooks replace forged or absent values.",
        properties: {
          harness: { type: "string" },
          harnessSessionId: { type: "string" },
          harnessTurnId: { type: "string" },
          cwd: { type: "string" },
          repoId: { type: "string" },
          branch: { type: "string" },
          commit: { type: "string" },
          worktreeState: { type: "string" },
          model: { type: "string" },
          injectedBy: { type: "string" },
        },
      },
    },
    required: ["action"],
  },
};

function safePath(root: string, candidate: string): string {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes repository root: ${candidate}`);
  }
  return absolute;
}

function markdownFiles(target: string): string[] {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith(".md") ? [target] : [];
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => markdownFiles(path.join(target, entry.name)));
}

function fileDescriptor(root: string, absolute: string) {
  const content = fs.readFileSync(absolute, "utf8");
  return {
    logical_path: path.relative(root, absolute).split(path.sep).join("/"),
    content_hash: crypto.createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
    content,
  };
}

type SyncClient = {
  memorySync(request: Record<string, unknown>): Promise<unknown>;
};

export async function handleSyncTool(
  client: MindGraph,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const action = String(args.action || "");
    const context = (args.invocation_context || {}) as InvocationContext;
    const adapter = new CodegraphAdapter({
      cwd: context.cwd || process.cwd(),
    });
    const requestedRepo =
      typeof args.repo === "string"
        ? args.repo
        : typeof args.repo_id === "string"
          ? args.repo_id
          : context.repoId;
    const repository = await adapter.resolveRepository(requestedRepo);
    const root = repository.repoRoot;
    const repoId = repository.repoId;
    const provider = String(args.provider || "claude_project");
    const remote = client as unknown as SyncClient;

    if (action === "scan") {
      const repositories =
        args.workspace === true
          ? await adapter.resolveRepositories()
          : [repository];
      const requested =
        Array.isArray(args.paths) && args.paths.length > 0
          ? args.paths.map(String)
          : [".claude/agent-memory", "memory"];
      const scans = [];
      for (const selected of repositories) {
        scans.push(
          await scanRepository(
            remote,
            selected,
            requested,
            provider,
            args.agent_id,
          ),
        );
      }
      if (args.workspace === true) {
        return ok({
          provider,
          workspace: true,
          repositories: scans,
          one_way: "files_to_graph",
        });
      }
      return ok(scans[0]);
    }

    const request: Record<string, unknown> = {
      ...args,
      provider,
      repo_id: repoId,
    };
    delete request.invocation_context;
    delete request.paths;
    delete request.repo;
    delete request.workspace;
    if (action === "begin" && !request.content) {
      if (!request.logical_path) {
        return err("missing_field", "logical_path is required for begin");
      }
      const file = fileDescriptor(
        root,
        safePath(root, String(request.logical_path)),
      );
      request.content = file.content;
      request.content_hash ||= file.content_hash;
    }
    if (
      action === "status" &&
      request.logical_path &&
      request.file_present !== false
    ) {
      const absolute = safePath(root, String(request.logical_path));
      request.file_present = fs.existsSync(absolute);
      if (request.file_present && !request.content_hash) {
        request.content_hash = fileDescriptor(root, absolute).content_hash;
      }
    }
    return ok(await remote.memorySync(request));
  } catch (error) {
    return err(
      "sync_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function scanRepository(
  remote: SyncClient,
  repository: RepositoryIdentity,
  requested: string[],
  provider: string,
  agentId: unknown,
) {
  const files = [
    ...new Set(
      requested.flatMap((candidate) =>
        markdownFiles(safePath(repository.repoRoot, candidate)),
      ),
    ),
  ].sort();
  const results = [];
  for (const absolute of files) {
    const file = fileDescriptor(repository.repoRoot, absolute);
    const status = await remote.memorySync({
      action: "scan",
      provider,
      repo_id: repository.repoId,
      logical_path: file.logical_path,
      content_hash: file.content_hash,
      file_present: true,
      agent_id: agentId,
    });
    results.push({
      logical_path: file.logical_path,
      content_hash: file.content_hash,
      bytes: file.bytes,
      status,
    });
  }
  return {
    repo_id: repository.repoId,
    root: ".",
    files: results,
  };
}
