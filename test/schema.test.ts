import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/tools.js";
import {
  RETRIEVE_ACTIONS,
  ENDPOINT_ACTIONS,
  FIELD_NAME_CONVENTIONS,
  LESSON_CAPTURE_CONTRACT,
  WORK_ACTION_CONTRACT,
} from "./contract.fixture.js";

// ─────────────────────────────────────────────────────────────────────────
// KNOWN R4 DIVERGENCES — documented, owner-decision-pending breaking changes.
//
// These are recorded so they do NOT fail CI but remain explicit; any NEW
// undocumented drift DOES fail. Source: docs/plans/collaborator-readiness-
// refactors.md (R4 section). See the StructuredOutput "divergences_documented".
// ─────────────────────────────────────────────────────────────────────────
const KNOWN_DIVERGENCES = {
  // R4 #3: the MCP `mindgraph_retrieve` action enum inherits the TS SDK's
  // RetrieveRequest.action type, which omits these two server-valid actions.
  retrieveMissingActions: ["merge_candidates", "curation_counts"] as const,
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  required?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
};

function toolByName(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

function actionEnum(name: string): string[] {
  const schema = toolByName(name).inputSchema as JsonSchema;
  const enumVals = schema.properties?.action?.enum;
  if (!Array.isArray(enumVals)) throw new Error(`${name} has no action enum`);
  return enumVals as string[];
}

describe("generated tool schemas — structural sanity", () => {
  it("every tool has a non-empty name, description, and object inputSchema", () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const t of TOOLS) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect((t.description as string).length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
      expect((t.inputSchema as JsonSchema).type).toBe("object");
      expect((t.inputSchema as JsonSchema).properties).toBeTruthy();
    }
  });

  it("tool names are unique", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("publishes ingest chunk controls in server units and bounds", () => {
    const props = (toolByName("mindgraph_ingest").inputSchema as JsonSchema)
      .properties!;
    expect(props.chunk_size).toMatchObject({
      type: "integer",
      minimum: 50,
      maximum: 32_000,
      default: 2_000,
    });
    expect(props.chunk_overlap).toMatchObject({
      minimum: 0,
      maximum: 0.9,
      default: 0.1,
    });
    expect(props.chunk_size.description).toContain("tokens");
    expect(props.chunk_overlap.description).toContain("Fractional");
  });

  it("exposes the expected 9 static cognitive tools", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const expected of [
      "mindgraph_capture",
      "mindgraph_reason",
      "mindgraph_commit",
      "mindgraph_plan",
      "mindgraph_retrieve",
      "mindgraph_series_query",
      "mindgraph_ingest",
      "mindgraph_synthesize",
      "mindgraph_ontology",
      "mindgraph_code",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});

describe("retrieve action enum vs canonical contract", () => {
  const enumVals = actionEnum("mindgraph_retrieve");

  it("every retrieve enum value that maps to a /retrieve action is canonical", () => {
    // The MCP retrieve tool folds /traverse + retrieveContext + document_index
    // into one tool, so it carries extra non-/retrieve actions. Of the values
    // that ARE canonical /retrieve actions, none may be invalid.
    const canonicalRetrieve = new Set<string>(RETRIEVE_ACTIONS);
    // Actions handled by other endpoints (traverse) or special-cased (context,
    // document_index) — legitimately present in the MCP tool, not /retrieve.
    const nonRetrieveButValid = new Set([
      "context", // -> retrieveContext()
      "document_index", // -> getNodes(node_type=Document)
      "chain",
      "neighborhood",
      "path",
      "subgraph",
      "top_k_paths", // -> traverse()
    ]);
    for (const v of enumVals) {
      if (nonRetrieveButValid.has(v)) continue;
      expect(
        canonicalRetrieve.has(v),
        `retrieve enum value "${v}" is neither a canonical /retrieve action nor a known traverse/context action`,
      ).toBe(true);
    }
  });

  it("missing canonical /retrieve actions are exactly the documented R4 divergence", () => {
    const present = new Set(enumVals);
    const missing = RETRIEVE_ACTIONS.filter((a) => !present.has(a));
    // Any canonical action absent from the MCP enum must be on the allowlist.
    // If a NEW action goes missing (undocumented drift), this fails.
    expect(missing.sort()).toEqual(
      [...KNOWN_DIVERGENCES.retrieveMissingActions].sort(),
    );
  });
});

describe("field-name conventions (CLAUDE.md SDK-Server)", () => {
  it("traverse-style retrieve actions use start_uid/end_uid, never uid/from_uid/to_uid", () => {
    const props = (toolByName("mindgraph_retrieve").inputSchema as JsonSchema)
      .properties!;
    expect(props[FIELD_NAME_CONVENTIONS.traverseStart]).toBeTruthy();
    expect(props[FIELD_NAME_CONVENTIONS.traverseEnd]).toBeTruthy();
    for (const forbidden of FIELD_NAME_CONVENTIONS.traverseForbidden) {
      expect(
        props[forbidden],
        `mindgraph_retrieve must not expose a "${forbidden}" field (use start_uid/end_uid)`,
      ).toBeUndefined();
    }
  });

  it("reason 'claim' uses a structured claim + evidence ARRAY (argument endpoint, no action sent downstream)", () => {
    const props = (toolByName("mindgraph_reason").inputSchema as JsonSchema)
      .properties!;
    // evidence must be an array of {label,...} per ArgumentRequest contract.
    expect(props.evidence?.type).toBe("array");
    expect(props.evidence?.items?.type).toBe("object");
    expect(props.claim?.type).toBe("object");
    expect(props.warrant?.type).toBe("object");
    expect(props.argument?.type).toBe("object");
  });
});

describe("coding-agent work contract parity", () => {
  it("covers every advertised mindgraph_plan action exactly once", () => {
    const advertised = actionEnum("mindgraph_plan").sort();
    const contracted = WORK_ACTION_CONTRACT.map((entry) => entry.toolAction).sort();
    expect(contracted).toEqual(advertised);
    expect(new Set(contracted).size).toBe(contracted.length);
  });

  it("maps every MCP work action to a canonical server action", () => {
    for (const entry of WORK_ACTION_CONTRACT) {
      expect(
        ENDPOINT_ACTIONS[entry.endpoint].includes(entry.serverAction),
        `${entry.toolAction} maps to unknown ${entry.endpoint} action ${entry.serverAction}`,
      ).toBe(true);
    }
  });

  it("advertises every action-specific field required by the work fixture", () => {
    const properties = (toolByName("mindgraph_plan").inputSchema as JsonSchema)
      .properties!;
    for (const entry of WORK_ACTION_CONTRACT) {
      for (const field of entry.schemaFields) {
        expect(
          properties[field],
          `mindgraph_plan action ${entry.toolAction} is missing schema field ${field}`,
        ).toBeTruthy();
      }
    }
  });

  it("exposes Lesson as an action-less /memory/distill mapping", () => {
    expect(actionEnum("mindgraph_capture")).toContain("lesson");
    const properties = (toolByName("mindgraph_capture").inputSchema as JsonSchema)
      .properties!;
    for (const field of LESSON_CAPTURE_CONTRACT.schemaFields) {
      expect(
        properties[field],
        `mindgraph_capture lesson is missing schema field ${field}`,
      ).toBeTruthy();
    }
  });

  it("requires authored fields and provenance for skill capture", () => {
    expect(actionEnum("mindgraph_capture")).toContain("skill");
    const schema = toolByName("mindgraph_capture").inputSchema as JsonSchema & {
      allOf?: unknown[];
    };
    const encoded = JSON.stringify(schema.allOf);
    expect(encoded).toContain('"const":"skill"');
    for (const field of ["name", "description", "content"]) {
      expect(encoded).toContain(`"${field}"`);
    }
    for (const field of [
      "session_uid",
      "work_uid",
      "execution_uid",
      "summarizes_uids",
    ]) {
      expect(encoded).toContain(`"${field}"`);
    }
  });

  it("marks the mixed read/write plan tool conservatively write-capable", () => {
    const annotations = toolByName("mindgraph_plan").annotations;
    expect(annotations?.readOnlyHint).toBe(false);
  });
});

describe("commit/inquiry/traverse enum values are subsets of canonical contract", () => {
  // The MCP tools rename a few actions for ergonomics (e.g. resolve_decision ->
  // server `resolve`). We assert the values that pass through unchanged are
  // canonical; renamed ones are checked in the dispatch test instead.
  it("inquiry-mapped reason actions are canonical /epistemic/inquiry actions (claim excepted)", () => {
    const enumVals = actionEnum("mindgraph_reason");
    const inquiry = new Set(ENDPOINT_ACTIONS["/epistemic/inquiry"]);
    for (const v of enumVals) {
      if (v === "claim") continue; // routes to /epistemic/argument
      expect(
        inquiry.has(v),
        `reason action "${v}" is not a canonical /epistemic/inquiry action`,
      ).toBe(true);
    }
  });

  it("traverse-mapped retrieve actions match canonical /traverse actions", () => {
    const enumVals = new Set(actionEnum("mindgraph_retrieve"));
    for (const v of ENDPOINT_ACTIONS["/traverse"]) {
      expect(
        enumVals.has(v),
        `retrieve tool is missing canonical traverse action "${v}"`,
      ).toBe(true);
    }
  });
});
