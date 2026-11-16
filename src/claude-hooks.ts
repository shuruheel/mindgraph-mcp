import {
  readHookInput,
  runHookCore,
  type HookClient,
  type HookCoreOutput,
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
  return claudeHookOutput(output);
}

/** Claude Code's wire form of a hook result. */
export function claudeHookOutput(output: HookCoreOutput): Record<string, unknown> {
  switch (output.kind) {
    case "context":
      return {
        hookSpecificOutput: {
          hookEventName: output.event ?? "SessionStart",
          additionalContext: output.context,
        },
        ...(output.notice ? { systemMessage: output.notice } : {}),
      };
    case "rewrite":
      // H1: never return updatedInput. Auto mode reviews the input the model
      // wrote and refuses the call when a hook changes it afterwards; the
      // core already recorded these fields for the server (call-ledger.ts).
      return {};
    case "block":
      return { decision: "block", reason: output.reason };
    case "notice":
      // Shown to the user, never added to the model's context.
      return { systemMessage: output.message };
    case "noop":
      return {};
  }
}
