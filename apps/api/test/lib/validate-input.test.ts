// Ported 1:1 from worker/validate-input.test.mjs.

import { describe, expect, it } from "vitest";
import { themeSlug } from "../../src/lib/slug.js";
import { validatePostInput } from "../../src/lib/validate-input.js";

describe("validatePostInput", () => {
  it("rejects missing body", () => {
    const r = validatePostInput(null, themeSlug);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.body.status).toBe("invalid");
    }
  });

  it("rejects body without theme field", () => {
    expect(validatePostInput({}, themeSlug).ok).toBe(false);
  });

  it("rejects non-string theme field", () => {
    expect(validatePostInput({ theme: 42 }, themeSlug).ok).toBe(false);
  });

  it("rejects shell-shaped inputs", () => {
    for (const evil of ["$(rm -rf ~)", "foo; ls", "foo`whoami`", "../../etc/passwd"]) {
      expect(validatePostInput({ theme: evil }, themeSlug).ok).toBe(false);
    }
  });

  it("rejects too-short and too-long themes", () => {
    expect(validatePostInput({ theme: "a" }, themeSlug).ok).toBe(false);
    expect(validatePostInput({ theme: "a".repeat(81) }, themeSlug).ok).toBe(false);
  });

  it("rejects unicode (must stay ASCII for slug safety)", () => {
    expect(validatePostInput({ theme: "テスト" }, themeSlug).ok).toBe(false);
  });

  it("trims leading/trailing whitespace before validating", () => {
    const r = validatePostInput({ theme: "  Vision Transformer  " }, themeSlug);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.raw).toBe("Vision Transformer");
  });

  it("accepts plain ASCII title and derives slug", () => {
    const r = validatePostInput({ theme: "Mixture of Experts" }, themeSlug);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.raw).toBe("Mixture of Experts");
      expect(r.slug).toBe("mixture-of-experts");
    }
  });

  it("returns slug-failure body when themeSlug throws", () => {
    const broken = (): string => {
      throw new Error("boom");
    };
    const r = validatePostInput({ theme: "Anything Valid" }, broken);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.body.message.includes("boom")).toBe(true);
    }
  });

  it("does not leak the raw body content into the error response", () => {
    const r = validatePostInput({ theme: "<script>" }, themeSlug);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.body.message.includes("<script>")).toBe(false);
  });
});
