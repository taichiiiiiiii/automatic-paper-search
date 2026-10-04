/**
 * Vitest tests for `auditThemeSeeds`'s directory-walking behaviour
 * (the `audit()` function itself in
 * `paperpilot/scripts/audit_theme_seeds.py`, as opposed to the
 * per-paper predicate already covered in `auditThemeSeeds.test.ts`).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditThemeSeeds } from "../../../src/lineage/theme/auditThemeSeeds.js";

let themesDir: string;
beforeEach(() => {
  themesDir = mkdtempSync(join(tmpdir(), "audit-seeds-"));
});

function writeLineage(slug: string, payload: unknown): void {
  const dir = join(themesDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lineage.json"), JSON.stringify(payload));
}

describe("auditThemeSeeds", () => {
  it("returns exit 0 with no themes directory entries", () => {
    const result = auditThemeSeeds(join(themesDir, "does-not-exist"));
    expect(result.exitCode).toBe(0);
    expect(result.seenThemes).toBe(0);
  });

  it("flags a theme whose focus seed is off-topic", () => {
    writeLineage("self-supervised-learning", {
      meta: { theme: "Self-Supervised Learning" },
      nodes: [
        {
          id: "lpips",
          title: "The Unreasonable Effectiveness of Deep Features",
          tldr: "supervised, self-supervised, and even unsupervised; deep learning",
          is_focus: true,
        },
      ],
    });
    const result = auditThemeSeeds(themesDir);
    expect(result.exitCode).toBe(1);
    expect(result.seenThemes).toBe(1);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.slug).toBe("self-supervised-learning");
    expect(result.problems[0]!.titles[0]).toContain("Unreasonable Effectiveness");
  });

  it("is clean when every focus seed is on-topic", () => {
    writeLineage("rag", {
      meta: { theme: "RAG" },
      nodes: [{ id: "p1", title: "Anything", tldr: "", is_focus: true }],
    });
    const result = auditThemeSeeds(themesDir);
    expect(result.exitCode).toBe(0);
    expect(result.problems).toEqual([]);
  });

  it("skips a theme with no focus nodes or no theme name, without counting it as seen", () => {
    writeLineage("no-focus", {
      meta: { theme: "No Focus" },
      nodes: [{ id: "p1", title: "x", is_focus: false }],
    });
    writeLineage("no-theme-name", { meta: {}, nodes: [{ id: "p1", title: "x", is_focus: true }] });
    const result = auditThemeSeeds(themesDir);
    expect(result.seenThemes).toBe(0);
    expect(result.problems).toEqual([]);
  });

  it("skips (with a warning) an unreadable lineage.json rather than throwing", () => {
    mkdirSync(join(themesDir, "broken"), { recursive: true });
    writeFileSync(join(themesDir, "broken", "lineage.json"), "not valid json");
    writeLineage("rag", {
      meta: { theme: "RAG" },
      nodes: [{ id: "p1", title: "x", tldr: "", is_focus: true }],
    });
    const warnings: string[] = [];
    const result = auditThemeSeeds(themesDir, { warn: (m) => warnings.push(m) });
    expect(result.exitCode).toBe(0);
    expect(result.seenThemes).toBe(1);
    expect(warnings.some((w) => w.includes("broken"))).toBe(true);
  });
});
