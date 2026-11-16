import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHumanTerminal } from "./agent-shell.js";
import {
  loadConsentStore,
  resolveConsent,
  writeConsent,
  type LoadedConsentStore,
} from "./consent.js";
import {
  COMMAND,
  displayPath,
  resolutionEnv,
  storeProblem,
  type ConsentIo,
} from "./consent-cli.js";
import { nodeGit, printable, type GitRunner } from "./consent-plan.js";
import { passwdHome } from "./hook-env.js";

/**
 * `off --all`: turn MindGraph off everywhere, and remove the local files it
 * left in places that were never turned on. Only files whose path and name
 * are exactly what MindGraph writes are removed: never a directory tree, never
 * a symbolic link's target, never a file outside the runtime directory or a
 * repository's `.git/mindgraph` folder. The cloud, `.codegraph/` folders and
 * settings files are not touched.
 */

const LEDGER_NAME = /^[0-9a-f]{64}\.json$/;
const CALL_NAME = /^[0-9a-f]{64}\.[0-9a-f]{16}\.json$/;
const SCOPE_CACHE_FILE = "repository-scopes.json";
/** ~/.claude.json can be large; nothing MindGraph reads here is bigger. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

export interface Residue {
  /** `<git-common-dir>/mindgraph/repository-id` of repositories never turned on. */
  identityFiles: string[];
  /** Session records whose working directory was never turned on, with that directory. */
  ledgers: Array<{ file: string; directory: string }>;
  /** Pending tool calls whose project directory was never turned on. */
  calls: Array<{ file: string; directory: string }>;
  /** Cached repository lookups for repositories pinned nowhere. */
  scopeEntries: string[];
  scopeFile: string;
  runtimeDir: string;
}

export interface ResidueOptions {
  dryRun?: boolean;
  /** Claude Code's `.claude.json`; default: `claudeConfigFile(env)`. */
  claudeConfig?: string;
}

/** The runtime directory hooks and the call ledger use today. */
export function runtimeDirFor(env: NodeJS.ProcessEnv): string {
  return env.MINDGRAPH_RUNTIME_DIR || path.join(os.homedir(), ".mindgraph", "runtime");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A regular file (not a link), read as JSON; undefined otherwise. */
function readJsonFile(file: string): unknown {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function isRealDirectory(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function realpath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** Claude Code's `.claude.json`: in `CLAUDE_CONFIG_DIR` when that is set to an
 * absolute path (as Claude Code itself reads it), else in the account's home. */
export function claudeConfigFile(env: NodeJS.ProcessEnv): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir && path.isAbsolute(dir)) return path.join(dir, ".claude.json");
  const home = passwdHome();
  return home ? path.join(home, ".claude.json") : "";
}

function claudeProjectDirectories(file: string): string[] {
  const parsed = readJsonFile(file);
  if (!isRecord(parsed) || !isRecord(parsed.projects)) return [];
  return Object.keys(parsed.projects);
}

/**
 * What `off --all` would remove, computed against the store as it stands now.
 * A path counts as never turned on when consent does not resolve on there.
 */
export function findResidue(
  loaded: LoadedConsentStore,
  options: { env: NodeJS.ProcessEnv; git: GitRunner; claudeConfig: string },
): Residue {
  const env = resolutionEnv(options.env);
  const consented = (dir: string) =>
    resolveConsent(dir, loaded, { env }).state === "on";
  const roots = loaded.status === "ok" ? (loaded.store?.roots ?? []) : [];
  const storedPaths = new Set<string>();
  const pinnedIds = new Set<string>();
  for (const root of roots) {
    storedPaths.add(root.root);
    for (const repository of root.repositories) {
      storedPaths.add(repository.root);
      pinnedIds.add(repository.repo_id);
    }
  }

  const runtimeDir = runtimeDirFor(options.env);
  const candidates = new Set<string>();
  const ledgers: Residue["ledgers"] = [];
  for (const name of listDir(runtimeDir)) {
    if (!LEDGER_NAME.test(name)) continue;
    const file = path.join(runtimeDir, name);
    const record = readJsonFile(file);
    // Records written before consent existed carry the directory a tool
    // call ran in; current ones do not.
    const directory = isRecord(record) ? record.repoContextCwd : undefined;
    if (typeof directory !== "string" || !path.isAbsolute(directory)) continue;
    candidates.add(directory);
    if (!consented(directory)) ledgers.push({ file, directory });
  }

  const callsDir = path.join(runtimeDir, "calls");
  const calls: Residue["calls"] = [];
  for (const name of listDir(callsDir)) {
    if (!CALL_NAME.test(name)) continue;
    const file = path.join(callsDir, name);
    const record = readJsonFile(file);
    const directory = isRecord(record) ? record.projectDir : undefined;
    if (typeof directory !== "string" || !path.isAbsolute(directory)) continue;
    candidates.add(directory);
    if (!consented(directory)) calls.push({ file, directory });
  }

  for (const directory of claudeProjectDirectories(options.claudeConfig)) {
    if (path.isAbsolute(directory)) candidates.add(directory);
  }

  const identityFiles = new Set<string>();
  for (const directory of candidates) {
    const file = identityFileFor(directory, options.git, consented, storedPaths, pinnedIds);
    if (file) identityFiles.add(file);
  }

  const scopeFile = path.join(runtimeDir, SCOPE_CACHE_FILE);
  const cache = readJsonFile(scopeFile);
  const scopeEntries =
    isRecord(cache) && cache.v === 1 && isRecord(cache.entries)
      ? Object.keys(cache.entries).filter((repoId) => !pinnedIds.has(repoId))
      : [];

  return {
    identityFiles: [...identityFiles].sort(),
    ledgers,
    calls,
    scopeEntries,
    scopeFile,
    runtimeDir,
  };
}

/** The repository-id file MindGraph may have written for the repository at
 * `directory`, when that repository was never turned on; else undefined. */
function identityFileFor(
  directory: string,
  git: GitRunner,
  consented: (dir: string) => boolean,
  storedPaths: Set<string>,
  pinnedIds: Set<string>,
): string | undefined {
  try {
    if (!fs.statSync(directory).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  if (consented(directory)) return undefined;
  let output: string;
  try {
    output = git(["-C", directory, "rev-parse", "--show-toplevel", "--git-common-dir"]);
  } catch {
    return undefined;
  }
  const [topLine, commonLine] = output.split("\n").map((line) => line.trim());
  if (!topLine || !commonLine) return undefined;
  const top = realpath(path.resolve(directory, topLine));
  const common = realpath(path.resolve(directory, commonLine));
  if (!top || !common || path.basename(common) !== ".git") return undefined;
  const owner = path.dirname(common);
  // A repository anything in the store names, or that resolves on (a
  // worktree's main checkout, say), keeps its identity even when this
  // particular directory is off.
  for (const p of [top, owner]) {
    if (storedPaths.has(p) || consented(p)) return undefined;
  }
  const identityDir = path.join(common, "mindgraph");
  const file = path.join(identityDir, "repository-id");
  if (!isRealDirectory(identityDir) || !isRegularFile(file)) return undefined;
  // The store pins remote-less repositories by this file's content, so a
  // repository turned on from a linked worktree, or turned on and then
  // moved, keeps its identity even though no stored path leads here.
  const id = readSmallText(file);
  if (id === undefined || pinnedIds.has(id)) return undefined;
  return file;
}

/** The trimmed text of a small regular file; undefined when unreadable. */
function readSmallText(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

// ── Removal ───────────────────────────────────────────────────────────

/** Unlink `file` only if it is a regular file directly inside `dir` whose
 * name passes `name`. A link, a directory or anything else is left alone. */
function removeExact(file: string, dir: string, name: (base: string) => boolean): boolean {
  if (path.dirname(file) !== dir || !name(path.basename(file))) return false;
  if (!isRegularFile(file)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function removeIdentityFile(file: string): boolean {
  const identityDir = path.dirname(file);
  if (
    path.basename(file) !== "repository-id" ||
    path.basename(identityDir) !== "mindgraph" ||
    path.basename(path.dirname(identityDir)) !== ".git" ||
    !isRealDirectory(identityDir)
  ) {
    return false;
  }
  const removed = removeExact(file, identityDir, (base) => base === "repository-id");
  if (removed) {
    try {
      fs.rmdirSync(identityDir); // only when empty
    } catch {
      // Something else lives there; leave it.
    }
  }
  return removed;
}

/** Rewrite the scope cache without `drop`, atomically. Returns how many
 * entries were dropped. */
function rewriteScopeCache(file: string, drop: Set<string>): number {
  const cache = readJsonFile(file);
  if (!isRecord(cache) || cache.v !== 1 || !isRecord(cache.entries)) return 0;
  const kept: Record<string, unknown> = {};
  let dropped = 0;
  for (const [repoId, entry] of Object.entries(cache.entries)) {
    if (drop.has(repoId)) dropped++;
    else kept[repoId] = entry;
  }
  if (dropped === 0) return 0;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...cache, entries: kept }), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    return dropped;
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Nothing was written.
    }
    return 0;
  }
}

// ── The command ───────────────────────────────────────────────────────

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function residueLines(residue: Residue, placesOn: number): string[] {
  const lines = [
    placesOn
      ? `MindGraph is on in ${count(placesOn, "place", "places")}; all of them will be turned off.`
      : "MindGraph is not turned on anywhere.",
    "Local files MindGraph left in places you never turned on:",
  ];
  const total =
    residue.identityFiles.length +
    residue.ledgers.length +
    residue.calls.length +
    residue.scopeEntries.length;
  if (total === 0) lines.push("  None found.");
  if (residue.identityFiles.length) {
    lines.push(`  Repository identity files (${residue.identityFiles.length}):`);
    for (const file of residue.identityFiles) lines.push(`    ${displayPath(file)}`);
  }
  if (residue.ledgers.length) {
    lines.push(`  Session records (${residue.ledgers.length}):`);
    for (const { file, directory } of residue.ledgers) {
      lines.push(`    ${displayPath(file)}  (from ${displayPath(directory)})`);
    }
  }
  if (residue.calls.length) {
    lines.push(`  Pending tool calls (${residue.calls.length}):`);
    for (const { file, directory } of residue.calls) {
      lines.push(`    ${displayPath(file)}  (from ${displayPath(directory)})`);
    }
  }
  if (residue.scopeEntries.length) {
    lines.push(
      `  Cached repository lookups in ${displayPath(residue.scopeFile)} (${residue.scopeEntries.length}): ${residue.scopeEntries.join(", ")}`,
    );
  }
  lines.push(
    "Only directories Claude Code or MindGraph's own records remember were checked.",
    "Not touched: memory stored in MindGraph, .codegraph folders and settings files.",
  );
  return lines;
}

/** `off --all [--dry-run]`. Returns the exit code. */
export async function runOffAll(io: ConsentIo, options: ResidueOptions = {}): Promise<number> {
  // A dry run changes nothing, so like plain `off` it runs from any shell.
  if (!options.dryRun) {
    const terminal = requireHumanTerminal(io);
    if (!terminal.ok) {
      io.err(terminal.message);
      return 2;
    }
  }
  const loaded = loadConsentStore(io.env);
  const problem = storeProblem(loaded);
  if (problem) {
    // An unreadable store would make every repository look never turned on.
    io.err(problem);
    return 1;
  }
  const claudeConfig = options.claudeConfig ?? claudeConfigFile(io.env);
  const residue = findResidue(loaded, {
    env: io.env,
    git: io.git ?? nodeGit(io.env),
    claudeConfig,
  });
  const placesOn = loaded.status === "ok" ? (loaded.store?.roots.length ?? 0) : 0;
  const out = (line: string) => io.out(printable(line));

  if (options.dryRun) {
    out("What off --all would do (dry run; nothing is changed):");
    for (const line of residueLines(residue, placesOn)) out(line);
    out("Dry run: nothing was removed or changed.");
    return 0;
  }

  out("Turn MindGraph off everywhere on this machine?");
  out("");
  for (const line of residueLines(residue, placesOn)) out(line);
  out("");
  out("  1. Turn off everywhere and remove the files listed");
  out("  2. Not now");
  out("");
  const answer = (await io.ask("Choose 1-2. Enter chooses 2. ")).trim();
  if (answer !== "1") {
    io.out("Not now: nothing was changed.");
    return 0;
  }

  const refreshed = io.refreshRunner?.();
  if (refreshed) io.out(refreshed);
  try {
    writeConsent(
      (store) => {
        store.roots = [];
      },
      { env: io.env, now: io.now },
    );
  } catch (error) {
    io.err(`${(error as Error).message} No files were removed.`);
    return 1;
  }

  let failed = 0;
  const tally = (removed: boolean) => {
    if (!removed) failed++;
    return removed;
  };
  const identities = residue.identityFiles.filter((file) => tally(removeIdentityFile(file))).length;
  const callsDir = path.join(residue.runtimeDir, "calls");
  const ledgers = residue.ledgers.filter(({ file }) =>
    tally(removeExact(file, residue.runtimeDir, (base) => LEDGER_NAME.test(base))),
  ).length;
  const calls = residue.calls.filter(({ file }) =>
    tally(removeExact(file, callsDir, (base) => CALL_NAME.test(base))),
  ).length;
  const lookups = residue.scopeEntries.length
    ? rewriteScopeCache(residue.scopeFile, new Set(residue.scopeEntries))
    : 0;
  failed += residue.scopeEntries.length - lookups;

  out("MindGraph is off everywhere on this machine from the next hook event.");
  out(
    `Removed: ${count(identities, "repository identity file", "repository identity files")}, ${count(ledgers, "session record", "session records")}, ${count(calls, "pending tool call", "pending tool calls")}, ${count(lookups, "cached repository lookup", "cached repository lookups")}.`,
  );
  if (failed > 0) {
    out(`${count(failed, "item was", "items were")} left in place (changed or not removable since the list was made).`);
  }
  out(`Memory already stored stays in MindGraph. Turn on again: ${COMMAND} on`);
  return 0;
}
