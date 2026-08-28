# mindgraph-mcp

[![npm](https://img.shields.io/npm/v/mindgraph-mcp)](https://www.npmjs.com/package/mindgraph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Model Context Protocol server for [MindGraph](https://mindgraph.cloud) — plug your persistent, structured knowledge graph into Claude Desktop, Claude Code, Codex, and any MCP-compatible client.

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

One command:

```bash
npx -y mindgraph-mcp install-code --api-key mg_your_key_here --hooks
```

This registers the MCP server with the coding profile AND installs the Claude
Code hooks (session lifecycle + work-brief injection) with persisted connection
settings. Prefer separate steps? `install-code` alone registers just the
server, and `install-hooks --harness claude-code --scope user --api-key …`
adds the hooks later.

**Optional — enable code intelligence**: install
[codegraph](https://github.com/colbymchenry/codegraph) and run `codegraph init`
in your repositories. This powers `mindgraph_code`'s anchors and live
callers/impact federation. Without it, memory and work tools function fully;
code anchoring degrades to typed unavailable results (the installer tells you
which state you're in).

The hooks open/rebind a Session at start and inject the current work brief,
stamp every MindGraph tool call with verified session/repo/commit provenance,
and prompt one reflection checkpoint before a substantial session ends. A
session automatically re-claims only *this* agent's own prior work; other
tasks appear in the brief as context, and the agent claims one deliberately
when it starts that work. They
**fail open** — if MindGraph is unreachable, your coding session is never
blocked. `--scope project` (with `--project-dir`) installs into a single
repository's `.claude/settings.json` instead; `uninstall-hooks` reverses either
cleanly. Connection settings persist to `~/.mindgraph/hooks.json` (mode 600) so
hooks work regardless of shell environment; the API key is never written into
project settings.

**Updates are hands-free.** The MCP registration floats on `npx @latest`,
and at startup the server self-heals the pinned hook runner from its own
bundle — upgrade-only (never a downgrade from a stale npx cache), atomic,
and only on machines that already have hooks installed. When it refreshes
the runner it also re-writes MindGraph-owned hook entries (timeout budgets,
new events) in settings files that already carry them — your scope choice is
respected, never expanded. So after a release, the next session start picks
up the new server and refreshes the hooks; the session after that runs them.
Opt out with `MINDGRAPH_HOOK_AUTOUPDATE=off` (the server then just prints a
version-skew note and leaves updating to `install-hooks`).

### Multi-repository workspaces

Working across sibling repositories (a parent directory holding several
checkouts)? Declare them once in `.mindgraph/workspace.json` at the parent:

```json
{
  "v": 1,
  "workspace_id": "my-workspace",
  "repositories": [
    { "root": "engine", "repo_id": "github.com/acme/engine", "space_uid": "space:project:engine" },
    { "root": "core", "space_uid": "space:project:core" }
  ]
}
```

- **Discovery** walks up from the invocation directory to the nearest
  `.mindgraph/workspace.json` (override with `MINDGRAPH_WORKSPACE_FILE`).
  `root` paths are relative to the directory containing `.mindgraph`. Only
  declared repositories participate — siblings are never scanned implicitly.
- **Routing**: a code ref with a `path` routes to the repository defining that
  file (nearest declared root, else its git root). A `repo` argument matches by
  declared `repo_id`, root path, or directory basename. Bare symbol refs
  resolve against the current repository only — pass `path` or `repo` to
  target a sibling. An id that matches nothing errors (`unknown_repository`)
  rather than guessing.
- **Identity**: `repo_id` defaults to the normalized origin remote
  (`github.com/acme/engine`), so teammates' clones converge on the same graph
  entities; clones without a remote get a durable generated id.
- **Spaces**: each repository's anchors are written into its `space_uid`.
  Anchoring requires an explicit space — per-repo `space_uid`, a
  `repo_space_uid` argument, or `MINDGRAPH_CODE_SPACE_UID` — so shared code
  identity never lands silently in a private per-agent space.
- **Memory-file sync**: `mindgraph_sync action=scan workspace=true` fans out
  across the declared repositories (and errors with a diagnostic when nothing
  is declared); all other sync actions stay single-repository.
- **Precedence**: the legacy `MINDGRAPH_CODE_REPOS` env map (`{"repo-id":
  {"root": "...", "space_uid": "..."}}`) merges over workspace-file entries
  for the same root.

### Coding agents (Codex)

Codex gets the same durable work substrate through its native command hooks.
Register the MCP server with a distinct agent identity, then install the hooks:

```bash
codex mcp add mindgraph --env MINDGRAPH_API_KEY=mg_your_key_here \
  --env MINDGRAPH_PROFILE=coding --env MINDGRAPH_HARNESS=codex \
  --env MINDGRAPH_AGENT_ID=codex:your-name \
  -- npx -y mindgraph-mcp@latest

npx -y mindgraph-mcp install-hooks --harness codex --scope user \
  --api-key mg_your_key_here --agent-id codex:your-name
```

(or the equivalent `[mcp_servers.mindgraph]` block in Codex's `config.toml`).
The installer copies the pinned self-contained runner to
`~/.mindgraph/bin/mindgraph-hook.cjs`, merge-safely upserts only entries marked
`--owner mindgraph`, and writes user hooks to `$CODEX_HOME/hooks.json`
(`~/.codex/hooks.json` by default). Use `--scope project --project-dir …` for
`<project>/.codex/hooks.json`. Re-run the install command to refresh owned
entries; foreign hooks are never changed. Codex requires newly installed or
changed command hooks to be reviewed with `/hooks` before they run.

At SessionStart the adapter opens/rebinds the graph Session and injects one
bounded work brief, re-claiming only this agent's own prior work.
PreToolUse replaces forged/absent invocation provenance
while preserving model-selected work targets, PostToolUse updates only the
disposable runtime ledger, Stop runs the once-per-session reflection
checkpoint, and SessionEnd performs best-effort cleanup. All paths fail open:
missing credentials or an unreachable MindGraph return Codex's no-op response
and never block the coding session.

## What You Get

**9 tools** covering the full knowledge-graph workflow (**11** in the coding
profile):

| Tool | Purpose |
|------|---------|
| `mindgraph_capture` | Entities, observations, sources, snippets, concepts, journals, lessons, governed skill candidates |
| `mindgraph_reason` | Claims with evidence, open questions, hypotheses, theories, anomalies |
| `mindgraph_commit` | Goals, projects, decisions, options, milestones, and dated decision-context linkage |
| `mindgraph_plan` | Plans, tasks, procedures, governance policies, risk assessments, executions |
| `mindgraph_retrieve` | Context retrieval with bounded graph expansion, search, min-cost traversal, document index. Read results return as compact rendered text (labels, uids, summaries, epistemic status tags, relationships, traversal depth/cost); set `max_output_chars` for a hard whole-item character budget, or pass `format: "json"` for the raw server response |
| `mindgraph_series_query` | Bounded, read-only dense-measurement queries: list an entity's Series, inspect latest values, page a time window, or calculate calendar aggregates |
| `mindgraph_ingest` | Chunk / document / session ingestion with LLM-powered extraction. `job_status` without an id renders the 20 most recent jobs (`format: "json"` for the full list) |
| `mindgraph_synthesize` | Project-scoped cross-document synthesis — mine signals (rendered as sections since 0.17.0), spawn Article-generation jobs |
| `mindgraph_ontology` | Operational Ontology (Layer 7) — typed domain objects, NL queries with provenance, extraction proposal review (approve/reject), object linking. Read actions render as text since 0.17.0 (`format: "json"` for raw) |
| `mindgraph_code` *(coding profile)* | Identity-stable code anchors + live structural federation: `anchor`/`recall`/`expand`/`affected` over a local codegraph index — what the graph knows about this code, joined to who calls it |
| `mindgraph_sync` *(coding profile)* | Idempotent, resumable import of markdown memory files (`.claude/agent-memory/**` etc.) with content-hash drift tracking, conflict surfacing, and a retirement report |

The coding profile's `mindgraph_plan` additionally carries the durable-work
composites: `resume_work` (deterministic bounded brief), `claim_task` /
`heartbeat` (fenced leases), and `start_iteration` / `checkpoint_iteration` /
`block_task` / `complete_task` / `abandon_iteration` (idempotent material
attempts with version conflict detection).

Plus **dynamically generated read tools**: when the tenant's active schema declares object types, the server renders per-type `search_<objs>` / `get_<obj>` / `summarize_<obj>` tools (from the cloud's `GET /v1/ontology/tools` manifest) at session start. `summarize_<obj>` returns the object — whether mapped from a connected SQL database or extracted from documents — *plus* its cognitive context (claims, risks, decisions, evidence). Since 0.17.0 these read tools render as text by default (pass `format: "json"` for the raw response); `related_*` tools follow the same contract, and `structured_query_*` composites always return raw rows.

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
mindgraph-mcp install-code     Install into Claude Code (--hooks: also install session hooks)
mindgraph-mcp uninstall        Remove from Claude Desktop config
mindgraph-mcp uninstall-code   Remove from Claude Code
mindgraph-mcp install-hooks    Install coding hooks (--harness claude-code|codex)
mindgraph-mcp uninstall-hooks  Remove MindGraph-owned hook entries
mindgraph-mcp skills pull      Render published and granted skills into local SKILL.md directories
mindgraph-mcp skills push      Import or update one local SKILL.md as a governed candidate
mindgraph-mcp status           Show installation status
```

Options: `--api-key <key>`, `--base-url <url>`, `--agent-id <id>`,
`--scope user|project`, `--project-dir <dir>`, `--harness <name>`, `--help`.

**Teams**: when several people share one org graph, give each member a
distinct identity — `--agent-id claude-code:<name>` on `install-code` /
`install-hooks`. Anchored knowledge is shared automatically; distinct agent
ids keep task leases and resume briefs per-person (identical ids make
teammates one logical agent, which claims each other's work).

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MINDGRAPH_API_KEY` | *(required)* | Your MindGraph API key (`mg_…`) |
| `MINDGRAPH_BASE_URL` | `https://api.mindgraph.cloud` | Override for self-hosted deployments |
| `MINDGRAPH_PROFILE` | `general` | `coding` exposes `mindgraph_code`/`mindgraph_sync` and the work composites |
| `MINDGRAPH_HARNESS` | `generic` | `claude-code` / `codex` — adapter selection and provenance |
| `MINDGRAPH_AGENT_ID` | *(stable per-user id)* | Agent identity stamped on every write and used for durable-work leases. Defaults to a stable `u-<hash>` derived from user@host, shared by the hooks, the registration, and the serve path — set explicitly for cross-device continuity or per-teammate identities |
| `MINDGRAPH_ORG_ID` | *(unset)* | Pin operations to a specific organization when a key has access to more than one |
| `MINDGRAPH_CODEGRAPH_BIN` | *(auto)* | Explicit path to the codegraph binary (PATH and `~/.local/bin` are probed) |
| `MINDGRAPH_HOOK_AUTOUPDATE` | *(on)* | `off` disables the server's startup self-heal of the pinned hook runner; the version-skew note then signals drift instead |
| `MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK` | *(unset)* | `1` silences the SessionStart warning for hooks running without a registered MindGraph MCP server (exotic registration layouts) |

## Usage in Claude

Once installed, start asking Claude about your knowledge graph naturally:

> "What did I capture about climate policy last week?"
> "Summarize my active goals and open decisions."
> "Ingest this PDF and extract the main claims."
> "Find entities mentioned across multiple project documents, then spin up a synthesis."

The server auto-injects your agent identity on every write so you always know which nodes came from your MCP sessions — the same identity the session hooks use for durable-work leases, so work claimed in one harness resumes in the other.

## Architecture

This MCP server is a thin wrapper over the [mindgraph](https://www.npmjs.com/package/mindgraph) TypeScript SDK. It exposes cognitive-layer abstractions (Reality, Epistemic, Intent, Action, Memory, Agent) as consolidated tools rather than one-tool-per-endpoint, which keeps the tool surface compact enough for high-quality tool selection by the model.

Search strategy is **keyword-first**: `mindgraph_retrieve` defaults to `action: "context"`, which seeds bounded cheapest-first graph expansion from BM25/hybrid recall. Escalate to `semantic` or `hybrid` only when keywords fail. Set `graph_expansion_limit: 0` when direct-only retrieval is required. For model-facing reads, `max_output_chars` bounds the rendered response from 512 to 24,000 characters while preserving whole evidence items and reporting omissions; `format: "json"` deliberately bypasses that rendering contract.

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
