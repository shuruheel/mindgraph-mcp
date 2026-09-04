# MindGraph MCP Memory Integration Profile V1

**Status: PROPOSED, revised 2026-09-04.** The read-only M0 reference surface is
implemented but unreleased. This specification defines the product contract for
application-independent graph memory through MindGraph MCP. It authorizes no
production mutation, paid model run, or release by itself.

## Objective

Make MindGraph MCP the portable memory layer through which an application can:

1. recover relevant prior context before acting;
2. preserve durable facts, decisions, preferences, work state, and evidence;
3. revise or retire stale knowledge instead of accumulating an unbounded log;
4. continue work across sessions, agents, machines, and applications; and
5. show what memory was used, why it was selected, and how it changed.

Tenant knowledge remains graph-resident. A curator may improve memory maintenance,
but it is a generic, versioned, auditable, and replaceable policy behind this
contract. The curator is not the memory store, the authorization boundary, or the
public application interface.

## Product guarantee and protocol boundary

MindGraph supports any conforming MCP application at the portable baseline. It
does not claim that connecting an MCP server alone makes memory automatic.

MCP tools are model-controlled and MCP resources are application-controlled. The
host decides what reaches the model, and an MCP server does not receive the whole
conversation by default. MCP 2026-07-28 is also stateless: every request is
self-contained and no durable application session may be inferred from a
connection. These are protocol properties, not defects MindGraph can override.

Therefore:

- **MCP-compatible** means the application can discover and use MindGraph's
  standard tools, resources, and prompts.
- **Memory-aware** means the application also supplies the portable lifecycle
  events and injects bounded MindGraph context at the required boundaries.
- **Managed memory** means the complete capture, context-delivery, curation,
  correction, audit, and rollback contract is active and qualified for that
  application version.

“Automatic graph memory” may be claimed only for a memory-aware or managed
integration. “Improves continuation” may be claimed only after a named application
passes its executable-continuation acceptance gate.

## Scope

V1 covers:

- standard MCP access to graph-backed memory;
- a portable application event envelope;
- bounded context delivery;
- asynchronous curator proposals;
- deterministic, governed graph mutation;
- observable degradation and integration health;
- conformance and application-level acceptance; and
- the first capture-only and shadow implementation batches.

V1 does not:

- require a particular model, checkpoint, vendor, or local harness;
- give an MCP server unrestricted access to an application's conversation;
- treat client-supplied identity as authorization;
- replace an application's user-consent responsibilities;
- allow arbitrary model output to mutate the graph;
- replace native personalization that an application does better; or
- claim graph superiority over strong maintained text memory without evidence.

## Protocol baseline

The target protocol is MCP **2026-07-28**. The contract relies only on core tools,
resources, prompts, per-request client metadata, and authorization. It does not
depend on deprecated roots, sampling, logging, implicit protocol sessions, or an
experimental extension.

At authoring time, `mindgraph-mcp` 0.19.0 uses
`@modelcontextprotocol/sdk` 1.29.0 over stdio. The first implementation batch must
produce a compatibility matrix and migration decision for MCP 2026-07-28. V1 must
continue to serve supported deployed clients while that migration is staged.

Application continuity uses explicit MindGraph identifiers carried in ordinary
arguments or event envelopes. It never relies on transport affinity, process
lifetime, or an MCP connection identifier.

## Integration profiles

Profiles are cumulative. A higher profile includes all lower-profile behavior.

| Profile | Application obligations | MindGraph obligations | Permitted claim |
|---|---|---|---|
| **M0: Portable baseline** | Connect to the MCP server and permit standard tool/resource use | Publish a concise memory workflow, structured tools, bounded context, explicit health, and actionable errors | Works with this supported MCP client |
| **M1: Memory-aware** | Provide stable scope and lifecycle events; deterministically request and inject context at declared boundaries | Accept events idempotently, retrieve scoped context, expose processing state, and run capture/shadow processing asynchronously | Automatic context and memory observation are active for this application/version |
| **M2: Managed memory** | Meet M1 plus consent, correction, deletion, and audit UX requirements | Run a qualified curator, deterministic compiler, governed reversible mutation, correction propagation, monitoring, and rollback | Managed graph memory is active for this application/version |

### M0: Portable baseline

M0 minimizes reliance on model discretion but cannot eliminate it. The server must:

- state one default workflow in server instructions: **orient, answer, preserve**;
- offer one high-level memory workflow tool in addition to the comprehensive
  MindGraph tools;
- expose bounded continuity and integration-health resources;
- return compact rendered text plus schema-valid structured content;
- describe when retrieval, capture, correction, and explicit no-write behavior
  are appropriate;
- use deterministic tool ordering and stable names; and
- make unsupported automatic behavior visible rather than implying it occurred.

Prompts may teach the workflow, but prompt selection is optional and is not an M0
guarantee.

### M1: Memory-aware

M1 adds a deterministic application adapter. The adapter must:

- establish tenant, application, actor, and work scope explicitly;
- request bounded continuity context at session start or resume;
- request topic-shaped context when the application can identify the current
  task or user topic;
- inject returned context without silently exceeding the declared budget;
- submit scrubbed events with stable idempotency keys;
- emit a boundary event before a clean close when the host supports it; and
- expose capture, delivery, and degradation status to the user or operator.

M1 ingestion is observation, not permission to mutate durable graph state.
Capture must fail open for the host interaction while retaining visible retry or
degradation state. Context delivery must fail boundedly: no context is preferable
to stale, cross-tenant, incorrectly scoped, or unbounded context.

### M2: Managed memory

M2 adds asynchronous policy and mutation. The system must:

- consume the same M1 event contract;
- preserve separate per-turn and boundary cadences;
- generate versioned semantic proposals, including `NOOP`;
- compile proposals deterministically into authorized graph operations;
- validate current state, scope, evidence, and optimistic versions before write;
- journal every accepted mutation and make it reversible;
- propagate correction, supersession, and deletion;
- support shadow, canary, pause, and rollback modes; and
- requalify after material curator, adapter, host, or application changes.

## Public memory workflow

V1 adds one high-level read tool, `mindgraph_memory`, while preserving the
existing comprehensive read and write tools. It is a workflow surface, not a replacement for
`mindgraph_retrieve`, `mindgraph_capture`, `mindgraph_reason`,
`mindgraph_commit`, or `mindgraph_plan`.

MCP safety annotations apply to an entire tool, not independently to each action.
The M0 surface therefore cannot truthfully mix read-only status/context calls with
later event-log writes. The public tools are separated by mutability:

| Tool and action | Profile | Behavior | Mutation |
|---|---|---|---|
| `mindgraph_memory(status)` | M0 | Report supported profile, adapter state, scope, curator mode, and explicit limitations | None |
| `mindgraph_memory(context)` | M0 | Return bounded topic or continuity context with provenance and retrieval trace | None |
| `mindgraph_observe(observe)` *(future)* | M1 | Accept one or more portable application events idempotently | Event log only |
| `mindgraph_observe(checkpoint)` *(future)* | M1 | Record an explicit work boundary and request asynchronous distillation | Event log only |
| `mindgraph_proposals(list|get)` *(future)* | M2 | Inspect shadow or pending curator proposals and their evidence | None |

Durable graph mutation remains behind existing typed tools and, for a future
curator, the governed compiler. The read-only `mindgraph_memory` tool does not
remove or weaken explicit user or agent writes; it keeps status/context safety
metadata truthful while those writes continue through their normal authorization
checks.

Every tool must define an input schema, output schema, tool annotations, size
limits, and actionable error contract. Every result must include compact text for
compatibility and `structuredContent` conforming to its output schema.

### Context result

A `context` result must include:

| Field | Purpose |
|---|---|
| `context_id` | Stable identifier for delivery, feedback, and later attribution |
| `scope` | Effective tenant/application/project/task/user scope |
| `mode` | `topic`, `continuity`, or `resume` |
| `rendered_context` | Bounded model-ready context |
| `rendered_hash` | Hash of the exact rendered context for delivery verification |
| `items` | Structured nodes, edges, evidence, and source references |
| `retrieval_trace` | Query legs, filters, expansion, ranking, and omissions |
| `budget` | Requested and used tokens/characters/items |
| `freshness` | Relevant timestamps and known staleness indicators |
| `warnings` | Degradation, ambiguity, truncation, or unsupported behavior |

Continuity and resume context must remain task-first and lease-aware. V1 must not
replace the existing authoritative `resume_work` behavior with a recency dump.
Topic context must be query-shaped and bounded; broad graph preloading is not the
default.

### Integration-health resource

M0 exposes `mindgraph://memory/status`. It returns the same profile and health
facts as `mindgraph_memory(status)` and is governed as a graph read. The resource
is diagnostic; client inclusion is optional.

A future bounded context resource may be added after the tool contract is stable.
V1 does not encode arbitrary private user queries into listable resource URIs.

## Portable application event envelope

The envelope is versioned independently of any harness:

```json
{
  "schema_version": "mindgraph.memory.event.v1",
  "event_id": "application-stable-idempotency-key",
  "kind": "tool_completed",
  "occurred_at": "2026-08-31T18:00:00Z",
  "application": { "name": "example-host", "version": "1.2.3" },
  "actor": { "agent_id": "agent:...", "user_ref": "opaque-user-ref" },
  "scope": {
    "repository": "optional-stable-repository-ref",
    "project": "optional-project-ref",
    "task": "optional-task-ref",
    "session": "application-session-ref",
    "turn": "optional-turn-ref"
  },
  "authority": "tool_result",
  "payload": {},
  "evidence_refs": [],
  "privacy": {
    "consent_basis": "configured",
    "content_class": "derived",
    "redaction_version": "scrubber-v1"
  }
}
```

Required event kinds are:

- `session_started`, `session_resumed`, and `session_ended`;
- `context_requested`, `context_delivered`, and `context_feedback` so retrieval
  can be distinguished from actual application injection and later usefulness;
- `user_message_observed` and `assistant_message_observed` when the user has
  authorized text observation;
- `tool_started`, `tool_completed`, and `tool_failed`;
- `task_state_changed`, `decision_recorded`, and `correction_recorded` when the
  host can identify them authoritatively; and
- `boundary` for a checkpoint, compaction, handoff, or clean stop.

A `context_delivered` event must identify the `context_id`, exact rendered hash,
actual injected size, application placement, and any application-side truncation.
If the application cannot verify injection, it reports `delivery_unverified`
rather than treating retrieval as delivery. `context_feedback` may record later
use, omission, correction, or irrelevance without claiming causal task benefit.

Raw message events are optional. A host may instead provide consented, scrubbed,
bounded semantic observations. Tool results, repository state, explicit user
corrections, and server reads have different authority and must not be flattened
into indistinguishable text.

Envelope `authority` is an assertion, not a grant. The server stamps an
`effective_authority` from authenticated adapter provenance and the observed
operation. A model-initiated `observe` call cannot impersonate a tool result, user
correction, or host lifecycle event; absent trusted adapter provenance it is stored
as `model_report` or rejected. Event content is untrusted data, never curator or
compiler instructions.

The adapter must scrub secrets and disallowed paths before an event leaves the
device. The server must validate the envelope again. Unknown fields are retained
only when the declared schema permits them; unknown event kinds are rejected or
quarantined, never silently reinterpreted.

## Scope, identity, and authorization

Every operation resolves the following separately:

1. **tenant authorization**, derived only from the authenticated credential;
2. **application identity**, reported by MCP request metadata and the adapter;
3. **actor identity**, such as a stable MindGraph agent or opaque user reference;
4. **work scope**, such as repository, project, task, session, and turn; and
5. **invocation provenance**, including the application event or explicit tool
   call that caused the operation.

Client metadata and envelope identity are evidence, not authorization. A caller
cannot widen tenant, repository, project, or tool authority by changing them.
Cross-tenant reads, writes, queue records, model batches, logs, and metrics are
forbidden.

Durable sessions are MindGraph graph entities or explicit application handles.
They are not MCP protocol sessions or stdio process lifetimes.

## Curator proposal contract

The curator consumes normalized events and current authorized graph state. It
emits proposals in a model-independent schema:

| Field | Requirement |
|---|---|
| `proposal_id` | Stable, unique, and auditable |
| `policy_version` | Curator family, checkpoint, prompt, and contract versions |
| `event_refs` | Events and boundaries that support the proposal |
| `operation` | `create`, `update`, `relate`, `supersede`, `close`, `delete`, or `noop` |
| `target` | Logical identity plus optional current UID and expected version |
| `payload` | High-level semantic state, never raw database commands |
| `evidence_refs` | Exact supporting observations or graph records |
| `scope` | Effective authorized work scope |
| `confidence` | Calibrated proposal confidence |
| `reason_code` | Bounded machine-readable rationale category |
| `created_at` | Proposal timestamp |

The policy may recommend only semantic actions from its versioned allowlist. It
must not emit arbitrary MCP calls, database queries, tenant identifiers, or
authorization decisions.

`NOOP` is a first-class result. Harmful writes, missed required writes, needless
writes, and incorrect abstentions are all measured.

## Deterministic compiler and mutation boundary

The compiler owns:

- schema and action legality;
- current-state lookup and logical identity resolution;
- evidence and provenance requirements;
- tenant and work-scope enforcement;
- optimistic version and lease/fencing checks;
- idempotency and replay protection;
- allowlisted graph-operation construction;
- dry-run rendering;
- journal creation and reversibility; and
- rejection reasons suitable for audit and policy feedback.

No curator proposal mutates the graph directly. A proposal can be `shadow`,
`pending_review`, `accepted`, `rejected`, `applied`, `reverted`, or `expired`.
State transitions are server-owned and auditable.

Autonomous curator mutation requires a dedicated principal with least privilege.
Governance capability is mandatory and fail-closed for that principal. A generic
compatibility fallback that allows calls when governance is unsupported is not
permitted on the curator path.

## Policy registry and promotion

Every runnable curator policy must have an immutable registry record containing:

- model/checkpoint identity and artifact hash or signed provider reference;
- event, proposal, compiler, and prompt contract versions;
- training-data lineage and consent class;
- frozen evaluation references and measured regression bands;
- supported application/profile scope;
- lifecycle-cost measurements;
- promotion state: `development`, `shadow`, `canary`, `production`, or `retired`;
  and
- an explicit rollback target.

Mutable model aliases, local training manifests, or unversioned prompts are not
deployable policy identities. Promotion is a governed registry transition, not a
worker configuration edit.

## Runtime and failure behavior

The runtime is asynchronous:

```text
application adapter
  -> local scrub and bounded event envelope
  -> durable tenant-scoped outbox/ingest
  -> resident curator worker
  -> semantic proposal
  -> deterministic compiler and governance
  -> shadow ledger or reversible graph mutation
  -> bounded context on a later application request
```

No curator inference runs synchronously in a host hook, stdio request lifecycle,
or session-end cleanup path. The application path enqueues within its budget and
continues.

The runtime must provide:

- ordered processing within a declared scope;
- idempotent ingest and proposal compilation;
- bounded retries with backoff;
- dead-letter quarantine and replay;
- queue age, throughput, error, cost, and model-version metrics;
- visible profile degradation when capture or delivery is unhealthy;
- per-tenant rate and spend limits; and
- a global and per-tenant kill switch.

An absent or late end event cannot be required for correctness. Clean boundaries
improve distillation, but recovery must tolerate host termination.

## Privacy, consent, and retention

- Hosts must obtain consent before exposing user content to MindGraph.
- Adapters default to the minimum event content needed for the selected profile.
- Secrets, credentials, disallowed files, and configured sensitive classes are
  scrubbed before transmission and rejected if detected server-side.
- Raw content, derived events, proposals, graph mutations, and audit records have
  separately configurable retention.
- Deletion and correction must propagate through queued events, proposals,
  generated views, caches, and graph records where legally and technically
  required.
- Tenant content never enters shared model weights. Training export requires a
  separate consented, reviewed, scrubbed, and lineage-preserving process.

## Conformance and acceptance

### Protocol conformance

M0 must pass:

- supported-client discovery and invocation through MCP Inspector and the named
  client compatibility matrix;
- deterministic, schema-valid tool/resource catalogs;
- output-schema and `structuredContent` validation;
- governance parity between equivalent resource and tool reads;
- tool-selection evaluations covering retrieval, write, correction, abstention,
  and error recovery;
- bounded output and pagination tests; and
- explicit status for every unsupported higher-profile capability.

M1 must additionally pass:

- cross-application envelope fixtures;
- idempotent replay, reordering, retry, partial-delivery, and abrupt-stop tests;
- client-side and server-side secret/redaction tests;
- context-budget and scope-isolation tests;
- exact rendered-context hash, injection accounting, and unverified-delivery
  tests;
- authoritative `resume_work` compatibility; and
- proof that capture failure does not block the host interaction.

M2 must additionally pass:

- frozen shadow comparisons against reviewed proposals;
- precision, required-write recall, harmful-write, unnecessary-write, and
  abstention thresholds;
- deterministic compiler validity and rejection tests;
- cross-tenant isolation and adversarial identity tests;
- prompt-injection and forged-authority tests across message and tool-result
  events;
- correction, deletion, rollback, and model-regression drills;
- bounded latency and lifecycle cost; and
- canary evidence with no unacceptable established-capability regression.

### Product acceptance

Protocol conformance does not establish memory utility. Each named
application/version requires a natural-mode comparison using the same tasks,
reasoner, budgets, and application configuration:

- unmodified native application memory; versus
- the same application plus the claimed MindGraph integration profile.

Restart-readiness is supporting evidence. Only executable-continuation tasks with
checkable outcomes can establish less rework or better completion. Results do not
transfer silently to a different application, adapter, host model, curator, or
version.

## Implementation plan

### Batch A: Freeze the portable contract

**Owner:** `mindgraph-mcp`, with SDK/cloud review.

- approve this profile and the separated read/event/proposal tool boundaries;
- publish JSON Schemas for events, results, and proposals;
- define profile/status degradation codes;
- produce the MCP 2026-07-28 SDK and named-client compatibility matrix;
- freeze cross-application fixture examples; and
- add a conformance-test skeleton.

**Exit gate:** schemas and semantics are reviewable without a curator checkpoint or
application-specific hook.

### Batch B: Improve the M0 portable baseline

**Owner:** `mindgraph-mcp`.

- implement `mindgraph_memory(status|context)`;
- add `mindgraph://memory/status`;
- add output schemas and structured content to the new surface;
- simplify server instructions around the orient-answer-preserve workflow;
- add tool-selection, bounded-output, governance, and client compatibility tests;
  and
- document exactly what remains model- or application-discretionary.

**Exit gate:** a generic supported MCP client can discover, retrieve, and inspect
MindGraph memory without custom hooks, with no claim of automatic capture.

### Batch C: Implement M1 capture and shadow plumbing

**Owners:** `mindgraph-mcp`, `mindgraph-ts`, and `mindgraph-cloud`.

- implement separate `mindgraph_observe(observe|checkpoint)` actions against a
  durable idempotent ingest API;
- build Claude, Codex, and one generic reference adapter against the same event
  fixtures;
- add local scrubbing, bounded outbox, retries, and visible degradation;
- persist tenant-scoped events and processing status;
- implement shadow proposal storage and read-only `mindgraph_proposals`
  inspection with no graph mutation; and
- run reliability, privacy, scope, latency, and cost acceptance.

**Exit gate:** supported adapters deliver the same normalized contract and shadow
processing cannot mutate the graph.

### Batch D: Qualify an improved curator

**Owner:** `mindgraph-cognitive-rl`, with compiler fixtures supplied by product
repositories.

- complete the action-value signal and lineage audit;
- run the approved compute-matched fine-grained-credit comparison if powered;
- test realistic application holdouts and established capability retention;
- freeze the selected checkpoint, policy contract, and evaluation references; and
- register the candidate without promoting it to mutation.

**Exit gate:** one candidate clears precommitted shadow thresholds and regression
bands. Training loss or reward agreement alone is insufficient.

### Batch E: Deterministic compiler and reversible canary

**Owners:** `mindgraph-rs`, `mindgraph-cloud`, `mindgraph-mcp`, and dashboard.

- implement the compiler, dedicated principal, fail-closed governance, audit, and
  rollback path;
- expose reviewed proposal state and integration health;
- run internal shadow, then explicitly approved reversible canaries; and
- exercise correction, deletion, pause, rollback, and tenant-isolation drills.

**Exit gate:** canary and rollback evidence passes. Default autonomous mutation
remains off.

### Batch F: Application qualification and promotion

**Owners:** product and research repositories.

- run restart-readiness and executable-continuation tests for each named
  application/version;
- compare against its unmodified native memory at matched budgets;
- account for capture, inference, retrieval, storage, latency, and failure costs;
- publish a bounded claim for the qualified profile only; and
- establish drift requalification and rollback cadence.

**Exit gate:** only a passing named application/version may advertise managed
memory or improved continuation.

## First delivery slice

The next engineering batch is **A -> B -> capture-only portions of C**, while the
curator action-credit audit proceeds independently.

This slice may create events, outbox records, processing status, and shadow
proposals. It must not allow curator-generated graph mutation. It improves the
portable MCP baseline immediately and creates the application-independent evidence
path required to qualify a later curator.

## Decisions fixed by V1

- The public product contract is memory integration, not a particular curator.
- The graph is the durable source of truth; generated views are compatibility
  products, not competing memory stores.
- Standard MCP is the M0 baseline; automatic behavior requires an explicit M1/M2
  application contract.
- The M0 `mindgraph_memory` tool stays read-only; M1 event ingestion and M2
  proposal inspection use separately annotated tools.
- Application events and curator actions are separately versioned and portable.
- Context delivery is bounded, query-shaped, and task/lease-aware.
- Capture and curation are asynchronous.
- Curator output is a proposal; deterministic governed code owns mutation.
- Server-side execution comes first; a local sidecar remains a later portable
  privacy tier.
- Product claims are profile-, application-, and version-specific.

## Open decisions before Batch C

- Minimum raw-text observation, if any, needed by the first non-coding reference
  adapter.
- Default context budgets by host class and how adapters report actual injection.
- Retention defaults for raw events, derived events, proposals, and audit records.
- Initial named applications beyond Claude Code and Codex for ecological
  qualification.
- Whether repeated third-party adapter demand justifies a formal MCP extension
  after the core-tool contract proves stable.

## Related material

- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [Curator research roadmap](https://github.com/shuruheel/mindgraph-cognitive-rl/blob/main/docs/ROADMAP.md)
- [Post-Design-B architecture](https://github.com/shuruheel/mindgraph-cognitive-rl/blob/main/docs/plans/ARCHITECTURE-POST-DESIGNB.md)
- [Fine-grained curator credit pilot](https://github.com/shuruheel/mindgraph-cognitive-rl/blob/main/docs/plans/FINE-GRAINED-CURATOR-CREDIT-V1.md)
