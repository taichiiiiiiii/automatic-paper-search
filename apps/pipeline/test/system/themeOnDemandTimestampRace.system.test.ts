/**
 * System test (R2-34): reproduces the exact publication-blocking bug a
 * real on-demand run hit (run 38221581049, "Low-Rank Adaptation") --
 * generation, packaging, and promotion all succeed, but the published
 * `lineage-quality-v1.json` row for the theme ends up `blocked`
 * because `timestamp_not_future` fails on a sub-second race:
 * `meta.generated_at` keeps milliseconds (`pyIsoformat`) while the
 * `as_of` the workflow/promoter use is always whole-second
 * (`.github/workflows/theme-on-demand.yml`'s `date -u
 * +%Y-%m-%dT%H:%M:%SZ`, `release/promote.ts`'s own fallback). This
 * runs the REAL `release/cli.ts package` -> `promote()` ->
 * `buildLineageQualityCli` chain (same as `themeLineage.system.test.ts`),
 * not a unit-level stand-in, so a regression in the comparison OR in
 * how any of those CLIs construct/forward `as_of` would fail this.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { originFile, promoteInSandbox, type SpawnRecord } from "./support/promoteHarness.js";
import { describeRun, runCli } from "./support/runCli.js";
import { createSandbox, type Sandbox } from "./support/sandbox.js";
import { THEME_DIR } from "./support/scenarios.js";

const LINEAGE = `${THEME_DIR}/lineage.json`;
// A brand-new slug, distinct from "flash-attention", so the sandbox's
// real `lineage-audit-fixtures-v1.json` (copied from `data/config`,
// which DOES carry a human-reviewed golden fixture bound by hash to
// the pristine flash-attention artifact) has no entry for it -- just
// like a genuinely new on-demand theme request. Reusing the
// flash-attention slug directly would fail on `golden_fixture`
// (input_sha256 mismatch from this test's own byte edit), a different
// and unrelated failure mode from the one under test.
const NEW_SLUG = "low-rank-adaptation-race-test";
const NEW_DIR = `data/published/themes/${NEW_SLUG}`;
const NEW_LINEAGE = `${NEW_DIR}/lineage.json`;

describe("theme on-demand publish (R2-34): sub-second generated_at vs whole-second as_of", () => {
  let sb: Sandbox;
  afterAll(() => sb?.cleanup());

  it("does not block publication when generated_at's milliseconds push it past as_of's truncated second", async () => {
    sb = createSandbox({
      copyData: [THEME_DIR, "data/published/identity-aliases-v1.json"],
      files: { "data/published/conferences.json": [] },
    });

    // Simulate the real run's "Freeze candidate metadata" step
    // (theme-on-demand.yml): `as_of` is captured a moment AFTER
    // generation finished, as `date -u +%Y-%m-%dT%H:%M:%SZ` (whole
    // second, floored, never ceiled). Pick an as_of whole second and
    // give the newly-"generated" (here: reused flash-attention bytes,
    // under a brand-new slug) lineage a generated_at that lands later
    // in that SAME second (`.750Z`) -- textually later, even though
    // generation strictly preceded the as_of capture.
    const asOfDate = new Date();
    asOfDate.setUTCMilliseconds(0);
    const asOf = `${asOfDate.toISOString().slice(0, 19)}Z`;
    const racingGeneratedAt = `${asOf.slice(0, -1)}.750Z`;

    const lineage = JSON.parse(readFileSync(sb.path(LINEAGE), "utf8")) as {
      root: string;
      meta: Record<string, unknown>;
      [key: string]: unknown;
    };
    lineage.meta = {
      ...lineage.meta,
      slug: NEW_SLUG,
      generated_at: racingGeneratedAt,
    };
    mkdirSync(sb.path(NEW_DIR), { recursive: true });
    writeFileSync(sb.path(NEW_LINEAGE), `${JSON.stringify(lineage, null, 2)}\n`);
    // Deliberately NOT committed: `promote()` checks out `baseSha` (the
    // sandbox's original pushed commit) into a fresh worktree and
    // applies the packaged candidate dir on top, so only the candidate
    // package (built from this working-tree addition) needs to carry
    // the race timestamp -- matching how the real workflow's
    // `generate` job hands a freshly generated (uncommitted) tree to
    // `package`.

    const candidate = sb.path("..", "candidate");
    const pkg = await runCli(sb, "release/cli.ts", ["package", candidate, NEW_DIR], {
      env: { PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED: "1" },
    });
    expect(pkg.code, describeRun(pkg)).toBe(0);

    const baseSha = sb.git("rev-parse", "HEAD");
    const spawnLog: SpawnRecord[] = [];
    const res = await promoteInSandbox(sb, {
      kind: "themes",
      candidateDir: candidate,
      allowedPaths: [NEW_DIR],
      baseSha,
      asOf,
      log: spawnLog,
    }).catch((e: Error) => {
      throw new Error(
        `${e.message}\n${spawnLog.map((s) => `${s.argv.join(" ")} -> ${s.exitCode}\n${s.output.slice(-1500)}`).join("\n")}`,
      );
    });
    expect(res.changed).toBe(true);
    expect(spawnLog.map((s) => s.exitCode)).toEqual(spawnLog.map(() => 0));

    const quality = JSON.parse(originFile(sb, "data/published/lineage-quality-v1.json")) as {
      as_of: string;
      collections: Array<{
        collection_id: string;
        publication_tier: string;
        generated_at: string;
        audit: { checks: Array<{ name: string; status: string }> };
      }>;
    };
    expect(quality.as_of).toBe(asOf);
    const row = quality.collections.find((c) => c.collection_id === `theme:${NEW_SLUG}`);
    if (!row) {
      throw new Error(
        `no quality row for theme:${NEW_SLUG}; collections: ${JSON.stringify(quality.collections.map((c) => c.collection_id))}`,
      );
    }
    expect(row.generated_at).toBe(racingGeneratedAt);
    const timestampCheck = row.audit.checks.find((c) => c.name === "timestamp_not_future")!;
    // The actual bug: this used to be "failed", which forces `blocked`
    // regardless of every other check (contract.ts's publicationTier).
    expect(timestampCheck.status).toBe("passed");
    // A new theme has no human golden fixture yet (`unknown`, not
    // `failed`), so once the timestamp race is fixed it publishes as
    // `unaudited` (design doc 41 D1) -- never `blocked`.
    expect(row.publication_tier).toBe("unaudited");
  });
});
