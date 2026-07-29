import {
  readHookInput,
  runHookCore,
  type HookClient,
  type HookInput,
  type HookRuntimeOptions,
} from "./hook-core.js";

export type ClaudeHookInput = HookInput;
export type { HookClient, HookRuntimeOptions };
export { readHookInput };

export async function runClaudeHook(
  input: ClaudeHookInput,
  client: HookClient,
  options: HookRuntimeOptions = {},
): Promise<Record<string, unknown>> {
  const output = await runHookCore(input, client, {
    ...options,
    harness: "claude-code",
    // D10: compaction is a new Claude context boundary, so the same brief must
    // be re-injected even when its content hash is unchanged.
    reinjectUnchangedCompact: true,
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
          updatedInput: output.updatedInput,
        },
      };
    case "block":
      return { decision: "block", reason: output.reason };
    case "noop":
      return {};
  }
}
