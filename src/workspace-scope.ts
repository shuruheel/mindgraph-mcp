import fs from "node:fs";
import path from "node:path";
import { CodegraphAdapter, repositoryIdentityKey } from "./codegraph.js";
import { anchorRepository, type CodeClient } from "./code-tool.js";

export interface RepositoryScope {
  uids: string[];
  /** Scope uid → the repository id it stands for, for grouping a brief. */
  names: Record<string, string>;
  /** Repo ids whose identity resolution ERRORED (as opposed to resolving to
   * "absent", which just means no tasks can target them yet). A failure
   * silently narrowing — or entirely removing — the scope was the amplifier
   * in the 2026-07-29 auto-claim incident: the cloud identity 403 emptied the
   * scope and resume ran against the global pool with no signal anywhere. */
  failures: string[];
}

export interface ScopeClient {
  entity?(request: Record<string, unknown>): Promise<unknown>;
}

/** How many tasks a resume lists when its scope spans several repositories:
 * the selection plus the work ranked behind it. */
export const WORKSPACE_RESUME_LIMIT = 9;

/** Where resolved repository uids are remembered between hook runs. Twelve
 * identity lookups measured about six seconds at every session start; the
 * uid of a repository does not change. `tenant` must differ whenever the API
 * key, base URL or organization does, so a uid never crosses tenants. */
export interface ScopeCache {
  dir: string;
  tenant: string;
  now?: () => number;
}

const SCOPE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const SCOPE_CACHE_FILE = "repository-scopes.json";

type CachedScopes = Record<string, { uid: string; at: number }>;

function readScopeCache(cache: ScopeCache | undefined): CachedScopes {
  if (!cache) return {};
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(cache.dir, SCOPE_CACHE_FILE), "utf8"),
    ) as { v?: number; tenant?: string; entries?: CachedScopes };
    if (parsed.v !== 1 || parsed.tenant !== cache.tenant || !parsed.entries) return {};
    const now = (cache.now ?? Date.now)();
    return Object.fromEntries(
      Object.entries(parsed.entries).filter(
        ([, entry]) =>
          typeof entry?.uid === "string" &&
          typeof entry.at === "number" &&
          now - entry.at >= 0 &&
          now - entry.at < SCOPE_CACHE_TTL_MS,
      ),
    );
  } catch {
    return {};
  }
}

function writeScopeCache(cache: ScopeCache | undefined, entries: CachedScopes): void {
  if (!cache) return;
  try {
    fs.mkdirSync(cache.dir, { recursive: true, mode: 0o700 });
    const file = path.join(cache.dir, SCOPE_CACHE_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ v: 1, tenant: cache.tenant, entries }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch {
    // The cache only saves time; resolution already succeeded without it.
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The repositories a session's durable work is selected from: every
 * repository the workspace file at or above `cwd` declares, else the ones
 * declared by workspace files one directory below it, else the repository
 * `cwd` is in.
 */
export async function resolveRepositoryScope(
  cwd: string,
  client: ScopeClient,
  agentId: string,
  options: { workspaceFile?: string; cache?: ScopeCache } = {},
): Promise<RepositoryScope> {
  if (!client.entity) return { uids: [], names: {}, failures: [] };
  const adapter = new CodegraphAdapter({
    cwd,
    workspaceFile: options.workspaceFile,
    childWorkspaces: true,
  });
  const configured = await adapter.resolveRepositories();
  const repositories =
    configured.length > 0
      ? configured
      : [await adapter.resolveRepository()];
  const failures: string[] = [];
  const names: Record<string, string> = {};
  const cached = readScopeCache(options.cache);
  const fresh: CachedScopes = {};
  const stamp = (options.cache?.now ?? Date.now)();
  const resolved = await Promise.all(
    repositories.map(async (repository) => {
      const remembered = cached[repository.repoId];
      if (remembered) {
        names[remembered.uid] = repository.repoId;
        return remembered.uid;
      }
      try {
        const payload = record(
          await client.entity!({
            action: "resolve_identity",
            identity: {
              namespace: "external.code",
              key_version: 1,
              key: repositoryIdentityKey(repository),
            },
            agent_id: agentId,
          }),
        );
        if (payload?.status === "existing" && typeof payload.uid === "string" && payload.uid) {
          names[payload.uid] = repository.repoId;
          fresh[repository.repoId] = { uid: payload.uid, at: stamp };
          return payload.uid;
        }
        if (payload?.status === "absent") {
          // Anchor the repository identity NOW (the same idempotent upsert
          // create_task uses). Skipping "absent" repos meant a repo whose
          // identity had never been anchored ran every session UNSCOPED —
          // silently mixing other repositories' tasks into its briefs
          // (caught live by the E2E: a task scoped to repo B surfaced in
          // repo A's session because A had no anchor).
          const anchored = await anchorRepository(
            client as unknown as CodeClient,
            repository,
            repository.spaceUid ?? `space:agent:${agentId}`,
            agentId,
          );
          if (anchored?.uid) {
            names[anchored.uid] = repository.repoId;
            fresh[repository.repoId] = { uid: anchored.uid, at: stamp };
            return anchored.uid;
          }
          failures.push(
            `${repository.repoId}: anchor ${anchored?.status ?? "failed"}`,
          );
          return undefined;
        }
        failures.push(
          `${repository.repoId}: ${typeof payload?.status === "string" && payload.status ? payload.status : "unresolved"}`,
        );
        return undefined;
      } catch (error) {
        failures.push(
          `${repository.repoId}: ${(error as Error)?.message || "resolve failed"}`,
        );
        return undefined;
      }
    }),
  );
  if (Object.keys(fresh).length > 0) {
    writeScopeCache(options.cache, { ...cached, ...fresh });
  }
  return {
    uids: [...new Set(resolved.filter((uid): uid is string => Boolean(uid)))],
    names,
    failures,
  };
}
