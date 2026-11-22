# mindgraph-mcp

[![npm](https://img.shields.io/npm/v/mindgraph-mcp)](https://www.npmjs.com/package/mindgraph-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Model Context Protocol server for [MindGraph](https://mindgraph.cloud) — plug your persistent, structured knowledge graph into Claude Desktop, Claude Code, Codex, and any MCP-compatible client.

Requires Node.js 20 or later. Speaks MCP revision 2026-07-28 and the 2025
revisions, over stdio and hosted Streamable HTTP.

## Connect without installing

Chat apps and editors can use the hosted connector at `https://mindgraph.cloud/mcp`: no
package, no API key, a MindGraph sign-in in the browser.

- **Claude** (claude.ai, Claude Desktop, mobile): [Add to Claude](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=MindGraph&connectorUrl=https%3A%2F%2Fmindgraph.cloud%2Fmcp)
- **Cursor**: [Add to Cursor](https://cursor.com/install-mcp?name=mindgraph&config=eyJ1cmwiOiJodHRwczovL21pbmRncmFwaC5jbG91ZC9tY3AifQ%3D%3D)
- **Claude Code**: `claude mcp add --transport http mindgraph https://mindgraph.cloud/mcp`, then `/mcp` to sign in
- **ChatGPT**: Settings › Connectors › Advanced › Developer mode › Create › paste the URL
- **VS Code and others**: steps at [mindgraph.cloud/docs/mcp](https://mindgraph.cloud/docs/mcp#connect-an-app)

Install the package (below) when you want what only a local server can do: the
coding profile with lifecycle hooks, code anchors read from your repository, the
workspace-scoped work brief, or Claude Desktop without a sign-in.

## Install

The fastest way to install the local server is the interactive setup:

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

### Cursor (local server)

```bash
npx -y mindgraph-mcp install-cursor --api-key mg_your_key_here
```

Writes the local server with the coding profile into `~/.cursor/mcp.json` (owner-only,
other servers untouched), which gives Cursor the code tools and the workspace-scoped
`mindgraph_memory` resume that the hosted connector cannot offer. `uninstall-cursor`
removes it. Like every coding setup, it answers only in repositories where you
[turned MindGraph on](#turning-mindgraph-on-in-a-repository). No hooks are installed: Cursor loads Claude Code hooks from
`~/.claude/settings.json` by default, so if you installed those they may already run in
Cursor; that combination has not been tested in a live Cursor session yet.

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

Then, in each repository where you want MindGraph, run this from your own
terminal (see [Turning MindGraph on in a repository](#turning-mindgraph-on-in-a-repository)):

```bash
npx -y mindgraph-mcp@latest on
```

Until you do, the hooks and the coding-profile server do nothing there.

**Optional — enable code intelligence**: install
[codegraph](https://github.com/colbymchenry/codegraph) and run `codegraph init`
in your repositories. This powers `mindgraph_code`'s anchors and live
callers/impact federation. Without it, memory and work tools function fully;
code anchoring degrades to typed unavailable results (the installer tells you
which state you're in).

In a repository where MindGraph is on, the hooks open/rebind a Session at start and inject the current work brief,
stamp every MindGraph tool call with verified session/repo/commit provenance,
and prompt one reflection checkpoint before a substantial session ends. A
session automatically re-claims only *this* agent's own prior work; other
tasks appear in the brief as context, and the agent claims one deliberately
when it starts that work. They
**fail open** — if MindGraph is unreachable, your coding session is never
blocked. `--scope project` (with `--project-dir`) installs into a single
repository's `.claude/settings.json` instead; `uninstall-hooks` reverses either
cleanly. Connection settings persist to `~/.mindgraph/hooks.json` (mode 600),
and the hooks take their API key, base URL and organization from that file
only, never from the environment, so a project's settings cannot redirect them;
the API key is never written into project settings.

**Per-prompt recall (off by default; `--prompt-recall` turns it on).** When
enabled, a `UserPromptSubmit` hook runs a
bounded topic recall for each prompt — the same request the Hermes provider
makes: `POST /retrieve/context` with up to 8 keywords from the prompt (obvious
secrets redacted first), 5 items, no source chunks — and injects at most 4,000
characters headed `MindGraph recall (bounded):`, one line per item (type,
label, one-line summary, source document). An item is injected only when its
label or summary mentions two distinct keywords from the prompt, so a prompt
can inject nothing (a prompt with a single usable keyword never injects). Prompts under 12 characters and
slash commands are skipped, a block identical to the last one injected is not re-injected in the same
session, and the hook gives up after 4 s and injects nothing on any error, so
it never blocks a prompt. It is off by default because, in a replay of 59
real prompts, only 0–4% of the items it injected were relevant to the prompt.
Turn it on with `install-hooks --prompt-recall` (or `install-code --hooks
--prompt-recall`); `--no-prompt-recall` turns it back off, and
`MINDGRAPH_HOOK_PROMPT_RECALL=off` disables it at runtime. Re-running the
installer without the flag removes MindGraph's recall entry and says so;
`UserPromptSubmit` hooks from other tools are left alone.

**Transcript capture (off by default).** `install-hooks --capture` adds a
`PreCompact` hook and makes `SessionEnd` capture too. **What leaves the
machine when capture is on:** the user prompts and assistant text replies
from the Claude Code transcript (`transcript_path`) written since the last
capture, sent to `POST /ingest/session` for extraction, attached to the
session's MindGraph Session. Tool calls, tool output, thinking blocks,
subagent (sidechain) turns, compaction summaries, slash-command output and
system reminders are never sent; API keys, tokens, private keys and
`key=value` credentials are redacted by pattern (a heuristic, not a
guarantee). The capture offset lives in the hook ledger under
`~/.mindgraph/runtime/` (mode 600). `npx mindgraph-mcp hooks preview
[transcript_path]` prints exactly the request body that would be sent, and
sends nothing. `install-hooks --no-capture` (or
`MINDGRAPH_HOOK_CAPTURE=off`) turns it off. Both choices persist in
`~/.mindgraph/hooks.json`, so automatic hook refreshes keep them.

**Updates are hands-free.** The MCP registration floats on `npx @latest`,
and at startup the server self-heals the pinned hook runner from its own
bundle — upgrade-only (never a downgrade from a stale npx cache), atomic,
and only on machines that already have hooks installed. When it refreshes
the runner it also re-writes MindGraph-owned hook entries (timeout budgets,
new events) in settings files that already carry them — your scope choice is
respected, never expanded. So after a release, the next session start picks
up the new server and refreshes the hooks; the session after that runs them.
Opt out with `MINDGRAPH_HOOK_AUTOUPDATE=off` (the server then just prints a
version-skew note and leaves updating to `install-hooks`). In a directory where
MindGraph is off, the server touches only a runner too old to know about
turning on, and then only your user-level hook entries, never a project's.

### Turning MindGraph on in a repository

MindGraph's coding hooks and the coding-profile server do nothing in a
repository until you turn MindGraph on there. Run this in the repository (or
pass its path), in a terminal you opened yourself:

```bash
npx -y mindgraph-mcp@latest on
```

`on` shows what will happen before it changes anything: what the hooks do at
session start (and with prompt recall or capture, if you turned those on),
what leaves your machine and where it goes (the base URL and organization
saved in `~/.mindgraph/hooks.json`), who can read it, and how to undo it. It
records your answer in `~/.mindgraph/hooks.json`: the folder, the
repositories you chose, and when. Nothing is sent while you decide. `on`
refuses to run from inside Claude Code, Codex or Cursor (including Claude
Code's `!` prefix and Cursor's built-in terminal), so a model cannot turn it on
for you. The answer takes effect from the next session.

- **Workspaces.** At the root of a [multi-repository
  workspace](#multi-repository-workspaces), `on` lists the repositories
  `.mindgraph/workspace.json` declares and lets you choose them and the root
  itself. The workspace file only routes; it never turns anything on, so
  cloning a repository that carries one turns nothing on. Editing it pauses
  MindGraph under that root until you run `on` there again. Repositories in
  the folder that the file does not list stay off. Worktrees of a repository
  you turned on count as that repository.
- **`npx -y mindgraph-mcp@latest off [path]`** turns it off for one repository
  or workspace (inside a workspace, for that repository only) from the next
  hook event. It runs anywhere, since it can only turn things off. Memory
  already stored stays in MindGraph.
- **`npx -y mindgraph-mcp@latest off --all`** turns it off everywhere. It also
  lists, and after you confirm removes, the local files MindGraph left in
  repositories you never turned on: `.git/mindgraph/repository-id`, old
  session records and pending tool calls under `~/.mindgraph/runtime/`, and
  cached repository lookups. Only directories that Claude Code (its
  `.claude.json`, in `CLAUDE_CONFIG_DIR` when set) or MindGraph's own records
  remember are checked. It never touches the cloud, `.codegraph/`
  folders or settings files. Add `--dry-run` to see the list without changing
  anything.
- **`npx -y mindgraph-mcp@latest status`** starts with whether MindGraph is on
  in the current directory, and why not if it is off, then lists every place
  you turned it on.

**Upgrading from a version without `on`.** MindGraph is off everywhere until
you run `on`; nothing turns it on for you. Each Claude Code session started in
a repository shows a one-line notice, *MindGraph hooks now run only where you
turn them on*, until you run `on`, `off` or `off --all` once (Codex shows no
notice). The first session
after upgrading may still run the old hook runner for its SessionStart, which
can open a session and show the work brief; every later event is off. The
hooks also no longer read `MINDGRAPH_API_KEY`, `MINDGRAPH_BASE_URL` or
`MINDGRAPH_ORG_ID`: they use what `install-hooks` or `install-code --hooks`
saved in `~/.mindgraph/hooks.json`. If your key was only in the environment,
run `npx -y mindgraph-mcp@latest install-hooks --harness claude-code --api-key
mg_…` once. Environment variables can only turn hook features off
(`MINDGRAPH_HOOKS=off`, `MINDGRAPH_HOOK_CAPTURE=off`,
`MINDGRAPH_HOOK_PROMPT_RECALL=off`), never on.

`hooks.json` is found through your account's home directory, not `$HOME`. Set
`MINDGRAPH_HOME` to keep it somewhere else; the pinned hook runner (`bin/`) and
the hooks' runtime files (`runtime/`) then live there too. Install hooks with
`--scope user` while it is set: project settings are shared through git, so
`install-hooks --scope project` refuses rather than name a path on your
machine. When that folder is not an
absolute path or is inside a git work tree, MindGraph refuses it and stays off
everywhere until you unset or move it: `status` says why, and `on` and `off`
refuse.

### Importing Claude Code's notes

Claude Code keeps its own notes for each project (its auto memory). To copy
them into MindGraph, so other machines and other agents can use them, run this
in a repository or workspace where MindGraph is on, in a terminal you opened
yourself:

```bash
npx -y mindgraph-mcp@latest import notes            # or: import notes <path>
npx -y mindgraph-mcp@latest import notes --dry-run  # show the list, send nothing
```

The command reads the notes folder Claude Code uses for that place:
`autoMemoryDirectory` from `.claude/settings.local.json` (only when git does
not track that file; the card then warns you that a file in the repository
chose the folder) or from your user settings when set, otherwise
`~/.claude/projects/<the folder's path with every character other than a letter or digit replaced by ->/memory`
(`CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME` are honoured). Like
Claude Code, it ignores `autoMemoryDirectory` in the checked-in
`.claude/settings.json`, and it refuses a folder that is a file-system root,
your home folder, or the repository or workspace itself or a folder above it. Before
sending anything it lists every note with its size, whether it is new or
updated, where it goes (the memory for that repository or workspace), and who
can read it: anyone holding an API key for your organization. Pressing Enter
never sends; you choose 1 to import.

- **One item per note.** Each note is stored as written, with no
  language-model call. The note's path in the folder, together with an id for
  this notes folder on this machine, is its key, so importing again updates
  changed notes only and sends nothing when nothing changed, and an import
  never changes or hides notes that a teammate or another machine imported
  into the same memory. A note you deleted is hidden in MindGraph on the next
  import (hidden items can be restored). If part of the folder cannot be read,
  notes the import could not reach are not hidden that time.
- **Never sent:** the index files at the top of the folder (`MEMORY.md`,
  `CATALOG.md`, `README.md`, `ARCHIVE.md`); notes of type `user` (`type: user`
  or `metadata.type: user` in the frontmatter) unless you add
  `--include-user`; notes longer than 8 KB; any note containing text that
  looks like a secret (an API key, token, private key, `..._PASSWORD=` or
  `..._TOKEN=` value, or a password in a URL), which the list names without
  showing its content, or whose file or folder name looks like one; and any note whose
  frontmatter says `mindgraph: skip`. A note imported before that now falls
  under one of these is hidden on the next import.
- **Files a note names.** For a path in backticks in a note, such as
  `` `src/consent.ts` ``, that names a file git tracks inside the repository or
  workspace, the import records the file's git blob hash in its local record
  and sends it with the note. MindGraph does not keep it yet. Untracked and
  ignored files, such as `.env`, are never hashed.
- **Your files stay yours.** The import never writes to the notes folder. It
  refuses a notes folder that is inside a git repository (such a `memory/`
  folder is written by the repository's authors) and skips repositories
  nested in the folder. It refuses to run from inside Claude Code, Codex or
  Cursor (a dry run is allowed), and no hook runs it.
- **Where it goes.** The destination is the base URL and organization saved in
  `~/.mindgraph/hooks.json`, and the space pinned when you turned MindGraph on.
  If you change the base URL or organization, the next import sends every note
  to the new one and leaves the items in the old one alone (hide them there if
  you no longer want them). If the space changes, items in the old space are
  hidden there, and the card names that space.
  A repository turned on by itself has no space of its own yet, so the import
  refuses there; inside a workspace each repository and the workspace root have
  one. What was sent is recorded in `~/.mindgraph/import-notes.json` (readable
  only by you).

### Multi-repository workspaces

Working across sibling repositories (a parent directory holding several
checkouts)? Declare them once in `.mindgraph/workspace.json` at the parent,
then run `npx -y mindgraph-mcp@latest on` there:

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

- **Turning it on**: the file declares; `on` decides. `root` paths are
  relative to the directory containing `.mindgraph`; `..` and absolute roots
  are refused. Only the repositories you chose at `on` participate, as they
  were when you chose them. Siblings are never scanned implicitly, and
  `MINDGRAPH_WORKSPACE_FILE`, `MINDGRAPH_CODE_REPOS`, `MINDGRAPH_REPO_ROOT`,
  `MINDGRAPH_REPO_ID` and `MINDGRAPH_CODE_SPACE_UID` are ignored.
- **Routing**: a code ref with a `path` routes to the turned-on repository
  holding that file. A `repo` argument matches by declared `repo_id`, root
  path, or directory basename. Bare symbol refs resolve against the current
  repository only — pass `path` or `repo` to target a sibling. A path or id
  outside the turned-on repositories is refused (`not_opted_in`) rather than
  guessed. At the workspace root itself, name the repository: `create_task`
  and the code tools there need a `repo`.
- **Identity**: `repo_id` defaults to the normalized origin remote
  (`github.com/acme/engine`), so teammates' clones converge on the same graph
  entities; clones without a remote get a durable generated id.
- **Spaces**: each repository's anchors are written into its `space_uid`.
  Anchoring requires an explicit space — per-repo `space_uid` or a
  `repo_space_uid` argument — so shared code
  identity never lands silently in a private per-agent space.
- **Work brief**: a session started at the workspace root (when you turned
  the root on) selects durable work across the turned-on repositories and
  lists the other eligible tasks by repository. In a coding setup,
  `mindgraph_memory` with `mode: "resume"` and `scope: "workspace"` returns the
  same view on demand; in the default profile that call returns an error.
- **Memory-file sync**: `mindgraph_sync action=scan workspace=true` fans out
  across the turned-on repositories; all other sync actions stay
  single-repository.

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
checkpoint, and SessionEnd performs best-effort cleanup. Codex hooks follow
the same rule as Claude Code's: they do nothing in a repository until you run
`npx -y mindgraph-mcp@latest on` there. All paths fail open:
missing credentials or an unreachable MindGraph return Codex's no-op response
and never block the coding session.

## What You Get

**11 tools** covering the full knowledge-graph workflow (**13** in the coding
profile):

| Tool | Purpose |
|------|---------|
| `mindgraph_capture` | Entities, observations, sources, snippets, concepts, journals, lessons, governed skill candidates |
| `mindgraph_reason` | Claims with evidence, open questions, hypotheses, theories, anomalies |
| `mindgraph_commit` | Goals, projects, decisions, options, milestones, and dated decision-context linkage |
| `mindgraph_plan` | Plans, tasks, procedures, governance policies, risk assessments, executions |
| `mindgraph_retrieve` | Context retrieval with bounded graph expansion, search, min-cost traversal, document index. Read results return as compact rendered text (labels, uids, summaries, epistemic status tags, relationships, traversal depth/cost); set `max_output_chars` for a hard whole-item character budget, or pass `format: "json"` for the raw server response |
| `mindgraph_memory` | Read-only M0 memory workflow: inspect honest integration status, retrieve bounded topic context, recover authoritative task-first resume/continuity context, or read a conversation-start `brief` (work in progress, active goals, open decisions, preferences). Returns model-ready text plus a structured envelope with scope, hashes, trace, budget, freshness, and warnings |
| `mindgraph_remember` | Small-text fast path: `remember` stores one fact/preference/decision synchronously and it is BM25- and vector-searchable on return; a stable `custom_id` makes re-sends an upsert of the same memory. `forget` reversibly removes by uid or custom_id in two calls (the first returns a preview and removes nothing; repeat with `confirm: true` to remove), with `dry_run` previewing the affected edge uids; `restore` undoes a forget from the uid and edge uids it returned |
| `mindgraph_series_query` | Bounded, read-only dense-measurement queries: list an entity's Series, inspect latest values, page a time window, or calculate calendar aggregates |
| `mindgraph_ingest` | Chunk / document / session ingestion with LLM-powered extraction. `document_status` performs read-only authoritative readiness inspection (`document-status.v1`: `lexical`, `vector`, `extraction`) by `document_uid`, with optional `attempt_id` pinning, `until`, and bounded `wait_seconds` (up to 50 s locally, 25 s hosted). `job_status` without an id renders the 20 most recent jobs (`format: "json"` for the full list); with `job_id` and `wait_seconds` it waits for an in-memory job and reports progress |
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

- `mindgraph://memory/status` — M0 capabilities, adapter state, and explicit automatic-delivery/curator limitations
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
mindgraph-mcp hooks preview    Print what transcript capture would send (sends nothing)
mindgraph-mcp hooks stats      Per-event hook calls, time and injected characters for a session
mindgraph-mcp skills pull      Render published and granted skills into local SKILL.md directories
mindgraph-mcp skills push      Import or update one local SKILL.md as a governed candidate
mindgraph-mcp on [path]        Turn MindGraph on for a repository or workspace (asks first)
mindgraph-mcp off [path]       Turn MindGraph off for a repository or workspace
mindgraph-mcp off --all        Turn it off everywhere and remove its local files from
                               repositories you never turned on (--dry-run: list only)
mindgraph-mcp import notes [path]
                               Copy Claude Code's notes for a place you turned on into
                               MindGraph, one item per note (asks first; --dry-run:
                               list only; --include-user: also notes of type user)
mindgraph-mcp status           Show whether MindGraph is on here, and installation status
```

Run every command as `npx -y mindgraph-mcp@latest <command>`, so an older copy
in a project's `node_modules` or the npx cache never answers it.

Options: `--api-key <key>`, `--base-url <url>`, `--agent-id <id>`,
`--scope user|project`, `--project-dir <dir>`, `--harness <name>`,
`--prompt-recall` / `--no-prompt-recall` (recall is off by default),
`--capture` / `--no-capture`,
`--session-id <id>` (for `hooks preview` and `hooks stats`), `--help`.

**Teams**: when several people share one org graph, give each member a
distinct identity — `--agent-id claude-code:<name>` on `install-code` /
`install-hooks`. Anchored knowledge is shared automatically; distinct agent
ids keep task leases and resume briefs per-person (identical ids make
teammates one logical agent, which claims each other's work).

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MINDGRAPH_API_KEY` | *(required)* | Your MindGraph API key (`mg_…`) for the MCP server. `install-hooks` saves it for the hooks when `--api-key` is not given; the hooks themselves read only `~/.mindgraph/hooks.json` |
| `MINDGRAPH_BASE_URL` | `https://api.mindgraph.cloud` | Override for self-hosted deployments (the MCP server; the hooks use the URL saved in `hooks.json`) |
| `MINDGRAPH_PROFILE` | `general` | `coding` exposes `mindgraph_code`/`mindgraph_sync` and the work composites, and answers only in repositories where you ran `on` |
| `MINDGRAPH_HARNESS` | `generic` | `claude-code` / `codex` — adapter selection and provenance |
| `MINDGRAPH_AGENT_ID` | *(stable per-user id)* | Agent identity stamped on every write and used for durable-work leases. Defaults to a stable `u-<hash>` derived from user@host, shared by the hooks, the registration, and the serve path — set explicitly for cross-device continuity or per-teammate identities |
| `MINDGRAPH_ORG_ID` | *(unset)* | Pin the MCP server's operations to a specific organization when a key has access to more than one. `install-hooks` saves it for the hooks, which do not read it at runtime |
| `MINDGRAPH_HOME` | *(your account's `~/.mindgraph`)* | Absolute path of the folder holding `hooks.json` (hook connection settings and where MindGraph is on), the pinned hook runner (`bin/`) and the hooks' runtime files (`runtime/`). Inside a git work tree, or when not absolute, it is refused and MindGraph stays off everywhere |
| `MINDGRAPH_EVAL` | *(unset)* | `1` lets the MCP server, the hooks, `import notes`, `skills` and `init` talk only to a MindGraph at a local address (`localhost`, `127.x.x.x`, `::1`); any other address is refused with `eval_requires_loopback` before anything is sent. Also requires an accepted `MINDGRAPH_HOME` (`eval_requires_home`), installs user-scope hooks only under `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, and turns off the runner self-heal. For evaluation and benchmark runs |
| `MINDGRAPH_HOOKS` | *(unset)* | `off` pauses the hooks and the coding-profile server, even where MindGraph is on. No variable can turn MindGraph on |
| `MINDGRAPH_CODEGRAPH_BIN` | *(auto)* | Explicit path to the codegraph binary (PATH and `~/.local/bin` are probed) |
| `MINDGRAPH_HOOK_AUTOUPDATE` | *(on)* | `off` disables the server's startup self-heal of the pinned hook runner; the version-skew note then signals drift instead |
| `MINDGRAPH_HOOK_PROMPT_RECALL` | *(on when opted in)* | `off` disables the Claude `UserPromptSubmit` recall at runtime; the hook is installed only with `--prompt-recall` |
| `MINDGRAPH_HOOK_CAPTURE` | *(stored choice; off)* | `off` turns Claude transcript capture off at runtime. It cannot turn capture on: only `install-hooks --capture` does, because a project's settings file can set hook environment variables |
| `MINDGRAPH_SKIP_MCP_REGISTRATION_CHECK` | *(unset)* | `1` silences the SessionStart warning for hooks running without a registered MindGraph MCP server (exotic registration layouts) |

## Usage in Claude

Once installed, start asking Claude about your knowledge graph naturally:

> "What did I capture about climate policy last week?"
> "Summarize my active goals and open decisions."
> "Ingest this PDF and extract the main claims."
> "Find entities mentioned across multiple project documents, then spin up a synthesis."

The portable memory workflow can also be invoked explicitly:

```text
mindgraph_memory {"action":"status"}
mindgraph_memory {"action":"context","mode":"topic","query":"graph continuation"}
mindgraph_memory {"action":"context","mode":"resume","project_uid":"project-uid"}
```

`mindgraph_memory` is intentionally read-only. Existing typed write tools remain
available for durable facts, corrections, decisions, work transitions, lessons,
and ingestion. Automatic lifecycle observation and curator mutation are not part
of M0, and a successful MCP read does not prove the host injected the context.

The server auto-injects your agent identity on every write so you always know which nodes came from your MCP sessions — the same identity the session hooks use for durable-work leases, so work claimed in one harness resumes in the other.

## Architecture

This MCP server is a thin wrapper over the [mindgraph](https://www.npmjs.com/package/mindgraph) TypeScript SDK. It exposes cognitive-layer abstractions (Reality, Epistemic, Intent, Action, Memory, Agent) as consolidated tools rather than one-tool-per-endpoint, which keeps the tool surface compact enough for high-quality tool selection by the model.

The proposed application-independent memory contract and its staged delivery plan
live in [Memory Integration Profile V1](docs/MEMORY-INTEGRATION-PROFILE-V1.md). It
distinguishes portable MCP compatibility from integrations that provide automatic
lifecycle observation, context delivery, and managed curation.

Search strategy is **keyword-first**: `mindgraph_retrieve` defaults to `action: "context"`, which seeds bounded cheapest-first graph expansion from BM25/hybrid recall. Escalate to `semantic` or `hybrid` only when keywords fail. Set `graph_expansion_limit: 0` when direct-only retrieval is required. For model-facing reads, `max_output_chars` bounds the rendered response from 512 to 24,000 characters while preserving whole evidence items and reporting omissions; `format: "json"` deliberately bypasses that rendering contract.

## Hosted mode

The same tool surface is importable as a library for a hosted Streamable HTTP
endpoint (the `https://mindgraph.cloud/mcp` connector that claude.ai, Claude
Code, ChatGPT and Cursor sign in to with OAuth). `mindgraph-mcp/server` exports
a per-request factory and has no load-time side effects — it never exits for a
missing key or touches hook files:

```ts
import { handleHostedRequest } from "mindgraph-mcp/server";

// After the route has verified the OAuth bearer and exchanged it for an API token:
return handleHostedRequest(request, {
  client, bearer, baseUrl, orgId, orgName, agentId: `mcp:${clientHost}:${userId}`,
  user: { id: userId, name, email },
  profile: "general", harness: "hosted", serverVersion,
  caches, // { generatedTools: Map, governance: Map } — one entry per org, kept by the route
});
```

Hosted mode serves the `general` profile plus the org's generated ontology
tools and three extra tools — `search`, `fetch` (the ChatGPT connector
contract, `structuredContent` + text twin) and `whoami` — each annotated and
carrying `_meta.securitySchemes` with its `graph:read` / `graph:write` /
`graph:evolve` scope. The signed-in member's identity overwrites `agent_id`
on every call; a model-supplied value is kept only as `requested_agent_id`
metadata. `mindgraph_code`, `mindgraph_sync` and hook installation are stdio-only.
The HTTP auth gate (401/403) is the route's job, not the library's.

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

### Engine failures and retries

Tool failures carry `isError: true`; `code`, `status`, and optional `retriable`
are preserved in both the JSON text and structured content. Lease-conflict fields
remain available to hooks. A failed retrieval is not an empty successful result.
Explicit `retriable: false` stops automatic retries, including index maintenance.
Other 503 responses retry only reviewed reads or atomically keyed work operations.

This adoption branch pins the TypeScript SDK to immutable source commit
`02bad10728836bf55129c08efabf71386432deee` so installs and CI exercise the same
retry implementation. Git installation builds the SDK through its `prepare` hook.
Replace this source pin and regenerate the lockfile only after a registry release
containing that implementation is verified; older SDK releases retry all 503s.
