import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { metadata as notFoundMetadata } from "../../app/not-found";

/**
 * P2 review LOW-2: `app/not-found.tsx` did not set its own
 * `alternates`/`openGraph`, so Next's metadata merging inherited the
 * ROOT layout's (the home page's) `canonical` and `openGraph.url` --
 * both "/" -- onto the 404 page: a crawler or a shared link preview
 * would read the 404 as if it were the home page. Separately, adding
 * our own `robots` field produced a SECOND, redundant `<meta
 * name="robots">` tag, because Next.js's app-render unconditionally
 * injects its own `<meta name="robots" content="noindex">` for the
 * literal `/404` page path (independent of any metadata this route
 * exports) -- see `NonIndex` in
 * node_modules/next/dist/server/app-render/app-render.js.
 *
 * P2 review round 3 LOW-D: LOW-2 fixed `canonical`/`og:url` but left
 * `description`/`openGraph.description` (and, via Next's own
 * openGraph->twitter auto-fill, `twitter:description`) inheriting the
 * ROOT layout's home-page description -- `out/404.html` described
 * itself as "AI/ML トップ会議の採択論文をタイトル・著者・タグから横断検索できるツール。"
 * (the home page's own copy), not as a 404. Fixed by giving this page
 * its own `description`/`openGraph.description`. `twitter: undefined`
 * additionally forces Next to re-derive the twitter card from this
 * page's own `openGraph` instead of keeping the inherited home-page
 * twitter object verbatim -- see app/not-found.tsx's comment for why
 * this corrects the twitter card's content rather than suppressing it
 * outright (Next has no supported way to emit zero `twitter:*` tags
 * while `openGraph` is present).
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(TEST_DIR, "..", "..", "out");

// The ROOT layout's home-page description (apps/web/app/layout.tsx) --
// the 404 page must not describe itself with this text.
const HOME_DESCRIPTION =
  "AI/ML トップ会議の採択論文をタイトル・著者・タグから横断検索できるツール。";

describe("app/not-found.tsx metadata", () => {
  it("overrides (does not merely omit) the inherited canonical and openGraph.url", () => {
    expect(notFoundMetadata.alternates).toEqual({ canonical: undefined });
    expect(notFoundMetadata.openGraph).toHaveProperty("url", undefined);
    // og:type and og:image restated so the preview card matches docs/404.html.
    expect(notFoundMetadata.openGraph).toMatchObject({ type: "website" });
    expect(JSON.stringify(notFoundMetadata.openGraph)).toContain("/assets/og-image.png");
  });

  it("does not set its own `robots` field (Next already forces noindex for /404)", () => {
    expect(notFoundMetadata).not.toHaveProperty("robots");
  });

  it("sets its own description and openGraph.description instead of inheriting the home page's (P2 review round 3 LOW-D)", () => {
    expect(notFoundMetadata.description).toBeTruthy();
    expect(notFoundMetadata.description).not.toBe(HOME_DESCRIPTION);
    expect(notFoundMetadata.openGraph).toHaveProperty("description", notFoundMetadata.description);
  });

  it("overrides (not merely omits) the inherited twitter object", () => {
    expect(notFoundMetadata).toHaveProperty("twitter", undefined);
  });
});

describe("built out/404.html head (P2 review LOW-2)", () => {
  it.skipIf(!existsSync(join(OUT_DIR, "404.html")))(
    "carries exactly one robots meta and no canonical link or og:url pointing at the home page",
    () => {
      const html = readFileSync(join(OUT_DIR, "404.html"), "utf8");
      const robotsMetas = html.match(/<meta name="robots"[^>]*>/g) ?? [];
      expect(robotsMetas).toHaveLength(1);
      expect(robotsMetas[0]).toContain("noindex");
      expect(html).not.toMatch(/<link rel="canonical"/);
      expect(html).not.toMatch(/<meta property="og:url"/);
    },
  );

  // P2 review round 3 LOW-D: description/og:description/twitter:description
  // must all carry the 404 page's OWN copy, never the home page's --
  // previously all three leaked the home page's description verbatim.
  it.skipIf(!existsSync(join(OUT_DIR, "404.html")))(
    "description, og:description and twitter:description all carry the 404's own copy, not the home page's",
    () => {
      const html = readFileSync(join(OUT_DIR, "404.html"), "utf8");
      expect(html).not.toContain(HOME_DESCRIPTION);
      expect(html).toContain(`<meta name="description" content="${notFoundMetadata.description}"`);
      expect(html).toContain(
        `<meta property="og:description" content="${notFoundMetadata.description}"`,
      );
      const twitterDescriptionMatch = html.match(/<meta name="twitter:description"[^>]*>/);
      if (twitterDescriptionMatch) {
        // Next cannot suppress the twitter card while openGraph is set
        // (see app/not-found.tsx's comment) -- it re-derives
        // twitter:description from openGraph.description, so if the tag
        // is present at all it must carry the SAME, correct copy.
        expect(twitterDescriptionMatch[0]).toContain(notFoundMetadata.description as string);
      }
    },
  );

  it.skipIf(!existsSync(join(OUT_DIR, "404", "index.html")))(
    "the /404/ directory copy matches 404.html byte-for-byte",
    () => {
      const a = readFileSync(join(OUT_DIR, "404.html"), "utf8");
      const b = readFileSync(join(OUT_DIR, "404", "index.html"), "utf8");
      expect(b).toBe(a);
    },
  );
});
