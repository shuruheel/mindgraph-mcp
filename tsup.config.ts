import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["cjs"],
    dts: true,
    clean: true,
    target: "node18",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    dts: true,
    target: "node18",
  },
]);
