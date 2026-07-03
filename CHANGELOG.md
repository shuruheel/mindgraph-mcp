# Changelog

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
