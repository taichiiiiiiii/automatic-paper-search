import { describe, expect, it } from "vitest";
import { buildHomeJsonLd, serializeJsonLd } from "../../lib/landing-json-ld";

// Port of docs/index.html's <script type="application/ld+json"> block
// (row 4 of docs/migration/p2-parity-gaps.md): schema.org WebSite +
// SearchAction, with URLs from canonicalUrl instead of the old GitHub
// Pages origin.

describe("buildHomeJsonLd", () => {
  it("matches docs/index.html's WebSite + SearchAction shape, with the new origin", () => {
    expect(buildHomeJsonLd()).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "PaperPilot",
      url: "https://paperpilot.pages.dev/",
      description: "AI/ML トップ会議の採択論文をタイトル・著者・タグから横断検索できるツール",
      inLanguage: "ja",
      potentialAction: {
        "@type": "SearchAction",
        target: "https://paperpilot.pages.dev/?q={search_term_string}",
        "query-input": "required name=search_term_string",
      },
    });
  });
});

describe("serializeJsonLd", () => {
  it("round-trips through JSON.parse back to the original value", () => {
    const data = buildHomeJsonLd();
    expect(JSON.parse(serializeJsonLd(data))).toEqual(data);
  });

  it("escapes '<' and '>' as \\u003c / \\u003e so a literal </script> cannot appear", () => {
    const serialized = serializeJsonLd({ evil: "</script><script>alert(1)</script>" });
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain(">");
    expect(serialized).toContain("\\u003c/script\\u003e");
  });

  it("escapes '&' as \\u0026", () => {
    expect(serializeJsonLd({ a: "x&y" })).toBe('{"a":"x\\u0026y"}');
  });

  it("escapes U+2028 and U+2029", () => {
    expect(serializeJsonLd({ a: "x\u2028y\u2029z" })).toBe('{"a":"x\\u2028y\\u2029z"}');
  });

  it("does not escape ordinary quotes or backslashes beyond JSON.stringify's own escaping", () => {
    expect(serializeJsonLd({ a: 'say "hi"' })).toBe('{"a":"say \\"hi\\""}');
  });
});
