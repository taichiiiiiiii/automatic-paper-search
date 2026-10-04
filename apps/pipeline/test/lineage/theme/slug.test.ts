/**
 * Vitest port of `test_sanitize_theme_*` (test_build_theme_lineage.py)
 * and the Python-side fixtures of `test_worker_slug_parity.py`'s
 * `PARITY_INPUTS` list (this module's `themeSlug` is a third
 * transcription of the same algorithm as `worker/slug.js` and
 * `paperpilot/scripts/_common.py::theme_slug` — see the module doc
 * comment on why it isn't an import).
 */
import { describe, expect, it } from "vitest";
import { sanitizeTheme, themeLineagePath, themeSlug } from "../../../src/lineage/theme/slug.js";

describe("sanitizeTheme", () => {
  it("strips control characters (not ordinary whitespace between words)", () => {
    expect(sanitizeTheme("Mixture\x00 of\nExperts\t")).toBe("Mixture ofExperts");
  });

  it("rejects empty input", () => {
    expect(() => sanitizeTheme("")).toThrow(RangeError);
  });

  it("rejects whitespace-only input", () => {
    expect(() => sanitizeTheme("   \t\n  ")).toThrow(RangeError);
  });

  it("rejects over 500 chars", () => {
    expect(() => sanitizeTheme("x".repeat(501))).toThrow(RangeError);
  });

  it("passes exactly 500 chars", () => {
    expect(sanitizeTheme("x".repeat(500))).toBe("x".repeat(500));
  });
});

describe("themeSlug", () => {
  // Expected outputs independently derived from the documented
  // algorithm (NFKD -> ASCII-only -> lowercase -> collapse non
  // [a-z0-9] runs to "-" -> trim hyphens -> cap 64 + trim).
  const cases: [string, string][] = [
    ["Mixture of Experts", "mixture-of-experts"],
    ["Direct-Preference-Optimization", "direct-preference-optimization"],
    ["Vision_Transformer", "vision-transformer"],
    ["Vision    Transformer", "vision-transformer"],
    ["  Diffusion Model  ", "diffusion-model"],
    ["RLHF", "rlhf"],
    ["BERT 2018", "bert-2018"],
    ["Reinforcement Learning from Human Feedback", "reinforcement-learning-from-human-feedback"],
    ["Retrieval-Augmented Generation", "retrieval-augmented-generation"],
    ["../../etc/passwd", "etc-passwd"],
    ["MoE モデル", "moe"],
  ];

  it.each(cases)("%s -> %s", (input, expected) => {
    expect(themeSlug(input)).toBe(expected);
  });

  it("caps at 64 chars and trims a trailing hyphen left by the cut", () => {
    const slug = themeSlug("a".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toBe("a".repeat(64));
    expect(slug.endsWith("-")).toBe(false);
  });

  it("rejects empty / whitespace-only input", () => {
    expect(() => themeSlug("")).toThrow(RangeError);
    expect(() => themeSlug("   ")).toThrow(RangeError);
  });

  it("rejects input that collapses to an empty slug (pure CJK, no ASCII fallback)", () => {
    expect(() => themeSlug("モデル")).toThrow(RangeError);
  });
});

describe("themeLineagePath", () => {
  it("joins docsRoot/themes/<slug>/lineage.json for a valid slug", () => {
    expect(themeLineagePath("/repo/docs", "mixture-of-experts")).toBe(
      "/repo/docs/themes/mixture-of-experts/lineage.json",
    );
  });

  it("rejects a slug containing path-traversal or non-slug characters", () => {
    expect(() => themeLineagePath("/repo/docs", "../../etc/passwd")).toThrow(RangeError);
    expect(() => themeLineagePath("/repo/docs", "has/slash")).toThrow(RangeError);
    expect(() => themeLineagePath("/repo/docs", "Has_Underscore")).toThrow(RangeError);
    expect(() => themeLineagePath("/repo/docs", "")).toThrow(RangeError);
    expect(() => themeLineagePath("/repo/docs", "-leading-hyphen")).toThrow(RangeError);
  });
});
