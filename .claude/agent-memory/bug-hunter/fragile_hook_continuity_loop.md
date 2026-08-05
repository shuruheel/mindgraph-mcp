---
name: fragile-hook-continuity-loop
description: Where the mindgraph-mcp coding-agent hook loop (hook-core.ts SessionStart/PreToolUse/PostToolUse/Stop/SessionEnd + the ~/.mindgraph/runtime ledger) breaks work continuity — recurring failure shapes to re-check after any change
metadata:
  type: project
---

The session-to-session work-continuity loop in `src/hook-core.ts` has five recurring
failure shapes. Re-check all five after any change to the hook loop, the runtime
ledger, or the server's `resume_work` response.

**Why:** a 2026-07-29 read-only audit of the released loop (origin/main hook-core.ts,
mindgraph-mcp 0.14.8) found every one of them either confirmed in code or visible in
live ledger files under `~/.mindgraph/runtime`. They are structural, not one-off bugs,
so they regress easily.

**How to apply:** when auditing or extending the hooks, walk these five first before
looking for anything new.

1. **Payload-order truncation.** The server serializes `resume_work` with a
   `BTreeMap` (no `preserve_order` feature anywhere in mindgraph-rs), so the brief's
   keys are **alphabetical**. `boundedBrief` caps the pretty-printed JSON at 8900
   chars, and `task`/`selection_reason`/`lease` are the LAST keys while
   `blockers`/`code_targets`/`knowledge` (full node JSON, caps 5/20/5) are the first.
   Any client-side cap over that payload cuts the identity of the work, not the
   boilerplate. Never assume the brief's cheap fields survive a cap.

2. **Ledger fields are adopted without provenance.** `sessionStart` writes
   `taskUid`/`taskVersion`/`leaseEpoch`/`executionUid` from whatever the brief
   surfaced, whether or not this agent claimed anything, and `preTool` then injects
   them. So a merely-surfaced backlog task, or another agent's lease epoch, becomes
   this session's fencing token. Any new ledger field needs a "did we actually own
   this?" gate.

3. **Tuple coherence.** `preTool` fills `task_uid`, `expected_version`,
   `lease_epoch`, `execution_uid` and `work_uid` INDEPENDENTLY, each only-when-absent.
   The moment the model addresses a second task explicitly, it gets the new
   `task_uid` paired with the old task's version/epoch/execution. These five fields
   must move as one tuple gated on `task_uid` agreement.

4. **Nothing self-heals.** There is no re-claim, re-resume, or ledger refresh
   anywhere except SessionStart. Once the lease expires (300s TTL, heartbeat only
   fires on a tool call) or is fenced by a concurrent session, the ledger keeps the
   stale epoch for the rest of the session and every plan mutation 409s. Server error
   bodies carry the current version only inside a prose message, so the hook cannot
   recover from them.

5. **Timeout budgets vs cold-tenant latency.** Cold cloud calls run ~16-20s.
   SessionStart is budgeted 30s but makes up to `2 + N_repos + 2` network calls (the
   parent overlay's `.mindgraph/workspace.json` declares 12 repos → 12 parallel
   `resolve_identity` calls). SessionEnd — which releases the lease and closes the
   Session node — is budgeted 8s (claude) / 3s (codex) for two of the same calls, so
   normal exits leak leases and open Session nodes on a cold tenant. PreToolUse gets
   3s while `invocationContext` can spend ~4.25s on git + repo resolution.

Related durable facts worth re-verifying rather than trusting: `active_execution` is
read from the brief at `hook-core.ts:414` but **does not exist** in the server
response (grep mindgraph-rs: zero hits), so the ledger always falls back to
`recent_executions[0]`, which is unfiltered by status and may be terminal.
See also [[fragile_mcp_adapter_contract]].
