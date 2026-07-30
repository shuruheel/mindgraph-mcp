import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Persisted connection settings for command hooks.
 *
 * Hooks are spawned by the harness with whatever environment the harness
 * happens to have — which usually does NOT include MINDGRAPH_API_KEY or
 * MINDGRAPH_BASE_URL (those live in the MCP server registration, a different
 * process). Without a persisted fallback, installed hooks silently no-op.
 *
 * The file is USER-level and mode 0600 because the API key is a secret:
 * project-scoped `.claude/settings.json` is commonly committed, so credentials
 * must never be written there. Resolution order everywhere: process env first,
 * then this file.
 */
export interface HookEnv {
  baseUrl?: string;
  apiKey?: string;
  /** Per-member agent identity — two teammates defaulting to the same
   * agent_id become ONE logical agent to leases and resume selection. */
  agentId?: string;
  /** Org pinned at install time. Hooks run with the harness's environment,
   * which usually lacks MINDGRAPH_ORG_ID even when the MCP registration has
   * it — on a multi-org key the hooks would otherwise open Sessions and claim
   * leases in the key's default org while the MCP tools write to the pinned
   * one. */
  orgId?: string;
}

/**
 * Stable per-user agent identity, shared by BOTH harness adapters.
 *
 * The old default was the harness name, which made (a) every Claude Code
 * session on every machine one logical agent, and (b) cross-harness handoff
 * impossible: a task leased under agent "codex" failed the own-prior-work
 * gate under agent "claude-code", so the headline promise — resume your work
 * in the other harness — could never bind. Deriving the default from
 * user@host gives each person/machine one identity that both harnesses
 * share. MINDGRAPH_AGENT_ID still overrides for cross-device continuity or
 * per-teammate identities.
 */
export function stableAgentId(): string {
  let user = "user";
  try {
    user = os.userInfo().username || "user";
  } catch {
    // Some containers have no passwd entry for the current uid.
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${user}@${os.hostname()}`)
    .digest("hex")
    .slice(0, 12);
  return `u-${digest}`;
}

export function hookEnvPath(dir?: string): string {
  return path.join(dir || path.join(os.homedir(), ".mindgraph"), "hooks.json");
}

export function loadHookEnv(dir?: string): HookEnv {
  try {
    const raw = fs.readFileSync(hookEnvPath(dir), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : undefined,
      orgId: typeof parsed.orgId === "string" ? parsed.orgId : undefined,
    };
  } catch {
    return {};
  }
}

export function saveHookEnv(
  env: Omit<HookEnv, "orgId"> & {
    /** undefined = keep the stored pin; null = CLEAR it. Without an explicit
     * clear, a stale org pin survived every reinstall and silently routed
     * hook writes to the wrong tenant forever. */
    orgId?: string | null;
  },
  dir?: string,
): string {
  const file = hookEnvPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = loadHookEnv(dir);
  const merged: HookEnv = {
    baseUrl: env.baseUrl ?? existing.baseUrl,
    apiKey: env.apiKey ?? existing.apiKey,
    agentId: env.agentId ?? existing.agentId,
    orgId: env.orgId === null ? undefined : (env.orgId ?? existing.orgId),
  };
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
  return file;
}
