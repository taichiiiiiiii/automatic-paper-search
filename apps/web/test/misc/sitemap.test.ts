import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalUrl, PUBLIC_ORIGIN } from "../../lib/config";
import type { BuiltPage } from "../../scripts/sitemap";
import {
  escapeXml,
  hasNoindexMeta,
  isPublicIndexPage,
  renderSitemap,
  sitemapUrls,
  sitePathFromIndexPage,
} from "../../scripts/sitemap";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(TEST_DIR, "..", "..", "out");
const BUILT_SITEMAP = join(OUT_DIR, "sitemap.xml");
/** The document shape this generator has to keep (read-only here). */
const LEGACY_SITEMAP = join(TEST_DIR, "..", "..", "..", "..", "docs", "sitemap.xml");

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const URLSET_OPEN_LINE = '<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">';

const NON_INDEX_PATHS = ["cvpr-2026/paper-links.html", "cvpr-2026/papers.json", "assets/app.js"];
const UNPUBLISHED_PATHS = ["404.html", "404/index.html", "_not-found/index.html"];
const PUBLIC_INDEX_PATHS = [
  "index.html",
  "cvpr-2026/index.html",
  "how-it-works/index.html",
  "themes/flash-attention/index.html",
  "cvpr-2026/lineage/index.html",
];

function docWithHead(...metas: string[]): string {
  return `<!DOCTYPE html><html lang="ja"><head>${metas.join("")}</head><body></body></html>`;
}

function robotsMeta(content: string): string {
  return docWithHead(`<meta name="robots" content="${content}" />`);
}

function page(relPath: string, html = docWithHead()): BuiltPage {
  return { relPath, html };
}

/** Out-relative POSIX paths of every built index page, found independently of
 * scripts/sitemap.ts so this file can catch a discovery bug there. */
function walkIndexPages(dir: string, base: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkIndexPages(full, base));
    } else if (entry.isFile() && entry.name === "index.html") {
      found.push(
        full
          .slice(base.length + 1)
          .split(sep)
          .join("/"),
      );
    }
  }
  return found;
}

describe("isPublicIndexPage", () => {
  it("accepts a built directory index at any depth", () => {
    for (const relPath of PUBLIC_INDEX_PATHS) {
      expect(isPublicIndexPage(relPath), relPath).toBe(true);
    }
  });

  it("rejects the 404 fallback and Next internal underscore routes", () => {
    for (const relPath of UNPUBLISHED_PATHS) {
      expect(isPublicIndexPage(relPath), relPath).toBe(false);
    }
  });

  it("rejects anything that is not an index.html", () => {
    for (const relPath of NON_INDEX_PATHS) {
      expect(isPublicIndexPage(relPath), relPath).toBe(false);
    }
  });
});

describe("sitePathFromIndexPage", () => {
  it("collapses index.html to its directory, with a trailing slash", () => {
    expect(sitePathFromIndexPage("index.html")).toBe("/");
    expect(sitePathFromIndexPage("cvpr-2026/index.html")).toBe("/cvpr-2026/");
    expect(sitePathFromIndexPage("themes/flash-attention/index.html")).toBe(
      "/themes/flash-attention/",
    );
  });
});

describe("hasNoindexMeta", () => {
  it("reads the robots meta Next emits for `robots: { index: false }`", () => {
    expect(hasNoindexMeta(robotsMeta("noindex, follow"))).toBe(true);
    expect(hasNoindexMeta(robotsMeta("NOINDEX"))).toBe(true);
    // Attribute order must not matter.
    expect(hasNoindexMeta(docWithHead('<meta content="noindex" name="robots">'))).toBe(true);
  });

  it("keeps an indexable page", () => {
    expect(hasNoindexMeta(robotsMeta("index, follow"))).toBe(false);
    expect(hasNoindexMeta(docWithHead())).toBe(false);
  });

  it("ignores the word noindex outside a robots meta", () => {
    expect(hasNoindexMeta(docWithHead('<meta name="description" content="noindex here">'))).toBe(
      false,
    );
    expect(hasNoindexMeta("<html><body><p>noindex</p></body></html>")).toBe(false);
  });
});

describe("sitemapUrls", () => {
  it("lists the landing page first, then the rest sorted by path", () => {
    const urls = sitemapUrls([
      page("how-it-works/index.html"),
      page("index.html"),
      page("cvpr-2026/index.html"),
    ]);
    expect(urls).toEqual([
      canonicalUrl("/"),
      canonicalUrl("/cvpr-2026/"),
      canonicalUrl("/how-it-works/"),
    ]);
  });

  it("builds absolute URLs from the site config, never the legacy prefix", () => {
    for (const url of sitemapUrls([page("index.html"), page("cvpr-2026/index.html")])) {
      expect(url.startsWith(PUBLIC_ORIGIN), url).toBe(true);
      expect(url).not.toContain("/automatic-paper-search");
      expect(url.endsWith("/"), url).toBe(true);
    }
  });

  it("drops unpublished pages and noindex pages", () => {
    const urls = sitemapUrls([
      page("index.html"),
      page("404/index.html"),
      page("_not-found/index.html"),
      page("cvpr-2026/paper-links/index.html", robotsMeta("noindex, follow")),
      page("cvpr-2026/index.html"),
    ]);
    expect(urls).toEqual([canonicalUrl("/"), canonicalUrl("/cvpr-2026/")]);
  });

  it("lists a path once, and nothing at all when no page is publishable", () => {
    expect(sitemapUrls([page("index.html"), page("index.html")])).toEqual([canonicalUrl("/")]);
    expect(sitemapUrls([page("404/index.html")])).toEqual([]);
    expect(sitemapUrls([])).toEqual([]);
  });
});

describe("renderSitemap", () => {
  it("keeps the document shape of docs/sitemap.xml", () => {
    const legacy = readFileSync(LEGACY_SITEMAP, "utf8").split("\n");
    const generated = renderSitemap([`${PUBLIC_ORIGIN}/`]).split("\n");

    expect(generated[0]).toBe(XML_DECLARATION);
    expect(legacy[0]).toBe(XML_DECLARATION);
    expect(generated).toContain(URLSET_OPEN_LINE);
    expect(legacy).toContain(URLSET_OPEN_LINE);
    expect(generated.at(-2)).toBe("</urlset>");
    expect(legacy.at(-2)).toBe("</urlset>");
    expect(generated).toContain(`  <url><loc>${PUBLIC_ORIGIN}/</loc></url>`);
  });

  it("emits one <url><loc> element per page, newline-terminated", () => {
    const xml = renderSitemap([canonicalUrl("/"), canonicalUrl("/themes/")]);
    expect(xml.match(/<loc>/g)?.length).toBe(2);
    expect(xml.endsWith("</urlset>\n")).toBe(true);
  });

  it("never emits a double hyphen inside its comment (XML forbids it)", () => {
    const xml = renderSitemap([canonicalUrl("/")]);
    const comment = xml.slice(xml.indexOf("<!--"), xml.indexOf("-->") + 3);
    expect(comment.startsWith("<!--") && comment.endsWith("-->")).toBe(true);
    expect(comment.slice(4, -3).includes("--")).toBe(false);
  });

  it("escapes XML metacharacters in a loc", () => {
    const xml = renderSitemap(["https://example.com/a&b/<c>"]);
    expect(xml).toContain("https://example.com/a&amp;b/&lt;c&gt;");
    expect(xml).not.toContain("a&b");
  });

  it("escapeXml covers the five predefined entities without double-escaping", () => {
    expect(escapeXml(["&", "<", ">", '"', "'"].join(""))).toBe("&amp;&lt;&gt;&quot;&apos;");
    expect(escapeXml("already &amp; escaped")).toBe("already &amp;amp; escaped");
  });
});

describe("built out/sitemap.xml", () => {
  // Skipped until scripts/sitemap.ts is wired into postbuild and a `next
  // build` has produced apps/web/out (same convention as test/csp.test.ts).
  it.skipIf(!existsSync(BUILT_SITEMAP))(
    "lists exactly the published, indexable pages under out/",
    () => {
      const xml = readFileSync(BUILT_SITEMAP, "utf8");
      const listed = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1] ?? "");
      const expected = walkIndexPages(OUT_DIR, OUT_DIR)
        .filter(
          (relPath) =>
            isPublicIndexPage(relPath) &&
            !hasNoindexMeta(readFileSync(join(OUT_DIR, relPath), "utf8")),
        )
        .map((relPath) => canonicalUrl(sitePathFromIndexPage(relPath)))
        .sort();

      expect(listed).toEqual(expected);
      for (const url of listed) {
        expect(url, url).not.toMatch(/\/(?:404\/|_)/);
      }
    },
  );
});
