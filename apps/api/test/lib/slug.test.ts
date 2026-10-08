// Ported 1:1 from worker/slug.test.mjs.

import { describe, expect, it } from "vitest";
import { THEME_INPUT_PATTERN, themeSlug } from "../../src/lib/slug.js";
import workerSlugExpected from "../fixtures/worker-slug-expected.json" with { type: "json" };

describe("themeSlug", () => {
  it("simple ASCII title", () =>
    expect(themeSlug("Mixture of Experts")).toBe("mixture-of-experts"));
  it("hyphens preserved", () =>
    expect(themeSlug("Direct-Preference-Optimization")).toBe("direct-preference-optimization"));
  it("underscores collapse to hyphen", () =>
    expect(themeSlug("Vision_Transformer")).toBe("vision-transformer"));
  it("multiple spaces collapse", () =>
    expect(themeSlug("Vision    Transformer")).toBe("vision-transformer"));
  it("leading/trailing whitespace stripped", () =>
    expect(themeSlug("  Diffusion Model  ")).toBe("diffusion-model"));
  it("mixed case lowered", () => expect(themeSlug("RLHF")).toBe("rlhf"));
  it("digits kept", () => expect(themeSlug("BERT 2018")).toBe("bert-2018"));
  it("empty input throws", () => expect(() => themeSlug("")).toThrow());
  it("whitespace-only throws", () => expect(() => themeSlug("   ")).toThrow());
  it("64-char cap applies", () => {
    const long = "a".repeat(200);
    expect(themeSlug(long).length).toBeLessThanOrEqual(64);
  });
});

describe("THEME_INPUT_PATTERN", () => {
  it("accepts plain titles", () => {
    expect(THEME_INPUT_PATTERN.test("Vision Transformer")).toBe(true);
    expect(THEME_INPUT_PATTERN.test("BERT")).toBe(true);
    expect(THEME_INPUT_PATTERN.test("Direct-Preference-Optimization")).toBe(true);
  });
  it("rejects shell-shaped inputs", () => {
    expect(THEME_INPUT_PATTERN.test("$(rm -rf ~)")).toBe(false);
    expect(THEME_INPUT_PATTERN.test("foo; ls")).toBe(false);
    expect(THEME_INPUT_PATTERN.test("foo`whoami`")).toBe(false);
    expect(THEME_INPUT_PATTERN.test("../../etc/passwd")).toBe(false);
  });
  it("rejects too short / too long", () => {
    expect(THEME_INPUT_PATTERN.test("a")).toBe(false);
    expect(THEME_INPUT_PATTERN.test("a".repeat(81))).toBe(false);
  });
  it("rejects unicode", () => {
    expect(THEME_INPUT_PATTERN.test("テスト")).toBe(false);
    expect(THEME_INPUT_PATTERN.test("café")).toBe(false);
  });
});

// Drift pin: until packages/core owns slug (TODO in src/lib/slug.ts), this
// cross-checks the apps/api copy against the still-canonical worker/slug.js
// so a future edit to one without the other is caught here instead of only
// by paperpilot/tests/test_worker_slug_parity.py (which never sees this
// copy).
//
// (p5-plan.md §2 A1, risk R9): this used to dynamic-`import()` the live
// worker/slug.js module at test time. worker/slug.js is production code,
// untouched until P5, so this test must not depend on its live behaviour
// to pass or fail -- it now reads a committed, frozen fixture
// (../fixtures/worker-slug-expected.json) generated once from the real
// worker/slug.js by ../fixtures/gen-worker-slug-expected.mjs (same
// pattern as packages/core/test/slug/fixtures/gen-worker-expected.mjs).
// If worker/slug.js is intentionally changed, re-run that generator and
// commit the new fixture.
describe("parity with worker/slug.js", () => {
  it("matches on a representative sample", () => {
    for (const { input, slug } of workerSlugExpected.themeSlugSamples) {
      expect(themeSlug(input)).toBe(slug);
    }
    // Compare by behaviour, not by .source string: biome's formatter drops
    // the redundant backslash before a trailing `-` in a character class
    // (functionally identical, since an unescaped `-` immediately before
    // `]` is already literal), so the two patterns' source text legitimately
    // differs while still accepting/rejecting the exact same strings.
    for (const { input, matches } of workerSlugExpected.themeInputPatternCandidates) {
      expect(THEME_INPUT_PATTERN.test(input)).toBe(matches);
    }
  });
});
