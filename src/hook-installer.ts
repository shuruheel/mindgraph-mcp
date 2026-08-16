import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type HookScope = "user" | "project";
export type HookHarness = "claude-code" | "codex";

const OWNER_MARKER = "--owner mindgraph";
// The hook invokes a pinned copy of the self-contained CLI bundle, installed
// by installHookRunner(). `npx -y mindgraph-mcp@latest` here cost ~10s of
// re-resolution PER HOOK INVOCATION — SessionStart produced a perfect brief in
// 12.7s against an 8s timeout and was killed every time (2026-07-29 live
// test). A copied bundle starts in ~100ms and pins the version the user
// actually installed.
const RUNNER_RELATIVE = ".mindgraph/bin/mindgraph-hook.cjs";

function command(harness: HookHarness): string {
  return `node "$HOME/${RUNNER_RELATIVE}" hook --harness ${harness} --owner mindgraph`;
}

function windowsCommand(harness: HookHarness): string {
  return `node "%USERPROFILE%\\.mindgraph\\bin\\mindgraph-hook.cjs" hook --harness ${harness} --owner mindgraph`;
}

/** Sidecar recording which package version the pinned runner was copied
 * from. The MCP registration floats on `npx -y mindgraph-mcp@latest` while
 * the runner is pinned at install time, so the two silently skew apart —
 * observed live 2026-08-12: a 0.14.7-era runner serving 0.17-era sessions
 * for two weeks with no signal. The sidecar is what makes skew detectable. */
const RUNNER_VERSION_RELATIVE = `${RUNNER_RELATIVE}.version`;

/** Copy the executing CLI bundle to the stable runner path hooks invoke. */
export function installHookRunner(
  sourceFile: string,
  homeDir?: string,
  version?: string,
): string {
  const target = path.join(homeDir || os.homedir(), RUNNER_RELATIVE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Atomic swap: a hook can spawn `node runner.cjs` at any moment — including
  // mid-refresh from a concurrently starting MCP server — and must never read
  // a torn bundle.
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.copyFileSync(sourceFile, temporary);
  fs.renameSync(temporary, target);
  const versionPath = path.join(homeDir || os.homedir(), RUNNER_VERSION_RELATIVE);
  if (version) {
    fs.writeFileSync(versionPath, `${version}\n`);
  } else {
    // A copy of unknown provenance must not inherit the previous sidecar.
    fs.rmSync(versionPath, { force: true });
  }
  return target;
}

export function installedHookRunnerVersion(homeDir?: string): string | undefined {
  try {
    const raw = fs
      .readFileSync(
        path.join(homeDir || os.homedir(), RUNNER_VERSION_RELATIVE),
        "utf8",
      )
      .trim();
    return raw || undefined;
  } catch {
    // Pre-sidecar installs (≤0.17.0) have a runner but no version record —
    // indistinguishable from no install, so no skew claim is made.
    return undefined;
  }
}

function parseSemver(value: string | undefined): [number, number, number] | undefined {
  if (!value) return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function semverNewer(
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

export interface RunnerRefresh {
  refreshed: boolean;
  reason:
    | "updated"
    | "current"
    | "downgrade"
    | "no_runner"
    | "no_source"
    | "unparseable"
    | "disabled"
    | "error";
  runnerVersion?: string;
}

/** Self-heal the pinned hook runner from the running server's own bundle.
 * The MCP registration floats on `npx @latest` while the runner pins at
 * install time, so the freshest code in the system is the server — without
 * this, every release required a manual `install-hooks` on every machine,
 * and a missed one served weeks-stale hooks with no signal (observed live
 * 2026-08-12). Upgrade-only: an npx cache serving an older server must
 * never downgrade the runner. A runner with NO version sidecar predates the
 * sidecar itself (≤0.17.0), so it is older than any server carrying this
 * code and safe to refresh. A machine with no runner has no hooks (e.g.
 * Claude Desktop serving this MCP) and is left untouched. Never throws.
 * Opt out with MINDGRAPH_HOOK_AUTOUPDATE=off. */
export function refreshHookRunner(
  serverVersion: string,
  sourceBundle: string,
  homeDir?: string,
): RunnerRefresh {
  try {
    if (process.env.MINDGRAPH_HOOK_AUTOUPDATE === "off") {
      return { refreshed: false, reason: "disabled" };
    }
    const home = homeDir || os.homedir();
    if (!fs.existsSync(path.join(home, RUNNER_RELATIVE))) {
      return { refreshed: false, reason: "no_runner" };
    }
    if (!fs.existsSync(sourceBundle)) {
      return { refreshed: false, reason: "no_source" };
    }
    const server = parseSemver(serverVersion);
    if (!server) return { refreshed: false, reason: "unparseable" };
    const runnerVersion = installedHookRunnerVersion(home);
    if (runnerVersion !== undefined) {
      const pinned = parseSemver(runnerVersion);
      if (!pinned) {
        return { refreshed: false, reason: "unparseable", runnerVersion };
      }
      if (!semverNewer(server, pinned)) {
        return {
          refreshed: false,
          reason: runnerVersion === serverVersion ? "current" : "downgrade",
          runnerVersion,
        };
      }
    }
    installHookRunner(sourceBundle, home, serverVersion);
    return { refreshed: true, reason: "updated", runnerVersion };
  } catch {
    return { refreshed: false, reason: "error" };
  }
}

/** After a runner refresh, re-write the owned hook ENTRIES too (timeout
 * budgets, matchers, newly added events) — but only in settings files that
 * already carry owned entries. The user's scope choice is respected, never
 * expanded: a file with no owned hooks is not a target, so this never
 * installs hooks onto a machine (or into a project) that opted out. */
export function refreshOwnedClaudeHooks(
  projectDir = process.cwd(),
  homeDir?: string,
): string[] {
  const refreshed: string[] = [];
  const scopes: HookScope[] = ["user", "project"];
  for (const scope of scopes) {
    try {
      const file = settingsPath("claude-code", scope, projectDir, undefined, homeDir);
      if (!fs.existsSync(file)) continue;
      if (!fs.readFileSync(file, "utf8").includes(OWNER_MARKER)) continue;
      installHooks("claude-code", scope, projectDir, undefined, homeDir);
      refreshed.push(file);
    } catch {
      // Self-heal must never break server startup.
    }
  }
  return refreshed;
}

/** A one-line warning when the pinned hook runner and the running server
 * come from different package versions; undefined when they match or the
 * runner's version is unrecorded. */
export function versionSkewNote(
  serverVersion: string,
  homeDir?: string,
): string | undefined {
  const runnerVersion = installedHookRunnerVersion(homeDir);
  if (!runnerVersion || runnerVersion === serverVersion) return undefined;
  return (
    `NOTE: the installed MindGraph hook runner is v${runnerVersion} but this ` +
    `MCP server is v${serverVersion} — hook behavior and tool contracts may ` +
    `be out of sync. Tell the user to run: ` +
    `npx -y mindgraph-mcp@latest install-hooks (refreshes the pinned runner).`
  );
}

export function uninstallHookRunner(homeDir?: string): void {
  try {
    fs.rmSync(path.join(homeDir || os.homedir(), RUNNER_RELATIVE));
  } catch {
    // Best effort — absence is the goal.
  }
  fs.rmSync(path.join(homeDir || os.homedir(), RUNNER_VERSION_RELATIVE), {
    force: true,
  });
}

type JsonObject = Record<string, unknown>;

function settingsPath(
  harness: HookHarness,
  scope: HookScope,
  projectDir = process.cwd(),
  codexHomeDir = process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex"),
  homeDir?: string,
): string {
  if (harness === "codex") {
    return scope === "user"
      ? path.join(codexHomeDir, "hooks.json")
      : path.join(projectDir, ".codex", "hooks.json");
  }
  return scope === "user"
    ? path.join(homeDir || os.homedir(), ".claude", "settings.json")
    : path.join(projectDir, ".claude", "settings.json");
}

function readSettings(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
}

function ownedHook(
  harness: HookHarness,
  timeout: number,
  additionalContextLimit?: number,
) {
  return {
    type: "command",
    command: command(harness),
    ...(harness === "codex"
      ? { commandWindows: windowsCommand(harness) }
      : {}),
    timeout,
    statusMessage: "Syncing MindGraph session context",
    ...(additionalContextLimit === undefined
      ? {}
      : { additionalContextLimit }),
  };
}

function desiredEntries(harness: HookHarness): Record<string, JsonObject[]> {
  const common = {
    SessionStart: [
      {
        matcher:
          harness === "claude-code"
            ? "startup|resume|clear|compact|fork"
            : "startup|resume|clear|compact",
        // B7 live acceptance caught cold SessionStart calls crossing the
        // inherited 20s edge in both harnesses: the hooks correctly failed
        // open, but no brief reached the model. The same installed runner
        // completed in 16.84s once warm. Keep a 30s cold-tenant margin.
        // The declared Codex context limit must not undercut the brief's own
        // 9,000-char budget: at 3,000 the harness applied a SECOND, tighter
        // truncation the renderer knew nothing about.
        hooks: [
          ownedHook(
            harness,
            30,
            harness === "codex" ? 10_000 : undefined,
          ),
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "mcp__mindgraph__.*",
        // Repository resolution over a large multi-repo workspace plus three
        // git probes can exceed 3s on the first (uncached) call; a killed
        // PreToolUse means the call goes through untagged.
        hooks: [ownedHook(harness, 5)],
      },
    ],
    // PostToolUse awaits the lease renewal round-trip, which fires exactly
    // when the tenant is cold (post-idle reclaim) — 5s killed it mid-claim.
    PostToolUse: [{ matcher: ".*", hooks: [ownedHook(harness, 10)] }],
    Stop: [{ hooks: [ownedHook(harness, 5)] }],
    // SessionEnd makes up to two sequential cloud calls (abandon_iteration +
    // session close) — the SAME cold-tenant latency SessionStart needs 30s
    // for. Claude honors the configured budget; Codex clamps SessionEnd to a
    // 3s platform cap regardless of this value (see codex-hooks.ts wire
    // map), so the codex adapter instead makes at most ONE call there.
    SessionEnd: [
      { hooks: [ownedHook(harness, harness === "codex" ? 3 : 30)] },
    ],
  };
  return harness === "claude-code"
    ? {
        ...common,
        TaskCreated: [{ hooks: [ownedHook(harness, 3)] }],
        TaskCompleted: [{ hooks: [ownedHook(harness, 3)] }],
      }
    : common;
}

function hookCommand(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = (value as JsonObject).command;
  return typeof command === "string" ? command : undefined;
}

function entryHasOwnedHook(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hooks = (value as JsonObject).hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((hook) => hookCommand(hook)?.includes(OWNER_MARKER))
  );
}

function writeSettings(file: string, settings: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function installHooks(
  harness: HookHarness,
  scope: HookScope,
  projectDir = process.cwd(),
  codexHomeDir?: string,
  homeDir?: string,
): { path: string; added: number; updated: number } {
  const file = settingsPath(harness, scope, projectDir, codexHomeDir, homeDir);
  const settings = readSettings(file);
  const hooks =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? (settings.hooks as JsonObject)
      : {};
  let added = 0;
  let updated = 0;
  for (const [event, wanted] of Object.entries(desiredEntries(harness))) {
    const current = Array.isArray(hooks[event])
      ? ([...(hooks[event] as unknown[])] as unknown[])
      : [];
    // UPSERT, don't dedupe: an existing owned entry is replaced with the
    // current definition. Skip-if-present left every 0.14.0 install running
    // the old npx command against the old 8s timeout after upgrading —
    // "Installed 0 hook entries" while nothing changed (2026-07-29).
    const kept = current.filter((entry) => !entryHasOwnedHook(entry));
    const hadOwned = kept.length !== current.length;
    for (const entry of wanted) {
      kept.push(entry);
      if (hadOwned) updated += 1;
      else added += 1;
    }
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  writeSettings(file, settings);
  return { path: file, added, updated };
}

function uninstallHooks(
  harness: HookHarness,
  scope: HookScope,
  projectDir = process.cwd(),
  codexHomeDir?: string,
): { path: string; removed: number } {
  const file = settingsPath(harness, scope, projectDir, codexHomeDir);
  if (!fs.existsSync(file)) return { path: file, removed: 0 };
  const settings = readSettings(file);
  const hooks =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? (settings.hooks as JsonObject)
      : {};
  let removed = 0;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const retainedEntries: unknown[] = [];
    for (const rawEntry of value) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        retainedEntries.push(rawEntry);
        continue;
      }
      const entry = { ...(rawEntry as JsonObject) };
      if (!Array.isArray(entry.hooks)) {
        retainedEntries.push(entry);
        continue;
      }
      const retainedHooks = entry.hooks.filter((hook) => {
        const owned = hookCommand(hook)?.includes(OWNER_MARKER) || false;
        if (owned) removed += 1;
        return !owned;
      });
      if (retainedHooks.length > 0) {
        entry.hooks = retainedHooks;
        retainedEntries.push(entry);
      }
    }
    if (retainedEntries.length > 0) hooks[event] = retainedEntries;
    else delete hooks[event];
  }
  settings.hooks = hooks;
  writeSettings(file, settings);
  return { path: file, removed };
}

export function installClaudeHooks(
  scope: HookScope,
  projectDir = process.cwd(),
): { path: string; added: number; updated: number } {
  return installHooks("claude-code", scope, projectDir);
}

export function uninstallClaudeHooks(
  scope: HookScope,
  projectDir = process.cwd(),
): { path: string; removed: number } {
  return uninstallHooks("claude-code", scope, projectDir);
}

export function installCodexHooks(
  scope: HookScope,
  projectDir = process.cwd(),
  codexHomeDir?: string,
): { path: string; added: number; updated: number } {
  return installHooks("codex", scope, projectDir, codexHomeDir);
}

export function uninstallCodexHooks(
  scope: HookScope,
  projectDir = process.cwd(),
  codexHomeDir?: string,
): { path: string; removed: number } {
  return uninstallHooks("codex", scope, projectDir, codexHomeDir);
}
