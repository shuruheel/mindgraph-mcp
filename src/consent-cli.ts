import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireHumanTerminal } from "./agent-shell.js";
import {
  loadConsentStore,
  nodeConsentFs,
  pathContains,
  resolveConsent,
  writeConsent,
  type ConsentDecision,
  type ConsentRoot,
  type LoadedConsentStore,
  type PinnedRepository,
} from "./consent.js";
import {
  ConsentPlanError,
  nodeGit,
  planConsent,
  printable,
  remoteRepositoryId,
  resolveRepositoryId,
  type GitRunner,
  type PlannedRepository,
  type RepoPlan,
  type WorkspacePlan,
} from "./consent-plan.js";
import {
  refreshHookRunner,
  refreshOwnedClaudeHooks,
  runnerPredatesGate,
} from "./hook-installer.js";
import {
  HookConfigError,
  loadHookEnv,
  mindgraphConfigDir,
  passwdHome,
  resolvedHookFeatures,
  type HookEnv,
} from "./hook-env.js";

/**
 * `on` and `off`: the only ways consent changes. `on` asks a person at a
 * terminal and records exactly what they approved; `off` only removes, so it
 * runs anywhere. All I/O is injected so the flows are testable.
 */

export const COMMAND = "npx -y mindgraph-mcp@latest";
export const INSTALL_CONSENT_LINE = `Hooks do nothing in a repository until you turn MindGraph on there: ${COMMAND} on`;
const DEFAULT_BASE_URL = "https://api.mindgraph.cloud";

export interface ConsentIo {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  out(line: string): void;
  err(line: string): void;
  /** Print `prompt` and read one line; "" at end of input. */
  ask(prompt: string): Promise<string>;
  git?: GitRunner;
  now?: () => Date;
  version?: string;
  /** Called between the plan and the write, after the person confirmed.
   * Tests use it to change files while "the person is reading". */
  beforeWrite?: () => void;
  /** Refresh the hook runner and the user-scope hook entries before consent
   * is written; returns a line to print, if any. Unset in tests, so a test
   * never touches the real runner. */
  refreshRunner?: () => string | undefined;
}

/**
 * What `on` and `off` run before writing consent: refresh the hook runner from
 * this bundle and rewrite the user-scope hook entries (never a project's
 * settings). `MINDGRAPH_HOOK_AUTOUPDATE=off` is honoured, except for a runner
 * that predates consent: turning consent on or off with a runner that ignores
 * it would mean nothing.
 */
export function refreshRunnerForConsent(
  version: string,
  bundle: string,
  homeDir?: string,
): string | undefined {
  const forced = runnerPredatesGate(homeDir);
  const result = refreshHookRunner(version, bundle, homeDir, { force: forced });
  if (!result.refreshed) return undefined;
  refreshOwnedClaudeHooks(homeDir, homeDir, ["user"]);
  return `Updated the hook runner to v${version}${forced ? " so it checks where MindGraph is on" : ""}.`;
}

/** I/O over the real process: readline on stdin, console on stdout/stderr.
 * With `bundle`, `on` and `off` refresh the hook runner from it. */
export function nodeConsentIo(version: string, bundle?: string): ConsentIo & { close(): void } {
  let rl: import("node:readline").Interface | undefined;
  let closed = false;
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  const open = async () => {
    if (rl) return;
    const readline = await import("node:readline");
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
    rl.on("close", () => {
      closed = true;
      for (const next of waiting.splice(0)) next("");
    });
  };
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    cwd: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    ask: async (prompt) => {
      await open();
      process.stdout.write(prompt);
      if (lines.length) return lines.shift()!;
      if (closed) return "";
      return new Promise((resolve) => waiting.push(resolve));
    },
    version,
    ...(bundle ? { refreshRunner: () => refreshRunnerForConsent(version, bundle) } : {}),
    close: () => rl?.close(),
  };
}

// ── Display helpers ───────────────────────────────────────────────────

function homeDir(): string | undefined {
  const home = passwdHome();
  if (!home) return undefined;
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

/** `~/x` for a path under the account's home directory. */
export function displayPath(p: string): string {
  const home = homeDir();
  if (home && pathContains(home, p)) {
    const rest = path.relative(home, p);
    return rest ? `~/${rest}` : "~";
  }
  return p;
}

/** A path as a shell argument: the short form when it needs no quoting. */
export function commandPath(p: string): string {
  const short = displayPath(p);
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(short)) return short;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function repositories(n: number): string {
  return `${n} ${n === 1 ? "repository" : "repositories"}`;
}

function storedConnection(env: NodeJS.ProcessEnv): HookEnv {
  return loadHookEnv(mindgraphConfigDir(env).dir);
}

// ── The card ──────────────────────────────────────────────────────────

/** The shared body of the card: what runs, what leaves, who reads, undo. The
 * feature lines follow `resolvedHookFeatures`, the function the hook command
 * uses, so the card never describes a feature the hooks do not run. */
export function cardBody(
  stored: HookEnv,
  subject: { what: string; remote?: string },
): string[] {
  const features = resolvedHookFeatures(stored);
  const lines = [
    "What happens in Claude Code sessions here",
    "  At session start, MindGraph opens a session record and adds this",
    `  ${subject.what}'s open work to the model's context (at most 9,000 characters).`,
  ];
  if (features.promptRecall) {
    lines.push(
      "  Prompt recall is on: on each prompt, up to 8 keywords from it are sent to search your memory.",
    );
  }
  if (features.capture) {
    lines.push(
      "  Capture is on: before compaction and at session end, the conversation's user and",
      "  assistant text (secrets removed) is sent to MindGraph.",
    );
  }
  lines.push("  The model can save notes, lessons and work through the MindGraph tools.");
  const baseUrl = (stored.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const org = stored.orgId ? `organization ${stored.orgId}` : "the API key's default organization";
  lines.push(
    "What leaves this machine",
    `  To ${baseUrl}, ${org}:`,
    `  a session record (date, model, harness) and ${subject.what}'s name and remote${subject.remote ? ` (${subject.remote})` : ""},`,
    "  plus whatever the model chooses to save.",
    features.capture
      ? "  Never: file contents or command output (tool calls and tool output are not sent)."
      : features.promptRecall
        ? "  Never: file contents or command output."
        : "  Never: your prompts, file contents, or command output.",
  );
  if (!stored.apiKey) {
    lines.push(
      `  No API key is saved for the hooks yet, so they send nothing until you run ${COMMAND} install-hooks.`,
    );
  }
  lines.push(
    "Who can read it",
    "  Anyone holding an API key for that organization. Memory here is labelled with",
    "  its own space once one exists; labels do not limit who can read.",
    "Why you are asked",
    "  MindGraph does nothing in a repository until you turn it on.",
    "Undo",
    `  ${COMMAND} off stops it at the next hook event. Memory already stored stays in MindGraph.`,
  );
  return lines;
}

const PREVIEW_LINE = `Nothing is sent while you decide. To see exactly what transcript capture would send from this directory, run ${COMMAND} hooks preview in another terminal.`;

export function repoCard(plan: RepoPlan, stored: HookEnv, remote: string | undefined): string[] {
  return [
    `Turn on MindGraph for ${displayPath(plan.root)}?`,
    "",
    ...cardBody(stored, {
      what: "this repository",
      remote: remote ?? "no remote; a local id is kept in the repository's .git folder",
    }),
    "",
    "  1. Turn on for this repository",
    "  2. Not now",
    "  3. Show what MindGraph sends (sends nothing)",
    "",
  ];
}

function repositoryRows(plan: WorkspacePlan, git: GitRunner): string[] {
  const width = Math.max(4, ...plan.included.map((r) => r.name.length));
  return plan.included.map((repository, index) => {
    const id =
      repository.declared_repo_id ?? remoteRepositoryId(repository.root, git) ?? "(no remote)";
    return `  ${String(index + 1).padStart(3)}  ${repository.name.padEnd(width)}  ${id}  ${repository.space_uid ?? "(no space)"}`;
  });
}

export function workspaceCard(plan: WorkspacePlan, stored: HookEnv, git: GitRunner): string[] {
  const name = plan.workspace_id ?? path.basename(plan.root);
  const lines = [
    `Turn on MindGraph for workspace ${name} (${displayPath(plan.root)})?`,
    "",
    `This workspace lists ${repositories(plan.listed)}; ${plan.included.length} can be turned on:`,
    ...repositoryRows(plan, git),
    `Sessions at ${displayPath(plan.root)} itself${plan.root_is_repository ? ", and in its own worktrees," : ""} use ${plan.root_space_uid}.`,
  ];
  if (plan.refused.length === 0) {
    lines.push("Not included: (none)");
  } else {
    lines.push("Not included:");
    for (const refused of plan.refused) lines.push(`  ${refused.name}  ${refused.reason}`);
  }
  lines.push(
    `Stay off (repositories here the workspace does not list): ${plan.undeclared.length ? plan.undeclared.join(", ") : "(none)"}`,
  );
  const targetRepo = plan.included.find((r) => pathContains(r.root, plan.target));
  if (plan.target !== plan.root && !targetRepo) {
    lines.push(
      `${displayPath(plan.target)} is not in a repository this workspace lists, so it stays off; add it to .mindgraph/workspace.json to include it.`,
    );
  }
  lines.push(
    "",
    ...cardBody(stored, { what: "each repository" }),
    "",
    plan.included.length
      ? `  1. Turn on for the workspace root and all ${repositories(plan.included.length)}`
      : "  1. Turn on for the workspace root",
    "  2. Choose repositories",
    "  3. Not now",
    "  4. Show what MindGraph sends (sends nothing)",
    "",
  );
  return lines;
}

// ── on ────────────────────────────────────────────────────────────────

export function storeProblem(loaded: LoadedConsentStore): string | undefined {
  switch (loaded.status) {
    case "ok":
    case "missing":
      return undefined;
    case "unreadable":
      return `${loaded.path} is not valid JSON, so it was left unchanged. Fix or remove it, then run this again.`;
    case "unsupported_version":
      return `${loaded.path} has consent settings this version does not understand, so they were left unchanged. Update with ${COMMAND}.`;
    case "unsafe_permissions":
      return `${loaded.path} or its folder can be changed by another account, so MindGraph does not trust it and nothing was changed. Fix: chmod 700 ${path.dirname(loaded.path)} && chmod 600 ${loaded.path}`;
    case "unsafe_location":
      return `${loaded.detail ?? `${loaded.path} is not in a safe place`}; nothing was changed.`;
  }
}

/** The env consent resolves with for on/off: MINDGRAPH_HOOKS=off pauses the
 * hooks, but must not hide which entry a path belongs to. */
export function resolutionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { MINDGRAPH_HOOKS: _paused, ...rest } = env;
  return rest;
}

const NOT_NOW = "Not now: nothing was changed.";

async function chooseMain(io: ConsentIo, max: number, notNow: number, preview: number): Promise<number | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = (await io.ask(`Choose 1-${max}. Enter chooses ${notNow}. `)).trim();
    const choice = /^\d+$/.test(answer) ? Number(answer) : undefined;
    if (choice === preview) {
      io.out(PREVIEW_LINE);
      continue;
    }
    return choice;
  }
  return undefined;
}

/** `on [path]`. Returns the exit code. */
export async function runOn(target: string | undefined, io: ConsentIo): Promise<number> {
  const terminal = requireHumanTerminal(io);
  if (!terminal.ok) {
    io.err(terminal.message);
    return 2;
  }
  const loaded = loadConsentStore(io.env);
  const problem = storeProblem(loaded);
  if (problem) {
    io.err(problem);
    return 1;
  }
  const git = io.git ?? nodeGit(io.env);
  const directory = path.resolve(io.cwd, target ?? ".");
  let plan: RepoPlan | WorkspacePlan;
  try {
    plan = planConsent(directory, { git });
  } catch (error) {
    if (error instanceof ConsentPlanError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }

  const current = resolveConsent(plan.target, loaded, { env: resolutionEnv(io.env) });
  if (
    current.state === "on" &&
    current.root === plan.root &&
    (plan.kind === "repo" || current.repo !== undefined)
  ) {
    io.out(
      `MindGraph is already on in ${displayPath(current.repo?.root ?? current.root)}. Check: ${COMMAND} status`,
    );
    return 0;
  }

  const stored = storedConnection(io.env);
  // Names and paths on the card come from a workspace file or from disk.
  const out = (line: string) => io.out(printable(line));
  let entry: ConsentRoot;
  let summary: string;
  if (plan.kind === "repo") {
    for (const line of repoCard(plan, stored, remoteRepositoryId(plan.root, git))) out(line);
    const choice = await chooseMain(io, 3, 2, 3);
    if (choice !== 1) {
      io.out(NOT_NOW);
      return 0;
    }
    const repository: PinnedRepository = {
      root: plan.root,
      repo_id: resolveRepositoryId(plan.root, undefined, git),
      space_uid: null,
    };
    entry = {
      root: plan.root,
      kind: "repo",
      repositories: [repository],
      consented_at: (io.now ?? (() => new Date()))().toISOString(),
      consented_with: { command: "on", version: io.version ?? "unknown" },
    };
    summary = `MindGraph is on in ${displayPath(plan.root)} from the next session.`;
  } else {
    for (const line of workspaceCard(plan, stored, git)) out(line);
    const choice = await chooseMain(io, 4, 3, 4);
    let rootEnabled: boolean;
    let chosen: PlannedRepository[];
    if (choice === 1) {
      rootEnabled = true;
      chosen = plan.included;
    } else if (choice === 2) {
      const picked = await chooseRepositories(io, plan);
      if (!picked) {
        io.out(NOT_NOW);
        return 0;
      }
      ({ rootEnabled, chosen } = picked);
    } else {
      io.out(NOT_NOW);
      return 0;
    }
    const pinnedSet: PinnedRepository[] = chosen.map((repository) => ({
      root: repository.root,
      repo_id: resolveRepositoryId(repository.root, repository.declared_repo_id, git),
      space_uid: repository.space_uid,
    }));
    entry = {
      root: plan.root,
      kind: "workspace",
      root_enabled: rootEnabled,
      root_space_uid: plan.root_space_uid,
      workspace_file: plan.workspace_file,
      workspace_sha256: plan.workspace_sha256,
      ...(plan.workspace_id ? { workspace_id: plan.workspace_id } : {}),
      repositories: pinnedSet,
      consented_at: (io.now ?? (() => new Date()))().toISOString(),
      consented_with: { command: "on", version: io.version ?? "unknown" },
    };
    const name = plan.workspace_id ?? path.basename(plan.root);
    const parts = rootEnabled
      ? pinnedSet.length
        ? `the root and ${repositories(pinnedSet.length)}`
        : "the root only"
      : `${repositories(pinnedSet.length)}; the root itself stays off`;
    summary = `MindGraph is on in ${displayPath(plan.root)} (workspace ${name}: ${parts}) from the next session.`;
  }

  io.beforeWrite?.();
  if (plan.kind === "workspace" && hashOf(plan.workspace_file) !== plan.workspace_sha256) {
    io.err("The workspace file changed while you were reading; nothing was saved. Run on again.");
    return 1;
  }
  const refreshed = io.refreshRunner?.();
  if (refreshed) io.out(refreshed);
  try {
    writeConsent(
      (store) => {
        store.roots = store.roots.filter((root) => root.root !== entry.root);
        store.roots.push(entry);
      },
      { env: io.env, now: io.now },
    );
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
  out(summary);
  out(`Check: ${COMMAND} status    Turn off: ${COMMAND} off ${commandPath(plan.root)}`);
  return 0;
}

function hashOf(file: string): string | undefined {
  try {
    return crypto.createHash("sha256").update(nodeConsentFs.readFile(file)).digest("hex");
  } catch {
    return undefined;
  }
}

async function chooseRepositories(
  io: ConsentIo,
  plan: WorkspacePlan,
): Promise<{ rootEnabled: boolean; chosen: PlannedRepository[] } | undefined> {
  io.out("    0  the workspace root itself");
  plan.included.forEach((repository, index) => {
    io.out(printable(`  ${String(index + 1).padStart(3)}  ${repository.name}`));
  });
  const answer = (await io.ask('Numbers separated by spaces, or "all": ')).trim().toLowerCase();
  if (!answer) return undefined;
  if (answer === "all") return { rootEnabled: true, chosen: plan.included };
  const picked = new Set<number>();
  for (const token of answer.split(/[\s,]+/)) {
    if (!/^\d+$/.test(token)) return undefined;
    const n = Number(token);
    if (n > plan.included.length) return undefined;
    picked.add(n);
  }
  return {
    rootEnabled: picked.has(0),
    chosen: plan.included.filter((_, index) => picked.has(index + 1)),
  };
}

// ── off ───────────────────────────────────────────────────────────────

const OFF_LINES = (where: string) => [
  `MindGraph is off in ${where} from the next hook event.`,
  "Hooks here will do nothing and send nothing; the tools of a coding setup (install-code) refuse here too.",
  "A general setup's MindGraph tools are not affected.",
  "Memory already stored here stays in MindGraph.",
  `Turn on again: ${COMMAND} on`,
];

/** The entry `off` acts on, and how. */
function offTarget(
  directory: string,
  decision: ConsentDecision,
  loaded: LoadedConsentStore,
): { entry: ConsentRoot; unpin?: PinnedRepository } | undefined {
  const roots = loaded.store?.roots ?? [];
  const byRoot = (root: string | undefined) => roots.find((r) => r.root === root);
  // The longest pinned repository of a workspace entry containing `p`.
  const pinnedFor = (entry: ConsentRoot, p: string) => {
    let match: PinnedRepository | undefined;
    for (const repository of entry.repositories) {
      if (pathContains(repository.root, p) && (!match || repository.root.length > match.root.length)) {
        match = repository;
      }
    }
    return match;
  };
  if (decision.state === "on") {
    const entry = byRoot(decision.root);
    if (!entry) return undefined;
    if (entry.kind === "workspace" && decision.repo) return { entry, unpin: decision.repo };
    return { entry };
  }
  if (decision.reason === "cwd_unresolvable") {
    // A folder that is gone. Act only on a stored path that is gone too, so a
    // mistyped path never turns off the places around it.
    let match: ConsentRoot | undefined;
    for (const root of roots) {
      if (pathContains(root.root, directory) && (!match || root.root.length > match.root.length)) {
        match = root;
      }
    }
    if (!match) return undefined;
    if (!stillThere(match.root)) return { entry: match };
    if (match.kind !== "workspace") return undefined;
    const pinned = pinnedFor(match, directory);
    return pinned && !stillThere(pinned.root) ? { entry: match, unpin: pinned } : undefined;
  }
  const entry = byRoot(decision.root);
  if (!entry) return undefined;
  // A paused entry goes; so does a workspace named at its root.
  if (decision.state === "needs_reapproval" || decision.directory === entry.root) {
    return { entry };
  }
  if (decision.reason === "not_consented") {
    // The repository was moved or lost its .git: a repository entry goes; in
    // a workspace only that repository is unpinned.
    if (entry.kind !== "workspace") return { entry };
    const pinned = decision.directory ? pinnedFor(entry, decision.directory) : undefined;
    return pinned ? { entry, unpin: pinned } : undefined;
  }
  return undefined;
}

function stillThere(root: string): boolean {
  try {
    return fs.realpathSync.native(root) === root;
  } catch {
    return false;
  }
}

/** `off [path]`. Allowed from any shell: it can only remove consent. */
export async function runOff(target: string | undefined, io: ConsentIo): Promise<number> {
  const loaded = loadConsentStore(io.env);
  const problem = storeProblem(loaded);
  if (problem) {
    io.err(problem);
    return 1;
  }
  const directory = path.resolve(io.cwd, target ?? ".");
  const decision = resolveConsent(directory, loaded, { env: resolutionEnv(io.env) });
  const action = offTarget(directory, decision, loaded);
  const refreshed = io.refreshRunner?.();
  if (refreshed) io.out(refreshed);
  try {
    writeConsent(
      (store) => {
        if (!action) return;
        if (action.unpin) {
          const entry = store.roots.find((r) => r.root === action.entry.root);
          if (entry) {
            entry.repositories = entry.repositories.filter((r) => r.root !== action.unpin!.root);
          }
        } else {
          store.roots = store.roots.filter((r) => r.root !== action.entry.root);
        }
      },
      { env: io.env, now: io.now },
    );
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
  if (!action) {
    io.out("MindGraph is already off here.");
    if (decision.state === "off" && decision.root) {
      io.out(
        `This folder is inside ${displayPath(decision.root)}, where MindGraph is on for other places. All of it: ${COMMAND} off ${commandPath(decision.root)}`,
      );
    }
    return 0;
  }
  if (action.unpin) {
    const name = action.entry.workspace_id ?? path.basename(action.entry.root);
    io.out(
      `${displayPath(action.unpin.root)} is part of workspace ${name}; MindGraph is off for this repository only. Whole workspace: ${COMMAND} off ${commandPath(action.entry.root)}`,
    );
    return 0;
  }
  for (const line of OFF_LINES(displayPath(action.entry.root))) io.out(line);
  return 0;
}

// ── status ────────────────────────────────────────────────────────────

const OFF_REASON: Partial<Record<string, string>> = {
  store_missing: "MindGraph has not been turned on anywhere on this machine yet",
  not_consented: "this directory is not inside a place you turned MindGraph on for",
  undeclared_repository: "this repository is not one the workspace lists",
  root_not_enabled: "the workspace root was left off when the workspace was turned on",
  hooks_paused: "MINDGRAPH_HOOKS=off is set in this shell",
  cwd_unresolvable: "this directory cannot be resolved",
  cwd_missing: "no directory was given",
};

/** The consent block that `status` starts with. */
export function consentStatusLines(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const loaded = loadConsentStore(env);
  const decision = resolveConsent(cwd, loaded, { env });
  const lines: string[] = [];
  const problem = storeProblem(loaded);
  if (problem) {
    lines.push(`MindGraph is off everywhere on this machine: ${problem}`);
  } else if (decision.state === "on") {
    const entry = loaded.store?.roots.find((r) => r.root === decision.root);
    const when = entry?.consented_at.slice(0, 10);
    const where =
      decision.kind === "workspace"
        ? `workspace ${entry?.workspace_id ?? path.basename(decision.root)} (${displayPath(decision.root)})${decision.repo ? `, repository ${path.basename(decision.repo.root)}` : ", the root itself"}`
        : `repository ${displayPath(decision.root)} (${decision.repo?.repo_id ?? "?"})`;
    lines.push(
      `MindGraph is on in this directory: ${where}${decision.reason === "consented_worktree" ? ", through a worktree of it" : ""}, space ${decision.space_uid ?? "(none yet)"}.${when ? ` Turned on ${when}.` : ""}`,
    );
  } else if (decision.state === "needs_reapproval") {
    const root = decision.root ?? cwd;
    lines.push(
      `MindGraph is paused in ${displayPath(root)}: .mindgraph/workspace.json ${decision.reason === "workspace_missing" ? "is missing" : "changed"} since you turned it on. Review: ${COMMAND} on ${commandPath(root)}`,
    );
  } else {
    lines.push(
      `MindGraph is off in this directory. Hooks here do nothing and send nothing; a coding setup's tools refuse here too (a general setup's tools are not affected). Turn on: ${COMMAND} on`,
    );
    const reason = OFF_REASON[decision.reason];
    if (reason) lines.push(`Why: ${reason}.`);
  }
  const where = mindgraphConfigDir(env);
  const home = passwdHome();
  if (where.source === "passwd" && home && env.HOME && path.resolve(env.HOME) !== path.resolve(home)) {
    lines.push(`The consent file is ${loaded.path} (from your account's home directory, not $HOME).`);
  }
  const roots = loaded.status === "ok" ? (loaded.store?.roots ?? []) : [];
  lines.push(`Turned on: ${roots.length} ${roots.length === 1 ? "place" : "places"}`);
  for (const root of roots) {
    lines.push(
      root.kind === "workspace"
        ? `  ${displayPath(root.root)}  workspace ${root.workspace_id ?? path.basename(root.root)}: root ${root.root_enabled ? "on" : "off"}, ${repositories(root.repositories.length)}`
        : `  ${displayPath(root.root)}  repository ${root.repositories[0]?.repo_id ?? ""}`,
    );
  }
  return lines;
}

/** Print a `HookConfigError` and return exit code 1; rethrow anything else. */
export function hookConfigFailure(error: unknown, err: (line: string) => void): number {
  if (error instanceof HookConfigError) {
    err(error.message);
    return 1;
  }
  throw error;
}
