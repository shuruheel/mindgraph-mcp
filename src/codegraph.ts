import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { randomUUID } from "node:crypto";

export type CodeRef = {
  repo?: string;
  path?: string;
  line?: number;
  symbol?: string;
  kind?: string;
  language?: string;
  signature?: string;
};

export type ResolvedCodeRef = {
  repoId: string;
  repoRoot: string;
  path: string;
  language: string;
  kind: string;
  qualifiedName: string;
  signature: string | null;
  startLine: number;
  endLine: number;
};

export type RepositoryIdentity = {
  repoId: string;
  repoRoot: string;
  spaceUid?: string;
};

export type CodegraphUnavailableReason =
  | "absent"
  | "timeout"
  | "wrong_index"
  | "index_incomplete"
  | "command_failed";

/** A requested repository id matched neither the configured workspace, the
 * current checkout, nor an existing path. Raised instead of silently
 * resolving to the enclosing repository, which would misattribute anchors
 * created elsewhere (e.g. on another machine) to whatever repo cwd is in. */
export class UnknownRepositoryError extends Error {
  constructor(readonly repo: string) {
    super(
      `unknown repository "${repo}": not declared in .mindgraph/workspace.json, ` +
        "not the current repository, and no such path exists",
    );
    this.name = "UnknownRepositoryError";
  }
}

/** The working directory a tool call should resolve repositories from: the
 * hook-injected invocation_context.cwd (the live session directory) when
 * present, else this process's cwd (where the MCP server was launched). */
export function invocationCwd(args: Record<string, unknown>): string {
  const context = args.invocation_context;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    const cwd = (context as Record<string, unknown>).cwd;
    if (typeof cwd === "string" && cwd) return cwd;
  }
  return process.cwd();
}

/** Caveat lines for an unavailable index. Strangers hit "absent" on their
 * first anchor; the model relays hints verbatim, so the install line is the
 * self-serve onboarding path. */
export function unavailabilityCaveats(
  reason: CodegraphUnavailableReason,
  message?: string
): string[] {
  const caveats = [message || "codegraph status failed"];
  if (reason === "absent") {
    caveats.push(
      "Optional: install codegraph (https://github.com/colbymchenry/codegraph) " +
        "and run `codegraph init` in this repository to enable code anchoring " +
        "and structural recall. Memory and work tools are unaffected."
    );
  }
  return caveats;
}

export type CodegraphAvailability = {
  available: boolean;
  reason?: CodegraphUnavailableReason;
  stale: boolean;
  caveats: string[];
  lastIndexed?: string;
};

export type CodegraphCandidate = {
  path: string;
  language: string;
  kind: string;
  qualifiedName: string;
  signature: string | null;
  startLine: number;
  endLine: number;
};

export type ResolveCodeRefResult = {
  ref: CodeRef;
  repository?: RepositoryIdentity;
  availability?: CodegraphAvailability;
  resolved?: ResolvedCodeRef;
  candidates: CodegraphCandidate[];
  error?: "invalid_ref" | "not_found" | "ambiguous" | CodegraphUnavailableReason;
};

export type ResolveCodeRefsResult = {
  repository: RepositoryIdentity;
  repositories: RepositoryIdentity[];
  availability: CodegraphAvailability;
  results: ResolveCodeRefResult[];
};

export type WorkspaceRepository = {
  root: string;
  repo_id?: string;
  space_uid?: string;
};

export type WorkspaceMap = {
  v: 1;
  workspace_id?: string;
  repositories: WorkspaceRepository[];
};

type CodegraphStatus = {
  initialized?: boolean;
  projectPath?: string;
  lastIndexed?: string;
  pendingChanges?: { added?: number; modified?: number; removed?: number };
  worktreeMismatch?: unknown;
  index?: {
    state?: string;
    pendingRefs?: number;
    reindexRecommended?: boolean;
  };
};

type QueryNode = {
  kind?: string;
  name?: string;
  qualifiedName?: string;
  filePath?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  signature?: string | null;
};

type QueryHit = { node?: QueryNode } & QueryNode;

type CommandFailure = Error & {
  kind?: CodegraphUnavailableReason;
  exitCode?: number | null;
};

type AdapterOptions = {
  timeoutMs?: number;
  statusTtlMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  workspaceFile?: string;
  now?: () => number;
};

type ConfiguredRepository = {
  repoId?: string;
  repoRoot: string;
  spaceUid?: string;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STATUS_TTL_MS = 60_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeSignature(signature: string): string {
  return signature.replace(/\s+/g, " ").trim();
}

function languageFromPath(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    {
      ".c": "c",
      ".cc": "cpp",
      ".cpp": "cpp",
      ".go": "go",
      ".java": "java",
      ".js": "javascript",
      ".jsx": "javascript",
      ".kt": "kotlin",
      ".py": "python",
      ".rb": "ruby",
      ".rs": "rust",
      ".swift": "swift",
      ".ts": "typescript",
      ".tsx": "typescript",
    }[extension] ?? "unknown"
  );
}

function asNode(hit: QueryHit): QueryNode {
  return hit.node ?? hit;
}

function toCandidate(node: QueryNode): CodegraphCandidate | null {
  if (!node.filePath || !node.kind || !(node.qualifiedName || node.name)) return null;
  return {
    path: normalizePath(node.filePath),
    language: node.language ?? languageFromPath(node.filePath),
    kind: node.kind,
    qualifiedName: node.qualifiedName ?? node.name ?? "",
    signature: node.signature ?? null,
    startLine: node.startLine ?? 1,
    endLine: node.endLine ?? node.startLine ?? 1,
  };
}

function normalizeRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return `${scp[1].toLowerCase()}/${scp[2].replace(/\.git$/, "")}`;
  }
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    return `${url.host.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

export function pathContains(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function nearestExistingDirectory(candidate: string): string {
  let current = resolve(candidate);
  for (;;) {
    if (existsSync(current)) {
      try {
        return statSync(current).isDirectory() ? current : dirname(current);
      } catch {
        // Keep walking toward an accessible ancestor.
      }
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function findWorkspaceFile(start: string, explicit?: string): string | undefined {
  if (explicit) return resolve(start, explicit);
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, ".mindgraph", "workspace.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, timeoutMs);
    timer.unref();

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (cause: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const error = new Error(cause.message) as CommandFailure;
      error.kind = cause.code === "ENOENT" ? "absent" : "command_failed";
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const error = new Error(`command timed out after ${timeoutMs}ms`) as CommandFailure;
        error.kind = "timeout";
        rejectPromise(error);
        return;
      }
      if (outputBytes > MAX_OUTPUT_BYTES) {
        const error = new Error("codegraph output exceeded 5 MiB") as CommandFailure;
        error.kind = "command_failed";
        rejectPromise(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(Buffer.concat(stderr).toString("utf8").trim()) as CommandFailure;
        error.kind = "command_failed";
        error.exitCode = code;
        rejectPromise(error);
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export class CodegraphAdapter {
  private readonly timeoutMs: number;
  private readonly statusTtlMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly workspaceFile?: string;
  private readonly now: () => number;
  private readonly identityCache = new Map<string, Promise<RepositoryIdentity>>();
  private readonly statusCache = new Map<
    string,
    { expiresAt: number; status: CodegraphStatus; availability: CodegraphAvailability }
  >();

  constructor(options: AdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.statusTtlMs = options.statusTtlMs ?? DEFAULT_STATUS_TTL_MS;
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.workspaceFile = findWorkspaceFile(
      this.cwd,
      options.workspaceFile ?? this.env.MINDGRAPH_WORKSPACE_FILE,
    );
    this.now = options.now ?? Date.now;
  }

  async resolveRepository(repo?: string, fallbackSpaceUid?: string): Promise<RepositoryIdentity> {
    const configured = await this.resolveRepositories(fallbackSpaceUid);
    const selected =
      (repo && configured.find((candidate) => candidate.repoId === repo)) ||
      (repo &&
        configured.find(
          (candidate) =>
            candidate.repoRoot === repo || basename(candidate.repoRoot) === repo,
        )) ||
      (!repo
        ? [...configured]
            .sort((a, b) => b.repoRoot.length - a.repoRoot.length)
            .find((candidate) => pathContains(candidate.repoRoot, this.cwd))
        : undefined) ||
      (!repo && configured.length === 1 ? configured[0] : undefined);
    if (selected) {
      return !repo && this.env.MINDGRAPH_REPO_ID
        ? this.resolveRepositoryIdentity(
            selected.repoRoot,
            this.env.MINDGRAPH_REPO_ID,
            selected.spaceUid,
          )
        : selected;
    }
    if (repo) {
      const requestedPath = await realpath(resolve(this.cwd, repo)).catch(() =>
        resolve(this.cwd, repo),
      );
      if (!existsSync(requestedPath)) {
        // The request names a repository id, not a checkout path. Falling
        // through to the enclosing repository would run codegraph against
        // the wrong index while labeling results with the requested id.
        const current = await this.currentRepository(fallbackSpaceUid);
        if (current.repoId === repo) return current;
        throw new UnknownRepositoryError(repo);
      }
      const repoRoot = (await this.gitRoot(requestedPath)) ?? requestedPath;
      return this.resolveRepositoryIdentity(
        repoRoot,
        this.env.MINDGRAPH_REPO_ID,
        this.env.MINDGRAPH_CODE_SPACE_UID || fallbackSpaceUid,
      );
    }
    return this.currentRepository(fallbackSpaceUid);
  }

  private async currentRepository(
    fallbackSpaceUid?: string,
  ): Promise<RepositoryIdentity> {
    const requestedRoot = this.env.MINDGRAPH_REPO_ROOT || this.cwd;
    const requestedPath = await realpath(resolve(this.cwd, requestedRoot)).catch(() =>
      resolve(this.cwd, requestedRoot),
    );
    const repoRoot =
      (await this.gitRoot(requestedPath)) ??
      requestedPath;
    return this.resolveRepositoryIdentity(
      repoRoot,
      this.env.MINDGRAPH_REPO_ID,
      this.env.MINDGRAPH_CODE_SPACE_UID || fallbackSpaceUid,
    );
  }

  async resolveRepositories(fallbackSpaceUid?: string): Promise<RepositoryIdentity[]> {
    return Promise.all(
      this.configuredRepositories().map((repository) =>
        this.resolveRepositoryIdentity(
          repository.repoRoot,
          repository.repoId,
          repository.spaceUid ||
            this.env.MINDGRAPH_CODE_SPACE_UID ||
            fallbackSpaceUid,
        ),
      ),
    );
  }

  private async resolveRepositoryIdentity(
    root: string,
    explicitRepoId?: string,
    spaceUid?: string,
  ): Promise<RepositoryIdentity> {
    const repoRoot = await realpath(root).catch(() => resolve(root));
    const cacheKey = `${repoRoot}\0${explicitRepoId ?? ""}\0${spaceUid ?? ""}`;
    const cached = this.identityCache.get(cacheKey);
    if (cached) return cached;
    const pending = this.loadRepositoryIdentity(repoRoot, explicitRepoId, spaceUid);
    this.identityCache.set(cacheKey, pending);
    return pending;
  }

  private async loadRepositoryIdentity(
    repoRoot: string,
    explicitRepoId?: string,
    spaceUid?: string,
  ): Promise<RepositoryIdentity> {
    const remote = await runProcess(
      "git",
      ["-C", repoRoot, "config", "--get", "remote.origin.url"],
      Math.min(this.timeoutMs, 2_000),
      this.env,
    ).catch(() => "");
    const repoId =
      explicitRepoId ||
      normalizeRemote(remote) ||
      (await this.persistedRepositoryId(repoRoot));
    return {
      repoId,
      repoRoot,
      spaceUid,
    };
  }

  private async persistedRepositoryId(repoRoot: string): Promise<string> {
    const rawCommonDir = await runProcess(
      "git",
      ["-C", repoRoot, "rev-parse", "--git-common-dir"],
      Math.min(this.timeoutMs, 2_000),
      this.env,
    ).catch(() => "");
    if (!rawCommonDir.trim()) {
      // Non-Git callers should normally provide MINDGRAPH_REPO_ID. Keep the
      // fallback path-free so an absolute local path never enters a key.
      return `local:${basename(repoRoot)}`;
    }
    const commonDir = resolve(repoRoot, rawCommonDir.trim());
    const identityDir = join(commonDir, "mindgraph");
    const identityFile = join(identityDir, "repository-id");
    try {
      const existing = readFileSync(identityFile, "utf8").trim();
      if (existing) return existing;
    } catch {
      // First resolver for this clone creates the durable fallback below.
    }
    mkdirSync(identityDir, { recursive: true, mode: 0o700 });
    const generated = randomUUID();
    try {
      writeFileSync(identityFile, `${generated}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return generated;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const winner = readFileSync(identityFile, "utf8").trim();
      if (!winner) throw new Error(`empty repository identity file: ${identityFile}`);
      return winner;
    }
  }

  private async gitRoot(candidate: string): Promise<string | undefined> {
    const start = nearestExistingDirectory(candidate);
    const raw = await runProcess(
      "git",
      ["-C", start, "rev-parse", "--show-toplevel"],
      Math.min(this.timeoutMs, 2_000),
      this.env,
    ).catch(() => "");
    return raw.trim() ? resolve(start, raw.trim()) : undefined;
  }

  /** Why the workspace map yielded no repositories — for callers that were
   * explicitly asked to fan out and would otherwise return silently empty. */
  workspaceDiagnostic(): string {
    if (!this.workspaceFile || !existsSync(this.workspaceFile)) {
      return (
        "no .mindgraph/workspace.json was found between the working " +
        "directory and the filesystem root"
      );
    }
    return `${this.workspaceFile} is malformed or declares no repositories`;
  }

  async availability(repository: RepositoryIdentity): Promise<CodegraphAvailability> {
    const cached = this.statusCache.get(repository.repoRoot);
    if (cached && cached.expiresAt > this.now()) return cached.availability;
    try {
      const status = await this.runJson<CodegraphStatus>([
        "status",
        repository.repoRoot,
        "-j",
      ]);
      const caveats: string[] = [];
      let availability: CodegraphAvailability;
      if (status.worktreeMismatch != null) {
        availability = {
          available: false,
          reason: "wrong_index",
          stale: false,
          caveats: ["the index belongs to a different worktree"],
          lastIndexed: status.lastIndexed,
        };
      } else if (!status.initialized || status.index?.state !== "complete") {
        availability = {
          available: false,
          reason: "index_incomplete",
          stale: false,
          caveats: [
            !status.initialized
              ? "codegraph is not initialized for this repository"
              : `codegraph index state is ${status.index?.state ?? "unknown"}`,
          ],
          lastIndexed: status.lastIndexed,
        };
      } else {
        const pending =
          (status.pendingChanges?.added ?? 0) +
          (status.pendingChanges?.modified ?? 0) +
          (status.pendingChanges?.removed ?? 0);
        if (pending > 0) caveats.push(`${pending} worktree changes are not indexed`);
        if ((status.index?.pendingRefs ?? 0) > 0) {
          caveats.push(`${status.index?.pendingRefs} references remain pending`);
        }
        if (status.index?.reindexRecommended) caveats.push("codegraph recommends reindexing");
        availability = {
          available: true,
          stale: caveats.length > 0,
          caveats,
          lastIndexed: status.lastIndexed,
        };
      }
      this.statusCache.set(repository.repoRoot, {
        status,
        availability,
        expiresAt: this.now() + this.statusTtlMs,
      });
      return availability;
    } catch (cause) {
      const failure = cause as CommandFailure;
      const reason = failure.kind ?? "command_failed";
      return {
        available: false,
        reason,
        stale: false,
        caveats: unavailabilityCaveats(reason, failure.message),
      };
    }
  }

  async resolveRefs(
    refs: Array<CodeRef | string>,
    options: { repo?: string; fallbackSpaceUid?: string } = {},
  ): Promise<ResolveCodeRefsResult> {
    const normalized = refs.map((ref) =>
      typeof ref === "string" ? { symbol: ref } : ref,
    );
    const results = await Promise.all(
      normalized.map(async (ref) => {
        const repository = await this.repositoryForRef(
          ref,
          options.repo,
          options.fallbackSpaceUid,
        );
        const availability = await this.availability(repository);
        if (!availability.available) {
          return {
            ref,
            repository,
            availability,
            candidates: [],
            error: availability.reason,
          } satisfies ResolveCodeRefResult;
        }
        return {
          ...(await this.resolveOne(ref, repository)),
          repository,
          availability,
        };
      }),
    );
    const repositories = [
      ...new Map(
        results.flatMap((result) =>
          result.repository
            ? [[result.repository.repoRoot, result.repository] as const]
            : [],
        ),
      ).values(),
    ];
    const repository =
      repositories[0] ??
      (await this.resolveRepository(options.repo, options.fallbackSpaceUid));
    if (repositories.length === 0) repositories.push(repository);
    const availabilities = results.flatMap((result) =>
      result.availability ? [result.availability] : [],
    );
    const availability =
      availabilities.length === 0
        ? await this.availability(repository)
        : {
            available: availabilities.every((item) => item.available),
            reason: availabilities.find((item) => !item.available)?.reason,
            stale: availabilities.some((item) => item.stale),
            caveats: [
              ...new Set(availabilities.flatMap((item) => item.caveats)),
            ],
          };
    return { repository, repositories, availability, results };
  }

  private async repositoryForRef(
    ref: CodeRef,
    defaultRepo?: string,
    fallbackSpaceUid?: string,
  ): Promise<RepositoryIdentity> {
    if (ref.repo || defaultRepo) {
      return this.resolveRepository(ref.repo || defaultRepo, fallbackSpaceUid);
    }
    if (ref.path) {
      const requested = isAbsolute(ref.path)
        ? resolve(ref.path)
        : resolve(this.cwd, ref.path);
      const absolute = await realpath(requested).catch(() => requested);
      const configured = await this.resolveRepositories(fallbackSpaceUid);
      const defining = [...configured]
        .sort((a, b) => b.repoRoot.length - a.repoRoot.length)
        .find((candidate) => pathContains(candidate.repoRoot, absolute));
      if (defining) {
        return this.env.MINDGRAPH_REPO_ID &&
          pathContains(defining.repoRoot, this.cwd)
          ? this.resolveRepositoryIdentity(
              defining.repoRoot,
              this.env.MINDGRAPH_REPO_ID,
              defining.spaceUid,
            )
          : defining;
      }
      const gitRoot = await this.gitRoot(absolute);
      if (gitRoot) {
        return this.resolveRepositoryIdentity(
          gitRoot,
          this.env.MINDGRAPH_REPO_ID,
          this.env.MINDGRAPH_CODE_SPACE_UID || fallbackSpaceUid,
        );
      }
    }
    return this.resolveRepository(undefined, fallbackSpaceUid);
  }

  async expand(
    resolved: ResolvedCodeRef,
    limit = 20,
  ): Promise<{
    availability: CodegraphAvailability;
    callers: ResolvedCodeRef[];
    callees: ResolvedCodeRef[];
    truncated: boolean;
  }> {
    const repository = {
      repoId: resolved.repoId,
      repoRoot: resolved.repoRoot,
    };
    const availability = await this.availability(repository);
    if (!availability.available) {
      return { availability, callers: [], callees: [], truncated: false };
    }
    const cap = Math.min(Math.max(limit, 1), 20);
    const [callers, callees] = await Promise.all([
      this.related("callers", resolved, cap + 1),
      this.related("callees", resolved, cap + 1),
    ]);
    return {
      availability,
      callers: callers.slice(0, cap),
      callees: callees.slice(0, cap),
      truncated: callers.length > cap || callees.length > cap,
    };
  }

  async affected(
    resolved: ResolvedCodeRef,
    limit = 50,
  ): Promise<{
    availability: CodegraphAvailability;
    affected: ResolvedCodeRef[];
    truncated: boolean;
  }> {
    const repository = {
      repoId: resolved.repoId,
      repoRoot: resolved.repoRoot,
    };
    const availability = await this.availability(repository);
    if (!availability.available) {
      return { availability, affected: [], truncated: false };
    }
    const cap = Math.min(Math.max(limit, 1), 50);
    const raw = await this.runJson<{
      affected?: Array<QueryNode & { filePath?: string; startLine?: number }>;
    }>([
      "impact",
      "-p",
      resolved.repoRoot,
      "-j",
      "-d",
      "2",
      resolved.qualifiedName,
    ]);
    const refs = (raw.affected ?? []).map((node) => ({
      path: node.filePath,
      line: node.startLine,
      symbol: node.qualifiedName ?? node.name,
      kind: node.kind,
    }));
    const resolvedRefs = await this.resolveRelatedRefs(refs.slice(0, cap + 1), repository);
    return {
      availability,
      affected: resolvedRefs.slice(0, cap),
      truncated: refs.length > cap,
    };
  }

  private configuredRepositories(): ConfiguredRepository[] {
    const configured: ConfiguredRepository[] = [];
    if (this.workspaceFile && existsSync(this.workspaceFile)) {
      try {
        const parsed = JSON.parse(
          readFileSync(this.workspaceFile, "utf8"),
        ) as WorkspaceMap;
        if (parsed.v === 1 && Array.isArray(parsed.repositories)) {
          const configDirectory = dirname(this.workspaceFile);
          const base =
            basename(configDirectory) === ".mindgraph"
              ? dirname(configDirectory)
              : configDirectory;
          for (const repository of parsed.repositories) {
            if (!repository || typeof repository.root !== "string") continue;
            configured.push({
              repoId:
                typeof repository.repo_id === "string"
                  ? repository.repo_id
                  : undefined,
              repoRoot: resolve(base, repository.root),
              spaceUid:
                typeof repository.space_uid === "string"
                  ? repository.space_uid
                  : undefined,
            });
          }
        }
      } catch {
        // Malformed workspace JSON contributes no repositories; it never
        // becomes an implicit sibling scan. Workspace-dependent callers
        // surface workspaceDiagnostic() so the failure is visible.
      }
    }
    const raw = this.env.MINDGRAPH_CODE_REPOS;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<
          string,
          string | { root: string; space_uid?: string }
        >;
        for (const [repoId, config] of Object.entries(parsed)) {
          configured.push({
            repoId,
            repoRoot: resolve(
              this.cwd,
              typeof config === "string" ? config : config.root,
            ),
            spaceUid:
              typeof config === "string" ? undefined : config.space_uid,
          });
        }
      } catch {
        // Preserve workspace-file entries when the legacy env map is malformed.
      }
    }
    return [
      ...new Map(
        configured.map((repository) => [repository.repoRoot, repository]),
      ).values(),
    ];
  }

  private async resolveOne(
    ref: CodeRef,
    repository: RepositoryIdentity,
  ): Promise<ResolveCodeRefResult> {
    const search = ref.symbol || ref.path;
    if (!search || (ref.line !== undefined && (!Number.isInteger(ref.line) || ref.line < 1))) {
      return { ref, candidates: [], error: "invalid_ref" };
    }
    try {
      const args = ["query", "-p", repository.repoRoot, "-j", "-l", "50"];
      if (ref.kind) args.push("-k", ref.kind);
      args.push(search);
      const hits = await this.runJson<QueryHit[]>(args);
      let candidates = hits.map(asNode).map(toCandidate).filter((item) => item !== null);
      if (ref.path) {
        const absolutePath = isAbsolute(ref.path)
          ? await realpath(ref.path).catch(() => ref.path!)
          : undefined;
        const wanted = normalizePath(
          absolutePath
            ? relative(repository.repoRoot, absolutePath)
            : ref.path,
        );
        candidates = candidates.filter((candidate) => candidate.path === wanted);
      }
      if (ref.language) {
        candidates = candidates.filter(
          (candidate) => candidate.language.toLowerCase() === ref.language?.toLowerCase(),
        );
      }
      if (ref.kind) {
        candidates = candidates.filter(
          (candidate) => candidate.kind.toLowerCase() === ref.kind?.toLowerCase(),
        );
      }
      if (ref.symbol) {
        const exact = candidates.filter((candidate) => {
          const tail = candidate.qualifiedName.split(/::|\.|#/).at(-1);
          return candidate.qualifiedName === ref.symbol || tail === ref.symbol;
        });
        if (exact.length > 0) candidates = exact;
      }
      if (ref.signature) {
        const signature = normalizeSignature(ref.signature);
        candidates = candidates.filter(
          (candidate) =>
            candidate.signature !== null &&
            normalizeSignature(candidate.signature) === signature,
        );
      }
      if (ref.line !== undefined) {
        candidates = candidates.filter(
          (candidate) =>
            candidate.startLine <= ref.line! && candidate.endLine >= ref.line!,
        );
        if (candidates.length > 1) {
          const narrowest = Math.min(
            ...candidates.map((candidate) => candidate.endLine - candidate.startLine),
          );
          const narrowed = candidates.filter(
            (candidate) => candidate.endLine - candidate.startLine === narrowest,
          );
          if (narrowed.length === 1) candidates = narrowed;
        }
      }

      if (candidates.length !== 1) {
        return {
          ref,
          candidates,
          error: candidates.length === 0 ? "not_found" : "ambiguous",
        };
      }
      return {
        ref,
        candidates,
        resolved: {
          repoId: repository.repoId,
          repoRoot: repository.repoRoot,
          ...candidates[0],
        },
      };
    } catch (cause) {
      const failure = cause as CommandFailure;
      return {
        ref,
        candidates: [],
        error: failure.kind ?? "command_failed",
      };
    }
  }

  private async related(
    action: "callers" | "callees",
    resolved: ResolvedCodeRef,
    limit: number,
  ): Promise<ResolvedCodeRef[]> {
    const raw = await this.runJson<{
      callers?: QueryNode[];
      callees?: QueryNode[];
    }>([
      action,
      "-p",
      resolved.repoRoot,
      "-j",
      "-l",
      String(limit),
      resolved.qualifiedName,
    ]);
    const refs = (raw[action] ?? []).map((node) => ({
      path: node.filePath,
      line: node.startLine,
      symbol: node.qualifiedName ?? node.name,
      kind: node.kind,
    }));
    return this.resolveRelatedRefs(refs, {
      repoId: resolved.repoId,
      repoRoot: resolved.repoRoot,
    });
  }

  private async resolveRelatedRefs(
    refs: CodeRef[],
    repository: RepositoryIdentity,
  ): Promise<ResolvedCodeRef[]> {
    const results = await Promise.all(refs.map((ref) => this.resolveOne(ref, repository)));
    const seen = new Set<string>();
    return results
      .flatMap((result) => (result.resolved ? [result.resolved] : []))
      .filter((result) => {
        const key = `${result.path}:${result.qualifiedName}:${result.startLine}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const candidates = [
      this.env.MINDGRAPH_CODEGRAPH_BIN,
      "codegraph",
      resolve(homedir(), ".local", "bin", "codegraph"),
    ].filter((candidate, index, all): candidate is string => {
      return Boolean(candidate) && all.indexOf(candidate) === index;
    });
    let lastFailure: CommandFailure | undefined;
    for (const executable of candidates) {
      try {
        const stdout = await runProcess(
          executable,
          args,
          this.timeoutMs,
          this.env,
          this.cwd,
        );
        return JSON.parse(stdout) as T;
      } catch (cause) {
        const failure = cause as CommandFailure;
        lastFailure = failure;
        if (failure.kind !== "absent") throw failure;
      }
    }
    throw (
      lastFailure ??
      Object.assign(new Error("codegraph executable not found"), {
        kind: "absent" as const,
      })
    );
  }
}

export function repositoryIdentityKey(repository: RepositoryIdentity): Record<string, unknown> {
  return { v: 1, kind: "repository", repo_id: repository.repoId };
}

export function codeRefIdentityKey(ref: ResolvedCodeRef): Record<string, unknown> {
  if (ref.kind === "file") {
    return {
      v: 1,
      kind: "file",
      repo_id: ref.repoId,
      path: ref.path,
    };
  }
  return {
    v: 1,
    kind: "symbol",
    repo_id: ref.repoId,
    language: ref.language,
    symbol_kind: ref.kind,
    qualified_name: ref.qualifiedName,
    disambiguator: {
      signature: ref.signature ?? "",
      path: ref.path,
    },
  };
}
