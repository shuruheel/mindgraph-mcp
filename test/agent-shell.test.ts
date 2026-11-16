import { describe, expect, it } from "vitest";
import {
  AGENT_ENV_VARS,
  agentShellSignal,
  requireHumanTerminal,
} from "../src/agent-shell.js";

const TTY = { isTTY: true };

describe("agent shell signal", () => {
  it.each(AGENT_ENV_VARS.filter((name) => name !== "CURSOR_EXTENSION_HOST_ROLE"))(
    "%s marks an agent's shell",
    (name) => {
      expect(agentShellSignal({ [name]: "1" })).toBe(`${name}=1`);
    },
  );

  it("CURSOR_EXTENSION_HOST_ROLE marks an agent only as agent-exec", () => {
    expect(agentShellSignal({ CURSOR_EXTENSION_HOST_ROLE: "agent-exec" })).toBe(
      "CURSOR_EXTENSION_HOST_ROLE=agent-exec",
    );
    expect(agentShellSignal({ CURSOR_EXTENSION_HOST_ROLE: "user" })).toBeUndefined();
  });

  it("an empty variable, and a plain shell, are not an agent", () => {
    expect(agentShellSignal({ CLAUDECODE: "" })).toBeUndefined();
    expect(agentShellSignal({ PATH: "/usr/bin", HOME: "/home/me", TERM: "xterm" })).toBeUndefined();
  });

  it("names the first variable found, with a long value cut short", () => {
    const signal = agentShellSignal({ AI_AGENT: "x".repeat(100), CODEX_CI: "1" });
    expect(signal?.startsWith("AI_AGENT=")).toBe(true);
    expect(signal!.length).toBeLessThan(60);
  });
});

describe("requireHumanTerminal", () => {
  it("allows a person's terminal", () => {
    expect(requireHumanTerminal({ stdin: TTY, stdout: TTY, env: {} })).toEqual({ ok: true });
  });

  it("refuses an agent's shell even with a terminal, naming the variable", () => {
    const check = requireHumanTerminal({ stdin: TTY, stdout: TTY, env: { CLAUDECODE: "1" } });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.message).toContain("Detected: CLAUDECODE=1");
      expect(check.message).toContain("terminal window that you opened yourself");
    }
  });

  it("refuses when input or output is not a terminal", () => {
    for (const io of [
      { stdin: {}, stdout: TTY },
      { stdin: TTY, stdout: { isTTY: false } },
    ]) {
      const check = requireHumanTerminal({ ...io, env: {} });
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.message).toContain("Detected: no terminal");
    }
  });
});
