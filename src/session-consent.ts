// Optional desktop policy for standalone sibling clones. Explicit repository
// and workspace decisions always win. Hooks do no discovery or network I/O.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConsentStore, resolveConsent, type ConsentDecision, type LoadedConsentStore } from "./consent.js";
import { normalizeRemote } from "./codegraph.js";

export function sessionConsent(cwd: unknown, env = process.env, loaded: LoadedConsentStore = loadConsentStore(env)): ConsentDecision {
  const decision = resolveConsent(cwd, loaded, { env });
  const store = loaded.store;
  if (!store?.reconnectSiblings || decision.state !== "off" || decision.reason !== "not_consented" ||
      !decision.inRepository || !decision.directory) return decision;
  const directory = decision.directory;
  const candidates = store.roots.filter(r => r.kind === "repo" && r.repositories[0].space_uid &&
    directory.startsWith(path.dirname(r.root) + path.sep));
  if (!candidates.length) return decision;
  // Use only a direct sibling with its own .git directory, never a nested
  // repository, linked gitdir, or workspace checkout needing its own review.
  let root = directory;
  while (!fs.existsSync(path.join(root, ".git"))) {
    const parent = path.dirname(root);
    if (parent === root) return decision;
    root = parent;
  }
  const siblings = candidates.filter(r => path.dirname(r.root) === path.dirname(root));
  if (!siblings.length || store.reconnectExcluded?.includes(root)) return decision;
  for (let p = root;; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, ".mindgraph/workspace.json"))) return decision;
    if (p === path.dirname(p)) break;
  }
  const config = path.join(root, ".git/config");
  let origin: string | null;
  try {
    if (!fs.lstatSync(path.join(root, ".git")).isDirectory() || !fs.lstatSync(config).isFile()) return decision;
    const raw = execFileSync("git", ["config", "--no-includes", "--file", config, "--get", "remote.origin.url"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, maxBuffer: 8192,
    }).trim();
    if (!/^(?:https?:\/\/|ssh:\/\/|git:\/\/|(?:[\w.-]+@)?[\w.-]+:)/i.test(raw)) return decision;
    origin = normalizeRemote(raw);
  } catch { return decision; }
  const matches = siblings.flatMap(r => r.repositories).filter(r => r.repo_id === origin);
  if (!matches.length) return { ...decision, offerDesktopLink: true };
  if (new Set(matches.map(r => r.space_uid)).size !== 1) return decision;
  const repo = { ...matches[0], root };
  return { state: "on", reason: "reconnected", directory, root, kind: "repo", repo, space_uid: repo.space_uid,
    repositories: [repo], storeAcknowledged: decision.storeAcknowledged };
}
