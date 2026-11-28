import { createHash } from "node:crypto";

/**
 * MindGraph Work Dashboard — Story Revision v1 & Lane Command Contract.
 *
 * Pure, zero-dependency contract definitions, RFC 8785 (JCS) canonical JSON
 * serialization, manifest validation, and independent evaluator integrity
 * verification shared across MCP, Dashboard, Cloud, and Repo Worker tests.
 */

export const STORY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const BOARD_MANAGED_CARD_ERROR_CODE = "board_managed_card_write_forbidden" as const;

export type AcceptanceOutcome = "pass" | "fail" | "not_measured";
export type AcceptanceTarget = "pass" | "fail";

export interface AcceptanceCase {
  id: string;
  label: string;
  baseline: AcceptanceOutcome;
  target: AcceptanceTarget;
}

export interface PinnedAsset {
  path: string;
  sha256: string;
}

export interface InteractionMockupContent {
  decision: string;
  citation_label: string;
  passage: string;
  source_path: string;
  revision: string;
  lines: string;
}

export interface BehaviorBranch {
  id: string;
  condition: string;
  outcome: string;
}

export interface BehaviorDiagramContent {
  branches: BehaviorBranch[];
}

export interface AcceptanceChartContent {
  denominator: number;
  baseline_passed: number | null;
  target_passed: number;
  fixture_version: string;
  case_ids: string[];
}

interface StoryPanelBase {
  id: string;
  element_ids: string[];
  accessible_text: string;
  assets: PinnedAsset[];
}

export interface InteractionMockupPanel extends StoryPanelBase {
  kind: "interaction_mockup";
  content: InteractionMockupContent;
}

export interface BehaviorDiagramPanel extends StoryPanelBase {
  kind: "behavior_diagram";
  content: BehaviorDiagramContent;
}

export interface AcceptanceChartPanel extends StoryPanelBase {
  kind: "acceptance_chart";
  content: AcceptanceChartContent;
}

export type StoryPanel =
  | InteractionMockupPanel
  | BehaviorDiagramPanel
  | AcceptanceChartPanel;

export interface FixtureRef {
  repo_ref: string;
  fixture_version: string;
  paths: PinnedAsset[];
}

export interface StoryManifestV1 {
  schema_version: typeof STORY_MANIFEST_SCHEMA_VERSION;
  narrative_md: string;
  acceptance_cases: AcceptanceCase[];
  panels: StoryPanel[];
  fixture_ref: FixtureRef;
}

export interface StoryApprovalRequest {
  card_uid: string;
  revision_uid: string;
  manifest_digest: string;
  expected_version: number;
  request_key: string;
}

export interface StoryApprovalReceipt {
  approval_uid: string;
  card_uid: string;
  revision_uid: string;
  manifest_digest: string;
  board_version: number;
  approved_by: string;
  approved_at: string;
  superseded_by?: string;
}

export interface StoryClaimResponse {
  run_uid: string;
  card_uid: string;
  revision_uid: string;
  manifest_digest: string;
  manifest_ref: string;
  tested_base_commit: string;
  fixture_ref: FixtureRef;
}

export interface CaseEvaluationResult {
  case_id: string;
  outcome: "pass" | "fail";
  detail?: string;
}

export interface StoryEvaluationEvidence {
  run_uid: string;
  revision_uid: string;
  manifest_digest: string;
  tested_tree_digest: string;
  fixture_digest: string;
  case_results: CaseEvaluationResult[];
  evaluator_version: string;
}

export type LaneState = "active" | "suspended";
export type LaneCommandAction = "start" | "suspend" | "resume";

export interface LaneCommandOperation {
  lane_id: string;
  action: LaneCommandAction;
}

export interface LaneCommandRequest {
  command_batch_id: string;
  source: "board" | "chat";
  operations: LaneCommandOperation[];
}

export interface LaneWorkerStatus {
  lane_id: string;
  state: LaneState;
  worker_status: "idle" | "running" | "pausing_checkpoint" | "waiting_for_worker" | "suspended";
  eligible_ready_stories: number;
  open_blockers: number;
}

export interface LaneCommandReceipt {
  command_batch_id: string;
  board_version: number;
  affected_lanes: LaneWorkerStatus[];
  reverse_command: LaneCommandRequest;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const STABLE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UNSAFE_MARKUP_RE = /<\s*\/?\s*(?:script|iframe|object|embed|svg)\b|javascript\s*:|\bon[a-z]+\s*=/i;

/**
 * RFC 8785 (JSON Canonicalization Scheme) serializer.
 *
 * - Object keys sorted by UTF-16 code units (`<` / `>`, never localeCompare).
 * - Rejects non-finite numbers (`NaN`, `Infinity`) and non-JSON values (`undefined`, functions, symbols).
 * - Normalizes `-0` to `0`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("RFC 8785 canonical JSON forbids non-finite numbers.");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error("RFC 8785 canonical JSON accepts only plain objects.");
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const entries: string[] = [];
      for (const key of keys) {
        const entry = record[key];
        if (entry === undefined) {
          throw new Error(`RFC 8785 canonical JSON forbids undefined property "${key}".`);
        }
        entries.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
      }
      return `{${entries.join(",")}}`;
    }
    default:
      throw new Error(`RFC 8785 canonical JSON forbids value of type ${typeof value}.`);
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function manifestDigest(manifest: StoryManifestV1): string {
  return `sha256:${sha256Hex(canonicalJson(manifest))}`;
}

export function fixtureDigest(fixtureRef: FixtureRef): string {
  return `sha256:${sha256Hex(canonicalJson(fixtureRef))}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeRelativeAssetPath(p: string): boolean {
  if (!p || p.length > 512) return false;
  if (p.startsWith("/") || p.includes("\\") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return false;
  const segments = p.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

function assertSafeText(value: unknown, field: string, errors: string[]): value is string {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} must be a non-empty string.`);
    return false;
  }
  if (UNSAFE_MARKUP_RE.test(value)) {
    errors.push(`${field} contains forbidden executable markup or script URI.`);
    return false;
  }
  return true;
}

function validateAssets(assets: unknown, field: string, errors: string[]): void {
  if (!Array.isArray(assets)) {
    errors.push(`${field} must be an array.`);
    return;
  }
  const seen = new Set<string>();
  assets.forEach((asset, index) => {
    const prefix = `${field}[${index}]`;
    if (!isPlainRecord(asset)) {
      errors.push(`${prefix} must be an object.`);
      return;
    }
    if (typeof asset.path !== "string" || !isSafeRelativeAssetPath(asset.path)) {
      errors.push(`${prefix}.path must be a safe relative repository path (no URLs or traversal).`);
    } else if (seen.has(asset.path)) {
      errors.push(`${prefix}.path duplicates "${asset.path}".`);
    } else {
      seen.add(asset.path);
    }
    if (typeof asset.sha256 !== "string" || !SHA256_HEX_RE.test(asset.sha256)) {
      errors.push(`${prefix}.sha256 must be a 64-character lowercase hex SHA-256 digest.`);
    }
  });
}

export function validateStoryManifest(
  input: unknown,
): { ok: true; manifest: StoryManifestV1; digest: string; fixture_digest: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainRecord(input)) {
    return { ok: false, errors: ["Manifest must be a plain JSON object."] };
  }
  if (input.schema_version !== STORY_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schema_version must equal ${STORY_MANIFEST_SCHEMA_VERSION}.`);
  }
  assertSafeText(input.narrative_md, "narrative_md", errors);

  const caseIds = new Set<string>();
  if (!Array.isArray(input.acceptance_cases) || input.acceptance_cases.length === 0) {
    errors.push("acceptance_cases must be a non-empty array.");
  } else {
    input.acceptance_cases.forEach((c, index) => {
      const prefix = `acceptance_cases[${index}]`;
      if (!isPlainRecord(c)) {
        errors.push(`${prefix} must be an object.`);
        return;
      }
      if (typeof c.id !== "string" || !STABLE_ID_RE.test(c.id)) {
        errors.push(`${prefix}.id must match ${STABLE_ID_RE.source}.`);
      } else if (caseIds.has(c.id)) {
        errors.push(`${prefix}.id duplicates "${c.id}".`);
      } else {
        caseIds.add(c.id);
      }
      assertSafeText(c.label, `${prefix}.label`, errors);
      if (c.baseline !== "pass" && c.baseline !== "fail" && c.baseline !== "not_measured") {
        errors.push(`${prefix}.baseline must be pass, fail, or not_measured.`);
      }
      if (c.target !== "pass" && c.target !== "fail") {
        errors.push(`${prefix}.target must be pass or fail.`);
      }
    });
  }

  if (!Array.isArray(input.panels) || input.panels.length === 0) {
    errors.push("panels must be a non-empty ordered array.");
  } else {
    const panelIds = new Set<string>();
    input.panels.forEach((panel, index) => {
      const prefix = `panels[${index}]`;
      if (!isPlainRecord(panel)) {
        errors.push(`${prefix} must be an object.`);
        return;
      }
      if (typeof panel.id !== "string" || !STABLE_ID_RE.test(panel.id)) {
        errors.push(`${prefix}.id must match ${STABLE_ID_RE.source}.`);
      } else if (panelIds.has(panel.id)) {
        errors.push(`${prefix}.id duplicates "${panel.id}".`);
      } else {
        panelIds.add(panel.id);
      }
      assertSafeText(panel.accessible_text, `${prefix}.accessible_text`, errors);
      validateAssets(panel.assets, `${prefix}.assets`, errors);

      const elementIds = new Set<string>();
      if (!Array.isArray(panel.element_ids) || panel.element_ids.length === 0) {
        errors.push(`${prefix}.element_ids must be a non-empty array.`);
      } else {
        for (const eid of panel.element_ids) {
          if (typeof eid !== "string" || !STABLE_ID_RE.test(eid)) {
            errors.push(`${prefix}.element_ids contains invalid ID "${String(eid)}".`);
          } else if (elementIds.has(eid)) {
            errors.push(`${prefix}.element_ids duplicates "${eid}".`);
          } else {
            elementIds.add(eid);
          }
        }
      }

      if (!isPlainRecord(panel.content)) {
        errors.push(`${prefix}.content must be a declarative object.`);
        return;
      }

      switch (panel.kind) {
        case "interaction_mockup":
          assertSafeText(panel.content.decision, `${prefix}.content.decision`, errors);
          assertSafeText(panel.content.citation_label, `${prefix}.content.citation_label`, errors);
          assertSafeText(panel.content.passage, `${prefix}.content.passage`, errors);
          assertSafeText(panel.content.source_path, `${prefix}.content.source_path`, errors);
          assertSafeText(panel.content.revision, `${prefix}.content.revision`, errors);
          assertSafeText(panel.content.lines, `${prefix}.content.lines`, errors);
          break;
        case "behavior_diagram": {
          const branches = panel.content.branches;
          if (!Array.isArray(branches) || branches.length === 0) {
            errors.push(`${prefix}.content.branches must be a non-empty array.`);
          } else {
            const branchIds = new Set<string>();
            branches.forEach((b, bIdx) => {
              const bPrefix = `${prefix}.content.branches[${bIdx}]`;
              if (!isPlainRecord(b)) {
                errors.push(`${bPrefix} must be an object.`);
                return;
              }
              if (typeof b.id !== "string" || !STABLE_ID_RE.test(b.id)) {
                errors.push(`${bPrefix}.id must match ${STABLE_ID_RE.source}.`);
              } else if (branchIds.has(b.id)) {
                errors.push(`${bPrefix}.id duplicates "${b.id}".`);
              } else {
                branchIds.add(b.id);
                if (!elementIds.has(b.id)) {
                  errors.push(`${bPrefix}.id "${b.id}" must be listed in ${prefix}.element_ids.`);
                }
              }
              assertSafeText(b.condition, `${bPrefix}.condition`, errors);
              assertSafeText(b.outcome, `${bPrefix}.outcome`, errors);
            });
          }
          break;
        }
        case "acceptance_chart": {
          const { denominator, baseline_passed, target_passed, fixture_version, case_ids } = panel.content;
          if (typeof denominator !== "number" || !Number.isInteger(denominator) || denominator <= 0) {
            errors.push(`${prefix}.content.denominator must be a positive integer.`);
          }
          if (
            baseline_passed !== null &&
            (typeof baseline_passed !== "number" ||
              !Number.isInteger(baseline_passed) ||
              baseline_passed < 0 ||
              (typeof denominator === "number" && baseline_passed > denominator))
          ) {
            errors.push(`${prefix}.content.baseline_passed must be null or an integer within 0..denominator.`);
          }
          if (
            typeof target_passed !== "number" ||
            !Number.isInteger(target_passed) ||
            target_passed < 0 ||
            (typeof denominator === "number" && target_passed > denominator)
          ) {
            errors.push(`${prefix}.content.target_passed must be an integer within 0..denominator.`);
          }
          assertSafeText(fixture_version, `${prefix}.content.fixture_version`, errors);
          if (!Array.isArray(case_ids) || case_ids.length === 0) {
            errors.push(`${prefix}.content.case_ids must be a non-empty array.`);
          } else {
            for (const cid of case_ids) {
              if (typeof cid !== "string" || !caseIds.has(cid)) {
                errors.push(`${prefix}.content.case_ids references unknown case "${String(cid)}".`);
              }
            }
            if (typeof denominator === "number" && case_ids.length !== denominator) {
              errors.push(`${prefix}.content.case_ids length must match denominator (${denominator}).`);
            }
          }
          break;
        }
        default:
          errors.push(`${prefix}.kind "${String(panel.kind)}" is not a supported v1 panel kind.`);
      }
    });
  }

  if (!isPlainRecord(input.fixture_ref)) {
    errors.push("fixture_ref must be an object.");
  } else {
    assertSafeText(input.fixture_ref.repo_ref, "fixture_ref.repo_ref", errors);
    assertSafeText(input.fixture_ref.fixture_version, "fixture_ref.fixture_version", errors);
    if (!Array.isArray(input.fixture_ref.paths) || input.fixture_ref.paths.length === 0) {
      errors.push("fixture_ref.paths must pin at least one immutable fixture file.");
    } else {
      validateAssets(input.fixture_ref.paths, "fixture_ref.paths", errors);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const manifest = input as unknown as StoryManifestV1;
  return {
    ok: true,
    manifest,
    digest: manifestDigest(manifest),
    fixture_digest: fixtureDigest(manifest.fixture_ref),
  };
}

/**
 * Independent evaluator integrity check: verifies that evaluation evidence
 * matches the claimed revision, canonical manifest digest, immutable fixture
 * digest, every pinned fixture file digest (catching worker fixture tampering),
 * and every required acceptance case ID.
 */
export function verifyEvaluatorIntegrity(
  claim: StoryClaimResponse,
  evidence: StoryEvaluationEvidence,
  evaluatedFixturePaths: PinnedAsset[],
  expectedCaseIds: string[],
): { ok: true; passed: number; total: number } | { ok: false; code: string; reason: string } {
  if (evidence.run_uid !== claim.run_uid) {
    return { ok: false, code: "run_mismatch", reason: `Evidence run_uid (${evidence.run_uid}) does not match claim (${claim.run_uid}).` };
  }
  if (evidence.revision_uid !== claim.revision_uid) {
    return { ok: false, code: "revision_mismatch", reason: `Evidence revision (${evidence.revision_uid}) does not match claim (${claim.revision_uid}).` };
  }
  if (!DIGEST_RE.test(evidence.manifest_digest) || evidence.manifest_digest !== claim.manifest_digest) {
    return { ok: false, code: "manifest_digest_mismatch", reason: "Evidence manifest_digest does not match approved claim digest." };
  }
  const expectedFixtureDigest = fixtureDigest(claim.fixture_ref);
  if (evidence.fixture_digest !== expectedFixtureDigest) {
    return { ok: false, code: "fixture_digest_mismatch", reason: "Evidence fixture_digest does not match immutable fixture_ref." };
  }
  const actualMap = new Map(evaluatedFixturePaths.map((p) => [p.path, p.sha256]));
  for (const pinned of claim.fixture_ref.paths) {
    const observed = actualMap.get(pinned.path);
    if (!observed) {
      return { ok: false, code: "fixture_missing", reason: `Pinned fixture path "${pinned.path}" is missing from evaluated tree.` };
    }
    if (observed !== pinned.sha256) {
      return {
        ok: false,
        code: "fixture_tampered",
        reason: `Pinned fixture path "${pinned.path}" digest mismatch (expected ${pinned.sha256}, got ${observed}).`,
      };
    }
  }
  const seenCases = new Map<string, CaseEvaluationResult>();
  for (const result of evidence.case_results) {
    if (seenCases.has(result.case_id)) {
      return { ok: false, code: "duplicate_case_result", reason: `Duplicate evaluation result for case "${result.case_id}".` };
    }
    seenCases.set(result.case_id, result);
  }
  for (const caseId of expectedCaseIds) {
    if (!seenCases.has(caseId)) {
      return { ok: false, code: "missing_case_result", reason: `Missing evaluation result for case "${caseId}".` };
    }
  }
  const passed = expectedCaseIds.filter((id) => seenCases.get(id)?.outcome === "pass").length;
  return { ok: true, passed, total: expectedCaseIds.length };
}

export function validateLaneCommandRequest(
  input: unknown,
): { ok: true; command: LaneCommandRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainRecord(input)) {
    return { ok: false, errors: ["Lane command request must be an object."] };
  }
  if (typeof input.command_batch_id !== "string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.command_batch_id)) {
    errors.push("command_batch_id must be a stable 8..128 character replay key.");
  }
  if (input.source !== "board" && input.source !== "chat") {
    errors.push('source must be "board" or "chat".');
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    errors.push("operations must be a non-empty array.");
  } else {
    const seenLanes = new Set<string>();
    input.operations.forEach((op, index) => {
      const prefix = `operations[${index}]`;
      if (!isPlainRecord(op)) {
        errors.push(`${prefix} must be an object.`);
        return;
      }
      if (typeof op.lane_id !== "string" || !STABLE_ID_RE.test(op.lane_id)) {
        errors.push(`${prefix}.lane_id must be a stable lane identifier.`);
      } else if (seenLanes.has(op.lane_id)) {
        errors.push(`${prefix}.lane_id "${op.lane_id}" appears more than once in the same transaction.`);
      } else {
        seenLanes.add(op.lane_id);
      }
      if (op.action !== "start" && op.action !== "suspend" && op.action !== "resume") {
        errors.push(`${prefix}.action must be start, suspend, or resume.`);
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, command: input as unknown as LaneCommandRequest };
}

/**
 * Structured refusal payload returned when a caller attempts to mutate a
 * board-managed story card through `mindgraph_plan` or general SDK plan routes.
 */
export function boardManagedWriteRefusal(cardUid: string): {
  error: typeof BOARD_MANAGED_CARD_ERROR_CODE;
  card_uid: string;
  message: string;
  required_surface: "board_api";
} {
  return {
    error: BOARD_MANAGED_CARD_ERROR_CODE,
    card_uid: cardUid,
    message: `Card "${cardUid}" is board-managed. Submit revisions, approvals, and claims through the board API instead of mindgraph_plan.`,
    required_surface: "board_api",
  };
}
