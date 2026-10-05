/**
 * Tests for apps/web/scripts/legacy-redirects.ts (design doc §5.4 /
 * docs/migration/p5-plan.md §5.4, changeset A8). Runs the generator
 * against a small fixture tree mirroring today's docs/ shapes, into a
 * fresh temp directory, so the real docs/ and the real apps/web/out
 * are never touched (and nothing here depends on LAYOUT_MODE).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { layoutFor } from "@paperpilot/core/layout";
import { PUBLIC_ORIGIN } from "@paperpilot/core/site";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRedirectPageHtml,
  DEFAULT_SOURCE_DIR,
  generateLegacyRedirectSite,
  mapLegacyPath,
} from "../../scripts/legacy-redirects";

let sourceDir: string;
let outDir: string;
let workDir: string;

/** Mirrors the real docs/ shape (see the repo survey behind this
 * changeset): a site index, a custom 404, a couple of conference
 * pages with all four legacy page kinds, and themes/index.html. Plus
 * one *.json file, to prove data is never mirrored. */
async function writeFixtureSite(dir: string): Promise<void> {
  await writeFile(join(dir, "index.html"), "<html>old home</html>");
  await writeFile(join(dir, "404.html"), "<html>old 404 (content must be ignored)</html>");
  await mkdir(join(dir, "iclr-2026"), { recursive: true });
  await writeFile(join(dir, "iclr-2026", "index.html"), "<html>catalog</html>");
  await writeFile(join(dir, "iclr-2026", "lineage.html"), "<html>lineage</html>");
  await writeFile(join(dir, "iclr-2026", "deep.html"), "<html>deep</html>");
  await writeFile(join(dir, "iclr-2026", "paper-links.html"), "<html>paper links</html>");
  await writeFile(join(dir, "iclr-2026", "papers.json"), "[]");
  await mkdir(join(dir, "themes"), { recursive: true });
  await writeFile(join(dir, "themes", "index.html"), "<html>themes</html>");
  await writeFile(join(dir, "themes", "themes-manifest.json"), "{}");
  await mkdir(join(dir, "how-it-works"), { recursive: true });
  await writeFile(join(dir, "how-it-works", "index.html"), "<html>how it works</html>");
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "legacy-redirects-test-"));
  sourceDir = join(workDir, "source");
  outDir = join(workDir, "out");
  await mkdir(sourceDir, { recursive: true });
  await writeFixtureSite(sourceDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function listAllFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listAllFiles(full, base)));
    } else {
      out.push(
        full
          .slice(base.length + 1)
          .split("\\")
          .join("/"),
      );
    }
  }
  return out;
}

describe("generateLegacyRedirectSite", () => {
  it("emits a page for every legacy HTML file, at the identical relative path", async () => {
    await generateLegacyRedirectSite({ sourceDir, outDir });
    const written = await listAllFiles(outDir);
    for (const relPath of [
      "index.html",
      "404.html",
      "iclr-2026/index.html",
      "iclr-2026/lineage.html",
      "iclr-2026/deep.html",
      "iclr-2026/paper-links.html",
      "themes/index.html",
      "how-it-works/index.html",
    ]) {
      expect(written, relPath).toContain(relPath);
    }
  });

  it("never mirrors JSON or other non-HTML data", async () => {
    await generateLegacyRedirectSite({ sourceDir, outDir });
    const written = await listAllFiles(outDir);
    expect(written.some((p) => p.endsWith(".json"))).toBe(false);
  });

  it("writes .nojekyll and no sitemap.xml", async () => {
    await generateLegacyRedirectSite({ sourceDir, outDir });
    const written = await listAllFiles(outDir);
    expect(written).toContain(".nojekyll");
    expect(written.some((p) => p.endsWith("sitemap.xml"))).toBe(false);
  });

  it("copies redirect.js with the real PUBLIC_ORIGIN substituted in, placeholder gone", async () => {
    await generateLegacyRedirectSite({ sourceDir, outDir });
    const content = await readFile(join(outDir, "redirect.js"), "utf8");
    expect(content).toContain(PUBLIC_ORIGIN);
    expect(content).not.toContain("%%NEW_ORIGIN%%");
  });

  it("every generated page has no inline script and a canonical link equal to the mapped target", async () => {
    await generateLegacyRedirectSite({ sourceDir, outDir });
    const cases: ReadonlyArray<[string, string]> = [
      ["index.html", `${PUBLIC_ORIGIN}/`],
      ["iclr-2026/index.html", `${PUBLIC_ORIGIN}/iclr-2026/`],
      ["iclr-2026/lineage.html", `${PUBLIC_ORIGIN}/iclr-2026/lineage/`],
      ["iclr-2026/deep.html", `${PUBLIC_ORIGIN}/iclr-2026/deep/`],
      ["iclr-2026/paper-links.html", `${PUBLIC_ORIGIN}/iclr-2026/paper-links/`],
      ["themes/index.html", `${PUBLIC_ORIGIN}/themes/`],
      ["how-it-works/index.html", `${PUBLIC_ORIGIN}/how-it-works/`],
    ];
    for (const [relPath, target] of cases) {
      const html = await readFile(join(outDir, relPath), "utf8");
      // No inline script: every <script> tag must carry a src attribute.
      const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scriptTags.length, relPath).toBeGreaterThan(0);
      for (const tag of scriptTags) {
        expect(tag, relPath).toMatch(/\bsrc="/);
      }
      expect(html).not.toMatch(/<script\b[^>]*>[^<]/); // no script body text
      expect(html).toContain(`<link rel="canonical" href="${target}">`);
      expect(html).toContain(`content="0; url=${target}"`);
      expect(html).toContain('<script src="/automatic-paper-search/redirect.js"></script>');
    }
  });

  it("maps the custom 404.html to a catch-all targeting the new site's root, ignoring its old content", async () => {
    await generateLegacyRedirectSite({ sourceDir, outDir });
    const html = await readFile(join(outDir, "404.html"), "utf8");
    expect(html).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/">`);
    expect(html).not.toContain("old 404");
  });

  it("writes a 404.html catch-all even when the source has none", async () => {
    await rm(join(sourceDir, "404.html"));
    await generateLegacyRedirectSite({ sourceDir, outDir });
    const html = await readFile(join(outDir, "404.html"), "utf8");
    expect(html).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/">`);
  });
});

describe("DEFAULT_SOURCE_DIR (M4 of the P5 tier-A review)", () => {
  it("resolves through layoutFor(REPO_ROOT).legacySite, not a hard-coded docs/ literal", () => {
    expect(DEFAULT_SOURCE_DIR).toBe(layoutFor(getRepoRoot()).legacySite);
  });

  it("is byte-identical to the pre-fix docs/ path while LAYOUT_MODE is legacy (inert, no behavior change)", () => {
    expect(DEFAULT_SOURCE_DIR).toBe(join(getRepoRoot(), "docs"));
  });
});

describe("mapLegacyPath", () => {
  it("leaves an unmapped path untouched", () => {
    expect(mapLegacyPath("/assets/style.css")).toBe("/assets/style.css");
  });
});

describe("buildRedirectPageHtml", () => {
  it("embeds the given target in refresh, canonical, and the visible link", () => {
    const html = buildRedirectPageHtml("https://example.pages.dev/x/");
    expect(html).toContain('content="0; url=https://example.pages.dev/x/"');
    expect(html).toContain('<link rel="canonical" href="https://example.pages.dev/x/">');
    expect(html).toContain(
      '<a href="https://example.pages.dev/x/">https://example.pages.dev/x/</a>',
    );
  });
});
