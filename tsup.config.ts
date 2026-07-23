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
  },
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    dts: true,
    target: "node18",
    define,
  },
]);
