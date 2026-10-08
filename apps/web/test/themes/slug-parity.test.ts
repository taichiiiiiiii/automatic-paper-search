// Guards the three-way slug parity CLAUDE.md §14 requires (Python
// `_common.theme_slug()` <-> worker/slug.js <-> the browser's own
// `?theme=` validation). `test_worker_slug_parity.py` already pins
// Python<->Worker<->docs/assets/theme.js; this test adds the fourth
// leg -- apps/web/lib/themes-slug.ts, which is the TS port of the
// SAME browser-side validation theme.js used to do -- so a change to
// worker/slug.js's regex literals that isn't mirrored here fails loudly
// instead of silently drifting (the thing API-08/SCR-31/OUT-53 exist to
// prevent).
//
// (p5-plan.md §2 A1, risk R9): this used to read + eval worker/slug.js's
// source at test time. worker/slug.js is production code, untouched
// until P5, so this test must not depend on its live content to pass or
// fail -- it now reads a committed, frozen fixture
// (fixtures/worker-slug-regex-expected.json) generated once from the real
// worker/slug.js by fixtures/gen-worker-regex-expected.mjs (same pattern
// as packages/core/test/slug/fixtures/gen-worker-expected.mjs). If
// worker/slug.js's SLUG_RE / THEME_INPUT_PATTERN is intentionally
// changed, re-run that generator and commit the new fixture.
import { describe, expect, it } from "vitest";
import { SLUG_RE, THEME_INPUT_PATTERN } from "../../lib/themes-slug";
import workerSlugRegexExpected from "./fixtures/worker-slug-regex-expected.json" with {
  type: "json",
};

// A battery of inputs exercising every edge the two patterns care
// about (empty, min/max length, every allowed character class,
// traversal/shell/unicode shapes). Used to assert BEHAVIOURAL parity
// rather than exact `.source` byte equality -- this repo's `biome
// format` normalises away the unnecessary `\-` escape inside a
// character class (`[A-Za-z0-9 _\-]` -> `[A-Za-z0-9 _-]`), which is a
// semantics-preserving rewrite but would make a byte-exact comparison
// flap every time `biome check --write` runs (one of this brief's
// required verify commands). Kept in sync with
// fixtures/gen-worker-regex-expected.mjs's own copy of these lists.
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

describe("theme slug regex parity with worker/slug.js (frozen fixture)", () => {
  const slugReExpected = new Map(
    workerSlugRegexExpected.slugRe.map((c) => [c.input, c.matches] as const),
  );
  const themeInputExpected = new Map(
    workerSlugRegexExpected.themeInputPattern.map((c) => [c.input, c.matches] as const),
  );

  it("SLUG_RE agrees with worker/slug.js's SLUG_RE on every probe input", () => {
    for (const probe of SLUG_PROBES) {
      const expected = slugReExpected.get(probe);
      expect(expected, `missing fixture entry for ${JSON.stringify(probe)}`).toBeDefined();
      expect(SLUG_RE.test(probe), `SLUG_RE.test(${JSON.stringify(probe)})`).toBe(expected);
    }
  });

  it("THEME_INPUT_PATTERN agrees with worker/slug.js's THEME_INPUT_PATTERN on every probe input", () => {
    for (const probe of THEME_INPUT_PROBES) {
      const expected = themeInputExpected.get(probe);
      expect(expected, `missing fixture entry for ${JSON.stringify(probe)}`).toBeDefined();
      expect(
        THEME_INPUT_PATTERN.test(probe),
        `THEME_INPUT_PATTERN.test(${JSON.stringify(probe)})`,
      ).toBe(expected);
    }
  });

  it("SLUG_RE accepts the shapes worker/slug.js's themeSlug() produces", () => {
    expect(SLUG_RE.test("vision-transformer")).toBe(true);
    expect(SLUG_RE.test("flash-attention-2")).toBe(true);
  });

  it("SLUG_RE rejects path-traversal / uppercase / unicode shapes", () => {
    expect(SLUG_RE.test("../x")).toBe(false);
    expect(SLUG_RE.test("Mixture-Of-Experts")).toBe(false);
    expect(SLUG_RE.test("テーマ")).toBe(false);
    expect(SLUG_RE.test("")).toBe(false);
  });

  it("THEME_INPUT_PATTERN enforces the 2-80 char ASCII-ish shape", () => {
    expect(THEME_INPUT_PATTERN.test("Vision Transformer")).toBe(true);
    expect(THEME_INPUT_PATTERN.test("a")).toBe(false);
    expect(THEME_INPUT_PATTERN.test("x".repeat(81))).toBe(false);
    expect(THEME_INPUT_PATTERN.test("rm -rf /")).toBe(false);
    expect(THEME_INPUT_PATTERN.test("テーマ名")).toBe(false);
  });
});
