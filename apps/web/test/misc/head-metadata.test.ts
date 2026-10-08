import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalUrl } from "../../lib/config";
import { buildMetadata } from "../../lib/metadata";

/**
 * LOW finding: og:image, twitter:card summary_large_image and the
 * favicon (`rel="icon"`) links were all missing from every page's
 * head, a parity regression against every docs/*.html page (which sets
 * the same og-image.png + favicon pair site-wide).
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(TEST_DIR, "..", "..");
const OUT_DIR = join(WEB_ROOT, "out");

// buildMetadata always constructs openGraph.images as an array and
// twitter as a plain { card, title, description, images } object, but
// Next's own `Metadata` type widens both to a union of shapes it also
// accepts as *input* -- these two narrow views describe only what this
// module actually produces, for type-safe assertions below.
interface BuiltOpenGraph {
  readonly images?: readonly { url: string; width: number; height: number; alt: string }[];
}
interface BuiltTwitter {
  readonly card?: string;
  readonly images?: readonly string[];
}

describe("buildMetadata default Open Graph / Twitter Card image", () => {
  it("falls back to the site-wide og-image when a page gives none", () => {
    const meta = buildMetadata({ path: "/", title: "T", description: "D" });
    const openGraph = meta.openGraph as BuiltOpenGraph | undefined;
    const twitter = meta.twitter as BuiltTwitter | undefined;
    expect(openGraph?.images).toEqual([
      {
        url: canonicalUrl("/assets/og-image.png"),
        width: 1200,
        height: 630,
        alt: expect.any(String),
      },
    ]);
    expect(twitter?.card).toBe("summary_large_image");
    expect(twitter?.images).toEqual([canonicalUrl("/assets/og-image.png")]);
  });

  it("still lets a page override with its own image", () => {
    const meta = buildMetadata({
      path: "/x/",
      title: "T",
      description: "D",
      ogImage: { path: "/assets/custom.png", width: 10, height: 20, alt: "A" },
    });
    const openGraph = meta.openGraph as BuiltOpenGraph | undefined;
    const twitter = meta.twitter as BuiltTwitter | undefined;
    expect(openGraph?.images?.[0]?.url).toBe(canonicalUrl("/assets/custom.png"));
    expect(twitter?.card).toBe("summary_large_image");
  });
});

describe("built head parity with docs/*.html", () => {
  it.skipIf(!existsSync(OUT_DIR))(
    "the home page links the favicon and sets og:image + twitter:card",
    () => {
      const html = readFileSync(join(OUT_DIR, "index.html"), "utf8");
      expect(html).toMatch(/<link rel="icon"[^>]*href="\/assets\/favicon\.svg"/);
      expect(html).toMatch(/<link rel="icon"[^>]*href="\/assets\/favicon-32\.png"/);
      expect(html).toMatch(/<meta property="og:image" content="[^"]*\/assets\/og-image\.png"/);
      expect(html).toMatch(/<meta name="twitter:card" content="summary_large_image"/);
    },
  );
});
