/**
 * Pins the single definition of the theme input / theme slug regexes
 * (docs/migration/safety-contracts.md API-08). apps/api and apps/web
 * re-export these; the pipeline's workflow contract test compares the
 * workflows' THEME_RE env literal against THEME_INPUT_PATTERN.source.
 * Changing either pattern must be deliberate: update this pin, the
 * workflows' THEME_RE env, and the frozen worker fixtures together.
 */
import { describe, expect, it } from "vitest";
import * as slugIndex from "../../src/slug/index.js";
import { SLUG_RE, THEME_INPUT_PATTERN, themeSlug } from "../../src/slug/index.js";

describe("theme regex patterns (exact sources)", () => {
  it("THEME_INPUT_PATTERN source and flags", () => {
    expect(THEME_INPUT_PATTERN.source).toBe("^[A-Za-z0-9 _-]{2,80}$");
    expect(THEME_INPUT_PATTERN.flags).toBe("");
  });
  it("SLUG_RE source and flags", () => {
    expect(SLUG_RE.source).toBe("^[a-z0-9-]+$");
    expect(SLUG_RE.flags).toBe("");
  });
  it("are exported from the slug index", () => {
    expect(slugIndex.THEME_INPUT_PATTERN).toBe(THEME_INPUT_PATTERN);
    expect(slugIndex.SLUG_RE).toBe(SLUG_RE);
  });
});

describe("theme regex patterns (behaviour)", () => {
  it("THEME_INPUT_PATTERN accepts plain titles and rejects unsafe shapes", () => {
    for (const ok of ["Vision Transformer", "BERT", "under_score-hyphen 123", "x".repeat(80)]) {
      expect(THEME_INPUT_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "a",
      "x".repeat(81),
      "$(rm -rf ~)",
      "foo; ls",
      "../../etc/passwd",
      "テスト",
      "café",
      "ok\n",
    ]) {
      expect(THEME_INPUT_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it("SLUG_RE accepts every themeSlug() output and rejects unsafe shapes", () => {
    for (const input of ["Mixture of Experts", "Flash-Attention_2.0!!", "A".repeat(100), "RAG"]) {
      expect(SLUG_RE.test(themeSlug(input)), input).toBe(true);
    }
    for (const bad of ["", "../x", "Mixture-Of-Experts", "テーマ", "a/b", "ok\n"]) {
      expect(SLUG_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
