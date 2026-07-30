// Dynamic, per-object-type read tools generated from the active ontology.
//
// The cloud emits schema-qualified descriptors (GET /v1/ontology/tools) for
// object discovery/point/context reads, every declared relation+entry-role,
// and one structured composite per active schema. We render them into MCP tools
// at list-time (cached, short TTL) and dispatch through the typed SDK methods.

import { MindGraph } from "mindgraph";
import { renderNodeList, renderObjectList, renderOntologyAnswer } from "./render.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface GeneratedToolDescriptor {
  name: string;
  description: string;
  schema_id: string;
  object_type: string;
  maps_to: string; // search | object | object_context | related | structured_query
  relation?: string;
  entry_role?: "source" | "target";
  far_type?: string;
  input_schema: Record<string, unknown>;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  // Compact on purpose — pretty-printing doubled the token cost.
  content: [{ type: "text", text: JSON.stringify(data) }],
});

// Rendered-by-default for the read mappings; format:"json" escapes; unknown
// shapes fall back to raw. structured_query is ALWAYS raw — models copy its
// rows/aggregates structurally.
const rendered = (
  format: unknown,
  raw: unknown,
  render: (value: unknown) => string | undefined,
): ToolResult => {
  if (format === "json") return ok(raw);
  const text = render(raw);
  return text !== undefined ? { content: [{ type: "text", text }] } : ok(raw);
};
const err = (message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true,
});

const CACHE_TTL_MS = 5 * 60 * 1000;

// A failed manifest fetch is not an answer about which tools exist. Caching it
// as one blanks the ontology tool surface for a full TTL on a single blip, so
// failures get a short cooldown instead — and never overwrite a good manifest.
const FAILURE_COOLDOWN_MS = 15 * 1000;

interface Cache {
  tools: Tool[];
  byName: Map<string, GeneratedToolDescriptor>;
  fetchedAt: number;
}
/** Last manifest the server actually answered with. */
let cache: Cache | null = null;
let retryNotBefore = 0;

const EMPTY = {
  tools: [] as Tool[],
  byName: new Map<string, GeneratedToolDescriptor>(),
};

class DuplicateGeneratedToolError extends Error {}

export function clearGeneratedToolCache(): void {
  cache = null;
  retryNotBefore = 0;
}

/**
 * Fetch (and cache) the generated tools for the active ontology. Never throws
 * on transport failure: an old server without the endpoint yields an empty set
 * so the static tools still list. A *transient* failure keeps serving the last
 * known-good manifest rather than asserting the ontology has no tools.
 */
export async function getGeneratedTools(
  client: MindGraph,
): Promise<{ tools: Tool[]; byName: Map<string, GeneratedToolDescriptor> }> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { tools: cache.tools, byName: cache.byName };
  }
  if (now < retryNotBefore) {
    // Recently failed. Serve the stale manifest if we have one — a stale tool
    // that no longer exists fails at dispatch, which is a better answer than
    // silently having no ontology tools at all.
    return cache ? { tools: cache.tools, byName: cache.byName } : EMPTY;
  }
  try {
    // Access defensively so the MCP typechecks/runs against any SDK version —
    // an SDK without the method simply yields no generated tools.
    const c = client as unknown as {
      listOntologyTools?: () => Promise<{ tools: GeneratedToolDescriptor[] }>;
    };
    if (typeof c.listOntologyTools !== "function") {
      cache = { tools: [], byName: new Map(), fetchedAt: Date.now() };
      return { tools: cache.tools, byName: cache.byName };
    }
    const resp = await c.listOntologyTools();
    const byName = new Map<string, GeneratedToolDescriptor>();
    const tools: Tool[] = [];
    for (const d of resp.tools ?? []) {
      if (byName.has(d.name)) {
        throw new DuplicateGeneratedToolError(
          `duplicate generated ontology tool name: ${d.name}`,
        );
      }
      byName.set(d.name, d);
      // Read mappings gain the format escape hatch; the structured composite
      // keeps its exact published schema (deny_unknown_fields server-side).
      const inputSchema =
        d.maps_to === "structured_query"
          ? (d.input_schema as Tool["inputSchema"])
          : ({
              ...d.input_schema,
              properties: {
                ...(d.input_schema.properties as Record<string, unknown> | undefined),
                format: {
                  type: "string",
                  enum: ["text", "json"],
                  description:
                    "Output format (default 'text': compact rendered block). Pass 'json' for the raw server response.",
                },
              },
            } as unknown as Tool["inputSchema"]);
      tools.push({
        name: d.name,
        description: d.description,
        inputSchema,
      });
    }
    cache = { tools, byName, fetchedAt: Date.now() };
    retryNotBefore = 0;
    return { tools, byName };
  } catch (error) {
    if (error instanceof DuplicateGeneratedToolError) throw error;
    // Unreachable or erroring. Back off briefly, but do not record an empty
    // manifest as if the server had answered with one.
    retryNotBefore = Date.now() + FAILURE_COOLDOWN_MS;
    return cache ? { tools: cache.tools, byName: cache.byName } : EMPTY;
  }
}

// Exactly the properties the server publishes on the structured composite's
// input schema, minus the two the descriptor itself supplies (schema_id,
// select). Keep in sync with `structured_query_schema()` in
// mindgraph-cloud/src/ontology/tools.rs.
const STRUCTURED_QUERY_PASSTHROUGH = [
  "anchor",
  "path",
  "where",
  "include",
  "page",
  "aggregate",
] as const;

/** Dispatch a generated tool call into the appropriate /ontology read endpoint. */
export async function handleGeneratedTool(
  client: MindGraph,
  desc: GeneratedToolDescriptor,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const ontologyClient = client as unknown as {
      searchDomainObjects: (
        query: string,
        options: Record<string, unknown>,
      ) => Promise<unknown>;
      getDomainObject: (
        uid: string,
        binding: Record<string, unknown>,
      ) => Promise<unknown>;
      getDomainObjectContext: (
        uid: string,
        depth: number | undefined,
        binding: Record<string, unknown>,
      ) => Promise<unknown>;
      queryDomainStructured?: (request: Record<string, unknown>) => Promise<unknown>;
      queryRelatedDomainObjects?: (request: Record<string, unknown>) => Promise<unknown>;
    };
    switch (desc.maps_to) {
      case "search": {
        const query = args.query as string | undefined;
        if (!query) return err(`query is required for ${desc.name}`);
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const filters = Array.isArray(args.filters)
          ? args.filters as Array<{
              field: string;
              op: "eq" | "neq" | "in" | "contains" | "gte" | "lte" | "exists";
              value?: unknown;
            }>
          : undefined;
        return rendered(
          args.format,
          await ontologyClient.searchDomainObjects(query, {
            schema_id: desc.schema_id,
            object_types: [desc.object_type],
            filters,
            limit,
          }),
          (raw) => renderObjectList(raw, `${desc.object_type} search: ${query}`),
        );
      }
      case "object": {
        const uid = args.uid as string | undefined;
        if (!uid) return err(`uid is required for ${desc.name}`);
        return rendered(
          args.format,
          await ontologyClient.getDomainObject(uid, {
            schema_id: desc.schema_id,
            object_type: desc.object_type,
          }),
          (raw) => renderNodeList([raw], desc.object_type),
        );
      }
      case "object_context": {
        const uid = args.uid as string | undefined;
        if (!uid) return err(`uid is required for ${desc.name}`);
        const depth = typeof args.depth === "number" ? args.depth : undefined;
        return rendered(
          args.format,
          await ontologyClient.getDomainObjectContext(uid, depth, {
            schema_id: desc.schema_id,
            object_type: desc.object_type,
          }),
          renderOntologyAnswer,
        );
      }
      case "related": {
        const uid = args.uid as string | undefined;
        if (!uid) return err(`uid is required for ${desc.name}`);
        if (!desc.relation || !desc.entry_role || !desc.far_type) {
          return err(`invalid related descriptor: ${desc.name}`);
        }
        if (!ontologyClient.queryRelatedDomainObjects) {
          return err(
            "related ontology tools require a graph-aware version of the mindgraph SDK",
          );
        }
        return rendered(
          args.format,
          await ontologyClient.queryRelatedDomainObjects({
          schema_id: desc.schema_id,
          entry_type: desc.object_type,
          uid,
          relation: desc.relation,
          entry_role: desc.entry_role,
          far_type: desc.far_type,
          where: Array.isArray(args.where)
            ? args.where as Array<{
                field: string;
                op: "eq" | "neq" | "in" | "contains" | "gte" | "lte" | "exists";
                value?: unknown;
              }>
            : undefined,
          include_provenance: args.include_provenance === true,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          offset: typeof args.offset === "number" ? args.offset : undefined,
        }),
          (raw) => renderObjectList(raw, `${desc.far_type} related via ${desc.relation}`),
        );
      }
      case "structured_query": {
        const select = args.select as string | undefined;
        if (!select) return err(`select is required for ${desc.name}`);
        if (!ontologyClient.queryDomainStructured) {
          return err(
            "structured ontology tools require a graph-aware version of the mindgraph SDK",
          );
        }
        // Forward only what the composite tool publishes. The server's
        // StructuredQueryRequest is deny_unknown_fields and the generated
        // input schema is additionalProperties:false, so spreading the raw
        // args 400s the entire call the moment anything else rides along —
        // which is what the adapter's own injected agent_id did.
        const request: Record<string, unknown> = {
          schema_id: desc.schema_id,
          select,
        };
        for (const field of STRUCTURED_QUERY_PASSTHROUGH) {
          if (args[field] !== undefined) request[field] = args[field];
        }
        return ok(await ontologyClient.queryDomainStructured(request));
      }
      default:
        return err(`unknown generated tool mapping: ${desc.maps_to}`);
    }
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
