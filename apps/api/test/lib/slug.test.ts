// Ported 1:1 from worker/slug.test.mjs.

import { describe, expect, it } from "vitest";
import { THEME_INPUT_PATTERN, themeSlug } from "../../src/lib/slug.js";

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
describe("parity with worker/slug.js", () => {
  it("matches on a representative sample", async () => {
    // @ts-expect-error untyped legacy module, read-only reference for parity
    const legacy = await import("../../../../worker/slug.js");
    const samples = [
      "Mixture of Experts",
      "Vision_Transformer",
      "  Diffusion Model  ",
      "RLHF",
      "BERT 2018",
      "a".repeat(200),
    ];
    for (const sample of samples) {
      expect(themeSlug(sample)).toBe(legacy.themeSlug(sample));
    }
    // Compare by behaviour, not by .source string: biome's formatter drops
    // the redundant backslash before a trailing `-` in a character class
    // (functionally identical, since an unescaped `-` immediately before
    // `]` is already literal), so the two patterns' source text legitimately
    // differs while still accepting/rejecting the exact same strings.
    for (const candidate of [
      "Vision Transformer",
      "$(rm -rf ~)",
      "a",
      "a".repeat(81),
      "テスト",
      "Direct-Preference-Optimization",
    ]) {
      expect(THEME_INPUT_PATTERN.test(candidate)).toBe(legacy.THEME_INPUT_PATTERN.test(candidate));
    }
  });
});
