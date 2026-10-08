/**
 * Vitest port of the CLI tests in
 * `paperpilot/tests/test_generate_themes_manifest.py`.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGenerateThemesManifestCli } from "../../../src/lineage/theme/generateThemesManifestCli.js";

function writeThemeJson(themesDir: string, slug: string, theme: string): void {
  const dir = join(themesDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "lineage.json"),
    JSON.stringify({
      root: "p1",
      nodes: [{ id: "p1", title: "x", is_focus: true }],
      edges: [],
      meta: { theme, slug, generated_at: "2026-01-01T00:00:00Z" },
    }),
  );
}

describe("runGenerateThemesManifestCli", () => {
  it("accepts --themes-dir and writes the manifest", () => {
    const themesDir = mkdtempSync(join(tmpdir(), "gtm-cli-"));
    writeThemeJson(themesDir, "moe", "MoE");
    const rc = runGenerateThemesManifestCli(["--themes-dir", themesDir]);
    expect(rc).toBe(0);
    expect(existsSync(join(themesDir, "themes-manifest.json"))).toBe(true);
  });

  it("returns non-zero when the directory does not exist", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "gtm-cli-")), "does-not-exist");
    expect(runGenerateThemesManifestCli(["--themes-dir", missing])).not.toBe(0);
  });

  it("requires --themes-dir", () => {
    expect(runGenerateThemesManifestCli([])).toBe(2);
  });
});
