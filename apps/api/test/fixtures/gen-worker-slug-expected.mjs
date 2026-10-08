#!/usr/bin/env node
/**
 * Generate `worker-slug-expected.json`, a frozen record of what the real
 * `worker/slug.js` returns for the probe battery `lib/slug.test.ts`'s
 * "parity with worker/slug.js" block cares about: `themeSlug()` output on
 * a representative sample, and `THEME_INPUT_PATTERN` matches on a second
 * sample.
 *
 * Run with (from the repo root):
 *   node apps/api/test/fixtures/gen-worker-slug-expected.mjs
 *
 * This script is NOT run in CI and is not a vitest test file (its name
 * does not match *.test.*). `lib/slug.test.ts` only ever reads the
 * committed `worker-slug-expected.json` output -- it must not import
 * `worker/slug.js` at test time (docs/migration/p5-plan.md §2 A1):
 * `worker/` is production code until P5 and the test suite must not
 * depend on its live behaviour to pass or fail. Mirrors the pattern
 * already established by
 * packages/core/test/slug/fixtures/gen-worker-expected.mjs.
 *
 * Re-run this script by hand (and commit the new output) only if
 * `worker/slug.js` is intentionally changed.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_SLUG_JS = resolve(here, "../../../../worker/slug.js");
const OUT_PATH = resolve(here, "worker-slug-expected.json");

// Kept in sync with lib/slug.test.ts's "parity with worker/slug.js" block.
const THEME_SLUG_SAMPLES = [
  "Mixture of Experts",
  "Vision_Transformer",
  "  Diffusion Model  ",
  "RLHF",
  "BERT 2018",
  "a".repeat(200),
];
const THEME_INPUT_CANDIDATES = [
  "Vision Transformer",
  "$(rm -rf ~)",
  "a",
  "a".repeat(81),
  "テスト",
  "Direct-Preference-Optimization",
];

async function main() {
  const legacy = await import(WORKER_SLUG_JS);

  const out = {
    themeSlugSamples: THEME_SLUG_SAMPLES.map((input) => ({
      input,
      slug: legacy.themeSlug(input),
    })),
    themeInputPatternCandidates: THEME_INPUT_CANDIDATES.map((input) => ({
      input,
      matches: legacy.THEME_INPUT_PATTERN.test(input),
    })),
  };

  writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(
    `wrote ${out.themeSlugSamples.length + out.themeInputPatternCandidates.length} cases to ${OUT_PATH}`,
  );
}

main();
