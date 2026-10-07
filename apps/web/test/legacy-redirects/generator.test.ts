/**
 * Tests for apps/web/scripts/legacy-redirects.ts (design doc §5.4 /
 * docs/migration/p5-plan.md §5.4, changeset A8). Runs the generator
 * against a small path list mirroring the old site's page shapes, into a
 * fresh temp directory, so the real apps/web/out is never touched. The
 * real frozen list (legacy/redirect/paths.json, frozen from the deleted
 * legacy/gh-pages-site in Tier C, §6.3) is checked separately below.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { PUBLIC_ORIGIN } from "@paperpilot/core/site";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRedirectPageHtml,
  DEFAULT_PATHS_FILE,
  generateLegacyRedirectSite,
  mapLegacyPath,
  readFrozenPaths,
} from "../../scripts/legacy-redirects";

let paths: string[];
let outDir: string;
let workDir: string;

/** Mirrors the old site's page shapes: a site index, a custom 404, a
 * conference with all four legacy page kinds, themes/index.html and
 * how-it-works/index.html. */
const FIXTURE_PATHS: readonly string[] = [
  "index.html",
  "404.html",
  "iclr-2026/index.html",
  "iclr-2026/lineage.html",
  "iclr-2026/deep.html",
  "iclr-2026/paper-links.html",
  "themes/index.html",
  "how-it-works/index.html",
];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "legacy-redirects-test-"));
  outDir = join(workDir, "out");
  paths = [...FIXTURE_PATHS];
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
    await generateLegacyRedirectSite({ paths, outDir });
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

  it("never writes JSON or other non-HTML data", async () => {
    await generateLegacyRedirectSite({ paths, outDir });
    const written = await listAllFiles(outDir);
    expect(written.some((p) => p.endsWith(".json"))).toBe(false);
  });

  it("refuses a path that is not a safe relative *.html path", async () => {
    for (const bad of ["../escape.html", "/abs.html", "a/../b.html", "iclr-2026/papers.json"]) {
      await expect(generateLegacyRedirectSite({ paths: [bad], outDir }), bad).rejects.toThrow(
        /unsafe path/,
      );
    }
  });

  it("writes .nojekyll and no sitemap.xml", async () => {
    await generateLegacyRedirectSite({ paths, outDir });
    const written = await listAllFiles(outDir);
    expect(written).toContain(".nojekyll");
    expect(written.some((p) => p.endsWith("sitemap.xml"))).toBe(false);
  });

  it("copies redirect.js with the real PUBLIC_ORIGIN substituted in, placeholder gone", async () => {
    await generateLegacyRedirectSite({ paths, outDir });
    const content = await readFile(join(outDir, "redirect.js"), "utf8");
    expect(content).toContain(PUBLIC_ORIGIN);
    expect(content).not.toContain("%%NEW_ORIGIN%%");
  });

  it("every generated page has no inline script and a canonical link equal to the mapped target", async () => {
    await generateLegacyRedirectSite({ paths, outDir });
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
    await generateLegacyRedirectSite({ paths, outDir });
    const html = await readFile(join(outDir, "404.html"), "utf8");
    expect(html).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/">`);
    expect(html).not.toContain("old 404");
  });

  it("writes a 404.html catch-all even when the list has none", async () => {
    paths = paths.filter((p) => p !== "404.html");
    await generateLegacyRedirectSite({ paths, outDir });
    const html = await readFile(join(outDir, "404.html"), "utf8");
    expect(html).toContain(`<link rel="canonical" href="${PUBLIC_ORIGIN}/">`);
  });
});

describe("readFrozenPaths", () => {
  it("rejects a missing paths array, a non-HTML/unsafe entry, and duplicates", async () => {
    const file = join(workDir, "paths.json");
    const cases: ReadonlyArray<[unknown, RegExp]> = [
      [{}, /no "paths" array/],
      [{ paths: ["ok.html", 3] }, /invalid path entry/],
      [{ paths: ["iclr-2026/papers.json"] }, /invalid path entry/],
      [{ paths: ["../x.html"] }, /invalid path entry/],
      [{ paths: ["a.html", "a.html"] }, /twice/],
    ];
    for (const [doc, error] of cases) {
      await writeFile(file, JSON.stringify(doc));
      await expect(readFrozenPaths(file)).rejects.toThrow(error);
    }
  });
});

describe("the frozen legacy/redirect/paths.json (Tier C, p5-plan.md §6.3)", () => {
  it("is the generator's default, resolved from the repo root (not the cwd)", () => {
    expect(DEFAULT_PATHS_FILE).toBe(join(getRepoRoot(), "legacy", "redirect", "paths.json"));
  });

  it("is valid, sorted, and covers every legacy page kind", async () => {
    const frozen = await readFrozenPaths(DEFAULT_PATHS_FILE);
    expect(frozen).toEqual([...frozen].sort());
    for (const required of [
      "404.html",
      "index.html",
      "themes/index.html",
      "how-it-works/index.html",
      "lineage/index.html",
      "iclr-2026/index.html",
      "iclr-2026/lineage.html",
      "iclr-2026/deep.html",
      "iclr-2026/paper-links.html",
    ]) {
      expect(frozen, required).toContain(required);
    }
    // Every conference with a catalog page also had a paper-links page.
    const conferences = frozen
      .filter((p) => /^[^/]+-\d{4}\/index\.html$/.test(p))
      .map((p) => p.split("/")[0]);
    expect(conferences.length).toBe(10);
    for (const conf of conferences) {
      expect(frozen, conf).toContain(`${conf}/paper-links.html`);
    }
  });

  it("generates one stub per frozen entry plus the catch-all", async () => {
    const frozen = await readFrozenPaths(DEFAULT_PATHS_FILE);
    const { written } = await generateLegacyRedirectSite({ paths: frozen, outDir });
    expect(new Set(written)).toEqual(new Set(frozen.map((p) => `/${p}`)));
    const files = await listAllFiles(outDir);
    for (const relPath of frozen) {
      expect(files, relPath).toContain(relPath);
    }
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
