#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

if (process.env.FAKE_CODEGRAPH_TIMEOUT === "1") {
  setTimeout(() => {}, 60_000);
} else if (command === "status") {
  process.stdout.write(
    process.env.FAKE_CODEGRAPH_STATUS ||
      JSON.stringify({
        initialized: true,
        projectPath: process.cwd(),
        lastIndexed: "2026-07-28T00:00:00.000Z",
        pendingChanges: { added: 0, modified: 0, removed: 0 },
        worktreeMismatch: null,
        index: {
          state: "complete",
          pendingRefs: 0,
          reindexRecommended: false,
        },
      }),
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
