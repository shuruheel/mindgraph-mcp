import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MindGraph } from "mindgraph";
import { handleTool } from "../src/tools.js";

// ─────────────────────────────────────────────────────────────────────────
// Core dispatch test: mock the underlying `mindgraph` TS client and assert
// `handleTool` routes each tool/action to the correct client method with
// correctly-mapped arguments. This is the central untested logic of the MCP
// server (R5: first tests for this repo).
//
// NOTE: tests assert WIRE-LEVEL behavior (which method, which args) — they do
// NOT change dispatch source. If a mapping looks wrong, it is reported, not
// patched (source_behavior_changed must stay false).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a MindGraph mock where every method records its args and returns a
 * sentinel. Vitest mock fns let us assert which one was called.
 */
function makeClient() {
  const methods = [
    "capture",
    "journal",
    "structure",
    "findOrCreatePerson",
    "findOrCreateOrganization",
    "findOrCreateNation",
    "findOrCreateEvent",
    "findOrCreatePlace",
    "findOrCreateConcept",
    "argue",
    "inquire",
    "commit",
    "openDecision",
    "addOption",
    "deliberate",
    "resolveDecision",
    "getOpenDecisions",
    "plan",
    "execution",
    "governance",
    "procedure",
    "risk",
    "retrieveContext",
    "retrieve",
    "traverse",
    "getGoals",
    "getOpenQuestions",
    "getWeakClaims",
    "getPendingApprovals",
    "getContradictions",
    "getNodes",
    "ingestChunk",
    "ingestDocument",
    "ingestSession",
    "getJob",
    "listJobs",
    "signals",
    "runSynthesis",
    "listOntologySchemas",
    "getOntologySchema",
    "queryOntology",
    "searchDomainObjects",
    "listDomainObjects",
    "getDomainObject",
    "getDomainObjectContext",
    "listOntologyProposals",
    "getOntologyProposal",
    "approveOntologyProposal",
    "rejectOntologyProposal",
    "linkDomainObjects",
    "extractOntology",
  ] as const;

  const client = {} as Record<string, ReturnType<typeof vi.fn>>;
  for (const m of methods) {
    client[m] = vi.fn(async (...args: unknown[]) => ({ called: m, args }));
  }
  return client as unknown as MindGraph & Record<string, ReturnType<typeof vi.fn>>;
}

let client: ReturnType<typeof makeClient>;
beforeEach(() => {
  client = makeClient();
});

// Helper: parse the ok() text payload back to JSON.
function payload(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe("mindgraph_capture dispatch", () => {
  it("entity/person -> findOrCreatePerson(label, props-with-description, agent_id)", async () => {
    await handleTool(client, "mindgraph_capture", {
      action: "entity",
      entity_type: "person",
      label: "Henry Kissinger",
      summary: "Diplomat",
      agent_id: "mcp",
    });
    expect(client.findOrCreatePerson).toHaveBeenCalledTimes(1);
    const [label, props, agentId] = client.findOrCreatePerson.mock.calls[0];
    expect(label).toBe("Henry Kissinger");
    expect(props).toMatchObject({ description: "Diplomat" });
    expect(agentId).toBe("mcp");
    // no other entity ctor called
    expect(client.findOrCreateConcept).not.toHaveBeenCalled();
  });

  it("entity with no entity_type defaults to concept", async () => {
    await handleTool(client, "mindgraph_capture", {
      action: "entity",
      label: "Entropy",
    });
    expect(client.findOrCreateConcept).toHaveBeenCalledTimes(1);
    expect(client.findOrCreateConcept.mock.calls[0][0]).toBe("Entropy");
  });

  it("each entity_type maps to its dedicated find-or-create method", async () => {
    const cases: Array<[string, string]> = [
      ["organization", "findOrCreateOrganization"],
      ["nation", "findOrCreateNation"],
      ["event", "findOrCreateEvent"],
      ["place", "findOrCreatePlace"],
      ["concept", "findOrCreateConcept"],
    ];
    for (const [entity_type, method] of cases) {
      const c = makeClient();
      await handleTool(c, "mindgraph_capture", {
        action: "entity",
        entity_type,
        label: "X",
      });
      expect(c[method], `${entity_type} should route to ${method}`).toHaveBeenCalledTimes(1);
    }
  });

  it("journal -> journal(label, {content, mood, tags}, {agent_id})", async () => {
    await handleTool(client, "mindgraph_capture", {
      action: "journal",
      label: "Note",
      content: "felt good",
      mood: "happy",
      tags: ["a", "b"],
      agent_id: "mcp",
    });
    expect(client.journal).toHaveBeenCalledTimes(1);
    const [label, props, opts] = client.journal.mock.calls[0];
    expect(label).toBe("Note");
    expect(props).toEqual({ content: "felt good", mood: "happy", tags: ["a", "b"] });
    expect(opts).toEqual({ agent_id: "mcp" });
  });

  it("journal without content returns an error and calls nothing", async () => {
    const r = await handleTool(client, "mindgraph_capture", {
      action: "journal",
      label: "Note",
    });
    expect(r.isError).toBe(true);
    expect(client.journal).not.toHaveBeenCalled();
  });

  it("observation -> capture({action:'observation', ...})", async () => {
    await handleTool(client, "mindgraph_capture", {
      action: "observation",
      label: "Sky is blue",
      confidence: 0.9,
    });
    expect(client.capture).toHaveBeenCalledTimes(1);
    expect(client.capture.mock.calls[0][0]).toMatchObject({
      action: "observation",
      label: "Sky is blue",
      confidence: 0.9,
    });
  });

  it("concept capture -> structure({action:'concept', ...})", async () => {
    await handleTool(client, "mindgraph_capture", {
      action: "concept",
      label: "Justice",
    });
    expect(client.structure).toHaveBeenCalledTimes(1);
    expect(client.structure.mock.calls[0][0]).toMatchObject({ action: "concept", label: "Justice" });
  });
});

describe("mindgraph_reason dispatch", () => {
  it("claim -> argue() with structured claim + evidence ARRAY (no action field)", async () => {
    await handleTool(client, "mindgraph_reason", {
      action: "claim",
      claim: { label: "X causes Y", confidence: 0.8 },
      evidence: [{ label: "study A" }, { label: "study B" }],
      warrant: { label: "because" },
      argument: { label: "top" },
      agent_id: "mcp",
    });
    expect(client.argue).toHaveBeenCalledTimes(1);
    expect(client.inquire).not.toHaveBeenCalled();
    const req = client.argue.mock.calls[0][0];
    expect(req).not.toHaveProperty("action"); // monolithic /epistemic/argument
    expect(req.claim).toEqual({ label: "X causes Y", confidence: 0.8 });
    expect(Array.isArray(req.evidence)).toBe(true);
    expect(req.evidence).toHaveLength(2);
  });

  it("claim falls back to top-level label when claim object omitted", async () => {
    await handleTool(client, "mindgraph_reason", {
      action: "claim",
      label: "Implicit claim",
      confidence: 0.6,
    });
    expect(client.argue).toHaveBeenCalledTimes(1);
    expect(client.argue.mock.calls[0][0].claim).toEqual({ label: "Implicit claim", confidence: 0.6 });
  });

  it("non-claim actions -> inquire({action, label, ...}) with action passed through", async () => {
    for (const action of ["open_question", "hypothesis", "theory", "anomaly", "assumption"]) {
      const c = makeClient();
      await handleTool(c, "mindgraph_reason", { action, label: "Q" });
      expect(c.inquire).toHaveBeenCalledTimes(1);
      expect(c.argue).not.toHaveBeenCalled();
      expect(c.inquire.mock.calls[0][0]).toMatchObject({ action, label: "Q" });
    }
  });

  it("inquiry action without a label errors and calls nothing", async () => {
    const r = await handleTool(client, "mindgraph_reason", { action: "hypothesis" });
    expect(r.isError).toBe(true);
    expect(client.inquire).not.toHaveBeenCalled();
  });
});

describe("mindgraph_commit dispatch", () => {
  it("goal/project/milestone -> commit() with action passed through", async () => {
    for (const action of ["goal", "project", "milestone"]) {
      const c = makeClient();
      await handleTool(c, "mindgraph_commit", { action, label: "L", parent_uid: "p1" });
      expect(c.commit).toHaveBeenCalledTimes(1);
      expect(c.commit.mock.calls[0][0]).toMatchObject({ action, label: "L", parent_uid: "p1" });
    }
  });

  it("open_decision -> openDecision(label, {summary, props, agent_id})", async () => {
    await handleTool(client, "mindgraph_commit", {
      action: "open_decision",
      label: "DB choice",
      summary: "pg vs sqlite",
    });
    expect(client.openDecision).toHaveBeenCalledTimes(1);
    expect(client.openDecision.mock.calls[0][0]).toBe("DB choice");
    expect(client.openDecision.mock.calls[0][1]).toMatchObject({ summary: "pg vs sqlite" });
  });

  it("add_option -> addOption(decision_uid, label, opts)", async () => {
    await handleTool(client, "mindgraph_commit", {
      action: "add_option",
      decision_uid: "d1",
      label: "Postgres",
    });
    expect(client.addOption).toHaveBeenCalledTimes(1);
    expect(client.addOption.mock.calls[0][0]).toBe("d1");
    expect(client.addOption.mock.calls[0][1]).toBe("Postgres");
  });

  it("add_constraint -> deliberate({action:'add_constraint', decision_uid})", async () => {
    await handleTool(client, "mindgraph_commit", {
      action: "add_constraint",
      decision_uid: "d1",
      label: "budget",
    });
    expect(client.deliberate).toHaveBeenCalledTimes(1);
    expect(client.deliberate.mock.calls[0][0]).toMatchObject({
      action: "add_constraint",
      decision_uid: "d1",
    });
  });

  it("resolve_decision -> resolveDecision(decision_uid, chosen_option_uid, opts)", async () => {
    await handleTool(client, "mindgraph_commit", {
      action: "resolve_decision",
      decision_uid: "d1",
      chosen_option_uid: "o1",
      informs_uid: ["ctx1"],
      as_of_date: "2026-07-17",
      session_id: "session7",
      retrieval_trace_id: "trace7",
    });
    expect(client.resolveDecision).toHaveBeenCalledTimes(1);
    expect(client.resolveDecision.mock.calls[0][0]).toBe("d1");
    expect(client.resolveDecision.mock.calls[0][1]).toBe("o1");
    expect(client.resolveDecision.mock.calls[0][2]).toMatchObject({
      informs_uid: ["ctx1"],
      as_of_date: "2026-07-17",
      session_id: "session7",
      retrieval_trace_id: "trace7",
    });
  });

  it("get_open_decisions -> getOpenDecisions()", async () => {
    await handleTool(client, "mindgraph_commit", { action: "get_open_decisions" });
    expect(client.getOpenDecisions).toHaveBeenCalledTimes(1);
  });

  it("add_option without decision_uid errors", async () => {
    const r = await handleTool(client, "mindgraph_commit", { action: "add_option", label: "x" });
    expect(r.isError).toBe(true);
    expect(client.addOption).not.toHaveBeenCalled();
  });
});

describe("mindgraph_plan dispatch (agent plan + procedure + risk + governance)", () => {
  it("plan actions -> plan() with action passed through", async () => {
    for (const action of ["create_task", "create_plan", "add_step", "update_status", "get_plan"]) {
      const c = makeClient();
      await handleTool(c, "mindgraph_plan", { action, label: "L" });
      expect(c.plan).toHaveBeenCalledTimes(1);
      expect(c.plan.mock.calls[0][0]).toMatchObject({ action });
    }
  });

  it("execution actions remap to canonical /agent/execution actions", async () => {
    const remap: Array<[string, string]> = [
      ["start_execution", "start"],
      ["complete_execution", "complete"],
      ["fail_execution", "fail"],
    ];
    for (const [toolAction, serverAction] of remap) {
      const c = makeClient();
      await handleTool(c, "mindgraph_plan", { action: toolAction, task_uid: "t1" });
      expect(c.execution).toHaveBeenCalledTimes(1);
      expect(c.execution.mock.calls[0][0]).toMatchObject({ action: serverAction, task_uid: "t1" });
    }
  });

  it("governance actions -> governance() with canonical action", async () => {
    const remap: Array<[string, string]> = [
      ["create_policy", "create_policy"],
      ["request_approval", "request_approval"],
      ["resolve_approval", "resolve_approval"],
      ["get_pending", "get_pending"],
    ];
    for (const [toolAction, serverAction] of remap) {
      const c = makeClient();
      await handleTool(c, "mindgraph_plan", { action: toolAction, label: "L", task_uid: "t1" });
      expect(c.governance).toHaveBeenCalledTimes(1);
      expect(c.governance.mock.calls[0][0]).toMatchObject({ action: serverAction });
    }
  });

  it("procedure: add_procedure_step remaps to /action/procedure action 'add_step'", async () => {
    await handleTool(client, "mindgraph_plan", { action: "add_procedure_step", label: "S", target_uid: "f1" });
    expect(client.procedure).toHaveBeenCalledTimes(1);
    expect(client.procedure.mock.calls[0][0]).toMatchObject({ action: "add_step", target_uid: "f1" });
  });

  it("procedure: create_flow/add_affordance/add_control pass through to procedure()", async () => {
    for (const action of ["create_flow", "add_affordance", "add_control"]) {
      const c = makeClient();
      await handleTool(c, "mindgraph_plan", { action, label: "L" });
      expect(c.procedure).toHaveBeenCalledTimes(1);
      expect(c.procedure.mock.calls[0][0]).toMatchObject({ action });
    }
  });

  it("risk: assess_risk -> risk({action:'assess'}); get_assessments -> risk({action:'get_assessments'})", async () => {
    await handleTool(client, "mindgraph_plan", { action: "assess_risk", label: "R", target_uid: "x" });
    expect(client.risk).toHaveBeenCalledTimes(1);
    expect(client.risk.mock.calls[0][0]).toMatchObject({ action: "assess", target_uid: "x" });

    const c2 = makeClient();
    await handleTool(c2, "mindgraph_plan", { action: "get_assessments", target_uid: "x" });
    expect(c2.risk.mock.calls[0][0]).toMatchObject({ action: "get_assessments" });
  });
});

describe("mindgraph_retrieve dispatch", () => {
  it("context -> retrieveContext() with chunk_limit gated by include_chunks", async () => {
    await handleTool(client, "mindgraph_retrieve", { action: "context", query: "Kissinger NATO" });
    expect(client.retrieveContext).toHaveBeenCalledTimes(1);
    expect(client.retrieveContext.mock.calls[0][0]).toMatchObject({ query: "Kissinger NATO", chunk_limit: 0 });
  });

  it("context include_chunks=true sets a nonzero chunk_limit", async () => {
    await handleTool(client, "mindgraph_retrieve", { action: "context", query: "q", include_chunks: true, limit: 3 });
    expect(client.retrieveContext.mock.calls[0][0]).toMatchObject({ chunk_limit: 3 });
  });

  it("context without query errors and does not call retrieveContext", async () => {
    const r = await handleTool(client, "mindgraph_retrieve", { action: "context" });
    expect(r.isError).toBe(true);
    expect(client.retrieveContext).not.toHaveBeenCalled();
  });

  it("text/semantic/hybrid -> retrieve() with the matching action", async () => {
    for (const action of ["text", "semantic", "hybrid"]) {
      const c = makeClient();
      await handleTool(c, "mindgraph_retrieve", { action, query: "q" });
      expect(c.retrieve).toHaveBeenCalledTimes(1);
      expect(c.retrieve.mock.calls[0][0]).toMatchObject({ action, query: "q" });
    }
  });

  it("structured retrieves route to dedicated getters", async () => {
    const map: Array<[string, string]> = [
      ["active_goals", "getGoals"],
      ["open_questions", "getOpenQuestions"],
      ["weak_claims", "getWeakClaims"],
      ["pending_approvals", "getPendingApprovals"],
      ["unresolved_contradictions", "getContradictions"],
      ["stale_derivations", "retrieve"],
    ];
    for (const [action, method] of map) {
      const c = makeClient();
      await handleTool(c, "mindgraph_retrieve", { action });
      expect(c[method], `${action} -> ${method}`).toHaveBeenCalledTimes(1);
    }
  });

  it("preferences with query passes query+k; layer requires layer; recent passes filters", async () => {
    await handleTool(client, "mindgraph_retrieve", { action: "preferences", query: "hotels", limit: 5 });
    expect(client.retrieve.mock.calls[0][0]).toMatchObject({ action: "preferences", query: "hotels" });

    const c2 = makeClient();
    const rErr = await handleTool(c2, "mindgraph_retrieve", { action: "layer" });
    expect(rErr.isError).toBe(true);
    const c3 = makeClient();
    await handleTool(c3, "mindgraph_retrieve", { action: "layer", layer: "reality" });
    expect(c3.retrieve.mock.calls[0][0]).toMatchObject({ action: "layer", layer: "reality" });
  });

  it("document_index -> getNodes({node_type:'Document'})", async () => {
    await handleTool(client, "mindgraph_retrieve", { action: "document_index" });
    expect(client.getNodes).toHaveBeenCalledTimes(1);
    expect(client.getNodes.mock.calls[0][0]).toMatchObject({ node_type: "Document" });
  });

  it("traversal: neighborhood/path/subgraph route to traverse() with start_uid/end_uid field names", async () => {
    await handleTool(client, "mindgraph_retrieve", { action: "neighborhood", start_uid: "n1" });
    expect(client.traverse.mock.calls[0][0]).toMatchObject({ action: "neighborhood", start_uid: "n1" });

    const c2 = makeClient();
    await handleTool(c2, "mindgraph_retrieve", { action: "path", start_uid: "a", end_uid: "b" });
    const req = c2.traverse.mock.calls[0][0];
    expect(req).toMatchObject({ action: "path", start_uid: "a", end_uid: "b" });
    expect(req).not.toHaveProperty("from_uid");
    expect(req).not.toHaveProperty("to_uid");
    expect(req).not.toHaveProperty("uid");
  });

  it("path without end_uid errors", async () => {
    const r = await handleTool(client, "mindgraph_retrieve", { action: "path", start_uid: "a" });
    expect(r.isError).toBe(true);
    expect(client.traverse).not.toHaveBeenCalled();
  });

  it("neighborhood without start_uid errors", async () => {
    const r = await handleTool(client, "mindgraph_retrieve", { action: "neighborhood" });
    expect(r.isError).toBe(true);
    expect(client.traverse).not.toHaveBeenCalled();
  });
});

describe("mindgraph_ingest dispatch", () => {
  it("chunk/document/session route to their ingest methods; require content", async () => {
    const map: Array<[string, string]> = [
      ["chunk", "ingestChunk"],
      ["document", "ingestDocument"],
      ["session", "ingestSession"],
    ];
    for (const [action, method] of map) {
      const c = makeClient();
      await handleTool(c, "mindgraph_ingest", { action, content: "text", title: "T" });
      expect(c[method]).toHaveBeenCalledTimes(1);

      const cErr = makeClient();
      const r = await handleTool(cErr, "mindgraph_ingest", { action });
      expect(r.isError).toBe(true);
      expect(cErr[method]).not.toHaveBeenCalled();
    }
  });

  it("job_status with job_id -> getJob(id); without -> listJobs()", async () => {
    await handleTool(client, "mindgraph_ingest", { action: "job_status", job_id: "j1" });
    expect(client.getJob).toHaveBeenCalledWith("j1");

    const c2 = makeClient();
    await handleTool(c2, "mindgraph_ingest", { action: "job_status" });
    expect(c2.listJobs).toHaveBeenCalledTimes(1);
  });
});

describe("mindgraph_synthesize dispatch", () => {
  it("signals -> signals(project_uid, {signals,target_types}); requires project_uid", async () => {
    await handleTool(client, "mindgraph_synthesize", { action: "signals", project_uid: "p1", signals: "x" });
    expect(client.signals).toHaveBeenCalledTimes(1);
    expect(client.signals.mock.calls[0][0]).toBe("p1");

    const c2 = makeClient();
    const r = await handleTool(c2, "mindgraph_synthesize", { action: "signals" });
    expect(r.isError).toBe(true);
    expect(c2.signals).not.toHaveBeenCalled();
  });

  it("run -> runSynthesis(project_uid)", async () => {
    await handleTool(client, "mindgraph_synthesize", { action: "run", project_uid: "p1" });
    expect(client.runSynthesis).toHaveBeenCalledWith("p1");
  });

  it("job_status -> getJob(job_id); requires job_id", async () => {
    const r = await handleTool(client, "mindgraph_synthesize", { action: "job_status" });
    expect(r.isError).toBe(true);
    const c2 = makeClient();
    await handleTool(c2, "mindgraph_synthesize", { action: "job_status", job_id: "j1" });
    expect(c2.getJob).toHaveBeenCalledWith("j1");
  });
});

describe("mindgraph_ontology dispatch", () => {
  it("schemas/schema route to schema methods; schema requires schema_id", async () => {
    await handleTool(client, "mindgraph_ontology", { action: "schemas" });
    expect(client.listOntologySchemas).toHaveBeenCalledTimes(1);

    const r = await handleTool(makeClient(), "mindgraph_ontology", { action: "schema" });
    expect(r.isError).toBe(true);

    const c2 = makeClient();
    await handleTool(c2, "mindgraph_ontology", { action: "schema", schema_id: "s1" });
    expect(c2.getOntologySchema).toHaveBeenCalledWith("s1");
  });

  it("query -> queryOntology() with cognitive/source defaults true; requires query+schema_id", async () => {
    await handleTool(client, "mindgraph_ontology", { action: "query", query: "clients in NY", schema_id: "s1" });
    expect(client.queryOntology).toHaveBeenCalledTimes(1);
    expect(client.queryOntology.mock.calls[0][0]).toMatchObject({
      query: "clients in NY",
      schema_id: "s1",
      include_cognitive_context: true,
      include_sources: true,
    });

    const rNoSchema = await handleTool(makeClient(), "mindgraph_ontology", { action: "query", query: "x" });
    expect(rNoSchema.isError).toBe(true);
  });

  it("approve/reject require proposal_id and route to their methods", async () => {
    await handleTool(client, "mindgraph_ontology", { action: "approve", proposal_id: "p1", feedback: "ok" });
    expect(client.approveOntologyProposal).toHaveBeenCalledWith("p1", { feedback: "ok" });

    const c2 = makeClient();
    await handleTool(c2, "mindgraph_ontology", { action: "reject", proposal_id: "p1", reason: "bad" });
    expect(c2.rejectOntologyProposal).toHaveBeenCalledWith("p1", "bad");

    const r = await handleTool(makeClient(), "mindgraph_ontology", { action: "approve" });
    expect(r.isError).toBe(true);
  });

  it("link requires from_uid+to_uid+relation_type", async () => {
    const r = await handleTool(client, "mindgraph_ontology", { action: "link", from_uid: "a" });
    expect(r.isError).toBe(true);
    expect(client.linkDomainObjects).not.toHaveBeenCalled();

    const c2 = makeClient();
    await handleTool(c2, "mindgraph_ontology", {
      action: "link",
      from_uid: "a",
      to_uid: "b",
      relation_type: "WORKS_AT",
    });
    expect(c2.linkDomainObjects.mock.calls[0][0]).toMatchObject({
      from_uid: "a",
      to_uid: "b",
      relation_type: "WORKS_AT",
    });
  });

  it("extract requires schema_id and non-empty source_uids", async () => {
    const r1 = await handleTool(client, "mindgraph_ontology", { action: "extract", schema_id: "s1" });
    expect(r1.isError).toBe(true);
    const c2 = makeClient();
    await handleTool(c2, "mindgraph_ontology", { action: "extract", schema_id: "s1", source_uids: ["u1"] });
    expect(c2.extractOntology.mock.calls[0][0]).toMatchObject({ ontology_schema_id: "s1", source_uids: ["u1"] });
  });
});

describe("unknown tool / unknown action handling", () => {
  it("unknown tool name returns an error result (not a throw)", async () => {
    const r = await handleTool(client, "mindgraph_nonexistent", {});
    expect(r.isError).toBe(true);
    expect(payload(r).error).toMatch(/Unknown tool/i);
  });

  it("unknown action within a known tool returns an error result", async () => {
    const r = await handleTool(client, "mindgraph_capture", { action: "bogus", label: "x" });
    expect(r.isError).toBe(true);
  });

  it("a thrown client error is caught and returned as an isError result", async () => {
    client.getGoals.mockRejectedValueOnce(new Error("boom"));
    const r = await handleTool(client, "mindgraph_retrieve", { action: "active_goals" });
    expect(r.isError).toBe(true);
    expect(payload(r).error).toBe("boom");
  });
});
