import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
).version as string;

const define = {
  __PACKAGE_VERSION__: JSON.stringify(packageVersion),
};

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["cjs"],
    dts: true,
    clean: true,
    target: "node18",
    banner: { js: "#!/usr/bin/env node" },
    define,
    // The cli bundle is COPIED to ~/.mindgraph/bin/ as the pinned hook runner
    // and must run with no adjacent node_modules — tsup externalizes
    // `dependencies` by default, which left a bare require("mindgraph") in
    // the copy (SessionStart "cjs/loader" crash, 2026-07-29, bug #7).
    noExternal: ["mindgraph"],
  },
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    dts: true,
    target: "node18",
    define,
  },
  {
    // `mindgraph-mcp/server`: the hosted-mode factory the dashboard imports
    // (spec D5). ESM for Next.js, CJS for everything else; no define — the
    // version arrives in the options.
    entry: { server: "src/server.ts" },
    format: ["esm", "cjs"],
    dts: true,
    target: "node18",
  },
]);
