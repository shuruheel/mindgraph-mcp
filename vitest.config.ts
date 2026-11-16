import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Every test file gets its own MINDGRAPH_HOME, so no test can read or
    // write the developer's real ~/.mindgraph/hooks.json.
    setupFiles: ["test/setup-home.ts"],
  },
});
