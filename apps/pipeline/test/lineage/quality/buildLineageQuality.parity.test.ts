/**
 * Parity harness (design doc §7.2, brief P4d-3 headline target): the TS port
 * of `build_lineage_quality.py --as-of 2026-08-30T00:00:00Z` must byte-equal
 * the committed `docs/lineage-quality-v1.json`.
 *
 * (a)-class invariant, reworked (p5-plan.md §2 A1, risk R9; coordinator
 * follow-up: the original fixture-mirror of the full `docs/` tree
 * duplicated ~28 MB of published data into git history, too heavy to
 * commit): "the committed published `lineage-quality-v1.json` equals what
 * this builder produces from the LIVE published inputs" is itself an
 * invariant, not a frozen snapshot that can drift -- `promote.ts`
 * regenerates this exact manifest with this exact builder and commits it
 * as part of every promotion (see docs/design/39 §7.4 / the promoter's
 * `refreshSharedOutputs` hook), so "rebuilding from the current live
 * inputs reproduces the current committed artifact" holds both before and
 * after the P5 data move and after every legitimate data update. No
 * fixtures are needed: both sides of the comparison are read live, through
 * `layoutFor(getRepoRoot())` and the `auditFixtures`/`qualityPolicy` named
 * helpers, so this test follows the move automatically once `LAYOUT_MODE`
 * flips, with no change here.
 *
 * `AS_OF` stays the pinned instant baked into `docs/lineage-quality-v1.json`'s
 * own `as_of` field (confirmed below) -- that field is NOT derived from
 * wall-clock time by the builder (it's an input), so keeping it hardcoded
 * here reproduces the committed artifact's `as_of`/freshness-derived
 * `audit_status` values exactly, matching this test's original as-of
 * handling. If a future promotion legitimately re-pins `as_of` to a new
 * instant, this constant must be updated to match (not a drift risk this
 * test can absorb on its own, same as any other promoter-coordinated
 * input).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { auditFixtures, layoutFor, qualityPolicy } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  manifestPayload,
} from "../../../src/lineage/quality/buildLineageQuality.js";

const LAYOUT = layoutFor(getRepoRoot());
const AS_OF = "2026-08-30T00:00:00Z";

describe("buildManifest invariant: live published inputs reproduce the committed lineage-quality-v1.json", () => {
  it("byte-equals the committed artifact when rebuilt from the live inputs at the pinned --as-of instant", () => {
    const fixtures = JSON.parse(readFileSync(auditFixtures(LAYOUT), "utf8"));
    const policy = JSON.parse(readFileSync(qualityPolicy(LAYOUT), "utf8"));
    const manifest = buildManifest({ docsRoot: LAYOUT.published, asOf: AS_OF, fixtures, policy });
    const actual = manifestPayload(manifest);
    const expected = readFileSync(join(LAYOUT.published, "lineage-quality-v1.json"));
    expect(actual.equals(expected)).toBe(true);
  });
});
