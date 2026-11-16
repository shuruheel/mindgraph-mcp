// The answer a coding-profile MCP server gives where MindGraph is not on.
// No filesystem access here: the server module and the tool handlers build
// these from a decision they were handed.
import type { ConsentDecision, OnDecision } from "./consent.js";

export const TURN_ON = "npx -y mindgraph-mcp@latest on";

export interface NotOptedInPayload {
  [key: string]: unknown;
  error: string;
  code: "not_opted_in";
  retriable: false;
  state: string;
  reason: string;
  directory: string;
  command: string;
}

/** What the coding server's gate returns for one request. */
export type ConsentCheck =
  | { allowed: true; decision: OnDecision }
  | { allowed: false; payload: NotOptedInPayload };

/** Quoted unless every character is safe. A leading `~` or `=` is quoted
 * too: a shell would expand it (`~user`, zsh's `=cmd`) into another path. */
function shellArg(p: string): string {
  return /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./~-]*$/.test(p)
    ? p
    : `'${p.replace(/'/g, `'\\''`)}'`;
}

const FROM_A_TERMINAL =
  "in a terminal outside this session; it cannot be done from here.";

/** The refusal for a directory whose decision is not on. `requested` is a
 * real directory the caller knows (the session's); a call's own directory
 * that did not resolve is never echoed back. */
export function notOptedIn(
  decision: Pick<ConsentDecision, "state" | "reason" | "directory" | "root">,
  requested?: string,
): NotOptedInPayload {
  const directory = decision.directory ?? requested;
  if (directory === undefined) {
    return {
      error: `The directory this call came from could not be resolved, so MindGraph treats it as off. Nothing was sent.`,
      code: "not_opted_in",
      retriable: false,
      state: decision.state,
      reason: decision.reason,
      directory: "",
      command: TURN_ON,
    };
  }
  if (decision.state === "needs_reapproval" && decision.root) {
    const command = `${TURN_ON} ${shellArg(decision.root)}`;
    return {
      error: `MindGraph is paused in ${decision.root}: .mindgraph/workspace.json changed since it was turned on. Nothing was sent. The developer can review it by running \`${command}\` ${FROM_A_TERMINAL}`,
      code: "not_opted_in",
      retriable: false,
      state: decision.state,
      reason: decision.reason,
      directory,
      command,
    };
  }
  return {
    error: `MindGraph is off in ${directory}. Nothing was sent. The developer can turn it on by running \`${TURN_ON}\` ${FROM_A_TERMINAL}`,
    code: "not_opted_in",
    retriable: false,
    state: decision.state,
    reason: decision.reason,
    directory,
    command: `${TURN_ON} ${shellArg(directory)}`,
  };
}

/** A call whose own directory is on, but under a different root than the
 * one this server's session runs in. */
export function otherRoot(session: OnDecision, call: OnDecision): NotOptedInPayload {
  return {
    error: `This call came from ${call.directory}, which is outside ${session.root}, where this MindGraph server runs. Nothing was sent. Start a session in ${call.root} to use MindGraph there.`,
    code: "not_opted_in",
    retriable: false,
    state: "off",
    reason: "outside_root",
    directory: call.directory,
    command: `${TURN_ON} ${shellArg(call.directory)}`,
  };
}

/** A repository, ref path or name outside the pinned set of an on decision. */
export function outsidePinnedSet(
  decision: Pick<OnDecision, "directory" | "root">,
  message: string,
): NotOptedInPayload {
  return {
    error: `${message} Nothing was read or sent. Here MindGraph works only with the repositories turned on for ${decision.root}; the developer can review that list by running \`${TURN_ON} ${shellArg(decision.root)}\` ${FROM_A_TERMINAL}`,
    code: "not_opted_in",
    retriable: false,
    state: "on",
    reason: "outside_pinned_set",
    directory: decision.directory,
    command: `${TURN_ON} ${shellArg(decision.root)}`,
  };
}

/** A local coding tool reached with no consent decision at all (a caller
 * that did not wire the gate). Fails closed. */
export function noConsentDecision(): NotOptedInPayload {
  return {
    error: `MindGraph could not check whether it is on here, so nothing was sent. The developer can turn it on by running \`${TURN_ON}\` ${FROM_A_TERMINAL}`,
    code: "not_opted_in",
    retriable: false,
    state: "off",
    reason: "no_consent_check",
    directory: "",
    command: TURN_ON,
  };
}

export function refusalResult(payload: NotOptedInPayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError: true as const,
  };
}
