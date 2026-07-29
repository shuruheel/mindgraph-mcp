/*
 * Codex command-hook wire map (verified against the current Codex Hooks,
 * Configuration Reference, and Plugin Packaging docs on 2026-07-29):
 *
 * Codex event / field                         -> shared behavior
 * SessionStart.session_id/cwd/model/source    -> session_start; open/rebind,
 *                                                recover/claim, hash-gated
 *                                                bounded brief injection
 * SessionStart stdout                         -> hookSpecificOutput with
 *                                                hookEventName=SessionStart and
 *                                                additionalContext
 * PreToolUse.session_id/turn_id/cwd/model     -> authoritative InvocationContext
 * PreToolUse.tool_name/tool_input             -> pre_tool; MindGraph MCP only
 * PreToolUse stdout                           -> permissionDecision=allow plus
 *                                                updatedInput (Codex requires
 *                                                "allow" for rewrites)
 * PostToolUse.tool_name/tool_input/response   -> post_tool runtime-ledger counters
 * Stop.stop_hook_active                       -> stop once-guard
 * Stop stdout                                 -> decision=block + reason
 * SessionEnd.reason                           -> cleanup-only session/execution close
 *
 * Codex config locations are $CODEX_HOME/hooks.json (normally
 * ~/.codex/hooks.json) and <project>/.codex/hooks.json. Command handlers support
 * per-hook timeouts in seconds; SessionEnd is capped at 3 seconds.
 *
 * Contract gaps: Codex has no Claude TaskCreated/TaskCompleted hook equivalents.
 * Those counters are advisory only, so B7 omits them rather than inventing a
 * substitute. SessionEnd can be delayed or absent and remains cleanup-only.
 * No graph/server/tool contract changes are required.
 *
 * Plugin packaging also supports the same schema at hooks/hooks.json (or a
 * manifest-relative path in .codex-plugin/plugin.json), with PLUGIN_ROOT and
 * PLUGIN_DATA available to commands. B7 installs user/project hooks directly;
 * plugin packaging can reuse this codec without changing its wire contract.
 */

import {
  readHookInput,
  runHookCore,
  type HookClient,
  type HookInput,
  type HookRuntimeOptions,
} from "./hook-core.js";

export type CodexHookInput = HookInput;
export type { HookClient, HookRuntimeOptions };
export { readHookInput };

export async function runCodexHook(
  input: CodexHookInput,
  client: HookClient,
  options: HookRuntimeOptions = {},
): Promise<Record<string, unknown>> {
  const output = await runHookCore(input, client, {
    ...options,
    harness: "codex",
    // B7's native contract suppresses repeated unchanged brief injections.
    reinjectUnchangedCompact: false,
  });
  switch (output.kind) {
    case "context":
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: output.context,
        },
      };
    case "rewrite":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: output.updatedInput,
        },
      };
    case "block":
      return { decision: "block", reason: output.reason };
    case "noop":
      return {};
  }
}
