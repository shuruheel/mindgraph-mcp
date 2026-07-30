// MCP resource surface: the static resource list, the URI templates, and the
// reader that dispatches a URI into the SDK.
//
// Every resource here returns graph reads that `mindgraph_retrieve` also
// serves. The reader is therefore gated under that same tool name, so a policy
// written to deny retrieval cannot be walked around by asking for the same rows
// as a resource — `resources/read` was previously the one request type that
// reached the graph with no governance check at all.

import { MindGraph } from "mindgraph";
import { checkMcpGovernance, type GovernanceConfig } from "./governance.js";

export const RESOURCES = [
  {
    uri: "mindgraph://stats",
    name: "Graph Statistics",
    description:
      "Current knowledge graph statistics: node counts, edge counts, and layer distribution",
    mimeType: "application/json",
  },
  {
    uri: "mindgraph://goals",
    name: "Active Goals",
    description: "All active goals in the knowledge graph",
    mimeType: "application/json",
  },
  {
    uri: "mindgraph://questions",
    name: "Open Questions",
    description: "All open questions in the knowledge graph",
    mimeType: "application/json",
  },
  {
    uri: "mindgraph://contradictions",
    name: "Contradictions",
    description: "Contradictory claims in the knowledge graph",
    mimeType: "application/json",
  },
  {
    uri: "mindgraph://decisions",
    name: "Open Decisions",
    description: "Unresolved decisions awaiting resolution",
    mimeType: "application/json",
  },
];

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "mindgraph://node/{uid}",
    name: "Graph Node",
    description:
      "Retrieve a specific node by its UID, including all properties, edges, and version history",
    mimeType: "application/json",
  },
  {
    uriTemplate: "mindgraph://search/{query}",
    name: "Search Results",
    description:
      "BM25 keyword search across all nodes — pass 1–3 discriminating terms (e.g. 'Kissinger NATO'), not natural language sentences",
    mimeType: "application/json",
  },
  {
    uriTemplate: "mindgraph://layer/{layer}",
    name: "Layer Nodes",
    description:
      "List all nodes in a specific cognitive layer (reality, epistemic, intent, action, memory, agent)",
    mimeType: "application/json",
  },
];

/** The tool name resource reads are governed as. */
export const RESOURCE_GOVERNANCE_TOOL = "mindgraph_retrieve";

export interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
  // The MCP SDK types a handler result as an open record; without this the
  // named interface is not assignable to it.
  [key: string]: unknown;
}

function json(uri: string, data: unknown): ResourceContents {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data) }],
  };
}

/** Dispatch a resource URI into the SDK. Ungated — callers gate first. */
export async function readResource(
  client: MindGraph,
  uri: string,
): Promise<ResourceContents> {
  switch (uri) {
    case "mindgraph://stats":
      return json(uri, await client.stats());
    case "mindgraph://goals":
      return json(uri, await client.getGoals());
    case "mindgraph://questions":
      return json(uri, await client.getOpenQuestions());
    case "mindgraph://contradictions":
      return json(uri, await client.getContradictions());
    case "mindgraph://decisions":
      return json(uri, await client.getOpenDecisions());
  }

  const nodeMatch = uri.match(/^mindgraph:\/\/node\/(.+)$/);
  if (nodeMatch) {
    const uid = decodeURIComponent(nodeMatch[1]);
    const node = await client.getNode(uid);
    const edges = await client.getEdges({ from_uid: uid });
    const inEdges = await client.getEdges({ to_uid: uid });
    return json(uri, { node, outgoing_edges: edges, incoming_edges: inEdges });
  }

  const searchMatch = uri.match(/^mindgraph:\/\/search\/(.+)$/);
  if (searchMatch) {
    const query = decodeURIComponent(searchMatch[1]);
    return json(uri, await client.search(query, { limit: 20 }));
  }

  const layerMatch = uri.match(/^mindgraph:\/\/layer\/(.+)$/);
  if (layerMatch) {
    const layer = decodeURIComponent(layerMatch[1]);
    return json(uri, await client.getNodes({ layer, limit: 50 }));
  }

  throw new Error(`Unknown resource: ${uri}`);
}

/**
 * Read a resource through the same governance checkpoint tool calls pass. A
 * denial throws, which the MCP SDK surfaces as a request error.
 */
export async function readGovernedResource(
  client: MindGraph,
  uri: string,
  governanceConfig: GovernanceConfig,
): Promise<ResourceContents> {
  const governance = await checkMcpGovernance(
    RESOURCE_GOVERNANCE_TOOL,
    {},
    { ...governanceConfig, context: { resource_uri: uri } },
  );
  if (!governance.allowed) {
    throw new Error(governance.message);
  }
  return readResource(client, uri);
}
