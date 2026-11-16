import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { mindgraphConfigDir } from "../src/hook-env.js";

// hooks.json (connection settings and the consent store) is found through the
// account's home directory, not $HOME, so a temporary HOME no longer isolates
// a test. Point MINDGRAPH_HOME at a fresh directory for every test file;
// spawned processes that copy process.env inherit it.
const home = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "mindgraph-test-home-")),
);
process.env.MINDGRAPH_HOME = home;
// `off --all` reads Claude Code's project list from here instead of the
// account's real ~/.claude.json.
process.env.CLAUDE_CONFIG_DIR = path.join(home, "claude-config");

// A refused MINDGRAPH_HOME (for example a temporary directory inside a git
// work tree) falls back to the real store. Stop before any test touches it.
const where = mindgraphConfigDir();
if (where.source !== "override" || where.dir !== home) {
  fs.rmSync(home, { recursive: true, force: true });
  throw new Error(
    `The test MINDGRAPH_HOME (${home}) was not used${where.refused ? `: ${where.refused}` : ""}. Set TMPDIR to a directory outside every git work tree.`,
  );
}

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
