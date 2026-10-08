/**
 * `themeSlug` unit tests, plus the 3-way parity pin
 * docs/migration/p4-followups.md #25 asks for: this consolidated
 * `packages/core` implementation vs `worker/slug.js`'s `themeSlug()`
 * vs the real Python `theme_slug()`.
 *
 * Both comparison sides are committed, frozen fixtures rather than live
 * reads (docs/migration/p5-plan.md §2 A1): `theme-slug-cases.json` was
 * generated once from the real Python `theme_slug()` by `fixtures/gen.py`
 * (the same pattern `packages/core/test/pycompat/fixtures/gen.py` uses),
 * and `worker-slug-expected.json` was generated once from the real
 * `worker/slug.js`'s `themeSlug()` by `fixtures/gen-worker-expected.mjs`.
 * This test must not import or execute `worker/slug.js` at test time:
 * it is production code, left untouched until P5 replaces it, and the
 * suite must not depend on its live behaviour to pass or fail. If
 * `worker/slug.js` is intentionally changed, re-run
 * `fixtures/gen-worker-expected.mjs` and commit the new output.
 */
import { describe, expect, it } from "vitest";
import { themeSlug } from "../../src/slug/theme.js";
import themeSlugCases from "./fixtures/theme-slug-cases.json" with { type: "json" };
import workerSlugExpected from "./fixtures/worker-slug-expected.json" with { type: "json" };

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

describe("themeSlug 3-way parity (packages/core <-> worker/slug.js <-> Python)", () => {
  it("agrees with the frozen worker/slug.js record on every probe input (fixtures/gen-worker-expected.mjs)", () => {
    for (const { input, slug, error } of workerSlugExpected as Array<{
      input: string;
      slug: string | null;
      error: boolean;
    }>) {
      if (error) {
        expect(() => themeSlug(input), `themeSlug(${JSON.stringify(input)})`).toThrow();
      } else {
        expect(themeSlug(input), `themeSlug(${JSON.stringify(input)})`).toBe(slug);
      }
    }
  });

  it("agrees with the real Python theme_slug() on every probe input (fixtures/gen.py)", () => {
    for (const { input, slug, error } of themeSlugCases as Array<{
      input: string;
      slug: string | null;
      error: boolean;
    }>) {
      if (error) {
        expect(() => themeSlug(input), `themeSlug(${JSON.stringify(input)})`).toThrow();
      } else {
        expect(themeSlug(input), `themeSlug(${JSON.stringify(input)})`).toBe(slug);
      }
    }
  });

  it("the frozen worker/slug.js record itself agrees with the Python fixture on every shared probe (no silent 3-way drift)", () => {
    const pythonByInput = new Map(
      (themeSlugCases as Array<{ input: string; slug: string | null; error: boolean }>).map((c) => [
        c.input,
        c,
      ]),
    );
    for (const { input, slug, error } of workerSlugExpected as Array<{
      input: string;
      slug: string | null;
      error: boolean;
    }>) {
      const python = pythonByInput.get(input);
      if (!python) continue;
      expect(error, `error flag for ${JSON.stringify(input)}`).toBe(python.error);
      expect(slug, `slug for ${JSON.stringify(input)}`).toBe(python.slug);
    }
  });
});
