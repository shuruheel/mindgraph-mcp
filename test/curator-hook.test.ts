import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli-args.js";
import { cardBody } from "../src/consent-cli.js";
import { runClaudeHook, type HookClient } from "../src/claude-hooks.js";
import { loadHookEnv, resolvedHookFeatures, saveHookEnv } from "../src/hook-env.js";
import { installClaudeHooks } from "../src/hook-installer.js";
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

  it("fails closed when consented space_uid is null/empty so curator never writes to unscoped default space", async () => {
    const transcript = path.join(dir, "unscoped.jsonl");
    const runtimeDir = path.join(dir, "runtime");
    writeTranscript(transcript, [
      { type: "user", message: { content: "We decided to move auth to OAuth2." } },
      { type: "assistant", message: { content: "Noted." } },
    ]);

    const nullSpaceConsent = {
      state: "on" as const,
      root: dir,
      space_uid: null,
      inRepository: true,
      storeAcknowledged: true,
    };

    const client = mockClient();
    await runClaudeHook(
      { session_id: "s-null-space", cwd: dir, hook_event_name: "Stop", transcript_path: transcript },
      client,
      { runtimeDir, consent: nullSpaceConsent, curatorMode: "live" },
    );
    expect(client.curatorTurn).not.toHaveBeenCalled();

    // Direct request builder also refuses empty spaceUid.
    expect(() =>
      buildCuratorTurnRequests(transcript, "s-empty-space", 0, {
        spaceUid: "   ",
        dryRun: true,
      }),
    ).toThrow(/non-empty spaceUid/);
  });

  it("registers PreCompact in Claude settings when curatorMode is shadow/live even with capture=false, and strips it when off", () => {
    const resShadow = installClaudeHooks("project", dir, {
      capture: false,
      curatorMode: "shadow",
    });
    const settingsShadow = JSON.parse(fs.readFileSync(resShadow.path, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(settingsShadow.hooks.PreCompact).toBeDefined();

    const resOff = installClaudeHooks("project", dir, {
      capture: false,
      curatorMode: "off",
    });
    const settingsOff = JSON.parse(fs.readFileSync(resOff.path, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(settingsOff.hooks.PreCompact).toBeUndefined();
    expect(resOff.removedEvents).toContain("PreCompact");
  });

  it("advances curatorOffset past tool-only lines without calling /curator/turn, commits partial-batch progress, and enforces total dispatch deadline", async () => {
    const transcript = path.join(dir, "partial.jsonl");
    const runtimeDir = path.join(dir, "runtime");
    const onConsent = {
      state: "on" as const,
      root: dir,
      space_uid: "space-partial-1",
      inRepository: true,
      storeAcknowledged: true,
    };

    // 1. Tool-only JSONL lines advance curatorOffset with zero curator calls.
    writeTranscript(transcript, [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      },
    ]);
    const cToolOnly = mockClient();
    await runClaudeHook(
      { session_id: "s-tool", cwd: dir, hook_event_name: "Stop", transcript_path: transcript },
      cToolOnly,
      { runtimeDir, consent: onConsent, curatorMode: "shadow" },
    );
    expect(cToolOnly.curatorTurn).not.toHaveBeenCalled();

    // Appending a real turn after the tool-only block processes only the new turn cleanly.
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({ type: "user", message: { content: "We decided to enforce strict CSP headers." } })}\n` +
        `${JSON.stringify({ type: "assistant", message: { content: "Recorded strict CSP rule." } })}\n`,
      "utf8",
    );
    await runClaudeHook(
      { session_id: "s-tool", cwd: dir, hook_event_name: "Stop", transcript_path: transcript },
      cToolOnly,
      { runtimeDir, consent: onConsent, curatorMode: "shadow" },
    );
    expect(cToolOnly.curatorTurn).toHaveBeenCalledTimes(1);

    // 2. Partial-batch failure: turn 1 succeeds, turn 2 fails -> offset commits past turn 1 so retry sends ONLY turn 2.
    const batchFile = path.join(dir, "batch.jsonl");
    writeTranscript(batchFile, [
      { type: "user", message: { content: "We decided to require TLS 1.3 for all services." } },
      { type: "assistant", message: { content: "Noted TLS 1.3 requirement." } },
      { type: "user", message: { content: "We decided to sunset v1 webhooks next quarter." } },
      { type: "assistant", message: { content: "Noted v1 webhook sunset." } },
    ]);
    let attempt = 0;
    const seenKeys: string[] = [];
    const cPartial = mockClient({
      curatorTurn: vi.fn(async (body: Record<string, unknown>) => {
        attempt += 1;
        seenKeys.push(String(body.idempotency_key));
        if (attempt === 2) throw new Error("transient network reset");
        return { turn_id: `t-${attempt}`, accepted_ops: [], refused_ops: [] };
      }),
    });
    await runClaudeHook(
      { session_id: "s-batch", cwd: dir, hook_event_name: "Stop", transcript_path: batchFile },
      cPartial,
      { runtimeDir, consent: onConsent, curatorMode: "shadow" },
    );
    expect(seenKeys).toEqual(["mcp-curator:s-batch:1", "mcp-curator:s-batch:2"]);

    // Retry must NOT re-send turn 1 (no shadow re-billing / no duplicate dispatch); only turn 2 fires.
    await runClaudeHook(
      { session_id: "s-batch", cwd: dir, hook_event_name: "Stop", transcript_path: batchFile },
      cPartial,
      { runtimeDir, consent: onConsent, curatorMode: "shadow" },
    );
    expect(seenKeys).toEqual([
      "mcp-curator:s-batch:1",
      "mcp-curator:s-batch:2",
      "mcp-curator:s-batch:2",
    ]);

    // 3. Total dispatch deadline stops remaining turns once cumulative budget is exhausted.
    const burstFile = path.join(dir, "burst.jsonl");
    writeTranscript(burstFile, [
      { type: "user", message: { content: "We decided to adopt Biome for linting." } },
      { type: "assistant", message: { content: "Recorded Biome." } },
      { type: "user", message: { content: "We decided to adopt Vitest for unit tests." } },
      { type: "assistant", message: { content: "Recorded Vitest." } },
    ]);
    const cDeadline = mockClient({
      curatorTurn: vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ turn_id: "t-slow", accepted_ops: [], refused_ops: [] }), 60),
          ),
      ),
    });
    await runClaudeHook(
      { session_id: "s-deadline", cwd: dir, hook_event_name: "Stop", transcript_path: burstFile },
      cDeadline,
      { runtimeDir, consent: onConsent, curatorMode: "shadow", curatorTimeoutMs: 70 },
    );
    // Turn 1 consumes ~60ms of the 70ms total budget; turn 2 must NOT run past the shared deadline.
    expect(cDeadline.curatorTurn).toHaveBeenCalledTimes(1);
  });
});
