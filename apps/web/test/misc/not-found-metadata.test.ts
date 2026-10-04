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
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(TEST_DIR, "..", "..", "out");

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

  it.skipIf(!existsSync(join(OUT_DIR, "404", "index.html")))(
    "the /404/ directory copy matches 404.html byte-for-byte",
    () => {
      const a = readFileSync(join(OUT_DIR, "404.html"), "utf8");
      const b = readFileSync(join(OUT_DIR, "404", "index.html"), "utf8");
      expect(b).toBe(a);
    },
  );
});
