/**
 * p5-plan.md §2 A7 assertions 11 and 13 — workflow env constants and
 * input-validation regexes must stay byte-identical to the single
 * source of truth each one mirrors (core site config; core
 * THEME_INPUT_PATTERN; the core theme-slug shape), so a future change to
 * either side is caught here instead of silently drifting.
 */
import { PAGES_PRODUCTION_BRANCH, PAGES_PROJECT_NAME, PUBLIC_ORIGIN } from "@paperpilot/core/site";
import { THEME_INPUT_PATTERN, themeSlug } from "@paperpilot/core/slug";
import { describe, expect, it } from "vitest";
import { readWorkflow, type YamlDoc } from "./helpers.js";

describe("assertion 11: workflow env constants equal @paperpilot/core/site exports", () => {
  for (const file of ["pages-release.yml", "pages-rollback.yml"]) {
    it(`${file}`, () => {
      const doc = readWorkflow(file);
      expect(doc.env.CF_PAGES_PROJECT).toBe(PAGES_PROJECT_NAME);
      expect(doc.env.CF_PAGES_PRODUCTION_BRANCH).toBe(PAGES_PRODUCTION_BRANCH);
      expect(doc.env.PUBLIC_ORIGIN).toBe(PUBLIC_ORIGIN);
    });
  }
});

describe("assertion 13: theme input regex equals @paperpilot/core/slug's THEME_INPUT_PATTERN", () => {
  // Imported, not text-extracted: THEME_INPUT_PATTERN has ONE definition
  // in packages/core/src/slug/patterns.ts (safety-contracts.md API-08),
  // which apps/api and apps/web both re-export.
  it("core THEME_INPUT_PATTERN is still the expected shape (sanity)", () => {
    expect(THEME_INPUT_PATTERN.source).toBe("^[A-Za-z0-9 _-]{2,80}$");
  });

  for (const file of ["theme-on-demand.yml", "regen-themes.yml"]) {
    it(`${file}: THEME_RE env literal equals THEME_INPUT_PATTERN.source`, () => {
      const doc = readWorkflow(file);
      const literals = collectEnvLiteral(doc, "THEME_RE");
      expect(literals.length).toBeGreaterThan(0);
      for (const literal of literals) {
        expect(literal).toBe(THEME_INPUT_PATTERN.source);
      }
    });
  }
});

describe("assertion 13: generated theme-path regex matches every slug the core theme-slug validator can produce", () => {
  // The workflow never imports packages/core (it's plain bash), so this
  // pins the OTHER direction: every slug @paperpilot/core/slug's
  // themeSlug() can produce must satisfy the workflow's own
  // PRIMARY_PATH_RE — if either side's shape drifts, a real themeSlug()
  // output would be rejected by the workflow (or vice versa), and this
  // test catches that before a real dispatch would.
  const probe = [
    "Vision Transformer",
    "Mixture of Experts",
    "RAG",
    "a",
    "A".repeat(100),
    "Flash-Attention_2.0!!",
    "日本語 Theme",
    "  leading and trailing  ",
  ];

  it("theme-on-demand.yml's PRIMARY_PATH_RE accepts every themeSlug() output", () => {
    const doc = readWorkflow("theme-on-demand.yml");
    const literals = collectEnvLiteral(doc, "PRIMARY_PATH_RE");
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      const re = new RegExp(literal);
      for (const input of probe) {
        let slug: string;
        try {
          slug = themeSlug(input);
        } catch {
          continue; // themeSlug() itself rejects this probe input; nothing to check
        }
        expect(
          re.test(`data/published/themes/${slug}`),
          `slug ${JSON.stringify(slug)} from input ${JSON.stringify(input)} rejected by ${literal}`,
        ).toBe(true);
      }
    }
  });
});

function collectEnvLiteral(doc: YamlDoc, key: string): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const env = obj.env as Record<string, unknown> | undefined;
    if (env && typeof env[key] === "string") found.push(env[key] as string);
    for (const value of Object.values(obj)) walk(value);
  }
  walk(doc);
  return found;
}
