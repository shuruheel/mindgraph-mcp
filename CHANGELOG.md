# Changelog

## Unreleased

### Added

- `mindgraph_retrieve max_output_chars` sets a deterministic 512–24,000
  character budget for rendered text. Whole evidence items are packed under
  the bound and the final marker reports omissions; `format: "json"` remains
  the unmodified raw escape hatch.

### Fixed

- Chain, neighborhood, path, and subgraph responses using the live
  `{mode, start_uid, steps}` wire shape now render as compact traversal lines
  instead of falling back to raw JSON. Serde-tagged custom relations such as
  `{Custom: "SUPPORTED_BY"}` render as their semantic relation name on both
  step and nodes/edges responses.

## 0.19.0 (2026-08-17)

This release turns governed skills and dense measurements into first-class MCP
workflows. It depends on `mindgraph` TypeScript SDK 0.15.x and should be
published after SDK 0.15.0 resolves on npm.

### Added

- **Governed skill capture.** `mindgraph_capture action="skill"` accepts a
  stable agentskills.io name, trigger description, complete SKILL.md body,
  optional license, and required provenance. It always creates a candidate for
  owner/admin review and cannot self-publish.
- **Explicit skill-file interop.** `mindgraph-mcp skills pull` renders the
  caller's published and granted skills with a fixed allowlist of frontmatter;
  `skills push <path>` imports or updates a candidate with content-hash and
  version conflict protection. Neither command runs from hooks or background
  processes.
- **Bounded Series reads.** The read-only `mindgraph_series_query` tool lists
  an entity's Series and supports latest, keyset-window, and aggregate queries
  without injecting raw dense points into general retrieval context.

### Changed

- The `mindgraph` SDK dependency now targets `^0.15.0`; Series and skill
  calls use its published typed methods directly.

## 0.18.0 (2026-08-16)

### Added

- **The server self-heals the pinned hook runner — releases no longer need a
  manual `install-hooks` on every machine.** The MCP registration floats on
  `npx @latest` while the runner pins at install time; at startup the server
  now refreshes `~/.mindgraph/bin/mindgraph-hook.cjs` from its own bundled
  `cli.js` when the sidecar records an older version (a runner with no
  sidecar predates the sidecar and is refreshed too). Upgrade-only — a stale
  npx cache can never downgrade the runner — with an atomic tmp+rename swap
  so a concurrently firing hook never reads a torn bundle, and a no-runner
  machine (e.g. Claude Desktop) is left untouched. On refresh it also
  re-writes MindGraph-owned hook entries (timeout budgets, matchers, new
  events) in settings files that already carry them, never expanding the
  user's scope choice. Opt out with `MINDGRAPH_HOOK_AUTOUPDATE=off`; the
  version-skew instructions note then remains the fallback signal.

- **SessionStart warns when the harness has hooks but no registered MindGraph
  MCP server.** Observed live (2026-08-12): user-scope hooks delivered briefs
  and Stop nudges into Claude Code sessions with no `mcp__mindgraph__*` tools
  to act on — every ledger showed `stopNudged` with `memoryWritten` never
  true. The hook now checks the layouts the installer writes (user and
  cwd-project scope in `~/.claude.json`, `.mcp.json` up the tree) and leads
  the brief with a fix-it note when nothing registers the server.
  `MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK=1` silences it; the diagnostic never
  fails the hook.
- **Hook-runner/server version skew is now detectable and surfaced.** The MCP
  registration floats on `npx @latest` while the hook runner is pinned at
  install time — a 0.14-era runner silently served 0.17-era sessions for two
  weeks. `install-hooks`/`install-code --hooks` record the copied bundle's
  version in a sidecar; the server compares it to its own at startup and
  appends a re-run-install-hooks note to its instructions (and stderr) on
  mismatch.

### Fixed

- **A backend outage no longer reads as a governance denial.** The
  fail-closed message for an unreachable server said "could not establish
  permission… set `MINDGRAPH_GOVERNANCE=off`", steering callers toward
  disabling governance for a connectivity failure that disabling governance
  cannot fix (the graph call would fail identically). It now names the
  unreachable base URL and states the call was neither evaluated nor
  executed.
- **Hook-driven lease renewal adopts the fence from a thrown 409.** Renewal
  errors were swallowed whole, so a stale `expected_version` made every
  minute-bucketed heartbeat/reclaim fail identically while the lease silently
  lapsed — recovery waited for the model to make a plan call of its own. The
  hook now lifts `current_version`/`current_epoch`/`lease_expires_at` from
  the typed 409 body (and from 200-shaped error payloads), exactly like the
  model-call path.
- **A failed `relate` edge no longer repaints a successful write as an
  error.** `attachCodeRefsToToolResult` promised degradation without
  rollback, but its relate loop was unguarded: one thrown edge write turned
  the whole call into a tool error, losing the lesson/task UID the model had
  just created. Relate failures now return the committed write plus a
  per-edge caveat.

- **`mindgraph_code` now resolves from the live session directory.** The tool
  built its default codegraph adapter on the MCP server process's cwd,
  ignoring the hook-injected `invocation_context.cwd` that `mindgraph_sync`
  already honored — user-scope registrations and sessions that changed
  directory resolved workspaces and relative refs against the wrong root.
  `attachCodeRefsToToolResult` forwards the context too.
- **`mindgraph_code` anchor requires an explicit space
  (`missing_repository_space`) instead of writing code anchors silently into
  the per-agent private space.** The guard existed but was unreachable.
  Deliberate knowledge anchors (code symbols/files) written without a
  workspace `space_uid`, `repo_space_uid`, or `MINDGRAPH_CODE_SPACE_UID`
  landed in the writing agent's personal space, setting up the
  `exists_but_inaccessible` cross-agent trap for teammates resolving the
  same identity. The hooks' repository-scope anchoring (SessionStart /
  `create_task`) keeps its deliberate `space:agent:` fallback — scoping
  markers, unlike shared knowledge, are correct per-agent.
- **A stored repository id that is not available locally no longer resolves to
  the enclosing checkout.** `recall`/`expand`/`affected` on an anchor from a
  repository that isn't checked out or declared here treated the id as a
  relative path and walked up to the current repo — returning the wrong
  repository's structure under the anchored id, with a clean availability
  check. Unknown ids now surface `repository_unavailable` /
  `unknown_repository`, `affected` reports `unavailable_repositories` it had
  to skip, and a `repo`/`create_task` argument naming an unknown repository
  errors instead of silently scoping the enclosing one.
- **`mindgraph_sync` never follows symlinks out of the repository.** Scan
  skips escaping or looping symlinks; `begin`/`status` reject symlinked
  logical paths that leave the root.
- **`scan workspace=true` with no declared repositories errors with a
  diagnostic** (`workspace_not_configured`, distinguishing a missing file from
  a malformed one) instead of returning silently empty.

### Docs

- README documents multi-repository workspaces: `.mindgraph/workspace.json`
  discovery and format, per-ref routing rules (path/`repo`/bare-symbol),
  identity convergence, per-repo spaces, workspace scan, and
  `MINDGRAPH_CODE_REPOS` precedence.

## 0.17.0 (2026-07-30)

### Changed

- **BREAKING (output format): `mindgraph_ontology`'s read actions and the
  generated per-schema read tools return a rendered text block instead of
  the server's raw JSON.** Pass `format: "json"` on any of those calls to
  get the raw response back unchanged; the parameter is newly declared on
  `mindgraph_ontology` — covering `query`, `search`, `objects`, `object`
  and `object_context` — and injected into the input schema of every
  generated read tool (`search_*`, `get_*`, `summarize_*`, `related_*`).
  This is the treatment 0.16.0 gave `mindgraph_retrieve`, applied to the
  remaining read surfaces. One deliberate exception: the generated
  structured composite (`structured_query_*`) keeps its exact published
  schema — the server rejects unknown fields on it — and always returns
  raw rows, because models copy its tabular output structurally. Anything
  the renderer does not recognize also falls back to raw, so an unexpected
  response shape is never swallowed, and no server change is required.
  Consumers that parse these tools' output programmatically must now pass
  `format: "json"`. `mindgraph_plan`, `mindgraph_sync`, `mindgraph_code`,
  and the ontology write, schema and proposal actions are unaffected —
  they were never rendered and still return JSON.
- **Domain objects render as their own type, carrying their Layer-7
  fields.** Objects group under `### Customer` headings, each line reading
  `- **ACME Corp** [cust-1] (Customer, confidence 1)` above a
  `fields: region: EMEA; arr: 120000` line. Two wire families reach these
  tools and both resolve to the domain type: the hand-projected form that
  carries `node_type` as a plain string, and the serde-derived ontology
  handlers that emit it externally tagged (`{"Custom": "Customer"}`) with
  the typed payload under `props.data`. Relations render as
  `- A —HAS_REQUIREMENT→ B` label lines; an endpoint outside the returned
  object list — a cognitive neighbour, usually — renders as `[uid]` rather
  than dropping the relation, which is the difference between a partial
  answer and a silently incomplete one. Cognitive context is grouped by
  category (`### Cognitive context — claims`), and the block closes with
  the overall confidence, whether more results exist, and whether the seed
  cap was hit.
- **Provenance now says whether a span is a quotation.** `anchor` spans
  are located quotations and render quoted; `chunk_head` spans render as
  `- context: …` and are never quoted, honouring the server's C10
  contract. Reading the raw payload, a model had to know the `span_kind`
  convention to avoid attributing surrounding chunk text to a source as a
  verbatim quote.
- **An empty result now says it is empty.** A recognized ontology response
  with no objects, no cognitive context and no provenance renders
  `No matching domain objects.`, and an empty domain-object page renders
  `# <title> (0 results)`; both previously arrived as raw JSON for the
  model to interpret. The renderer claims a result is empty only when it
  recognizes the envelope — unrecognized shapes still fall through to raw.
- **`mindgraph_ingest` `job_status` without a `job_id` returns the 20 most
  recent jobs, newest first, instead of every job the tenant has ever
  run.** Each line carries the id, title, status, chunk progress, nodes
  created, queue position and any error (clipped at 160 characters), and
  the header reports `20 of 25` when the list was cut. The previous
  response was the entire unbounded list, pretty-printed — on an active
  tenant, the largest payload this package could hand a model. Pass
  `format: "json"` for the full raw list.
- **`mindgraph_synthesize` `signals` renders as named sections.** Each
  signal array becomes a `## entity bridges` section whose items resolve
  the label key the server actually sends — `target_label` for claim hubs,
  `from_label`/`to_label` for dialectical pairs, which render as
  `Memory as retrieval ↔ Memory as reasoning` — alongside the uid and the
  numeric scores. `format: "json"` is newly declared on this tool too.
- **The JSON this package emits is compact rather than 2-space
  pretty-printed.** That covers the `format: "json"` escapes, the actions
  that were never rendered, `mindgraph_code`'s payloads (success and error), and MCP
  resource contents. The indentation was pure output cost: measured on the
  ontology query and domain-search response shapes the test suite is
  fixtured on, the compact form is 35–40% smaller. Machine parsers are
  unaffected — `JSON.parse` reads both forms identically, including the
  hooks' ledger and the code-anchor attach seam.

## 0.16.0 (2026-07-30)

### Changed

- **BREAKING (output format): `mindgraph_retrieve` returns a rendered text
  block instead of the server's raw JSON — every action, including the
  traversals.** Pass `format: "json"` on any call to get the raw response
  back unchanged. The tool used to hand the model the wire payload verbatim:
  every null field of every typed prop, unbounded source-chunk offset
  arrays, curation edges carrying reviewer rationale, retrieval-expansion
  metadata. Measured live against production on a real `context` query, the
  response went from 55,045 characters (~14,877 tokens) to 7,228 (~1,954) —
  87% smaller — and `hybrid` search 83% smaller, with nothing a model reads
  removed. The rendered block leads with knowledge articles, then graph
  nodes grouped by node type as
  `- **label** [uid] (Claim, confidence 0.8, score 0.42) [truth: refuted]: summary`,
  each with at most one source quote (clipped at 180 characters), its
  source-document title, and who believes it; then relationships as
  `- A —EDGE_TYPE→ B` label lines, source excerpts when `include_chunks` is
  set, any applicable policies with their prose rules, and a count of items
  withheld by access scoping. Traversals render as a numbered path list with
  costs, then nodes and relationships. UIDs stay in the output deliberately
  — unlike a chat UI, a model chains its follow-up tool calls by uid.
  Consumers that parse `mindgraph_retrieve` output programmatically must now
  pass `format: "json"`; nothing in this package does (the hooks' ledger
  reads fencing state only from `mindgraph_plan` responses). This pairs with
  the server-side context hygiene deployed the same day — a cap on returned
  source chunks and curation edges dropped from context — but does the
  equivalent filtering client-side, so it degrades gracefully against a
  server without it.
- **Epistemic status now travels with the node instead of being buried in
  it.** `[SUPERSEDED by <uid>]`, `[truth: refuted]`, and validity-window
  flags (`OUTSIDE ITS VALIDITY WINDOW`, `NOT VALID AT THE REQUESTED TIME`)
  render inline on the node line. In the raw payload these were three
  booleans among forty fields, and models read superseded or refuted
  knowledge back as current.
- **Curation and self-referential edges never reach the model.**
  `POSSIBLE_DUPLICATE` edges — in both the `context` wire spelling and the
  PascalCase one traversals use — belong to the `merge_candidates` review
  surface, and shipping them as knowledge context made models repeat
  reviewer metadata ("LLM review: related but distinct") as fact. Self-loop
  edges are dropped as noise. Infra nodes (`Chunk`, `Document`, `Article`)
  are excluded from the graph section, where they duplicate the article and
  excerpt sections; when they were the *only* matches the block says so and
  names the action that will return them, rather than reading as an empty
  graph.
- **Rendered output is bounded, and says so when it is.** Individual items
  are clipped (summaries 400 characters, source quotes 180, articles and
  chunks 6,000 — a full ingestion chunk is 400–800 words, so `include_chunks`
  still yields quotable text), and sections are packed whole-item against a
  24,000-character budget: an item is either rendered completely or counted
  in a `(+N more not shown)` marker, never cut mid-item. Whenever anything
  was clipped or dropped the block ends by saying so and pointing at both
  remedies — fetch full content by uid, or re-run with `format: "json"`. For
  the structured list actions the renderer also caps items at the caller's
  `limit`, because the server ignores `limit` for several unscoped
  structured queries and returns up to its 200-row cap.
- **`limit` and `offset` are honored by `active_goals`, `open_questions`,
  `weak_claims`, `pending_approvals` and `unresolved_contradictions`.** The
  tool schema advertised both; these five went through no-argument SDK
  convenience methods that dropped them, so every call returned the server
  default. They now go through the generic `/retrieve` action dispatch like
  every other structured action. Consequence for anyone reading the raw
  payload: `format: "json"` on these five now returns the `/retrieve`
  dispatch response, not the previous convenience endpoints' shape.

### Added

- **`top_k_paths` is reachable from the MCP tool.** The k cheapest paths
  between `start_uid` and `end_uid`, with `k` (default 3, cap 25) and an
  optional `max_cost` ceiling; `max_depth` maps to the server's `max_hops`.
  Each path renders as a route of labels with its cost, with the uid
  sequence on its own line so a model can follow up on any hop.
- **Time-scoped retrieval parameters.** `valid_at` (an ISO-8601 date such as
  `"2021-06"`) annotates `context` nodes against their validity windows as
  of that date instead of today, and `created_after`/`created_before` (unix
  seconds) window the `recent` action by ingestion time. Both were server
  surface the tool had never exposed.
- **`explain: true` on `hybrid`** returns the per-leg retrieval scoring.
  Responses to a call with `explain` set are returned as raw JSON whatever
  `format` says, because the per-leg scores are the reason for the call.
- **`article_limit`** caps wiki articles in `context` results (default 3;
  `0` drops the article leg). An explicit value overrides profile defaults,
  including the coding profile's articles-off default — reaching for an
  advertised knob should not be a silent no-op.

### Fixed

- **`include_documents: false` now drops the article leg in every profile.**
  It was read only under the coding profile, so outside it the parameter did
  nothing and the only way to exclude ingested documents and wiki articles
  from a context result was to run the coding profile.
- **`layer` retrieval forwards `node_types`,** so a layer query can be
  narrowed to particular node types instead of returning the whole layer.
  The filter is applied by mindgraph-server 1.12.0 and later; against an
  older server the parameter is accepted and ignored, as it was before.

## 0.15.0 (2026-07-30)

### Added

- **Hook failures are now observable instead of silent.** Hooks still fail
  open — a revoked key, an unreachable server, or no key at all never blocks
  the harness — but every failure writes
  `~/.mindgraph/runtime/hook-health.json` (harness, last error, timestamp,
  consecutive-failure count) and one `mindgraph-hook: failing open (…)` line
  to stderr, where the harness debug log picks it up. The counter resets on
  the next successful hook run. Until now, continuity could be off for days
  — no brief, no session, no lease renewal — with nothing anywhere to look
  at. Override the marker location with `MINDGRAPH_RUNTIME_DIR`.

### Changed

- **BREAKING (identity): the default agent id is now a stable per-user value
  (`u-<hash of user@host>`) instead of the harness name.** The harness-name
  default made cross-harness resume — the headline promise — impossible: a
  task leased by agent `codex` failed the own-prior-work gate under agent
  `claude-code`, so the work never came back in the other harness. It also
  made every Claude Code session on every machine one logical agent. The
  same identity is now resolved by the hooks, the `install-code`
  registration, and the `serve` path (they previously disagreed, so the
  model's fenced tool calls and the hook's lease were two different agents on
  the server and fought each other with 409s). **Re-run `mindgraph-mcp
  install-hooks` for each harness you use** — it persists the id to
  `~/.mindgraph/hooks.json` and refreshes the hook budgets below. Leases
  claimed under the old default still rebind through a transitional
  compatibility path, restricted to the same harness's legacy name so no
  teammate's expired legacy lease can be seized; it drains itself as sessions
  re-claim under the stable id, and will be removed in a later release. To
  keep the old identity exactly, pass `--agent-id claude-code` (or set
  `MINDGRAPH_AGENT_ID`), which overrides the default as before.
- **Hook time budgets now match cold-tenant reality.** SessionEnd 8s → 30s
  and PostToolUse 5s → 10s (both await a cloud round-trip that fires exactly
  when the tenant is cold — lease renewal on post-idle reclaim, and
  abandon+close at exit); PreToolUse 3s → 5s (first-call repository
  resolution over a large multi-repo workspace plus three git probes; a
  killed PreToolUse means the tool call goes through untagged). Codex's
  `additionalContextLimit` goes 3,000 → 10,000: at 3,000 the harness applied
  a second, tighter truncation the brief renderer knew nothing about. Codex
  SessionEnd stays at 3s because that is a platform cap the configured
  timeout cannot raise — the Codex adapter now makes at most one cloud call
  there, releasing the lease (which blocks other sessions) and skipping the
  session close (a stale-open Session node is benign, since session open is
  an identity upsert). Existing installs keep their old budgets until you
  re-run `install-hooks`.

### Fixed

- **The injected work brief no longer truncates away the task it exists to
  deliver.** The brief was a raw `JSON.stringify` dump capped at 8,900
  characters, and the server serializes keys alphabetically — so `task`,
  `selection_reason`, and `lease` sorted last and were cut out while verbose
  full-node JSON survived, leaving the remainder sliced mid-string into
  unparseable JSON (observed live 2026-07-29). The brief is now rendered:
  the task leads with its uid, status, priority and version, followed by
  claim state, goal, next steps, blockers, and any still-running execution
  from a prior session. Each item is clipped against its own limit, optional
  context sections (relevant knowledge, code targets) are dropped whole
  rather than cut mid-item, and whenever anything was clipped or dropped the
  brief says so and tells the model to fetch full content by uid — so a
  bounded brief is never mistaken for a complete one. When the server reports
  tasks filtered out by repository scope, the brief now names the count
  ("N durable task(s) exist outside this repository scope"), and a scope
  resolution that failed is stated in the brief rather than silently
  narrowing what the model sees.
- **SessionStart anchors a repository identity that does not exist yet
  instead of running unscoped.** Only `existing` identities used to
  contribute to the scope filter, so the first session in a repository whose
  identity had never been anchored ran with no scope at all and mixed other
  repositories' tasks into its brief (caught by the E2E: a task scoped to one
  repo surfaced in another's session). An `absent` identity is now anchored
  through the same idempotent upsert `create_task` uses. Resolutions that
  genuinely error are collected and reported (stderr plus the brief note
  above) instead of quietly emptying the scope — that silent emptying was the
  amplifier in the 2026-07-29 auto-claim incident.
- **A live lease is never taken over by a new session.** SessionStart
  re-claims the agent's own prior work, but a lease that is still live
  belongs to whichever session claimed it; claiming from a second session
  fenced the first out mid-work. It now re-claims a live lease only when this
  very session already holds it (compact/resume re-entry, matched on task uid
  and lease epoch). Released servers rebind a same-owner live lease without
  `allow_takeover`, so this client-side gate is what preserves mutual
  exclusion today; the paired server change (mindgraph-rs #41) requires the
  flag.
- **The hook ledger tracks only work this session actually owns.** It used to
  adopt whatever the brief surfaced, so a merely-surfaced task became the
  provenance target stamped on every capture, and a foreign lease epoch was
  copied as this session's fencing token (both observed live). Work-targeting
  state is now written only on a successful claim. `complete_task` clears it:
  a retained task uid turned every later implicit `resume_work` into an
  explicit resume of the completed task — permanent `no_eligible_work` — and
  bypassed the extraction-provenance guard. A deliberate `claim_task` onto a
  different task rebinds the ledger and drops the previous task's version,
  epoch and execution rather than leaving them as fallbacks. Only a genuinely
  `running` execution is adopted as the active iteration, so SessionEnd no
  longer tries to abandon a completed one.
- **Fenced fields are only injected where they apply.** `expected_version`,
  `lease_epoch` and `execution_uid` are now filled from the ledger only when
  the model's own call targets the ledger's task, and only for the plan
  actions the server actually fences (`claim_task`, `heartbeat`,
  `start_iteration`, `checkpoint_iteration`, `block_task`, `complete_task`,
  `abandon_iteration`). Live ledgers showed task-B calls carrying task-A's
  version, epoch and execution — guaranteed 409s plus cross-task execution
  attribution — and the old gate compared the value the hook had just
  injected, making it self-satisfying, so a non-task action such as
  `update_status` on a PlanStep received the task's `expected_version` and
  409'd against the wrong node. Relatedly, a PlanStep's own `version` no
  longer overwrites the tracked task version: a bare `version` is accepted
  only when the response is the task itself.
- **A conflict now re-syncs the ledger instead of replaying a stale fence
  forever.** Structured 409 bodies were unreachable through the tool error
  envelope, which flattened everything into one prose string. Tool errors
  carrying machine-readable conflict state now spread `current_version`,
  `current_epoch`, `lease_expires_at` and `lease_owner_agent_id` as JSON
  siblings of `error`, and the hooks adopt them on the next call. This
  requires a server that sends those bodies (any mindgraph-server release
  newer than 1.11.2 — the resume-loop hardening, mindgraph-rs #41); older
  servers still get the prose.
- **A lease survives a quiet stretch mid-session.** Renewal was driven only
  by the server's expiry timestamp and only from PostToolUse, so a lagging
  client clock never triggered it and any pause longer than the lease TTL
  ended durable tracking for the rest of the session. Renewal now fires on
  either signal — imminent expiry or three minutes since the last successful
  renewal — and a lease that has already lapsed is re-claimed (bumping the
  epoch) rather than heartbeaten into a certain 409. A renewal whose response
  lands after the model has rebound or completed is discarded instead of
  stamping the old task's fence onto the new one, and the model's own
  heartbeats count as renewals so the hook does not double up on its cadence.
- **Hooks no longer track work in the wrong tenant.** They run with the
  harness's environment, which usually lacks `MINDGRAPH_ORG_ID` even when the
  MCP registration pins it — so on a multi-org key the hooks opened sessions
  and claimed leases in the key's default org while the MCP tools wrote to
  the pinned one. `install-hooks` / `install-code` now persist the org pin
  alongside the key. It follows the install environment exactly: installing
  without `MINDGRAPH_ORG_ID` clears a stale pin instead of letting it outlive
  every reinstall.
- **Session bookkeeping survives a slow SessionStart.** The session uid is
  written to the ledger before the resume/claim round-trips, so a harness
  timeout later in that flow can no longer leave a session PreToolUse cannot
  tag and SessionEnd cannot close (observed live: ledgers with real activity
  and a null session uid, every capture in them orphaned). Ledger lock
  waiters also wait 4s against a 3s stale-lock reclaim; they previously gave
  up after 500ms against a 10s reclaim, so a lock orphaned by a harness kill
  silently sent every hook to a throwaway default ledger.
- **The end-of-session reflection nudge fires on the right signals.** Shell
  commands are no longer counted as mutations: the `Bash` tool input has no
  MindGraph `action` field, so the old `action !== "read"` test scored every
  `git status` as a code change (while Codex's differently-named shell tool
  scored nothing) — worktree drift already detects shell-driven changes on
  both harnesses. And only reflective writes now satisfy the nudge — a
  `lesson` or `journal` capture, a resolved decision, a risk assessment —
  matching what the nudge actually asks for; creating an Entity or Source no
  longer counts as memory of the work.
- **The startup line reports the running version.** It announced `v0.7.1`
  regardless of what was installed.

## 0.14.9 (2026-07-29)

### Fixed

- **Hooked `create_task` calls now carry durable repository scope.** The coding
  adapter materializes the repository Entity from verified invocation context
  (or an explicit `repo`) and includes its UID in `scope_uids`, paired with the
  server's atomic scoped-Task creation path. If that identity is inaccessible,
  the MCP fails before creating an unscoped Task. This prevents a handoff from
  appearing in direct `resume_work` while disappearing from the next
  repository-filtered SessionStart brief.

## 0.14.8 (2026-07-29)

### Added

- **Codex hooks adapter.** `install-hooks --harness codex` merge-safely writes
  `$CODEX_HOME/hooks.json` (or `<project>/.codex/hooks.json` with `--scope
  project`), installs the same pinned self-contained runner Claude Code uses,
  and maps Codex's `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, and
  advisory `SessionEnd` events onto the same session lifecycle Claude Code
  gets: session open/rebind with one bounded work brief, verified invocation
  provenance stamped on MindGraph tool calls, and a once-per-session
  reflection checkpoint. Session context is delivered as Codex
  `additionalContext`; tool rewrites use its required `permissionDecision:
  "allow"` plus `updatedInput`; `SessionEnd` respects Codex's three-second
  cap and stays cleanup-only. Codex has no equivalent of Claude Code's
  `TaskCreated`/`TaskCompleted` events, so those advisory counters remain
  Claude Code-only. Every hook fails open, and foreign entries in the
  settings file are never modified. Note that Codex requires newly installed
  or changed command hooks to be reviewed with `/hooks` before they run.
  Both harnesses now run one shared lifecycle core behind thin wire codecs;
  Claude Code behavior, graph semantics, server endpoints, identity keys, and
  MCP tool contracts are unchanged.

### Changed

- **The SessionStart hook timeout is now 30 seconds, up from 20, in both
  harnesses.** Cold-tenant session starts crossed the old edge in live
  testing: the hook failed open as designed, but no work brief reached the
  model. The same installed runner completes in 16.84s once warm, so 30s
  keeps a cold-start margin. Existing installs keep the old 20-second value
  until you re-run `install-hooks` (or `install-code --hooks`), which
  refreshes MindGraph-owned entries in place.
- **`uninstall-hooks` no longer deletes the pinned runner** at
  `~/.mindgraph/bin/mindgraph-hook.cjs`. The runner is shared by every
  harness adapter, so removing one harness's configuration used to break
  hooks still installed for the other (or for a project outside the current
  directory). It now removes only the MindGraph-owned hook entries for the
  harness you name.

### Fixed

- **SessionStart no longer auto-claims work this agent never touched.** The
  hook claimed whatever `resume_work` selected, so one bad selection became
  sticky owned-lease state that every subsequent session re-selected and
  re-claimed — in a live case, a Task extracted from an ingested document,
  priority `critical`, with no agent history, was claimed by each new
  session, mutating extracted knowledge and burying real pending work.
  SessionStart now claims only the agent's own prior work: an owned live
  lease, a same-agent session rebind, or a lease this agent owns whose TTL
  has since lapsed (cross-session rebind keys off ownership rather than
  liveness, because sessions are usually further apart than any lease
  lifetime). Backlog tasks still surface in the injected brief as context —
  claiming one is now a deliberate `claim_task` the agent makes when it
  actually starts that work. Backlog session starts also drop two API
  round-trips.

## 0.14.7 (2026-07-29)

### Changed

- **Coding-profile context retrieval scopes documents and wiki articles out by
  default.** Engineering questions no longer surface unrelated ingested
  content; pass `include_documents: true` when the question is genuinely about
  a document, spec, or article. Deliberately scoped rather than walled:
  creator-based hard limits were rejected because ingested specs and PRDs are
  exactly what a coding agent should reach on purpose.

## 0.14.6 (2026-07-29)

### Fixed

- **Work-state questions route to `resume_work`, not keyword search.** The
  general profile's retrieve-first rule was served to coding sessions too, so
  "what have we been working on" could answer from keyword recall over all
  knowledge (in live testing: a wiki article about a person named Work). The
  coding profile now carries an explicit recall order — `resume_work` for work
  state, `mindgraph_code recall` for code knowledge, `node_types` filters for
  work-artifact searches — and the retrieve description itself redirects
  work-state questions.

## 0.14.5 (2026-07-29)

### Fixed

- **Absent codegraph is now self-serve.** The runtime unavailable result
  carries the optional-install hint (codegraph + `codegraph init`) so the
  agent can tell the user how to enable code anchoring instead of relaying a
  bare not-found; `install-hooks` prints the code-intelligence status line
  that `install-code` already had. codegraph remains optional: memory and work
  tools are unaffected without it.

## 0.14.4 (2026-07-29)

### Added

- **`--agent-id` on `install-code` / `install-hooks`** — per-member agent
  identity for teams sharing one org graph. Anchored knowledge is shared
  automatically (identity keys off the git remote, so teammates' clones
  converge on the same code entities); distinct agent ids keep task leases and
  resume briefs per-person. With identical ids, a team is one logical agent
  and members lease-recover each other's active tasks. Persisted to
  `~/.mindgraph/hooks.json`; hooks resolve env → stored → default.

## 0.14.3 (2026-07-29)

### Fixed

- **The pinned hook runner is now truly self-contained.** The bundle copied to
  `~/.mindgraph/bin/mindgraph-hook.cjs` still required the `mindgraph` SDK from
  an adjacent `node_modules` (tsup externalizes dependencies by default), so
  every hook crashed with a Node module-loader error. The SDK is now bundled
  in; a regression test executes the copied runner from an isolated directory.
  Re-run `install-hooks` (or `install-code --hooks`) once to refresh the
  runner.

## 0.14.2 (2026-07-29)

### Fixed

- **`install-code` no longer aborts on re-install.** An existing MCP
  registration made `claude mcp add` exit non-zero; the installer printed a
  misleading missing-CLI message and quit before the `--hooks` step — so
  upgrades never received updated hook entries. Already-registered now
  continues (the registration invokes `npx mindgraph-mcp@latest` and upgrades
  itself); a genuinely missing CLI keeps its guidance; real failures print the
  CLI's actual output.

## 0.14.1 (2026-07-29)

Patch release from the first production live test — four fixes, each pinned by
a regression test. Re-run `install-code --hooks` (or `install-hooks`) after
updating: the hook entries themselves changed.

### Fixed

- **Hooks now invoke a pinned local runner instead of `npx -y
  mindgraph-mcp@latest`.** Per-invocation npx re-resolution cost ~10s;
  SessionStart produced a correct work brief in 12.7s against its 8s timeout
  and was silently killed — no brief, no session, no provenance, in every real
  session. The installer now copies the self-contained CLI bundle to
  `~/.mindgraph/bin/mindgraph-hook.cjs` (version-pinned, ~100ms startup) and
  the SessionStart timeout is 20s for cold cloud tenant loads.
- **`mindgraph_sync` and `mindgraph_code` surface server error bodies** —
  previously a bare "failed: 403" with the typed code
  (`identity_namespace_forbidden`) discarded, leaving agents unable to
  self-correct or report.
- **`mindgraph_reason` prose reaches the server** — `claim.content`,
  `warrant.content`, and `evidence.description` are now mapped into `props`
  per the server's ArgumentRequest contract; previously serde silently dropped
  them and claims landed with empty content.

### Notes

Pairs with mindgraph-server ≥ 1.11.1 (identity-namespace access for plain org
credentials); against older servers the coding profile's anchor/sync actions
return the server's typed 403 — now visibly.

## 0.14.0 (2026-07-29)

The coding profile: MindGraph as a durable work substrate for coding agents.
**Compatibility**: requires `mindgraph` (TS SDK) 0.14.0. The coding profile's
work composites need a server newer than mindgraph 1.10.0 (local
`mindgraph-server` from main today; MindGraph Cloud after the next server
deploy). The default `general` profile is fully compatible with Cloud as-is.

### Added

- **Coding profile** (`MINDGRAPH_PROFILE=coding`, 10 tools): `mindgraph_code`
  (identity-stable code anchors + live callers/impact federation over a local
  codegraph index, with typed degradation — absent/timeout/wrong-index/stale
  are distinct states) and `mindgraph_sync` (idempotent, resumable import of
  markdown memory files with content-hash drift tracking and a retirement
  report).
- **Durable-work composites** on `mindgraph_plan`: `resume_work`, `claim_task`,
  `heartbeat`, `start_iteration`, `checkpoint_iteration`, `block_task`,
  `complete_task`, `abandon_iteration` — fenced leases, version conflicts, and
  idempotent retries surfaced to the model.
- **Claude Code hooks** + merge-safe installer (`install-hooks` /
  `uninstall-hooks`; `install-code --hooks` for the one-command setup):
  SessionStart opens/rebinds the session and injects the current work brief,
  PreToolUse stamps verified session/repo/commit provenance, Stop runs a
  once-per-session reflection checkpoint, SessionEnd cleans up. All hooks fail
  open. Connection settings persist to `~/.mindgraph/hooks.json` (mode 600).
- Action-aware governance targets (`action`, `mutability`, `target_uids` in the
  checkpoint payload).
- Install-time code-intelligence status: codegraph detected, or an explicit
  optional install pointer instead of silent degradation.

### Fixed

Four defects found in the live two-session dogfood, each pinned by a
regression test:

- the installed hook command failed to parse its own `--owner` flag (every
  installed hook died on first run);
- server typed-error bodies were dropped from tool errors, leaving agents
  unable to self-correct on `missing_field`/`version_conflict`;
- composite actions did not forward `execution_uid`;
- the PreToolUse ledger overwrote model-chosen `task_uid`/`expected_version`
  (now fill-only-if-absent; session identity stays adapter-authoritative).

## 0.13.5 (2026-07-27)

### Fixed

- **Every generated `structured_query` ontology tool was returning an error.**
  The adapter injects a default `agent_id` into each tool call, and the
  schema-qualified composite forwarded its arguments verbatim. The server's
  structured-query request rejects unknown fields, and the tool's own
  published input schema declares `additionalProperties: false` — so that one
  injected key failed every call, on the tools built for exactly the question
  these schemas exist to answer ("which customers asked for X?").

  Generated ontology tools now receive the arguments as sent, and the
  composite forwards only the fields it publishes.

- **One failed manifest fetch blanked the ontology tools for five minutes.**
  A transient error was cached as an authoritative empty tool set for the full
  cache lifetime. Failures now take a short cooldown and never overwrite a
  good manifest — a stale manifest is served instead, since a stale tool that
  no longer exists fails at dispatch, which beats having no ontology tools.

### Security

- **The governance checkpoint failed open permanently after one 404.** A
  single "this server has no governance endpoint" response latched the adapter
  into an ungoverned mode for the life of the process, with no re-probe and no
  log — so a server that later gained governance was never gated again. The
  latch is now a five-minute lease that re-probes on expiry and logs once when
  it engages.

- **A network blip took down the whole tool surface.** Any transport error on
  the governance probe was returned as a refusal, so a momentary failure
  refused every tool call. Transient conditions are retried before the gate
  decides. It still fails closed once retries are exhausted — an unevaluated
  policy is not a permit — but a rejected credential is now distinguished from
  a server without governance, and says what to do about it.

- **`resources/read` was not governed at all.** It returns the same graph data
  as the governance-gated tools, and was the one request type that reached the
  graph with no check. The resource surface now reads through the same
  checkpoint under `mindgraph_retrieve`, so a policy denying retrieval cannot
  be walked around by asking for the same rows as a resource. The resource URI
  travels as audit context.

## 0.13.4 (2026-07-26)

### Security

- **The installer ran its subprocesses through a shell.** `install-code` built
  its argument list, joined it with spaces, and passed the string to
  `execSync`, which executes via `/bin/sh -c`. The API key and base URL were
  interpolated unquoted, so either one containing `;`, backticks or `$(…)`
  executed arbitrary commands — during onboarding, with a value the user pastes
  in from elsewhere.

  Subprocesses now spawn with `execFileSync`, which takes an argument array and
  starts no shell, so no character in either value can be read as syntax.

  This does **not** hide the key from process listings: `claude mcp add --env
  KEY=value` places it in the child's arguments either way, which is that CLI's
  interface. What is fixed is shell interpretation.

  The browser-opening helper had the same shape (URL interpolated into a shell
  string, sourced from `MINDGRAPH_DASHBOARD_URL`) and is fixed the same way.
  The uninstall path used a fixed string and was never injectable; it was
  converted anyway so the CLI starts no shell at all.

## 0.13.3 (2026-07-25)

### Security

- **`mindgraph_plan` no longer exposes governance writes to the model.** The
  action enum offered `create_policy`, `request_approval`, and
  `resolve_approval` with a free-form props bag and no role gate — letting a
  model author the policy it is judged by, and raise *and then clear* its own
  approval gate. An agent blocked by "requires approval" could simply resolve
  it. All three are removed from the enum **and** from dispatch, so an invented
  action name is refused too.

  `get_pending` is unchanged: reading the approval queue is safe, and is what an
  agent needs in order to wait correctly. Approvals are granted by a person in
  the MindGraph dashboard.

  `resolve_approval` was removed rather than repaired because the obvious fix is
  worse than the bug. It sent `task_uid` where the server requires
  `approval_uid`, and never sent `approved` at all, which the server reads as
  false — so today it fails with a hard 400. Correcting only the field name
  would have converted that safe failure into a silent auto-deny of every
  approval an agent tried to resolve.

### Fixed

- **`mindgraph_ingest` forwarded `"ontology"` as if it were a cognitive layer.**
  It is a targeting flag. The server strips it from the cognitive list and
  returns an empty extraction once that list empties, so two silent failures
  followed: `["reality","epistemic","ontology"]` with no schema id ran cognitive
  extraction and performed **zero** domain-object extraction, and `["ontology"]`
  alone produced no extraction of any kind while the job reported success with
  `nodes_created: 0`. A green job over an empty graph, with no error.

  `"ontology"` is now stripped from the cognitive list, a bare `["ontology"]`
  maps to ontology-only mode so the server does not fall back to
  per-document-type defaults, and a request targeting ontology without an
  `ontology_schema_id` is refused rather than accepted when it could only
  extract nothing. Both schema descriptions now state that `ontology_schema_id`
  is what drives Layer-7 extraction.

  Under-extraction, not data loss — chunks are always embedded and
  `/ingest/resume` re-extracts.

## 0.13.2 (2026-07-25)

### Fixed

- **`mindgraph_ingest` published the wrong units for chunking.** `chunk_size` was
  described as characters with a default of 4000 and `chunk_overlap` as an
  absolute overlap with a default of 200. The server reads `chunk_size` as
  **tokens** (default 2000, valid 50–32,000) and `chunk_overlap` as a
  **fraction** of the chunk (default 0.1, maximum 0.9). A model following the
  published schema sent an overlap two orders of magnitude out of range on every
  call. Both parameters now declare the server's real units, defaults, and
  bounds, and `chunk_size` is typed `integer`.

  The server clamps out-of-range values rather than rejecting them, so clients on
  0.13.1 and earlier keep working — but they are steering the chunker with values
  that get silently corrected. Upgrade to send what you mean.

## 0.13.1 (2026-07-23)

### Fixed

- Reports version 0.13.1 in the MCP server handshake. The 0.13.0 package
  metadata was correct, but its runtime handshake still reported 0.12.0.

## 0.13.0 (2026-07-23)

Requires `mindgraph` (TS SDK) >= 0.13.0 and server >= 1.10.0. The dependency pin
moves `^0.12.0` → `^0.13.0`; release only after the SDK's 0.13.0 is on npm.

### Added

- **Generated ontology tools now dispatch.** Tools generated from a Layer 7 schema
  route to the SDK's structured surface — `queryDomainStructured`,
  `queryRelatedDomainObjects`, `getDomainObject`, and `getDomainObjectContext` —
  so an MCP client asks a typed, validated question of the schema instead of
  ranking text. Generated tool names are always schema-qualified, and a duplicate
  name is rejected at generation time rather than silently shadowing.

### Changed

- **Compatibility with an older SDK fails closed and legibly.** The structured
  query methods are treated as optional on the injected client; if the installed
  SDK predates 0.13.0 the affected tool reports that it is unavailable instead of
  throwing an opaque `undefined is not a function`. The static tool surface is
  unchanged in that case.

## 0.12.0 (2026-07-22)

### Added

- Adds a checkpoint-tier governance gate before every static and generated MCP tool invocation.
- Surfaces policy denials and approval handles to MCP clients, while failing closed on provider
  failures and obligations the adapter cannot enforce.
- Preserves compatibility with servers that do not expose the governance capability by probing
  once per session and leaving the existing tool flow unchanged.

### Fixed

- Reports the package's current version in the MCP server handshake.

## 0.11.0 (2026-07-18)

### Added

- `mindgraph_retrieve` context calls opt into three graph-expansion slots and
  depth two by default; callers can set `graph_expansion_limit` and
  `graph_max_depth` explicitly.
- Traversal actions expose `exclude_edge_types`, `include_provenance`, and the
  global `max_nodes` budget.

### Changed

- Traversal guidance now describes the server 1.9 min-cost witness semantics.
- Context expansion preserves direct-ranking recall when the graph cannot fill
  its three-slot default reservation.
- Bumps the `mindgraph` TS-SDK dependency `^0.11.0` → `^0.12.0`; release after
  the SDK's 0.12.0 is on npm.

## 0.10.0 (2026-07-07)

### Changed

- `mindgraph_ingest` contract fixes: `source` → `source_uri` (old `source`
  kept as a silent alias); chunk `title` → `label` with `document_uid` /
  `chunk_index` so chunks join their document's provenance chain. **Transcripts
  now extract Decisions/Options/Constraints** — pass `content_type: "transcript"`
  (or action `"session"`); the server gives it the full transcript layer set.
- `mindgraph` SDK dependency `^0.9.0` → `^0.11.0` (the 1.8 train's TS SDK).
  **Release order:** publish `mindgraph` (TS SDK) 0.11.0 and deploy the cloud
  server (mindgraph 1.8.0) before/with this package so the advertised fields
  are present in responses.

### Added

- `mindgraph_ingest` gains `content_type` (incl. `transcript`), `document_type`,
  `ontology_schema_id` + the `ontology` layer, and D1 conversation metadata
  (`participants` / `occurred_at` / `context`) so demands attribute to the
  named participant.

## 0.9.1 (2026-07-03)

### Changed

- `mindgraph` SDK dependency bumped `^0.5.0` → `^0.9.0` so compile-time types
  match the wire contract the tool description documents. **Release order:**
  publish `mindgraph` (TS SDK) 0.9.0 to npm before installing/publishing this
  package, and deploy the cloud server (mindgraph 1.6.0) before or with it so
  the advertised fields are actually present in responses.
- Retrieval tool description documents `path_cost` / `path_confidence` on
  traversal steps (server ≥ mindgraph 1.6.0) so agents can rank traverse
  results; notes they score the returned path, not the best possible path.

## 0.9.0 (2026-06-14)

### Added

- `mindgraph_retrieve` gains the `preferences` action (server ≥ 1.4.0): returns
  the user's stated/learned preferences relevant to a `query` (or all of them
  without one). The tool description steers the agent to use it for advice and
  recommendation requests so answers reflect what the user actually likes.

_(First CHANGELOG entry; earlier versions — through 0.8.0 — predate this file.)_
