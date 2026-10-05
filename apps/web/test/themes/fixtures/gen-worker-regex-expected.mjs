#!/usr/bin/env node
/**
 * Generate `worker-slug-regex-expected.json`, a frozen record of what the
 * real `worker/slug.js`'s `SLUG_RE` / `THEME_INPUT_PATTERN` regex literals
 * match/reject for the probe battery `slug-parity.test.ts` cares about.
 *
 * Run with (from the repo root):
 *   node apps/web/test/themes/fixtures/gen-worker-regex-expected.mjs
 *
 * This script is NOT run in CI and is not a vitest test file (its name
 * does not match *.test.*). `slug-parity.test.ts` only ever reads the
 * committed `worker-slug-regex-expected.json` output -- it must not read
 * or eval `worker/slug.js`'s source at test time (docs/migration/p5-plan.md
 * §2 A1): `worker/` is production code until P5 and the test suite must
 * not depend on its live content to pass or fail.
 *
 * Re-run this script by hand (and commit the new output) only if
 * `worker/slug.js`'s `SLUG_RE` or `THEME_INPUT_PATTERN` is intentionally
 * changed. Mirrors the pattern already established by
 * packages/core/test/slug/fixtures/gen-worker-expected.mjs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_SLUG_JS = resolve(here, "../../../../../worker/slug.js");
const OUT_PATH = resolve(here, "worker-slug-regex-expected.json");

// Kept in sync with slug-parity.test.ts's SLUG_PROBES / THEME_INPUT_PROBES.
const SLUG_PROBES = [
  "",
  "a",
  "vision-transformer",
  "flash-attention-2",
  "../x",
  "Mixture-Of-Experts",
  "テーマ",
  "a--b",
  "-leading",
  "trailing-",
  "a".repeat(64),
];
const THEME_INPUT_PROBES = [
  "",
  "a",
  "Vision Transformer",
  "x".repeat(80),
  "x".repeat(81),
  "rm -rf /",
  "テーマ名",
  "under_score-hyphen 123",
  "semi;colon",
];

function extractRegexLiteral(src, constName) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*=\\s*(/.*?/[a-z]*)\\s*;`);
  const match = src.match(re);
  if (!match?.[1]) {
    throw new Error(`could not find const ${constName} in worker/slug.js`);
  }
  // eslint-disable-next-line no-eval -- trusted local source file, not user input, build-time only
  return new Function(`return ${match[1]};`)();
}

function main() {
  const src = readFileSync(WORKER_SLUG_JS, "utf8");
  const slugRe = extractRegexLiteral(src, "SLUG_RE");
  const themeInputRe = extractRegexLiteral(src, "THEME_INPUT_PATTERN");

  const out = {
    slugRe: SLUG_PROBES.map((input) => ({ input, matches: slugRe.test(input) })),
    themeInputPattern: THEME_INPUT_PROBES.map((input) => ({
      input,
      matches: themeInputRe.test(input),
    })),
  };

  writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`wrote ${out.slugRe.length + out.themeInputPattern.length} cases to ${OUT_PATH}`);
}

main();
