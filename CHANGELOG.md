# Changelog

## Unreleased

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
