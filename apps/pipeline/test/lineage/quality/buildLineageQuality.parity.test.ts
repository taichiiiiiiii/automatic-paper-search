/**
 * Parity harness (design doc §7.2, brief P4d-3 headline target): the TS port
 * of `build_lineage_quality.py --as-of 2026-08-30T00:00:00Z` run against the
 * REAL `docs/` tree must byte-equal the committed `docs/lineage-quality-v1.json`.
 *
 * This is deliberately NOT a canned fixture: `docs/` is read-only published
 * data checked into the repo (design doc §7.3 — new code reads it, never
 * writes it during migration), so reading it here is the same thing the real
 * `--check` CLI invocation does, not a network call. Confirmed against the
 * real Python builder first (`uv run --extra dev python -m
 * paperpilot.scripts.build_lineage_quality --as-of 2026-08-30T00:00:00Z
 * --output <tmp>` byte-equals `docs/lineage-quality-v1.json` on this tree, at
 * the time this test was written) — this test pins the TS port to the same
 * ground truth without depending on Python being installed to run.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  manifestPayload,
} from "../../../src/lineage/quality/buildLineageQuality.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/test/lineage/quality -> repo root (5 levels up).
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const DOCS_ROOT = join(REPO_ROOT, "docs");
const AS_OF = "2026-08-30T00:00:00Z";

describe("buildManifest parity: real docs/ tree vs. committed lineage-quality-v1.json", () => {
  it("byte-equals the committed artifact at the pinned --as-of instant", () => {
    const fixtures = JSON.parse(
      readFileSync(join(REPO_ROOT, "paperpilot", "data", "lineage-audit-fixtures-v1.json"), "utf8"),
    );
    const policy = JSON.parse(
      readFileSync(join(REPO_ROOT, "paperpilot", "data", "lineage-quality-policy-v1.json"), "utf8"),
    );
    const manifest = buildManifest({ docsRoot: DOCS_ROOT, asOf: AS_OF, fixtures, policy });
    const actual = manifestPayload(manifest);
    const expected = readFileSync(join(DOCS_ROOT, "lineage-quality-v1.json"));
    expect(actual.equals(expected)).toBe(true);
  });
});
