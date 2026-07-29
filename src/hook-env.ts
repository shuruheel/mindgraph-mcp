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
    };
  } catch {
    return {};
  }
}

export function saveHookEnv(env: HookEnv, dir?: string): string {
  const file = hookEnvPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = loadHookEnv(dir);
  const merged: HookEnv = {
    baseUrl: env.baseUrl ?? existing.baseUrl,
    apiKey: env.apiKey ?? existing.apiKey,
  };
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
  return file;
}
