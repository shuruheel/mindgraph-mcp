# Changelog

## Unreleased

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
