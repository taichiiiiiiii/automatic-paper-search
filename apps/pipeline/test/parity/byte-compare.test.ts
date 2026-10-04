import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareTreesByteExact } from "../../src/parity/byte-compare.js";

describe("compareTreesByteExact (--expect-unchanged / --snapshot)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "parity-byte-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("passes when the directory is byte-identical to the snapshot, JSON included", async () => {
    const dir = path.join(tmp, "dir");
    const snapshot = path.join(tmp, "snapshot");
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(snapshot, { recursive: true });
    // even JSON that would be structurally equal under a different formatting must be
    // byte-identical here: this mode checks nothing was written, not semantic equivalence.
    await fs.writeFile(path.join(dir, "a.json"), '{"a":1}\n');
    await fs.writeFile(path.join(snapshot, "a.json"), '{"a":1}\n');

    const report = await compareTreesByteExact({ dir, snapshot });
    expect(report.equal).toBe(true);
    expect(report.mode).toBe("expect-unchanged");
  });

  it("fails when a byte differs, even inside a JSON file (format-only JSON tolerance does not apply here)", async () => {
    const dir = path.join(tmp, "dir");
    const snapshot = path.join(tmp, "snapshot");
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(snapshot, { recursive: true });
    await fs.writeFile(path.join(dir, "a.json"), '{"a": 1.0}\n');
    await fs.writeFile(path.join(snapshot, "a.json"), '{"a": 1}\n');

    const report = await compareTreesByteExact({ dir, snapshot });
    expect(report.equal).toBe(false);
    expect(report.fileResults[0]).toMatchObject({ path: "a.json", equal: false });
  });

  it("fails when a file was written that is absent from the snapshot (extra)", async () => {
    const dir = path.join(tmp, "dir");
    const snapshot = path.join(tmp, "snapshot");
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(snapshot, { recursive: true });
    await fs.writeFile(path.join(dir, "unexpected.json"), "{}");

    const report = await compareTreesByteExact({ dir, snapshot });
    expect(report.equal).toBe(false);
    expect(report.extraFiles).toEqual(["unexpected.json"]);
  });

  it("fails when a snapshot file is missing from the directory", async () => {
    const dir = path.join(tmp, "dir");
    const snapshot = path.join(tmp, "snapshot");
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(snapshot, { recursive: true });
    await fs.writeFile(path.join(snapshot, "expected.json"), "{}");

    const report = await compareTreesByteExact({ dir, snapshot });
    expect(report.equal).toBe(false);
    expect(report.missingFiles).toEqual(["expected.json"]);
  });
});
