import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isValidSkillName,
  parseSkillMd,
  renderSkillMd,
  skillsPull,
  skillsPush,
  type PushOutcome,
  type SkillDetail,
  type SkillsApi,
} from "../src/skills-cli.js";

function detail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    uid: "uid-1",
    name: "deploy-checklist",
    description: "Deploy review steps.",
    content: "# Steps\n\nDo the thing.",
    license: "MIT",
    status: "published",
    status_reason: null,
    content_hash: "hash-1",
    version: 3,
    ...overrides,
  };
}

/** In-memory server: `skills` is the published+granted set; `archive` keeps
 * withdrawn skills reachable by uid for status_reason reporting. */
function fakeApi(
  skills: SkillDetail[],
  archive: SkillDetail[] = []
): SkillsApi & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    async list() {
      return skills.map((skill) => ({
        uid: skill.uid,
        name: skill.name,
        status: skill.status,
        status_reason: skill.status_reason,
        content_hash: skill.content_hash,
        version: skill.version,
      }));
    },
    async get(uid: string) {
      return (
        skills.find((skill) => skill.uid === uid) ??
        archive.find((skill) => skill.uid === uid) ??
        null
      );
    },
    async send(body: Record<string, unknown>): Promise<PushOutcome> {
      sent.push(body);
      return { status: 200, body: { uid: "uid-new", created: true } };
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-skills-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SKILL.md rendering (I13: spec-legal-subset export)", () => {
  it("emits only allowlisted frontmatter and round-trips through the parser", () => {
    const skill = detail();
    const rendered = renderSkillMd(skill);
    expect(rendered).toContain('name: "deploy-checklist"');
    expect(rendered).toContain("mindgraph-uid");
    expect(rendered).toContain("mindgraph-content-hash");

    const parsed = parseSkillMd(rendered);
    expect(parsed?.name).toBe("deploy-checklist");
    expect(parsed?.description).toBe("Deploy review steps.");
    expect(parsed?.license).toBe("MIT");
    expect(parsed?.pin).toEqual({
      uid: "uid-1",
      version: "3",
      contentHash: "hash-1",
    });
    expect(parsed?.body).toBe(skill.content);
    expect(Object.keys(parsed?.unknown ?? { x: 1 })).toHaveLength(0);
  });

  // A7: capability-affecting keys are captured for review on import but
  // never re-emitted on export — the renderer takes only allowlisted fields,
  // so a skill whose imported frontmatter contained `allowed-tools` exports
  // WITHOUT it by construction.
  it("captures capability keys as inert raw text on parse; render cannot emit them", () => {
    const incoming = [
      "---",
      "name: helper",
      "description: Helps.",
      "allowed-tools: Bash, Edit",
      "model: opus",
      "custom-block:",
      "  nested: true",
      "---",
      "",
      "# Body",
      "",
    ].join("\n");
    const parsed = parseSkillMd(incoming);
    expect(parsed?.unknown["allowed-tools"]).toContain("Bash");
    expect(parsed?.unknown["model"]).toContain("opus");
    expect(parsed?.unknown["custom-block"]).toContain("nested: true");

    const rendered = renderSkillMd(detail({ name: "helper" }));
    expect(rendered).not.toContain("allowed-tools");
    expect(rendered).not.toContain("model:");
  });

  it("rejects invalid names (grammar is the first traversal defense)", () => {
    for (const bad of ["../x", "a/b", "Upper", "has space", "-lead", ""]) {
      expect(isValidSkillName(bad)).toBe(false);
    }
    expect(isValidSkillName("deploy-checklist")).toBe(true);
  });
});

describe("skills pull (A7)", () => {
  it("writes, then re-pull is a no-op, then upstream change overwrites", async () => {
    const skill = detail();
    let api = fakeApi([skill]);
    let report = await skillsPull(api, dir);
    expect(report.written).toEqual(["deploy-checklist"]);
    const file = path.join(dir, "deploy-checklist", "SKILL.md");
    expect(fs.existsSync(file)).toBe(true);

    report = await skillsPull(api, dir);
    expect(report.unchanged).toEqual(["deploy-checklist"]);
    expect(report.written).toHaveLength(0);

    const updated = detail({ content: "# Steps v2", content_hash: "hash-2" });
    api = fakeApi([updated]);
    report = await skillsPull(api, dir);
    expect(report.written).toEqual(["deploy-checklist"]);
    expect(fs.readFileSync(file, "utf8")).toContain("# Steps v2");
  });

  it("never overwrites local edits: upstream change lands as .conflict", async () => {
    const api = fakeApi([detail()]);
    await skillsPull(api, dir);
    const file = path.join(dir, "deploy-checklist", "SKILL.md");
    fs.writeFileSync(file, "my local edits");

    // Upstream unchanged: left entirely alone.
    let report = await skillsPull(api, dir);
    expect(report.locallyEdited).toEqual(["deploy-checklist"]);
    expect(fs.readFileSync(file, "utf8")).toBe("my local edits");
    expect(fs.existsSync(`${file}.conflict`)).toBe(false);

    // Upstream changed: conflict sidecar, local bytes untouched.
    const changed = fakeApi([
      detail({ content: "# Steps v2", content_hash: "hash-2" }),
    ]);
    report = await skillsPull(changed, dir);
    expect(report.conflicts).toEqual(["deploy-checklist"]);
    expect(fs.readFileSync(file, "utf8")).toBe("my local edits");
    expect(fs.readFileSync(`${file}.conflict`, "utf8")).toContain("# Steps v2");
  });

  // T-SEM5/I3: eligibility loss withdraws the skill — revoked instructions
  // never persist silently.
  it("withdraws revoked skills: unmodified removed with status_reason, modified disabled", async () => {
    const first = detail();
    const second = detail({ uid: "uid-2", name: "second-skill" });
    await skillsPull(fakeApi([first, second]), dir);
    // Locally modify the second before both are withdrawn.
    const secondFile = path.join(dir, "second-skill", "SKILL.md");
    fs.writeFileSync(secondFile, "edited locally");

    const archived = detail({
      status: "archived",
      status_reason: "superseded by v2",
    });
    const revokedSecond = detail({
      uid: "uid-2",
      name: "second-skill",
      status: "published",
    });
    const report = await skillsPull(fakeApi([], [archived, revokedSecond]), dir);

    const removedFirst = report.removed.find(
      (entry) => entry.name === "deploy-checklist"
    );
    expect(removedFirst?.kept).toBe(false);
    expect(removedFirst?.statusReason).toBe("superseded by v2");
    expect(fs.existsSync(path.join(dir, "deploy-checklist"))).toBe(false);

    const removedSecond = report.removed.find(
      (entry) => entry.name === "second-skill"
    );
    expect(removedSecond?.kept).toBe(true);
    expect(fs.existsSync(secondFile)).toBe(false);
    expect(fs.readFileSync(`${secondFile}.conflict`, "utf8")).toBe(
      "edited locally"
    );
  });

  // A15: a hostile pre-existing symlink at the target path refuses the write.
  it("refuses to write through a symlinked target (A15)", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mg-outside-"));
    try {
      fs.symlinkSync(outside, path.join(dir, "deploy-checklist"));
      const report = await skillsPull(fakeApi([detail()]), dir);
      expect(report.refused).toHaveLength(1);
      expect(report.refused[0].reason).toContain("symlink");
      expect(fs.readdirSync(outside)).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses server-supplied names outside the grammar", async () => {
    const report = await skillsPull(
      fakeApi([detail({ name: "../escape" })]),
      dir
    );
    expect(report.refused).toHaveLength(1);
    expect(fs.existsSync(path.join(path.dirname(dir), "escape"))).toBe(false);
  });
});

describe("skills push (A8 routing)", () => {
  it("uid-less directories create as imported candidates with inert frontmatter", async () => {
    const skillDir = path.join(dir, "my-skill");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: my-skill",
        "description: Mine.",
        "allowed-tools: Bash",
        "---",
        "",
        "# Body",
      ].join("\n")
    );
    const api = fakeApi([]);
    const report = await skillsPush(api, skillDir);
    expect(report.outcome).toBe("created");
    expect(api.sent).toHaveLength(1);
    const body = api.sent[0];
    expect(body.action).toBe("create");
    expect(body.skill_source).toBe("imported");
    expect(body.name).toBe("my-skill");
    expect(
      (body.imported_frontmatter as Record<string, string>)["allowed-tools"]
    ).toContain("Bash");
  });

  it("pin metadata routes to the candidate-only update path", async () => {
    const api = fakeApi([detail()]);
    await skillsPull(api, dir);
    const skillDir = path.join(dir, "deploy-checklist");
    const report = await skillsPush(api, skillDir);
    expect(report.outcome).toBe("updated");
    const update = api.sent.find((body) => body.action === "update");
    expect(update?.uid).toBe("uid-1");
  });

  it("surfaces idempotency conflicts with the existing uid and status", async () => {
    const skillDir = path.join(dir, "taken");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: taken\ndescription: d\n---\n\nbody"
    );
    const api: SkillsApi = {
      list: async () => [],
      get: async () => null,
      send: async () => ({
        status: 409,
        body: {
          error: "conflict",
          code: "idempotency_conflict",
          existing_uid: "uid-x",
          existing_status: "published",
        },
      }),
    };
    const report = await skillsPush(api, skillDir);
    expect(report.outcome).toBe("conflict");
    expect(report.existingUid).toBe("uid-x");
    expect(report.existingStatus).toBe("published");
  });
});
