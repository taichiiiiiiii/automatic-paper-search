/**
 * `lib/catalog-copy.ts`'s `getCatalogCopy` -- p5-plan.md §2 A2 follow-up
 * #17: three-tier fallback (static map -> per-slug build-time file ->
 * generic). "Test: a new slug with a copy file renders its display and
 * lede, escaped."
 */
// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conferenceCopyDir, layoutFor } from "@paperpilot/core/layout";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogHero } from "../../components/catalog/catalog-hero";
import { CATALOG_COPY, getCatalogCopy } from "../../lib/catalog-copy";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "catalog-copy-"));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  cleanup();
});

function writeCopyFile(slug: string, body: unknown): void {
  const dir = conferenceCopyDir(layoutFor(repoRoot));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(body), "utf-8");
}

describe("getCatalogCopy", () => {
  it("tier 1: a known static-map slug returns the reviewed entry, ignoring any file", () => {
    writeCopyFile("iclr-2026", { display: "SHOULD NOT WIN", lede: "nope" });
    expect(getCatalogCopy("iclr-2026", repoRoot)).toEqual(CATALOG_COPY["iclr-2026"]);
  });

  it("tier 2: a new slug with a copy file uses its display/lede", () => {
    writeCopyFile("neurips-2026", { display: "NeurIPS 2026", lede: "A fresh lede." });
    const copy = getCatalogCopy("neurips-2026", repoRoot);
    expect(copy.display).toBe("NeurIPS 2026");
    expect(copy.lede).toBe("A fresh lede.");
    expect(copy.description).toContain("NeurIPS 2026");
  });

  it("tier 3: an unknown slug with no copy file falls back to the generic copy", () => {
    const copy = getCatalogCopy("brand-new-conf", repoRoot);
    expect(copy.display).toBe("brand-new-conf");
    expect(copy.lede).toBe("");
  });

  // L6 (P5 tier-A review): a malformed copy file used to silently fall
  // back to the generic copy, so a corrupted operator-supplied file
  // could publish placeholder text for a real conference with no error
  // anywhere. `readConferenceCopyFile` now throws for this case
  // (`catalog-copy-reader.test.ts`), and `getCatalogCopy` deliberately
  // does NOT catch it -- the malformed file must fail the build.
  it("tier 3 (REVISED, L6): a malformed copy file throws instead of silently falling back", () => {
    const dir = conferenceCopyDir(layoutFor(repoRoot));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{not json", "utf-8");
    expect(() => getCatalogCopy("broken", repoRoot)).toThrow();
  });

  it("renders the copy-file display/lede escaped (no HTML injection) via CatalogHero", () => {
    writeCopyFile("neurips-2026", {
      display: "<script>alert(1)</script>",
      lede: "lede with <b>tags</b> & an ampersand",
    });
    const copy = getCatalogCopy("neurips-2026", repoRoot);
    render(
      <CatalogHero copy={copy} generated="2026-01-01" total={10} oralCount={1} tagCount={2} />,
    );
    // React renders {copy.display}/{copy.lede} as plain TEXT, never
    // parsed as markup -- no actual <script>/<b> element is created, but
    // the raw strings are still visible as plain text content. `display`
    // is rendered twice (breadcrumb + heading); `lede` once.
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getAllByText("<script>alert(1)</script>").length).toBeGreaterThan(0);
    expect(screen.getByText("lede with <b>tags</b> & an ampersand")).not.toBeNull();
  });
});
