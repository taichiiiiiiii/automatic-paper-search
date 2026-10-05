/**
 * Unit tests for `lineage/theme/slugCli.ts` — p5-plan.md §2 A2: "reads
 * `THEME_INPUT` from env and prints `themeSlug()`. Exit 1 if the result
 * is empty or does not match `^[a-z0-9-]{1,64}$`." Free text (the theme
 * label) comes ONLY from the environment, never argv.
 */
import { describe, expect, it } from "vitest";
import { resolveThemeSlug, runSlugCli } from "../../../src/lineage/theme/slugCli.js";

describe("resolveThemeSlug", () => {
  it("derives a slug from a normal theme label", () => {
    expect(resolveThemeSlug("Mixture of Experts")).toBe("mixture-of-experts");
  });

  it("returns null for undefined input", () => {
    expect(resolveThemeSlug(undefined)).toBeNull();
  });

  it("returns null for an empty/whitespace-only input", () => {
    expect(resolveThemeSlug("")).toBeNull();
    expect(resolveThemeSlug("   ")).toBeNull();
  });

  it("returns null when themeSlug() would throw (e.g. all-CJK input with no ASCII fallback)", () => {
    expect(resolveThemeSlug("機械学習")).toBeNull();
  });

  it("the derived slug always matches ^[a-z0-9-]{1,64}$ for an accepted input", () => {
    const slug = resolveThemeSlug("Flash Attention 2.0!!") as string;
    expect(slug).not.toBeNull();
    expect(slug).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});

describe("runSlugCli", () => {
  it("prints the slug and exits 0 when THEME_INPUT is set and valid", () => {
    const result = runSlugCli({ THEME_INPUT: "Vision Transformer" });
    expect(result).toEqual({ exitCode: 0, message: "vision-transformer" });
  });

  it("exits 1 when THEME_INPUT is unset", () => {
    const result = runSlugCli({});
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 when THEME_INPUT is empty", () => {
    const result = runSlugCli({ THEME_INPUT: "" });
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 when THEME_INPUT collapses to an empty/invalid slug", () => {
    const result = runSlugCli({ THEME_INPUT: "???" });
    expect(result.exitCode).toBe(1);
  });
});
