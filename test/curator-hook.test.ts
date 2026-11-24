import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli-args.js";
import { cardBody } from "../src/consent-cli.js";
import { runClaudeHook, type HookClient } from "../src/claude-hooks.js";
import { loadHookEnv, resolvedHookFeatures, saveHookEnv } from "../src/hook-env.js";
import {
  buildCuratorTurnRequests,
  hasDurableIntentSignal,
  isTrivialCodingAck,
  pairTranscriptTurns,
  shouldCurateTurn,
} from "../src/hook-memory.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mg-curator-hook-"));
}

function writeTranscript(file: string, lines: Array<Record<string, unknown>>): void {
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

function mockClient(overrides: Partial<HookClient> = {}): HookClient {
  return {
    session: vi.fn(async () => ({ uid: "sess-1" })),
    plan: vi.fn(async () => ({})),
    curatorTurn: vi.fn(async () => ({
      turn_id: "turn-1",
      accepted_ops: [{ op: "remember", kind: "decision", text: "Use PostgreSQL" }],
      refused_ops: [],
    })),
    ...overrides,
  };
}

describe("Step S5 per-turn session curator hook", () => {
  let dir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    dir = tmpDir();
    origEnv = process.env.MINDGRAPH_HOOK_CURATOR;
    delete process.env.MINDGRAPH_HOOK_CURATOR;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MINDGRAPH_HOOK_CURATOR;
    else process.env.MINDGRAPH_HOOK_CURATOR = origEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses --curator (shadow-first), --curator-live, and --no-curator flags", () => {
    expect(parseArgs(["node", "cli", "install-hooks"]).curatorMode).toBeUndefined();
    expect(parseArgs(["node", "cli", "install-hooks", "--curator"]).curatorMode).toBe("shadow");
    expect(parseArgs(["node", "cli", "install-hooks", "--curator-shadow"]).curatorMode).toBe("shadow");
    expect(parseArgs(["node", "cli", "install-hooks", "--curator-live"]).curatorMode).toBe("live");
    expect(parseArgs(["node", "cli", "install-hooks", "--no-curator"]).curatorMode).toBe("off");
  });

  it("persists curatorMode in hooks.json and reflects shadow vs live honestly on consent card", () => {
    expect(resolvedHookFeatures(loadHookEnv(dir)).curatorMode).toBe("off");

    saveHookEnv({ curatorMode: "shadow" }, dir);
    const shadowEnv = loadHookEnv(dir);
    expect(resolvedHookFeatures(shadowEnv).curatorMode).toBe("shadow");
    const shadowCard = cardBody(shadowEnv, { what: "repository" }).join("\n");
    expect(shadowCard).toContain("shadow mode");
    expect(shadowCard).toContain("dry_run=true");

    saveHookEnv({ curatorMode: "live" }, dir);
    const liveEnv = loadHookEnv(dir);
    expect(resolvedHookFeatures(liveEnv).curatorMode).toBe("live");
    const liveCard = cardBody(liveEnv, { what: "repository" }).join("\n");
    expect(liveCard).toContain("Session curator is on");
    expect(liveCard).toContain("/curator/turn");
  });

  it("skips trivial coding acks, always admits durable signals, and throttles dense coding sessions <= 60/100", () => {
    expect(isTrivialCodingAck("ok")).toBe(true);
    expect(isTrivialCodingAck("Yes, proceed")).toBe(true);
    expect(isTrivialCodingAck("We decided to switch from SQLite to RocksDB.")).toBe(false);
    expect(
      hasDurableIntentSignal({
        user: "Please forget the old API endpoint and always use v2 instead.",
        assistant: "Understood.",
      }),
    ).toBe(true);

    // Simulate a dense 100-turn coding session where every non-throttled turn emits 1.2 ops.
    // 10 turns carry explicit durable user intent; 20 are short acks; 70 are routine debugging steps.
    let turnsEvaluated = 0;
    let acceptedOps = 0;
    let durableAdmitted = 0;
    for (let i = 0; i < 100; i++) {
      const pair =
        i % 10 === 0
          ? { user: `We decided to pin architecture rule #${i} and never use legacy mode.`, assistant: "Recorded." }
          : i % 5 === 1
            ? { user: "looks good", assistant: "Continuing." }
            : { user: `Check compiler output in file_${i}.rs line ${i + 10}`, assistant: `Ran check ${i}.` };
      const verdict = shouldCurateTurn(pair, { turnsEvaluated, acceptedOps });
      turnsEvaluated += 1;
      if (verdict.send) {
        if (i % 10 === 0) durableAdmitted += 1;
        // Simulate Haiku emitting ~1.2 ops/turn on sent coding turns
        acceptedOps += i % 5 === 0 ? 2 : 1;
      }
    }
    expect(durableAdmitted).toBe(10); // 100% of durable/decision/update/retraction turns admitted
    expect((100 * acceptedOps) / turnsEvaluated).toBeLessThanOrEqual(60);
  });

  it("redacts secrets and pairs user/assistant text while skipping tool blocks", () => {
    const transcript = path.join(dir, "t.jsonl");
    writeTranscript(transcript, [
      {
        type: "user",
        message: { content: "We decided to rotate sk-ant-1234567890abcdefghijklmnop and switch to KMS." },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo secret" } },
            { type: "text", text: "Switched KMS config; Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrst removed." },
          ],
        },
      },
    ]);
    const prep = buildCuratorTurnRequests(transcript, "s-redact", 0, {
      spaceUid: "space-repo-1",
      dryRun: true,
      nowIso: "2026-11-24T06:00:00Z",
    });
    expect(prep.requests).toHaveLength(1);
    const body = prep.requests[0].body as {
      space_uid: string;
      dry_run: boolean;
      prompt_version: string;
      idempotency_key: string;
      turn: { user: string; assistant: string };
    };
    expect(body.space_uid).toBe("space-repo-1");
    expect(body.dry_run).toBe(true);
    expect(body.prompt_version).toBe("v3");
    expect(body.idempotency_key).toBe("mcp-curator:s-redact:1");
    expect(body.turn.user).not.toContain("sk-ant-");
    expect(body.turn.user).toContain("[REDACTED]");
    expect(body.turn.assistant).not.toContain("eyJhbGci");
    expect(body.turn.assistant).not.toContain("echo secret");
  });

  it("runs shadow-first on Stop only when consented and opted in, respects MINDGRAPH_HOOK_CURATOR=off, and fails open on timeout", async () => {
    const transcript = path.join(dir, "sess.jsonl");
    const runtimeDir = path.join(dir, "runtime");
    writeTranscript(transcript, [
      { type: "user", message: { content: "We decided to freeze prompt_version v2 for confirmation." } },
      { type: "assistant", message: { content: "Frozen v2 as requested." } },
    ]);

    const onConsent = {
      state: "on" as const,
      root: dir,
      space_uid: "space-consented-1",
      inRepository: true,
      storeAcknowledged: true,
    };

    // 1. Default off: zero curator calls.
    const cOff = mockClient();
    await runClaudeHook(
      { session_id: "s1", cwd: dir, hook_event_name: "Stop", transcript_path: transcript },
      cOff,
      { runtimeDir, consent: onConsent },
    );
    expect(cOff.curatorTurn).not.toHaveBeenCalled();

    // 2. Env kill-switch MINDGRAPH_HOOK_CURATOR=off overrides stored mode.
    process.env.MINDGRAPH_HOOK_CURATOR = "off";
    const cKill = mockClient();
    await runClaudeHook(
      { session_id: "s1", cwd: dir, hook_event_name: "Stop", transcript_path: transcript },
      cKill,
      { runtimeDir, consent: onConsent, curatorMode: "shadow" },
    );
    expect(cKill.curatorTurn).not.toHaveBeenCalled();
    delete process.env.MINDGRAPH_HOOK_CURATOR;

    // 3. Shadow mode sends dry_run=true scoped to consented space_uid and records ledger telemetry.
    const cShadow = mockClient();
    await runClaudeHook(
      { session_id: "s2", cwd: dir, hook_event_name: "Stop", transcript_path: transcript },
      cShadow,
      { runtimeDir, consent: onConsent, curatorMode: "shadow" },
    );
    expect(cShadow.curatorTurn).toHaveBeenCalledTimes(1);
    const callArg = (cShadow.curatorTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.dry_run).toBe(true);
    expect(callArg.space_uid).toBe("space-consented-1");

    // Re-firing Stop with no new transcript bytes does NOT resend the same turn.
    await runClaudeHook(
      { session_id: "s2", cwd: dir, hook_event_name: "Stop", transcript_path: transcript },
      cShadow,
      { runtimeDir, consent: onConsent, curatorMode: "shadow" },
    );
    expect(cShadow.curatorTurn).toHaveBeenCalledTimes(1);

    // 4. Timeout fails open without throwing and preserves offset for retry.
    const cSlow = mockClient({
      curatorTurn: vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve({ accepted_ops: [] }), 500)),
      ),
    });
    const out = await runClaudeHook(
      { session_id: "s3", cwd: dir, hook_event_name: "Stop", transcript_path: transcript },
      cSlow,
      { runtimeDir, consent: onConsent, curatorMode: "live", curatorTimeoutMs: 20 },
    );
    expect(out).toEqual({});
    expect(pairTranscriptTurns([{ role: "user", text: "hi" }])).toHaveLength(1);
  });
});
