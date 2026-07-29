# mindgraph-mcp

[![npm](https://img.shields.io/npm/v/mindgraph-mcp)](https://www.npmjs.com/package/mindgraph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Model Context Protocol server for [MindGraph](https://mindgraph.cloud) — plug your persistent, structured knowledge graph into Claude Desktop, Claude Code, and any MCP-compatible client.

## Install

The fastest way to install is the interactive setup:

```bash
npx mindgraph-mcp init
```

This walks you through:

1. Sign in via browser (or paste an existing API key).
2. Pick your client — Claude Desktop, Claude Code, or both.
3. The server is wired up automatically; restart your client to activate.

Don't have a MindGraph account yet? Sign up at [mindgraph.cloud](https://mindgraph.cloud) first.

### Manual install

```bash
# Claude Desktop
npx mindgraph-mcp install --api-key mg_your_key_here

# Claude Code
npx mindgraph-mcp install-code --api-key mg_your_key_here
```

Or drop this into your Claude Desktop config by hand (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "mindgraph": {
      "command": "npx",
      "args": ["-y", "mindgraph-mcp@latest"],
      "env": {
        "MINDGRAPH_API_KEY": "mg_your_key_here"
      }
    }
  }
}
```

### Coding agents (Claude Code)

The **coding profile** turns MindGraph into a durable work substrate for coding
agents: identity-stable code anchors (federated live against a local
[codegraph](https://github.com/colbymchenry/codegraph) index), graph-managed
tasks/plans/iterations with fenced leases, and a deterministic work brief that
lets a fresh session resume exactly where the last one stopped — across
sessions, crashes, and machines.

Two commands:

```bash
# 1. Register the MCP server with the coding profile
npx -y mindgraph-mcp install-code --api-key mg_your_key_here

# 2. Install the Claude Code hooks (session lifecycle + work-brief injection)
npx -y mindgraph-mcp install-hooks --harness claude-code --scope user --api-key mg_your_key_here
```

The hooks open/rebind a Session at start and inject the current work brief,
stamp every MindGraph tool call with verified session/repo/commit provenance,
and prompt one reflection checkpoint before a substantial session ends. They
**fail open** — if MindGraph is unreachable, your coding session is never
blocked. `--scope project` (with `--project-dir`) installs into a single
repository's `.claude/settings.json` instead; `uninstall-hooks` reverses either
cleanly. Connection settings persist to `~/.mindgraph/hooks.json` (mode 600) so
hooks work regardless of shell environment; the API key is never written into
project settings.

### Coding agents (Codex)

The server is harness-neutral — Codex gets the full coding tool surface today:

```bash
codex mcp add mindgraph --env MINDGRAPH_API_KEY=mg_your_key_here \
  --env MINDGRAPH_PROFILE=coding --env MINDGRAPH_HARNESS=codex \
  -- npx -y mindgraph-mcp@latest
```

(or the equivalent `[mcp_servers.mindgraph]` block in Codex's `config.toml`).
The hooks adapter for Codex — automatic session lifecycle and brief injection —
is planned; until then, ask the agent to call `mindgraph_plan resume_work` at
the start of a session.

## What You Get

**8 tools** covering the full knowledge-graph workflow (**10** in the coding
profile):

| Tool | Purpose |
|------|---------|
| `mindgraph_capture` | Entities, observations, sources, snippets, concepts, journal entries |
| `mindgraph_reason` | Claims with evidence, open questions, hypotheses, theories, anomalies |
| `mindgraph_commit` | Goals, projects, decisions, options, milestones, and dated decision-context linkage |
| `mindgraph_plan` | Plans, tasks, procedures, governance policies, risk assessments, executions |
| `mindgraph_retrieve` | Context retrieval with bounded graph expansion, search, min-cost traversal, document index |
| `mindgraph_ingest` | Chunk / document / session ingestion with LLM-powered extraction |
| `mindgraph_synthesize` | Project-scoped cross-document synthesis — mine signals, spawn Article-generation jobs |
| `mindgraph_ontology` | Operational Ontology (Layer 7) — typed domain objects, NL queries with provenance, extraction proposal review (approve/reject), object linking |
| `mindgraph_code` *(coding profile)* | Identity-stable code anchors + live structural federation: `anchor`/`recall`/`expand`/`affected` over a local codegraph index — what the graph knows about this code, joined to who calls it |
| `mindgraph_sync` *(coding profile)* | Idempotent, resumable import of markdown memory files (`.claude/agent-memory/**` etc.) with content-hash drift tracking, conflict surfacing, and a retirement report |

The coding profile's `mindgraph_plan` additionally carries the durable-work
composites: `resume_work` (deterministic bounded brief), `claim_task` /
`heartbeat` (fenced leases), and `start_iteration` / `checkpoint_iteration` /
`block_task` / `complete_task` / `abandon_iteration` (idempotent material
attempts with version conflict detection).

Plus **dynamically generated read tools**: when the tenant's active schema declares object types, the server renders per-type `search_<objs>` / `get_<obj>` / `summarize_<obj>` tools (from the cloud's `GET /v1/ontology/tools` manifest) at session start. `summarize_<obj>` returns the object — whether mapped from a connected SQL database or extracted from documents — *plus* its cognitive context (claims, risks, decisions, evidence).

**7 prompt templates** for common workflows:

`graph-summary`, `active-goals`, `open-questions`, `review-contradictions`, `knowledge-about`, `daily-briefing`, `capture-conversation`.

**Resources** (static + dynamic URIs):

- `mindgraph://stats`, `mindgraph://goals`, `mindgraph://questions`, `mindgraph://contradictions`, `mindgraph://decisions`
- `mindgraph://node/{uid}` — a node with all its outgoing and incoming edges
- `mindgraph://search/{query}` — BM25 search results
- `mindgraph://layer/{layer}` — all nodes in a cognitive layer (reality, epistemic, intent, action, memory, agent)

## CLI

```text
mindgraph-mcp                  Start the MCP server (stdio transport)
mindgraph-mcp init             Interactive setup
mindgraph-mcp install          Install into Claude Desktop config
mindgraph-mcp install-code     Install into Claude Code
mindgraph-mcp uninstall        Remove from Claude Desktop config
mindgraph-mcp uninstall-code   Remove from Claude Code
mindgraph-mcp install-hooks    Install Claude Code hooks (--harness claude-code)
mindgraph-mcp uninstall-hooks  Remove MindGraph-owned hook entries
mindgraph-mcp status           Show installation status
```

Options: `--api-key <key>`, `--base-url <url>`, `--scope user|project`,
`--project-dir <dir>`, `--harness <name>`, `--help`.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MINDGRAPH_API_KEY` | *(required)* | Your MindGraph API key (`mg_…`) |
| `MINDGRAPH_BASE_URL` | `https://api.mindgraph.cloud` | Override for self-hosted deployments |
| `MINDGRAPH_PROFILE` | `general` | `coding` exposes `mindgraph_code`/`mindgraph_sync` and the work composites |
| `MINDGRAPH_HARNESS` | `generic` | `claude-code` / `codex` — adapter selection and provenance |
| `MINDGRAPH_AGENT_ID` | `mcp` | Stamped onto every node/edge written by the MCP — useful for provenance across multiple agents |
| `MINDGRAPH_ORG_ID` | *(unset)* | Pin operations to a specific organization when a key has access to more than one |
| `MINDGRAPH_CODEGRAPH_BIN` | *(auto)* | Explicit path to the codegraph binary (PATH and `~/.local/bin` are probed) |

## Usage in Claude

Once installed, start asking Claude about your knowledge graph naturally:

> "What did I capture about climate policy last week?"
> "Summarize my active goals and open decisions."
> "Ingest this PDF and extract the main claims."
> "Find entities mentioned across multiple project documents, then spin up a synthesis."

The server auto-injects `agent_id: "mcp"` on every write so you always know which nodes came from your MCP sessions.

## Architecture

This MCP server is a thin wrapper over the [mindgraph](https://www.npmjs.com/package/mindgraph) TypeScript SDK. It exposes cognitive-layer abstractions (Reality, Epistemic, Intent, Action, Memory, Agent) as consolidated tools rather than one-tool-per-endpoint, which keeps the tool surface compact enough for high-quality tool selection by the model.

Search strategy is **keyword-first**: `mindgraph_retrieve` defaults to `action: "context"`, which seeds bounded cheapest-first graph expansion from BM25/hybrid recall. Escalate to `semantic` or `hybrid` only when keywords fail. Set `graph_expansion_limit: 0` when direct-only retrieval is required.

## Development

```bash
git clone https://github.com/shuruheel/mindgraph-mcp
cd mindgraph-mcp
npm install
npm run build            # build with tsup (CJS + .d.ts)
npm run lint             # tsc --noEmit
npm run dev              # tsup --watch
```

## License

MIT
