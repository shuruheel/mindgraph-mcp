/**
 * Coding writes go to the consented repository's Space (plan D5, batch B4).
 *
 * The server's typed write routes accept an optional, grant-checked
 * `space_uid` on these actions only (rs #181); every other action refuses it
 * with `space_uid_unsupported`, so the client below adds it to exactly these:
 *
 *   /memory/distill        lesson
 *   /memory/session        journal
 *   /reality/capture       observation, source, snippet
 *   /intent/commitment     goal, project, milestone
 *   /intent/deliberation   open_decision, add_option, add_constraint
 *   /agent/plan            create_task
 *
 * The Space comes only from the consent decision, never from model
 * arguments. The server never creates a Space on these routes (an unknown one
 * is 404 `scope_not_found`), so the first write to a Space that does not
 * exist yet asks `/memory/config ensure_space` to create it and retries once.
 * The refusal happens before any write, so the retry cannot duplicate one.
 * If the Space cannot be created the original error stands: a write is never
 * moved to another Space.
 */
import path from "node:path";
import { MindGraph, MindGraphError } from "mindgraph";
import type { OnDecision } from "./consent.js";

const CAPTURE_ACTIONS = new Set(["observation", "source", "snippet"]);
const COMMIT_ACTIONS = new Set(["goal", "project", "milestone"]);
const DELIBERATION_ACTIONS = new Set(["open_decision", "add_option", "add_constraint"]);

type Request = Record<string, unknown> | undefined;

function withSpace(req: Request, space: string): Record<string, unknown> {
  return { ...(req ?? {}), space_uid: space };
}

function actionIn(req: Request, actions: Set<string>): boolean {
  return typeof req?.action === "string" && actions.has(req.action);
}

/** A view of `client` whose coding writes carry `space`. Every other call
 * goes to `client` unchanged. */
export function clientWithSpace(client: MindGraph, space: string): MindGraph {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const call = value as (...args: unknown[]) => unknown;
      switch (prop) {
        case "distill":
          return (req: Request) =>
            call.call(target, req?.output_type === "lesson" ? withSpace(req, space) : req);
        case "capture":
          return (req: Request) =>
            call.call(target, actionIn(req, CAPTURE_ACTIONS) ? withSpace(req, space) : req);
        case "commit":
          return (req: Request) =>
            call.call(target, actionIn(req, COMMIT_ACTIONS) ? withSpace(req, space) : req);
        case "deliberate":
          return (req: Request) =>
            call.call(target, actionIn(req, DELIBERATION_ACTIONS) ? withSpace(req, space) : req);
        case "plan":
          return (req: Request) =>
            call.call(target, req?.action === "create_task" ? withSpace(req, space) : req);
        case "journal":
          return (label: unknown, props: unknown, options: Request) =>
            call.call(target, label, props, withSpace(options, space));
        case "openDecision":
          return (label: unknown, opts: Request) => call.call(target, label, withSpace(opts, space));
        case "addOption":
          return (decisionUid: unknown, label: unknown, opts: Request) =>
            call.call(target, decisionUid, label, withSpace(opts, space));
        default:
          return call.bind(target);
      }
    },
  });
}

/** The Space a coding write in this call goes to, or undefined: hosted mode
 * and a consented entry without a pinned Space write as before. */
export function repositorySpace(runtime: { hosted?: boolean; consent?: OnDecision }): string | undefined {
  if (runtime.hosted) return undefined;
  const space = runtime.consent?.space_uid;
  return typeof space === "string" && space.length > 0 ? space : undefined;
}

function isScopeNotFound(e: unknown): boolean {
  if (!(e instanceof MindGraphError) || e.status !== 404) return false;
  const body = e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : {};
  return body.code === "scope_not_found" || e.code === "scope_not_found";
}

/** A short name for the Space: the repository's or workspace's directory
 * name, never its full local path. */
function spaceLabel(decision: OnDecision): string {
  const root = decision.repo?.root ?? decision.root;
  const name = path.basename(root) || root;
  return decision.kind === "workspace" && !decision.repo ? `workspace ${name}` : `repository ${name}`;
}

/** Spaces this process has created or confirmed, so a later 404 is not retried twice. */
const ensured = new Set<string>();

/** Run `write` against a client whose coding writes carry the consented
 * repository's Space, creating the Space once if the server does not know it. */
export async function withRepositorySpace<T>(
  client: MindGraph,
  runtime: { hosted?: boolean; consent?: OnDecision },
  write: (client: MindGraph) => Promise<T>,
): Promise<T> {
  const space = repositorySpace(runtime);
  if (!space || !runtime.consent) return write(client);
  const scoped = clientWithSpace(client, space);
  try {
    return await write(scoped);
  } catch (e) {
    if (!isScopeNotFound(e) || ensured.has(space)) throw e;
    try {
      await client.memoryConfig({
        action: "ensure_space",
        space_uid: space,
        label: spaceLabel(runtime.consent),
      } as never);
    } catch {
      // An older server, or a key that may not create Spaces: the write's
      // own refusal is the clearer error.
      throw e;
    }
    ensured.add(space);
    return await write(scoped);
  }
}
