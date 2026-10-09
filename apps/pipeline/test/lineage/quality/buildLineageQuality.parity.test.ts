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
 * The as-of instant is read from the committed artifact's own `as_of`
 * field. The builder takes it as an input (not wall-clock), and every
 * promotion re-pins it to the promote time (`promote.ts`, `asOf`), so a
 * hardcoded constant broke the promoted tree's own test run on the first
 * real promotion (theme-on-demand run 37947503311). Reading it back keeps
 * the invariant exact: rebuilding at the artifact's instant must reproduce
 * the artifact byte for byte.
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
const COMMITTED_PATH = join(LAYOUT.published, "lineage-quality-v1.json");

describe("buildManifest invariant: live published inputs reproduce the committed lineage-quality-v1.json", () => {
  it("byte-equals the committed artifact when rebuilt from the live inputs at its own as_of instant", () => {
    const expected = readFileSync(COMMITTED_PATH);
    const asOf: unknown = JSON.parse(expected.toString("utf8")).as_of;
    expect(typeof asOf).toBe("string");
    const fixtures = JSON.parse(readFileSync(auditFixtures(LAYOUT), "utf8"));
    const policy = JSON.parse(readFileSync(qualityPolicy(LAYOUT), "utf8"));
    const manifest = buildManifest({
      docsRoot: LAYOUT.published,
      asOf: asOf as string,
      fixtures,
      policy,
    });
    const actual = manifestPayload(manifest);
    expect(actual.equals(expected)).toBe(true);
  });
});
