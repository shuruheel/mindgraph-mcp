import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOARD_MANAGED_CARD_ERROR_CODE,
  boardManagedWriteRefusal,
  canonicalJson,
  fixtureDigest,
  manifestDigest,
  validateLaneCommandRequest,
  validateStoryManifest,
  verifyEvaluatorIntegrity,
  type StoryClaimResponse,
  type StoryEvaluationEvidence,
  type StoryManifestV1,
} from "../src/story-contract.js";

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../docs/work-dashboard/citation-source.fixture.json",
);
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

describe("RFC 8785 canonical JSON", () => {
  it("sorts object keys by UTF-16 code units and normalizes -0", () => {
    expect(canonicalJson({ b: 1, a: -0, "\u20ac": "euro", "\ud83d\ude00": "grin" })).toBe(
      '{"a":0,"b":1,"\u20ac":"euro","\ud83d\ude00":"grin"}',
    );
    expect(canonicalJson({ z: { d: true, c: [3, 2, 1] }, a: null })).toBe(
      '{"a":null,"z":{"c":[3,2,1],"d":true}}',
    );
  });

  it("rejects non-finite numbers and undefined values", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/non-finite/i);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(/non-finite/i);
    expect(() => canonicalJson({ x: undefined })).toThrow(/undefined/i);
  });
});

describe("Story Manifest v1 & citation-source fixture parity", () => {
  it("validates r1 and r2 from citation-source.fixture.json with exact digest parity", () => {
    const r1 = validateStoryManifest(FIXTURE.revisions.r1.manifest);
    const r2 = validateStoryManifest(FIXTURE.revisions.r2.manifest);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.digest).toBe(FIXTURE.revisions.r1.manifest_digest);
    expect(r2.digest).toBe(FIXTURE.revisions.r2.manifest_digest);
    expect(r1.digest).not.toBe(r2.digest);
    expect(r1.fixture_digest).toBe(FIXTURE.revisions.r1.fixture_digest);
    expect(r2.fixture_digest).toBe(FIXTURE.revisions.r2.fixture_digest);
    expect(r1.fixture_digest).toBe(r2.fixture_digest);

    // Key insertion order must not change canonical digest.
    const reordered: StoryManifestV1 = {
      fixture_ref: r2.manifest.fixture_ref,
      panels: r2.manifest.panels,
      acceptance_cases: r2.manifest.acceptance_cases,
      narrative_md: r2.manifest.narrative_md,
      schema_version: 1,
    };
    expect(manifestDigest(reordered)).toBe(r2.digest);
  });

  it("rejects executable markup / XSS payloads in interaction mockups", () => {
    const poisoned = structuredClone(FIXTURE.revisions.r2.manifest);
    poisoned.panels[0].content.passage = '<script>alert("xss")</script>';
    const result = validateStoryManifest(poisoned);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/forbidden executable markup/i);
    }

    const poisonedUri = structuredClone(FIXTURE.revisions.r2.manifest);
    poisonedUri.panels[0].content.citation_label = "javascript:fetch('/steal')";
    const resultUri = validateStoryManifest(poisonedUri);
    expect(resultUri.ok).toBe(false);
  });

  it("rejects transient URLs, path traversal, and invalid asset digests", () => {
    const badUrl = structuredClone(FIXTURE.revisions.r2.manifest);
    badUrl.panels[0].assets = [{ path: "https://signed.example/tmp.png", sha256: "a".repeat(64) }];
    expect(validateStoryManifest(badUrl).ok).toBe(false);

    const traversal = structuredClone(FIXTURE.revisions.r2.manifest);
    traversal.panels[0].assets = [{ path: "../secrets.txt", sha256: "a".repeat(64) }];
    expect(validateStoryManifest(traversal).ok).toBe(false);

    const badHash = structuredClone(FIXTURE.revisions.r2.manifest);
    badHash.panels[0].assets = [{ path: "docs/decisions.md", sha256: "not-hex" }];
    expect(validateStoryManifest(badHash).ok).toBe(false);
  });

  it("rejects acceptance charts referencing unknown cases or mismatched denominators", () => {
    const badChart = structuredClone(FIXTURE.revisions.r2.manifest);
    badChart.panels[2].content.case_ids = ["available", "unknown_case", "unavailable"];
    const res = validateStoryManifest(badChart);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toMatch(/unknown case/i);
  });
});

describe("Independent evaluator integrity & fixture isolation", () => {
  const claim: StoryClaimResponse = FIXTURE.claim_response_r2;
  const passingEvidence: StoryEvaluationEvidence = FIXTURE.evaluation_evidence.r2_passed;
  const expectedCases = ["available", "renamed", "unavailable"];

  it("passes when manifest digest, fixture digest, pinned fixture bytes, and case results all match", () => {
    const check = verifyEvaluatorIntegrity(
      claim,
      passingEvidence,
      claim.fixture_ref.paths,
      expectedCases,
    );
    expect(check).toEqual({ ok: true, passed: 3, total: 3 });
  });

  it("fails closed when a worker modifies a pinned fixture file", () => {
    const tamperedPaths = claim.fixture_ref.paths.map((p) => ({
      path: p.path,
      sha256: "f".repeat(64),
    }));
    const check = verifyEvaluatorIntegrity(claim, passingEvidence, tamperedPaths, expectedCases);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("fixture_tampered");
  });

  it("fails closed on superseded revision or manifest digest mismatch", () => {
    const staleEvidence: StoryEvaluationEvidence = {
      ...FIXTURE.evaluation_evidence.r1_failed,
      run_uid: claim.run_uid,
    };
    const check = verifyEvaluatorIntegrity(claim, staleEvidence, claim.fixture_ref.paths, expectedCases);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("revision_mismatch");

    const badDigestEvidence: StoryEvaluationEvidence = {
      ...passingEvidence,
      manifest_digest: FIXTURE.revisions.r1.manifest_digest,
    };
    const checkDigest = verifyEvaluatorIntegrity(claim, badDigestEvidence, claim.fixture_ref.paths, expectedCases);
    expect(checkDigest.ok).toBe(false);
    if (!checkDigest.ok) expect(checkDigest.code).toBe("manifest_digest_mismatch");
  });

  it("fails closed if an acceptance case is omitted from evaluation evidence", () => {
    const incomplete: StoryEvaluationEvidence = {
      ...passingEvidence,
      case_results: passingEvidence.case_results.slice(0, 2),
      fixture_digest: fixtureDigest(claim.fixture_ref),
    };
    const check = verifyEvaluatorIntegrity(claim, incomplete, claim.fixture_ref.paths, expectedCases);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("missing_case_result");
  });
});

describe("Lane command contract & board-managed write fence", () => {
  it("validates the two-lane chat command and its reverse receipt command", () => {
    expect(validateLaneCommandRequest(FIXTURE.lane_command_example.request).ok).toBe(true);
    expect(validateLaneCommandRequest(FIXTURE.lane_command_example.receipt.reverse_command).ok).toBe(true);
  });

  it("rejects duplicate lane operations in one transaction or missing replay keys", () => {
    const dup = validateLaneCommandRequest({
      command_batch_id: "cmd-dup-1234",
      source: "chat",
      operations: [
        { lane_id: "memory-quality", action: "suspend" },
        { lane_id: "memory-quality", action: "resume" },
      ],
    });
    expect(dup.ok).toBe(false);

    const shortKey = validateLaneCommandRequest({
      command_batch_id: "short",
      source: "chat",
      operations: [{ lane_id: "memory-quality", action: "suspend" }],
    });
    expect(shortKey.ok).toBe(false);
  });

  it("emits a structured refusal for mindgraph_plan mutations against board-managed cards", () => {
    const refusal = boardManagedWriteRefusal("citation-source");
    expect(refusal).toMatchObject({
      error: BOARD_MANAGED_CARD_ERROR_CODE,
      card_uid: "citation-source",
      required_surface: "board_api",
    });
  });
});
