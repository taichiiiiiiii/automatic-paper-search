#!/usr/bin/env node
/**
 * Generate `worker-slug-expected.json`, a frozen record of what the real
 * `worker/slug.js::themeSlug()` returns for the same probe battery as
 * `theme-slug-cases.json` (itself generated once from the real Python
 * `theme_slug()` by `gen.py`, same directory).
 *
 * Run with (from the repo root):
 *   node packages/core/test/slug/fixtures/gen-worker-expected.mjs
 *
 * This script is NOT run in CI and is not a vitest test file (its name
 * does not match *.test.*). `theme.test.ts` only ever reads the
 * committed `worker-slug-expected.json` output — it must not import or
 * execute `worker/slug.js` at test time (docs/migration/p5-plan.md §2
 * A1): `worker/` is production code until P5 and the test suite must not
 * depend on its live behaviour to pass or fail.
 *
 * Re-run this script by hand (and commit the new output) only if
 * `worker/slug.js`'s `themeSlug()` is intentionally changed -- at which
 * point the "worker/slug.js itself is untouched" assumption documented
 * in theme.test.ts no longer holds and should be revisited too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = resolve(here, "theme-slug-cases.json");
const WORKER_SLUG_JS = resolve(here, "../../../../../worker/slug.js");
const OUT_PATH = resolve(here, "worker-slug-expected.json");

async function main() {
  const cases = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const workerModule = await import(WORKER_SLUG_JS);

  const results = cases.map(({ input }) => {
    try {
      return { input, slug: workerModule.themeSlug(input), error: false };
    } catch {
      return { input, slug: null, error: true };
    }
  });

  writeFileSync(OUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`wrote ${results.length} cases to ${OUT_PATH}`);
}

main();
