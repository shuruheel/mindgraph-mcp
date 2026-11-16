/**
 * Evaluation runs must never reach a hosted MindGraph.
 *
 * With `MINDGRAPH_EVAL=1`, every place this package builds a MindGraph
 * client or sends a request (the MCP server, the hooks, `import notes`,
 * `skills`, `init`) first passes its base URL through `evalBaseUrlRefusal`.
 * A URL whose host is not loopback (127.0.0.0/8, ::1, `localhost`) is
 * refused before any request is made, with the code `eval_requires_loopback`.
 * An unparseable URL is refused too: the check fails closed.
 *
 * An evaluation run also needs its own accepted `MINDGRAPH_HOME`
 * (`evalHomeRefusal`, code `eval_requires_home`): without one, the trial
 * would read the real `~/.mindgraph` (agent id, consent, runner, runtime
 * files); `on`, `off`, `off --all`, `import notes` and the installs check
 * it. A user-scope hook install or removal writes only into a configuration
 * directory the trial named (`evalUserScopeRefusal`, code
 * `eval_requires_config_dir`), never into the person's real settings;
 * `import notes` and `off --all` read Claude Code's files only from the
 * trial's `CLAUDE_CONFIG_DIR` (`evalClaudeReadRefusal`); and Claude Desktop's
 * and Cursor's configurations, which have no trial directory, are never
 * changed (`evalAppConfigRefusal`).
 */

import path from "node:path";
import { mindgraphConfigDir } from "./hook-env.js";

export const EVAL_REQUIRES_LOOPBACK = "eval_requires_loopback";
export const EVAL_REQUIRES_HOME = "eval_requires_home";
export const EVAL_REQUIRES_CONFIG_DIR = "eval_requires_config_dir";

/** `MINDGRAPH_EVAL=1` is set. */
export function evalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MINDGRAPH_EVAL === "1";
}

/** The host of an http(s) URL is loopback: `localhost`, an IPv4 address in
 * 127.0.0.0/8, or `::1`. WHATWG URL parsing has already canonicalised the
 * host (`127.1` and `0x7f.0.0.1` become `127.0.0.1`, `[0:0:0:0:0:0:0:1]`
 * becomes `[::1]`, and user-info before `@` is not the host), so the
 * comparison below runs on the canonical form only. */
export function isLoopbackUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(octets) && octets!.slice(1).every((o) => Number(o) <= 255) && octets![1] === "127";
}

/** The host to print in a refusal: never the full URL, which may carry
 * credentials or a path. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "(no host)";
  } catch {
    return "(not a URL)";
  }
}

/** The refusal message when eval mode is on and `baseUrl` is not loopback;
 * undefined when the URL may be used. */
export function evalBaseUrlRefusal(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!evalMode(env) || isLoopbackUrl(baseUrl)) return undefined;
  return (
    `${EVAL_REQUIRES_LOOPBACK}: MINDGRAPH_EVAL=1 is set, so MindGraph talks only to a server on this ` +
    `machine (127.0.0.0/8, ::1 or localhost); ${hostOf(baseUrl)} is not one. Nothing was sent.`
  );
}

/** Thrown where a client would otherwise be built. */
export class EvalLoopbackError extends Error {
  readonly code = EVAL_REQUIRES_LOOPBACK;
  constructor(message: string) {
    super(message);
    this.name = "EvalLoopbackError";
  }
}

/** Returns `baseUrl` unchanged, or throws `EvalLoopbackError` when eval mode
 * refuses it. Call it on the URL a client is about to be built with. */
export function assertEvalBaseUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const refusal = evalBaseUrlRefusal(baseUrl, env);
  if (refusal) throw new EvalLoopbackError(refusal);
  return baseUrl;
}

/** The refusal message when eval mode is on and `MINDGRAPH_HOME` is unset or
 * refused; undefined otherwise. A trial that fell back to the real
 * `~/.mindgraph` would run with the person's own settings and leave its
 * state there, so it stops instead. */
export function evalHomeRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!evalMode(env)) return undefined;
  const where = mindgraphConfigDir(env);
  if (where.source === "override") return undefined;
  const why = where.refused ?? "MINDGRAPH_HOME is not set";
  return (
    `${EVAL_REQUIRES_HOME}: MINDGRAPH_EVAL=1 is set, so MindGraph needs its own MINDGRAPH_HOME ` +
    `(an absolute path outside every git work tree); ${why}. Nothing was read or sent.`
  );
}

/** The refusal message when eval mode is on and a user-scope hook install
 * would write the person's real settings: Claude Code's user settings are
 * used only under an absolute `CLAUDE_CONFIG_DIR`, Codex's only under an
 * absolute `CODEX_HOME`. Project scope is the trial's own checkout. */
export function evalUserScopeRefusal(
  harness: "claude-code" | "codex",
  scope: "user" | "project",
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!evalMode(env) || scope !== "user") return undefined;
  const variable = harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const dir = env[variable];
  if (dir && path.isAbsolute(dir)) return undefined;
  return (
    `${EVAL_REQUIRES_CONFIG_DIR}: MINDGRAPH_EVAL=1 is set, so user-scope hooks are installed and removed only in ` +
    `the trial's own configuration directory; set ${variable} to an absolute path, or use --scope project. ` +
    `Nothing was written.`
  );
}

/** The refusal message when eval mode is on and `CLAUDE_CONFIG_DIR` is not an
 * absolute path, for a command that reads Claude Code's user files (settings,
 * notes, `.claude.json`): without it they would be the person's real ones,
 * read into the trial. */
export function evalClaudeReadRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!evalMode(env)) return undefined;
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir && path.isAbsolute(dir)) return undefined;
  return (
    `${EVAL_REQUIRES_CONFIG_DIR}: MINDGRAPH_EVAL=1 is set, so Claude Code's settings, notes and project list are ` +
    `read only from the trial's own configuration directory; set CLAUDE_CONFIG_DIR to an absolute path. ` +
    `Nothing was read or changed.`
  );
}

/** The refusal message when eval mode is on, for a command that writes an
 * application's configuration that cannot be moved to a trial directory
 * (Claude Desktop, Cursor). */
export function evalAppConfigRefusal(
  app: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!evalMode(env)) return undefined;
  return (
    `${EVAL_REQUIRES_CONFIG_DIR}: MINDGRAPH_EVAL=1 is set, and ${app}'s configuration has no trial directory, ` +
    `so an evaluation run never changes it. Nothing was written.`
  );
}
