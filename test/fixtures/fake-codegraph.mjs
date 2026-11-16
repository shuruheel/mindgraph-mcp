#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

// Default status knobs (ignored when FAKE_CODEGRAPH_STATUS replaces the whole
// payload). With neither set, the output is the complete index it always was.
//   FAKE_CODEGRAPH_INDEX_STATE  "null" emits `state: null`, "absent" omits the
//                               key, any other value is emitted as the state.
//   FAKE_CODEGRAPH_NODE_COUNT   emits a top-level `nodeCount`; unset omits it.
function defaultStatus() {
  const index = { state: "complete", pendingRefs: 0, reindexRecommended: false };
  const state = process.env.FAKE_CODEGRAPH_INDEX_STATE;
  if (state === "absent") delete index.state;
  else if (state === "null") index.state = null;
  else if (state) index.state = state;
  const nodeCount = process.env.FAKE_CODEGRAPH_NODE_COUNT;
  return {
    initialized: true,
    projectPath: process.cwd(),
    lastIndexed: "2026-07-28T00:00:00.000Z",
    ...(nodeCount ? { nodeCount: Number(nodeCount) } : {}),
    pendingChanges: { added: 0, modified: 0, removed: 0 },
    worktreeMismatch: null,
    index,
  };
}

if (process.env.FAKE_CODEGRAPH_TIMEOUT === "1") {
  setTimeout(() => {}, 60_000);
} else if (command === "status") {
  process.stdout.write(
    process.env.FAKE_CODEGRAPH_STATUS || JSON.stringify(defaultStatus()),
  );
} else if (command === "query") {
  process.stdout.write(process.env.FAKE_CODEGRAPH_QUERY || "[]");
} else if (command === "callers") {
  process.stdout.write(process.env.FAKE_CODEGRAPH_CALLERS || '{"callers":[]}');
} else if (command === "callees") {
  process.stdout.write(process.env.FAKE_CODEGRAPH_CALLEES || '{"callees":[]}');
} else if (command === "impact") {
  process.stdout.write(process.env.FAKE_CODEGRAPH_IMPACT || '{"affected":[]}');
} else {
  process.stderr.write(`unsupported fake command: ${command}`);
  process.exitCode = 2;
}
