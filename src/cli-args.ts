import type { HookScope } from "./hook-installer.js";

/**
 * argv parsing for the mindgraph-mcp CLI. Lives in its own module so tests
 * can exercise the REAL parser against the REAL installer output without
 * importing the CLI entrypoint (whose import runs main()).
 */
export function parseArgs(argv: string[]): {
  command: string;
  apiKey?: string;
  baseUrl?: string;
  scope: HookScope;
  projectDir?: string;
  harness?: string;
  hooks: boolean;
} {
  const args = argv.slice(2);
  let command = "serve";
  let apiKey = process.env.MINDGRAPH_API_KEY;
  let baseUrl: string | undefined = process.env.MINDGRAPH_BASE_URL;
  let scope: HookScope = "project";
  let projectDir: string | undefined;
  let harness: string | undefined;
  let hooks = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--api-key":
        apiKey = args[++i];
        break;
      case "--base-url":
        baseUrl = args[++i];
        break;
      case "--scope": {
        const value = args[++i];
        if (value !== "user" && value !== "project") {
          throw new Error("--scope must be user or project");
        }
        scope = value;
        break;
      }
      case "--project-dir":
        projectDir = args[++i];
        break;
      case "--harness":
        harness = args[++i];
        break;
      case "--hooks":
        hooks = true;
        break;
      case "--owner":
        // Ownership marker the installer embeds so uninstall can recognize
        // its own entries. The value must be consumed here or it is mistaken
        // for a command ("Unknown command: mindgraph" — every installed hook
        // died on first run before this arm existed).
        ++i;
        break;
      case "--help":
      case "-h":
        command = "help";
        break;
      default:
        if (!arg.startsWith("-")) {
          command = arg;
        }
        break;
    }
  }

  return { command, apiKey, baseUrl, scope, projectDir, harness, hooks };
}
