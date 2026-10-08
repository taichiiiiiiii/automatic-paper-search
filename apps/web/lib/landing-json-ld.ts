/**
 * JSON-LD (schema.org `WebSite` + `SearchAction`) for the top page,
 * ported from docs/index.html's `<script type="application/ld+json">`
 * block in `<head>` (row 4 of docs/migration/p2-parity-gaps.md). URLs
 * come from `canonicalUrl` (apps/web/lib/config.ts ->
 * @paperpilot/core/site), never hard-coded, so this tracks the same
 * origin change as every other page's metadata.
 *
 * `serializeJsonLd` escapes angle brackets, ampersand, and the two
 * Unicode line/paragraph separator code points so the result is safe
 * to place verbatim as a `<script>` element's text child (see
 * components/landing/json-ld.tsx for why that -- not
 * `dangerouslySetInnerHTML`, which is banned -- is how it gets
 * rendered): a literal `</script` substring in a value could otherwise
 * end the element's raw-text content early regardless of the
 * surrounding JSON structure, and the two separator code points are
 * historically unsafe wherever this text might later be run through a
 * JS parser instead of `JSON.parse`.
 */
import { canonicalUrl } from "./config";

export function buildHomeJsonLd(): Record<string, unknown> {
  const home = canonicalUrl("/");
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "PaperPilot",
    url: home,
    description: "AI/ML トップ会議の採択論文をタイトル・著者・タグから横断検索できるツール",
    inLanguage: "ja",
    potentialAction: {
      "@type": "SearchAction",
      target: `${home}?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };
}

// Built via String.fromCharCode rather than a `\u` escape or literal
// character in a string/regex literal: U+2028 and U+2029 are
// themselves JS/TS source line terminators (per the ECMAScript
// grammar), so pasting either in raw -- even inside a regex literal --
// would corrupt this file instead of matching the character at
// runtime.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Escapes a JSON-serializable value for safe embedding as a
 * `<script type="application/ld+json">` text child. Not general HTML
 * escaping -- this intentionally does NOT escape quotes (JSON needs
 * its own `"` characters intact). */
export function serializeJsonLd(data: unknown): string {
  const json = JSON.stringify(data)
    .split("<")
    .join("\\u003c")
    .split(">")
    .join("\\u003e")
    .split("&")
    .join("\\u0026");
  return json.split(LINE_SEPARATOR).join("\\u2028").split(PARAGRAPH_SEPARATOR).join("\\u2029");
}
