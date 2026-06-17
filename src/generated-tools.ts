// Dynamic, per-object-type read tools generated from the active ontology.
//
// The cloud emits descriptors (GET /v1/ontology/tools) for each active schema's
// object types — `search_<objs>`, `get_<obj>`, `summarize_<obj>`. We render them
// into MCP tools at list-time (cached, short TTL) and dispatch them into the
// generic /ontology read endpoints with `object_type` bound. No codegen.

import { MindGraph } from "mindgraph";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

interface GeneratedToolDescriptor {
  name: string;
  description: string;
  schema_id: string;
  object_type: string;
  maps_to: string; // "search" | "object" | "object_context"
  input_schema: Record<string, unknown>;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const err = (message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true,
});

const CACHE_TTL_MS = 5 * 60 * 1000;

interface Cache {
  tools: Tool[];
  byName: Map<string, GeneratedToolDescriptor>;
  fetchedAt: number;
}
let cache: Cache | null = null;

/**
 * Fetch (and cache) the generated tools for the active ontology. Never throws:
 * an old server without the endpoint, or any error, yields an empty set so the
 * static tools still list.
 */
export async function getGeneratedTools(
  client: MindGraph,
): Promise<{ tools: Tool[]; byName: Map<string, GeneratedToolDescriptor> }> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { tools: cache.tools, byName: cache.byName };
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
      byName.set(d.name, d);
      tools.push({
        name: d.name,
        description: d.description,
        inputSchema: d.input_schema as Tool["inputSchema"],
      });
    }
    cache = { tools, byName, fetchedAt: Date.now() };
    return { tools, byName };
  } catch {
    // Endpoint absent or unreachable — degrade to no generated tools.
    cache = { tools: [], byName: new Map(), fetchedAt: Date.now() };
    return { tools: cache.tools, byName: cache.byName };
  }
}

/** Dispatch a generated tool call into the appropriate /ontology read endpoint. */
export async function handleGeneratedTool(
  client: MindGraph,
  desc: GeneratedToolDescriptor,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (desc.maps_to) {
      case "search": {
        const query = args.query as string | undefined;
        if (!query) return err(`query is required for ${desc.name}`);
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        return ok(
          await client.searchDomainObjects(query, {
            schema_id: desc.schema_id,
            object_types: [desc.object_type],
            limit,
          }),
        );
      }
      case "object": {
        const uid = args.uid as string | undefined;
        if (!uid) return err(`uid is required for ${desc.name}`);
        return ok(await client.getDomainObject(uid));
      }
      case "object_context": {
        const uid = args.uid as string | undefined;
        if (!uid) return err(`uid is required for ${desc.name}`);
        const depth = typeof args.depth === "number" ? args.depth : undefined;
        return ok(await client.getDomainObjectContext(uid, depth));
      }
      default:
        return err(`unknown generated tool mapping: ${desc.maps_to}`);
    }
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
