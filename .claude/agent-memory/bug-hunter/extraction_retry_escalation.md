---
name: extraction-retry-escalation
description: Invariants and edge cases in mindgraph-server extraction pipeline LLM retry + model escalation
metadata:
  type: project
---

`mindgraph-server/src/extraction/pipeline.rs` retry design (audited 2026-06-12, found sound):

- `call_llm_with_retries`: unbounded `loop{}` bounded by `RETRY_BUDGET_SECS=600` wall-clock. Cannot hot-spin (every retry after attempt 0 sleeps capped-exponential backoff `MAX_BACKOFF_MS=64s`). Budget checked only on error path — a single long-blocking call is only preempted by cancellation, not the budget. `attempt: u32` overflow impossible within 600s.
- `run_single_pass`: `total_attempts` = 3 if fallback set (and `!= model`) else 2. Last attempt (`parse_attempt+1==total_attempts`) escalates to fallback model, resets temperature for o-series. User msg REBUILT from `base_user` each retry (no nudge stacking); transport failure → empty nudge. `extraction: Option` always resolved after loop via salvage-or-error.

**Why:** these are the load-bearing correctness points; the arithmetic is easy to break on future edits.
**How to apply:** if `total_attempts` math or the `parse_attempt+1` comparison changes, re-verify the last-attempt detection and that the salvage path still runs on the final transport failure.

Known low-severity smell: `is_transient_llm_error` classifies ALL in-body provider errors as transient ("provider error" substring), so an upstream non-retryable error (e.g. provider 400) wrapped in HTTP 200 by OpenRouter gets retried for the full budget. Safe direction but wasteful.
