import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type HookScope = "user" | "project";

const OWNER_MARKER = "--owner mindgraph";
// The hook invokes a pinned copy of the self-contained CLI bundle, installed
// by installHookRunner(). `npx -y mindgraph-mcp@latest` here cost ~10s of
// re-resolution PER HOOK INVOCATION — SessionStart produced a perfect brief in
// 12.7s against an 8s timeout and was killed every time (2026-07-29 live
// test). A copied bundle starts in ~100ms and pins the version the user
// actually installed.
const RUNNER_RELATIVE = ".mindgraph/bin/mindgraph-hook.cjs";
const COMMAND = `node "$HOME/${RUNNER_RELATIVE}" hook --harness claude-code --owner mindgraph`;

/** Copy the executing CLI bundle to the stable runner path hooks invoke. */
export function installHookRunner(sourceFile: string, homeDir?: string): string {
  const target = path.join(homeDir || os.homedir(), RUNNER_RELATIVE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(sourceFile, target);
  return target;
}

export function uninstallHookRunner(homeDir?: string): void {
  try {
    fs.rmSync(path.join(homeDir || os.homedir(), RUNNER_RELATIVE));
  } catch {
    // Best effort — absence is the goal.
  }
}

type JsonObject = Record<string, unknown>;

function settingsPath(scope: HookScope, projectDir = process.cwd()): string {
  return scope === "user"
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(projectDir, ".claude", "settings.json");
}

function readSettings(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
}

function ownedHook(timeout: number) {
  return {
    type: "command",
    command: COMMAND,
    timeout,
    statusMessage: "Syncing MindGraph session context",
  };
}

function desiredEntries(): Record<string, JsonObject[]> {
  return {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact|fork",
        hooks: [ownedHook(20)],
      },
    ],
    PreToolUse: [
      {
        matcher: "mcp__mindgraph__.*",
        hooks: [ownedHook(3)],
      },
    ],
    PostToolUse: [{ matcher: ".*", hooks: [ownedHook(5)] }],
    TaskCreated: [{ hooks: [ownedHook(3)] }],
    TaskCompleted: [{ hooks: [ownedHook(3)] }],
    Stop: [{ hooks: [ownedHook(5)] }],
    SessionEnd: [{ hooks: [ownedHook(8)] }],
  };
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

export function installClaudeHooks(
  scope: HookScope,
  projectDir = process.cwd(),
): { path: string; added: number; updated: number } {
  const file = settingsPath(scope, projectDir);
  const settings = readSettings(file);
  const hooks =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? (settings.hooks as JsonObject)
      : {};
  let added = 0;
  let updated = 0;
  for (const [event, wanted] of Object.entries(desiredEntries())) {
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

export function uninstallClaudeHooks(
  scope: HookScope,
  projectDir = process.cwd(),
): { path: string; removed: number } {
  const file = settingsPath(scope, projectDir);
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
