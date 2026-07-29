# Changelog

## Unreleased

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
