---
name: dedup-supersession
description: Idempotency + edge-orientation invariants for the dedup "updates"→Supersedes verdict in ingestion.rs
metadata:
  type: project
---

> ⚠️ **DRIFTED — do not trust the orientation claim** (flagged 2026-07-18, memory reorg). This says Supersedes is oriented by `created_at` (newer→older). The current authority — `mindgraph-rs/CLAUDE.md` — documents VALID-TIME-primary orientation: open window beats closed, then `valid_from`/`event_date`, with `created_at` only as a fallback. Re-read the current dedup path before relying on this. (Also misfiled: this is a mindgraph-server finding living under mcp memory.)

`mindgraph-server/src/ingestion.rs` dedup `updates` verdict (audited 2026-06-12, found correct):

- Supersedes edge points newer→older: `from=a, to=b` where a,b = pair; `if a.created_at >= b.created_at {(from,to)} else {(to,from)}`. Retrieval `edges_to_set(uids, Supersedes)` maps `to_uid→superseded`, so `flag_superseded_nodes` flags the older node. End-to-end consistent.
- Idempotency: `have_supersedes` HashSet wired into BOTH the `to_review` pre-filter AND the per-decision skip check (alongside `have`/`have_contra`/`routed`). `routed` guarantees one edge per pair per run — no pair gets both Supersedes and another edge.
- Entity downgrade: `(verdict=="contradicts" || verdict=="updates") && !statement_pair → distinct`. Correct (entities can neither contradict nor supersede).
- `supersessions_recorded` reported in BOTH response paths (dry-run/proposal JSON and background-job JSON).

**Why:** these four invariants are what keep nightly dedup idempotent and the supersession direction correct.
**How to apply:** if a 5th verdict is added or `routed`/`have_*` sets are refactored, re-verify all four still hold.
