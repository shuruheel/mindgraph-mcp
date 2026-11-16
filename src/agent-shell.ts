/**
 * Turning MindGraph on needs a person's answer at a terminal. This module
 * recognises the shell of a coding agent (Claude Code, Codex, Cursor and
 * others) by the environment variables those tools set for the commands they
 * run, and requires that both standard input and standard output are
 * terminals.
 *
 * It stops a model that runs the command as it was given, whether or not
 * the instruction was injected. It is not a sandbox: an agent that sets out
 * to defeat it can start a detached terminal or edit hooks.json directly,
 * and each of those shows in the transcript and passes the harness's own
 * permission prompts.
 */

/** Variables whose presence marks an agent's shell, in the order checked. */
export const AGENT_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "AI_AGENT",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_EXTENSION_HOST_ROLE",
  "GEMINI_CLI",
  "OPENCODE",
  "OPENCODE_CLIENT",
  "AUGMENT_AGENT",
  "ANTIGRAVITY_AGENT",
] as const;

/** Only this value of CURSOR_EXTENSION_HOST_ROLE marks an agent; Cursor sets
 * the variable for other extension hosts too. */
const CURSOR_AGENT_ROLE = "agent-exec";

/** The first agent variable present in `env`, as `NAME=value`; undefined in a
 * person's own shell. */
export function agentShellSignal(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of AGENT_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (name === "CURSOR_EXTENSION_HOST_ROLE" && value !== CURSOR_AGENT_ROLE) {
      continue;
    }
    return `${name}=${value.length > 40 ? `${value.slice(0, 40)}…` : value}`;
  }
  return undefined;
}

export interface TerminalStreams {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
}

export type TerminalCheck = { ok: true } | { ok: false; message: string };

/**
 * Refuse unless this looks like a person at a terminal: no agent variable,
 * and both standard input and standard output are terminals. The message is
 * for stderr; the caller exits 2.
 */
export function requireHumanTerminal(io: TerminalStreams): TerminalCheck {
  const signal =
    agentShellSignal(io.env) ??
    (!io.stdin.isTTY || !io.stdout.isTTY
      ? "no terminal (input or output is not a terminal)"
      : undefined);
  if (!signal) return { ok: true };
  return {
    ok: false,
    message:
      "This needs your answer at a terminal; it cannot be approved from inside a Claude Code, Codex or Cursor session.\n" +
      `Detected: ${signal}. Run this in a terminal window that you opened yourself.`,
  };
}
