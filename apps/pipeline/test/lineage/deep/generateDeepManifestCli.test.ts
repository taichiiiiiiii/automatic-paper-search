/**
 * M3 of the P4 review: `generate_deep_manifest.py`'s `--docs-dir`
 * (required) argparse flag now goes through the shared strict parser —
 * an unknown flag exits 2 instead of being silently ignored.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGenerateDeepManifestCli } from "../../../src/lineage/deep/generateDeepManifestCli.js";

describe("runGenerateDeepManifestCli", () => {
  it("requires --docs-dir", () => {
    expect(runGenerateDeepManifestCli([])).toBe(2);
  });

  it("exits 2 on an unrecognized flag", () => {
    expect(runGenerateDeepManifestCli(["--docs-dirr", "x"])).toBe(2);
  });

  it("returns 1 when --docs-dir does not exist", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "gdm-cli-")), "nope");
    expect(runGenerateDeepManifestCli(["--docs-dir", missing])).toBe(1);
  });

  it("accepts --docs-dir=value (single token) the same as two tokens", () => {
    // An otherwise-empty docs dir (just the papers.json catalog
    // writeManifest cross-checks against, and a slug-shaped basename —
    // the manifest's `conference` field) is enough to prove the `=`
    // form reached the same `--docs-dir` the two-token form does,
    // without needing a full lineage-artifact-v1 fixture.
    const dir = join(mkdtempSync(join(tmpdir(), "gdm-cli-")), "test-conf-2026");
    mkdirSync(dir);
    writeFileSync(join(dir, "papers.json"), "[]\n");
    const rc = runGenerateDeepManifestCli([`--docs-dir=${dir}`]);
    expect(rc).toBe(0);
    expect(existsSync(join(dir, "deep-manifest.json"))).toBe(true);
  });
});
