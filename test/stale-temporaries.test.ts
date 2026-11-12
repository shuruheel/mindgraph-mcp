import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStaleTemporaries } from "../src/hook-core.js";

describe("sweepStaleTemporaries", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-runtime-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const key = "a".repeat(64);
  const orphan = `${key}.json.4242.055d5a86-5147-43e7-a54b-17ca2e99cd6c.tmp`;

  it("removes an orphaned temporary older than an hour and nothing else", () => {
    const old = Date.now() - 2 * 60 * 60_000;
    for (const name of [orphan, `${key}.json`, "repository-scopes.json", "notes.tmp"]) {
      fs.writeFileSync(path.join(dir, name), "{}");
      fs.utimesSync(path.join(dir, name), old / 1000, old / 1000);
    }
    expect(sweepStaleTemporaries(dir)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual([`${key}.json`, "notes.tmp", "repository-scopes.json"]);
  });

  it("leaves a recent temporary alone: a write may be in flight", () => {
    fs.writeFileSync(path.join(dir, orphan), "{}");
    expect(sweepStaleTemporaries(dir)).toBe(0);
    expect(fs.existsSync(path.join(dir, orphan))).toBe(true);
  });

  it("is a no-op for a missing directory", () => {
    expect(sweepStaleTemporaries(path.join(dir, "absent"))).toBe(0);
  });
});
