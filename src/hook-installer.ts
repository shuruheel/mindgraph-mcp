import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { evalMode, evalUserScopeRefusal } from "./eval-guard.js";
import { loadHookEnv, mindgraphConfigDir, mindgraphDataDir } from "./hook-env.js";

export type HookScope = "user" | "project";
export type HookHarness = "claude-code" | "codex";

/** Optional Claude Code hook features (N17). Persisted in
 * ~/.mindgraph/hooks.json so self-healing refreshes keep the user's choice. */
export interface ClaudeHookFeatures {
  /** UserPromptSubmit bounded recall. Default OFF: registered only when
   * true (`--prompt-recall`). In a 59-prompt replay, 0-4% of the items it
   * injected were relevant to the prompt. */
  promptRecall?: boolean;
  /** PreCompact transcript capture (+ at SessionEnd). Default OFF. */
  capture?: boolean;
}

function storedFeatures(homeDir?: string): ClaudeHookFeatures {
  // Without an explicit home, read the same hooks.json the installer writes
  // (the account's MindGraph directory), not one under $HOME.
  const { promptRecall, capture } = loadHookEnv(
    homeDir ? path.join(homeDir, ".mindgraph") : undefined,
  );
  return { promptRecall, capture };
}

const OWNER_MARKER = "--owner mindgraph";
// The hook invokes a pinned copy of the self-contained CLI bundle, installed
// by installHookRunner(). `npx -y mindgraph-mcp@latest` here cost ~10s of
// re-resolution PER HOOK INVOCATION — SessionStart produced a perfect brief in
// 12.7s against an 8s timeout and was killed every time (2026-07-29 live
// test). A copied bundle starts in ~100ms and pins the version the user
// actually installed.
const RUNNER_RELATIVE = ".mindgraph/bin/mindgraph-hook.cjs";

/** Where the pinned runner lives: `bin/` in `mindgraphDataDir`, so an
 * accepted `MINDGRAPH_HOME` moves it with `hooks.json`. */
function runnerPath(homeDir?: string): string {
  return path.join(mindgraphDataDir(process.env, homeDir), "bin", "mindgraph-hook.cjs");
}

function runnerVersionPath(homeDir?: string): string {
  return `${runnerPath(homeDir)}.version`;
}

/** The runner under an accepted `MINDGRAPH_HOME`, or undefined when there is
 * no override (or an explicit `homeDir`). */
export function overrideRunner(homeDir?: string): string | undefined {
  if (homeDir || !process.env.MINDGRAPH_HOME) return undefined;
  if (mindgraphConfigDir().source !== "override") return undefined;
  return runnerPath();
}

/** The runner path an installed command names absolutely, or undefined for
 * the portable `$HOME` form. Only a machine-local settings file names the
 * override's runner: user scope, or any scope in an evaluation run (whose
 * checkout is the trial's own). Project settings are committed, so outside
 * eval mode they always carry the portable form and never a local path. The
 * path is fixed at install time: the hook's own environment never picks the
 * executable. */
function absoluteRunnerFor(scope: HookScope, homeDir?: string): string | undefined {
  const runner = overrideRunner(homeDir);
  if (!runner) return undefined;
  return scope === "user" || evalMode() ? runner : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** How a command names its runner: an existing entry's target kept verbatim
 * (`posix`), or the target for this scope and process. */
interface RunnerChoice {
  scope: HookScope;
  homeDir?: string;
  /** A POSIX runner target copied from an existing owned entry. */
  posix?: string;
}

function command(harness: HookHarness, choice: RunnerChoice): string {
  if (choice.posix) return `node ${choice.posix} hook --harness ${harness} --owner mindgraph`;
  const runner = absoluteRunnerFor(choice.scope, choice.homeDir);
  const target = runner ? shellQuote(runner) : `"$HOME/${RUNNER_RELATIVE}"`;
  return `node ${target} hook --harness ${harness} --owner mindgraph`;
}

function windowsCommand(harness: HookHarness, choice: RunnerChoice): string {
  const runner = absoluteRunnerFor(choice.scope, choice.homeDir);
  const target = runner ? `"${runner}"` : `"%USERPROFILE%\\.mindgraph\\bin\\mindgraph-hook.cjs"`;
  return `node ${target} hook --harness ${harness} --owner mindgraph`;
}

/** The runner target of an owned Claude Code entry already in `settings`,
 * when it is one of the two forms this installer writes: the portable
 * `"$HOME/.mindgraph/bin/mindgraph-hook.cjs"` or a single-quoted absolute
 * path ending in `/bin/mindgraph-hook.cjs`. A refresh keeps it, so a server
 * started under some other `MINDGRAPH_HOME` never retargets existing hooks
 * at its own runner. */
function existingRunnerTarget(settings: JsonObject): string | undefined {
  const pattern = /^node ("\$HOME\/\.mindgraph\/bin\/mindgraph-hook\.cjs"|'\/[^']*\/bin\/mindgraph-hook\.cjs') hook --harness claude-code --owner mindgraph$/;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
  for (const entries of Object.values(hooks as JsonObject)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = (entry as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        const text = (hook as { command?: unknown })?.command;
        if (typeof text !== "string") continue;
        const match = pattern.exec(text);
        if (match) return match[1];
      }
    }
  }
  return undefined;
}

/** Sidecar recording which package version the pinned runner was copied
 * from. The MCP registration floats on `npx -y mindgraph-mcp@latest` while
 * the runner is pinned at install time, so the two silently skew apart —
 * observed live 2026-08-12: a 0.14.7-era runner serving 0.17-era sessions
 * for two weeks with no signal. The sidecar is what makes skew detectable. */

/** Copy the executing CLI bundle to the stable runner path hooks invoke. */
export function installHookRunner(
  sourceFile: string,
  homeDir?: string,
  version?: string,
): string {
  const target = runnerPath(homeDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Atomic swap: a hook can spawn `node runner.cjs` at any moment — including
  // mid-refresh from a concurrently starting MCP server — and must never read
  // a torn bundle.
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.copyFileSync(sourceFile, temporary);
  fs.renameSync(temporary, target);
  const versionPath = runnerVersionPath(homeDir);
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
      .readFileSync(runnerVersionPath(homeDir), "utf8")
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

/** The first version whose hook runner checks consent. */
export const GATE_MIN_VERSION = "0.28.0";

/** A runner is installed and its version is unrecorded or below the gate
 * floor, so it runs hooks without checking consent. */
export function runnerPredatesGate(homeDir?: string): boolean {
  if (!fs.existsSync(runnerPath(homeDir))) return false;
  const pinned = parseSemver(installedHookRunnerVersion(homeDir));
  return !pinned || semverNewer(parseSemver(GATE_MIN_VERSION)!, pinned);
}

/** The line the server (on stderr) and `status` print while the installed
 * runner predates consent; undefined otherwise. */
export function gateFloorWarning(homeDir?: string): string | undefined {
  if (!runnerPredatesGate(homeDir)) return undefined;
  const version = installedHookRunnerVersion(homeDir);
  return (
    `the installed hook runner ${version ? `v${version}` : "(version unrecorded)"} predates consent and ignores it; ` +
    `run npx -y mindgraph-mcp@latest install-hooks`
  );
}

/** The hook entries the server may refresh at start, or undefined for no
 * refresh at all. Inside consent: the user and project entries. Outside it
 * (and in the general profile): only a runner that predates consent, and
 * then only the user entries, never a project's. Never when $HOME is not
 * the account's home: an environment variable must not pick where this
 * writes. */
export function runnerRefreshScopes(
  insideConsent: boolean,
  runnerBelowGate: boolean,
  homeIsAccount: boolean,
): HookScope[] | undefined {
  if (!homeIsAccount) return undefined;
  if (insideConsent) return ["user", "project"];
  return runnerBelowGate ? ["user"] : undefined;
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
 * Opt out with MINDGRAPH_HOOK_AUTOUPDATE=off; `force` refreshes anyway.
 * An evaluation run (MINDGRAPH_EVAL=1) never refreshes, forced or not: a
 * trial's runner is the one its harness installed. */
export function refreshHookRunner(
  serverVersion: string,
  sourceBundle: string,
  homeDir?: string,
  options: { force?: boolean } = {},
): RunnerRefresh {
  try {
    if (evalMode()) return { refreshed: false, reason: "disabled" };
    if (process.env.MINDGRAPH_HOOK_AUTOUPDATE === "off" && !options.force) {
      return { refreshed: false, reason: "disabled" };
    }
    if (!fs.existsSync(runnerPath(homeDir))) {
      return { refreshed: false, reason: "no_runner" };
    }
    if (!fs.existsSync(sourceBundle)) {
      return { refreshed: false, reason: "no_source" };
    }
    const server = parseSemver(serverVersion);
    if (!server) return { refreshed: false, reason: "unparseable" };
    const runnerVersion = installedHookRunnerVersion(homeDir);
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
    installHookRunner(sourceBundle, homeDir, serverVersion);
    return { refreshed: true, reason: "updated", runnerVersion };
  } catch {
    return { refreshed: false, reason: "error" };
  }
}

/** After a runner refresh, re-write the owned hook ENTRIES too (timeout
 * budgets, matchers, newly added events) — but only in settings files that
 * already carry owned entries. The user's scope choice is respected, never
 * expanded: a file with no owned hooks is not a target, so this never
 * installs hooks onto a machine (or into a project) that opted out. Each
 * file keeps the runner its owned entries already name, so a server started
 * under a different MINDGRAPH_HOME never points them at its own runner. An
 * evaluation run rewrites nothing. */
export function refreshOwnedClaudeHooks(
  projectDir = process.cwd(),
  homeDir?: string,
  scopes: HookScope[] = ["user", "project"],
): string[] {
  const refreshed: string[] = [];
  if (evalMode()) return refreshed;
  for (const scope of scopes) {
    try {
      const file = settingsPath("claude-code", scope, projectDir, undefined, homeDir);
      if (!fs.existsSync(file)) continue;
      if (!fs.readFileSync(file, "utf8").includes(OWNER_MARKER)) continue;
      installHooks(
        "claude-code",
        scope,
        projectDir,
        undefined,
        homeDir,
        storedFeatures(homeDir),
        { keepRunner: true },
      );
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
  return formatVersionSkewNote(runnerVersion, serverVersion);
}

/** The skew note's text, separate from the disk read so the instruction
 * length test can measure the longest string index.ts may append. */
export function formatVersionSkewNote(
  runnerVersion: string,
  serverVersion: string,
): string {
  return (
    `NOTE: the installed MindGraph hook runner is v${runnerVersion} but this ` +
    `MCP server is v${serverVersion} — hook behavior and tool contracts may ` +
    `be out of sync. Tell the user to run: ` +
    `npx -y mindgraph-mcp@latest install-hooks (refreshes the pinned runner).`
  );
}

export function uninstallHookRunner(homeDir?: string): void {
  try {
    fs.rmSync(runnerPath(homeDir));
  } catch {
    // Best effort — absence is the goal.
  }
  fs.rmSync(runnerVersionPath(homeDir), { force: true });
}

type JsonObject = Record<string, unknown>;

export interface InstallResult {
  path: string;
  added: number;
  updated: number;
  /** Optional events whose MindGraph-owned entry this install removed
   * (`UserPromptSubmit`, `PreCompact`); entries owned by others stay. */
  removedEvents: string[];
}

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
    ? path.join(homeDir ? path.join(homeDir, ".claude") : claudeUserConfigDir(), "settings.json")
    : path.join(projectDir, ".claude", "settings.json");
}

/** Claude Code's user configuration directory: an absolute
 * `CLAUDE_CONFIG_DIR` when set (Claude Code reads its user settings there),
 * else `~/.claude`. */
export function claudeUserConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir && path.isAbsolute(dir) ? dir : path.join(os.homedir(), ".claude");
}

function readSettings(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
}

function ownedHookFor(
  harness: HookHarness,
  timeout: number,
  additionalContextLimit: number | undefined,
  runner: RunnerChoice,
) {
  return {
    type: "command",
    command: command(harness, runner),
    ...(harness === "codex"
      ? { commandWindows: windowsCommand(harness, runner) }
      : {}),
    timeout,
    statusMessage: "Syncing MindGraph session context",
    ...(additionalContextLimit === undefined
      ? {}
      : { additionalContextLimit }),
  };
}

export const CLAUDE_POST_TOOL_MATCHER =
  "mcp__mindgraph__.*|Edit|MultiEdit|Write|NotebookEdit|Bash|Task|Agent";

function desiredEntries(
  harness: HookHarness,
  features: ClaudeHookFeatures = {},
  runner: RunnerChoice = { scope: "project" },
): Record<string, JsonObject[]> {
  const ownedHook = (h: HookHarness, timeout: number, limit?: number) =>
    ownedHookFor(h, timeout, limit, runner);
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
    // Claude Code: only the tools the hook acts on (MindGraph calls, edits,
    // and the shell/agent calls that keep a lease alive). Read, Grep and Glob
    // are most of a session's tool calls and the hook did nothing useful for
    // them but start a process (roadmap H8). Codex names its tools
    // differently, so it keeps the catch-all.
    PostToolUse: [
      {
        matcher: harness === "claude-code" ? CLAUDE_POST_TOOL_MATCHER : ".*",
        hooks: [ownedHook(harness, 10)],
      },
    ],
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
  if (harness !== "claude-code") return common;
  return {
    ...common,
    TaskCreated: [{ hooks: [ownedHook(harness, 3)] }],
    TaskCompleted: [{ hooks: [ownedHook(harness, 3)] }],
    // Opt-in bounded recall per prompt: the core gives up at 4s and fails
    // open, so a 5s budget never holds the prompt longer than that.
    ...(features.promptRecall === true
      ? { UserPromptSubmit: [{ hooks: [ownedHook(harness, 5)] }] }
      : {}),
    // Opt-in transcript capture before compaction (cold-tenant ingest).
    ...(features.capture === true
      ? { PreCompact: [{ hooks: [ownedHook(harness, 30)] }] }
      : {}),
  };
}

function hookCommand(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = (value as JsonObject).command;
  return typeof command === "string" ? command : undefined;
}

/** Remove MindGraph-owned hooks from an event's entries, hook by hook: an
 * entry that also holds another tool's hook keeps that hook, and an entry
 * left with no hooks is dropped. `removed` counts owned hooks taken out. */
function stripOwnedHooks(entries: unknown[]): { kept: unknown[]; removed: number } {
  const kept: unknown[] = [];
  let removed = 0;
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      kept.push(rawEntry);
      continue;
    }
    const entry = { ...(rawEntry as JsonObject) };
    if (!Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const retainedHooks = entry.hooks.filter((hook) => {
      const owned = hookCommand(hook)?.includes(OWNER_MARKER) || false;
      if (owned) removed += 1;
      return !owned;
    });
    if (retainedHooks.length === entry.hooks.length) {
      kept.push(rawEntry);
    } else if (retainedHooks.length > 0) {
      entry.hooks = retainedHooks;
      kept.push(entry);
    }
  }
  return { kept, removed };
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
  features: ClaudeHookFeatures = {},
  options: { keepRunner?: boolean } = {},
): InstallResult {
  // An evaluation run never writes the person's real user settings.
  const explicitDir = harness === "codex" ? codexHomeDir : homeDir;
  const refusal = explicitDir ? undefined : evalUserScopeRefusal(harness, scope);
  if (refusal) throw new Error(refusal);
  const file = settingsPath(harness, scope, projectDir, codexHomeDir, homeDir);
  const settings = readSettings(file);
  const kept = options.keepRunner && harness === "claude-code" ? existingRunnerTarget(settings) : undefined;
  const hooks =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? (settings.hooks as JsonObject)
      : {};
  let added = 0;
  let updated = 0;
  const removedEvents: string[] = [];
  const desired = desiredEntries(harness, features, { scope, homeDir, posix: kept });
  // A disabled optional event loses its owned hooks; foreign hooks stay,
  // including one that shares an entry with ours.
  for (const optional of ["UserPromptSubmit", "PreCompact"]) {
    if (optional in desired || !Array.isArray(hooks[optional])) continue;
    const { kept, removed } = stripOwnedHooks(hooks[optional] as unknown[]);
    if (removed === 0) continue;
    removedEvents.push(optional);
    if (kept.length > 0) hooks[optional] = kept;
    else delete hooks[optional];
  }
  for (const [event, wanted] of Object.entries(desired)) {
    const current = Array.isArray(hooks[event])
      ? ([...(hooks[event] as unknown[])] as unknown[])
      : [];
    // UPSERT, don't dedupe: an existing owned entry is replaced with the
    // current definition. Skip-if-present left every 0.14.0 install running
    // the old npx command against the old 8s timeout after upgrading —
    // "Installed 0 hook entries" while nothing changed (2026-07-29).
    // Owned hooks come out hook by hook, so a foreign hook sharing an entry
    // with ours survives the refresh.
    const { kept, removed } = stripOwnedHooks(current);
    const hadOwned = removed > 0;
    for (const entry of wanted) {
      kept.push(entry);
      if (hadOwned) updated += 1;
      else added += 1;
    }
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  writeSettings(file, settings);
  return { path: file, added, updated, removedEvents };
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
    const stripped = stripOwnedHooks(value);
    removed += stripped.removed;
    const retainedEntries = stripped.kept;
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
  features: ClaudeHookFeatures = {},
): InstallResult {
  return installHooks("claude-code", scope, projectDir, undefined, undefined, features);
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
): InstallResult {
  return installHooks("codex", scope, projectDir, codexHomeDir);
}

export function uninstallCodexHooks(
  scope: HookScope,
  projectDir = process.cwd(),
  codexHomeDir?: string,
): { path: string; removed: number } {
  return uninstallHooks("codex", scope, projectDir, codexHomeDir);
}
