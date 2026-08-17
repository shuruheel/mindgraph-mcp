/**
 * `mindgraph-mcp skills pull|push` — the coding-profile interop leg of
 * governed skills (spec D8).
 *
 * Both verbs are explicit user commands: no hook, no MCP tool, and no
 * background process writes skill files (I7); `mindgraph_sync` keeps its
 * local-read-only contract. Pull renders the caller's published+granted
 * skills into one directory per skill; the emitted SKILL.md frontmatter is a
 * FIXED ALLOWLIST — `name`, `description`, `license`, and the
 * `metadata.mindgraph-*` pin keys. Capability-affecting keys
 * (`allowed-tools`, `model`, …) and `imported_frontmatter` are never emitted
 * (I13): export is spec-legal-subset, not verbatim.
 *
 * Honesty note (T-SEC2, in the CLI help too): Claude Code and Codex
 * hot-reload skill files mid-session — running CLI sessions adopt pulled
 * changes immediately. Session pinning is a managed-agent property only.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- API surface -----------------------------------------------------------

export interface SkillSummary {
  uid: string;
  name: string;
  status: string;
  status_reason?: string | null;
  content_hash: string;
  version: number;
}

export interface SkillDetail extends SkillSummary {
  description: string;
  content: string;
  license?: string | null;
}

export interface PushOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** Minimal server client; injected so pull/push logic is testable offline. */
export interface SkillsApi {
  /** Published skills, optionally restricted to one agent's grants. */
  list(grantedTo?: string): Promise<SkillSummary[]>;
  /** Full skill (any status) — pull reports need status_reason after
   * eligibility loss. `null` when the uid no longer resolves. */
  get(uid: string): Promise<SkillDetail | null>;
  send(body: Record<string, unknown>): Promise<PushOutcome>;
}

export function httpSkillsApi(
  baseUrl: string,
  apiKey: string,
  agentId?: string
): SkillsApi {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/action/skill`;
  const call = async (body: Record<string, unknown>): Promise<PushOutcome> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(
        agentId ? { agent_id: agentId, ...body } : body
      ),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = { error: `non-JSON response (HTTP ${response.status})` };
    }
    return { status: response.status, body: parsed };
  };
  return {
    async list(grantedTo?: string): Promise<SkillSummary[]> {
      const { status, body } = await call({
        action: "list",
        ...(grantedTo ? { granted_to: grantedTo } : {}),
      });
      if (status !== 200) {
        throw new Error(
          `skill list failed (HTTP ${status}): ${String(body.error ?? "")}`
        );
      }
      return (body.skills as SkillSummary[]) ?? [];
    },
    async get(uid: string): Promise<SkillDetail | null> {
      const { status, body } = await call({ action: "get", uid });
      if (status === 404) return null;
      if (status !== 200) {
        throw new Error(
          `skill get failed (HTTP ${status}): ${String(body.error ?? "")}`
        );
      }
      const props = (body.props ?? {}) as Record<string, unknown>;
      return {
        uid: String(body.uid ?? uid),
        name: String(props.name ?? ""),
        description: String(props.description ?? ""),
        content: String(props.content ?? ""),
        license: (props.license as string | null) ?? null,
        status: String(props.status ?? "candidate"),
        status_reason: (props.status_reason as string | null) ?? null,
        content_hash: String(props.content_hash ?? ""),
        version: Number(body.version ?? 0),
      };
    },
    send: call,
  };
}

// ---- SKILL.md rendering and parsing ---------------------------------------

/** The agentskills.io name grammar — also the first line of the
 * path-traversal defense: it structurally excludes `/`, `..`, and spaces. */
export function isValidSkillName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  );
}

/** Render the spec-legal-subset SKILL.md: allowlisted frontmatter only. */
export function renderSkillMd(skill: SkillDetail): string {
  const lines = [
    "---",
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description)}`,
  ];
  if (skill.license) {
    lines.push(`license: ${JSON.stringify(skill.license)}`);
  }
  lines.push(
    "metadata:",
    `  mindgraph-uid: ${JSON.stringify(skill.uid)}`,
    `  mindgraph-version: ${JSON.stringify(String(skill.version))}`,
    `  mindgraph-content-hash: ${JSON.stringify(skill.content_hash)}`,
    "---",
    "",
    skill.content
  );
  return `${lines.join("\n")}\n`;
}

export interface ParsedSkillMd {
  name?: string;
  description?: string;
  license?: string;
  pin?: { uid: string; version?: string; contentHash?: string };
  /** Raw text of every non-allowlisted frontmatter key, captured verbatim
   * for review (`imported_frontmatter`) — parsed by nobody, interpreted by
   * nothing (T-SEM7: `allowed-tools` etc. stay deliberately inert). */
  unknown: Record<string, string>;
  body: string;
}

function scalar(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
  } catch {
    // plain YAML scalar
  }
  return trimmed;
}

/** Line-level frontmatter lexer: top-level `key:` at column 0; everything
 * until the next top-level key is that key's raw value (so nested blocks and
 * lists survive verbatim into `unknown`). No YAML dependency — we never
 * interpret structures we would then have to re-emit. */
export function parseSkillMd(text: string): ParsedSkillMd | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const frontmatter = text.slice(4, end + 1);
  // Strip the leading separator blank line and exactly one trailing
  // newline: render appends one, so this keeps pull->push cycles
  // byte-stable instead of growing the body (and moving the content hash)
  // by one newline per round trip.
  const body = text
    .slice(end + 5)
    .replace(/^\n/, "")
    .replace(/\n$/, "");

  const entries: Array<{ key: string; raw: string }> = [];
  for (const line of frontmatter.split("\n")) {
    const top = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (top) {
      entries.push({ key: top[1], raw: top[2] });
    } else if (entries.length > 0) {
      entries[entries.length - 1].raw += `\n${line}`;
    }
  }

  const result: ParsedSkillMd = { unknown: {}, body };
  for (const { key, raw } of entries) {
    switch (key) {
      case "name":
        result.name = scalar(raw);
        break;
      case "description":
        result.description = scalar(raw);
        break;
      case "license":
        result.license = scalar(raw);
        break;
      case "metadata": {
        const uid = /mindgraph-uid:\s*(.+)/.exec(raw);
        const version = /mindgraph-version:\s*(.+)/.exec(raw);
        const hash = /mindgraph-content-hash:\s*(.+)/.exec(raw);
        if (uid) {
          result.pin = {
            uid: scalar(uid[1]),
            version: version ? scalar(version[1]) : undefined,
            contentHash: hash ? scalar(hash[1]) : undefined,
          };
        } else if (raw.trim().length > 0) {
          result.unknown[key] = raw;
        }
        break;
      }
      default:
        result.unknown[key] = raw;
        break;
    }
  }
  return result;
}

// ---- pull ------------------------------------------------------------------

const STATE_FILE = ".mindgraph-skills-state.json";

interface SkillState {
  uid: string;
  content_hash: string;
  file_sha256: string;
}

type PullState = Record<string, SkillState>;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function loadState(dir: string): PullState {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, STATE_FILE), "utf8")
    ) as PullState;
  } catch {
    return {};
  }
}

function saveState(dir: string, state: PullState): void {
  fs.writeFileSync(
    path.join(dir, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`
  );
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface PullReport {
  written: string[];
  unchanged: string[];
  /** Locally edited while upstream is unchanged: left entirely alone —
   * the divergence is the user's until upstream moves or they push. */
  locallyEdited: string[];
  conflicts: string[];
  removed: Array<{ name: string; statusReason: string | null; kept: boolean }>;
  refused: Array<{ name: string; reason: string }>;
}

/** Resolve `dir/name` defensively (A15): grammar-checked name, canonical
 * containment, and symlink refusal at both the directory and the file. */
function safeSkillPaths(
  dir: string,
  name: string
): { skillDir: string; skillFile: string } | string {
  if (!isValidSkillName(name)) {
    return `invalid skill name ${JSON.stringify(name)}`;
  }
  const root = path.resolve(dir);
  const skillDir = path.resolve(root, name);
  if (skillDir !== path.join(root, name) || !skillDir.startsWith(root + path.sep)) {
    return "resolved path escapes the target directory";
  }
  if (isSymlink(skillDir)) {
    return "target directory is a symlink";
  }
  const skillFile = path.join(skillDir, "SKILL.md");
  if (isSymlink(skillFile)) {
    return "target SKILL.md is a symlink";
  }
  return { skillDir, skillFile };
}

export async function skillsPull(
  api: SkillsApi,
  dir: string,
  grantedTo?: string
): Promise<PullReport> {
  const report: PullReport = {
    written: [],
    unchanged: [],
    locallyEdited: [],
    conflicts: [],
    removed: [],
    refused: [],
  };
  fs.mkdirSync(dir, { recursive: true });
  const state = loadState(dir);
  const summaries = await api.list(grantedTo);
  const fetched = new Set<string>();

  for (const summary of summaries) {
    const detail = await api.get(summary.uid);
    if (!detail || detail.status !== "published") continue;
    fetched.add(detail.name);

    const paths = safeSkillPaths(dir, detail.name);
    if (typeof paths === "string") {
      report.refused.push({ name: detail.name, reason: paths });
      continue;
    }
    const { skillDir, skillFile } = paths;
    const rendered = renderSkillMd(detail);

    let existing: string | null = null;
    try {
      existing = fs.readFileSync(skillFile, "utf8");
    } catch {
      existing = null;
    }

    if (existing === rendered) {
      state[detail.name] = {
        uid: detail.uid,
        content_hash: detail.content_hash,
        file_sha256: sha256(rendered),
      };
      report.unchanged.push(detail.name);
      continue;
    }
    const recorded = state[detail.name];
    const locallyModified =
      existing !== null &&
      (!recorded || sha256(existing) !== recorded.file_sha256);
    if (locallyModified) {
      if (recorded && recorded.content_hash === detail.content_hash) {
        // Upstream unchanged: the local divergence is the user's until they
        // push or upstream moves. No write at all.
        report.locallyEdited.push(detail.name);
        continue;
      }
      // Upstream changed under a local edit: never overwrite — the new
      // upstream render lands beside the edits as a .conflict sidecar.
      fs.writeFileSync(`${skillFile}.conflict`, rendered);
      report.conflicts.push(detail.name);
      continue;
    }
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, rendered);
    state[detail.name] = {
      uid: detail.uid,
      content_hash: detail.content_hash,
      file_sha256: sha256(rendered),
    };
    report.written.push(detail.name);
  }

  // Eligibility loss (T-SEM5/I3): a previously pulled skill that is no
  // longer published+granted is withdrawn — stale revoked instructions never
  // persist silently. Unmodified directories are removed; locally modified
  // ones keep the edits but lose the live SKILL.md (renamed to .conflict so
  // the harness stops loading it).
  for (const [name, recorded] of Object.entries(state)) {
    if (fetched.has(name)) continue;
    const paths = safeSkillPaths(dir, name);
    if (typeof paths === "string") {
      delete state[name];
      continue;
    }
    const { skillDir, skillFile } = paths;
    let statusReason: string | null = null;
    try {
      const gone = await api.get(recorded.uid);
      statusReason = gone?.status_reason ?? (gone ? `status: ${gone.status}` : null);
    } catch {
      statusReason = null;
    }
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(skillFile, "utf8");
    } catch {
      existing = null;
    }
    if (existing === null) {
      delete state[name];
      continue;
    }
    const locallyModified = sha256(existing) !== recorded.file_sha256;
    if (locallyModified) {
      fs.renameSync(skillFile, `${skillFile}.conflict`);
      report.removed.push({ name, statusReason, kept: true });
    } else {
      fs.rmSync(skillDir, { recursive: true, force: true });
      report.removed.push({ name, statusReason, kept: false });
    }
    delete state[name];
  }

  saveState(dir, state);
  return report;
}

// ---- push ------------------------------------------------------------------

export interface PushReport {
  outcome:
    | "created"
    | "replayed"
    | "updated"
    | "conflict"
    | "error";
  message: string;
  uid?: string;
  existingUid?: string;
  existingStatus?: string;
}

export async function skillsPush(
  api: SkillsApi,
  skillPath: string
): Promise<PushReport> {
  const resolved = path.resolve(skillPath);
  const file = resolved.endsWith("SKILL.md")
    ? resolved
    : path.join(resolved, "SKILL.md");
  if (isSymlink(file)) {
    return { outcome: "error", message: `${file} is a symlink; refusing` };
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { outcome: "error", message: `could not read ${file}` };
  }
  const parsed = parseSkillMd(text);
  if (!parsed) {
    return {
      outcome: "error",
      message: "SKILL.md must start with a --- frontmatter block",
    };
  }
  if (!parsed.name || !parsed.description) {
    return {
      outcome: "error",
      message: "SKILL.md frontmatter requires name and description",
    };
  }

  // A directory carrying pin metadata from a prior pull routes to the
  // candidate-only update path; uid-less directories only ever create.
  if (parsed.pin?.uid) {
    const { status, body } = await api.send({
      action: "update",
      uid: parsed.pin.uid,
      name: parsed.name,
      description: parsed.description,
      content: parsed.body,
      ...(parsed.license ? { license: parsed.license } : {}),
    });
    if (status === 200) {
      return {
        outcome: "updated",
        message: `updated candidate ${parsed.name} (${parsed.pin.uid})`,
        uid: parsed.pin.uid,
      };
    }
    return {
      outcome: status === 409 ? "conflict" : "error",
      message: `update failed (HTTP ${status}): ${String(body.error ?? "")}`,
      existingUid: (body.existing_uid as string) ?? undefined,
      existingStatus: (body.existing_status as string) ?? undefined,
    };
  }

  const { status, body } = await api.send({
    action: "create",
    skill_source: "imported",
    name: parsed.name,
    description: parsed.description,
    content: parsed.body,
    ...(parsed.license ? { license: parsed.license } : {}),
    ...(Object.keys(parsed.unknown).length > 0
      ? { imported_frontmatter: parsed.unknown }
      : {}),
    import_origin: `skills-push:${path.basename(resolved)}`,
  });
  if (status === 200 && body.replayed === true) {
    return {
      outcome: "replayed",
      message: `unchanged: ${parsed.name} already imported (${String(body.uid)})`,
      uid: String(body.uid),
    };
  }
  if (status === 200) {
    return {
      outcome: "created",
      message: `imported ${parsed.name} as a candidate (${String(body.uid)}) — review and publish in the dashboard`,
      uid: String(body.uid),
    };
  }
  return {
    outcome: status === 409 ? "conflict" : "error",
    message: `import failed (HTTP ${status}): ${String(body.error ?? "")}`,
    existingUid: (body.existing_uid as string) ?? undefined,
    existingStatus: (body.existing_status as string) ?? undefined,
  };
}
