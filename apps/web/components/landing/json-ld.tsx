import { buildHomeJsonLd, serializeJsonLd } from "../../lib/landing-json-ld";

/**
 * Renders the schema.org `WebSite` + `SearchAction` JSON-LD block
 * ported from docs/index.html's `<head>` (row 4 of
 * docs/migration/p2-parity-gaps.md). A Server Component with no props,
 * meant to be rendered as a sibling of the page content in
 * app/page.tsx: Next.js App Router automatically hoists any
 * `<script>`/`<meta>`/`<link>`/`<title>` rendered anywhere in a
 * layout/page tree into the document `<head>`, so this needs no manual
 * `<head>` element of its own.
 *
 * Deliberately not `dangerouslySetInnerHTML` (banned -- CLAUDE.md
 * "never use dangerouslySetInnerHTML"): the JSON string is passed as
 * an ordinary text child instead. React does not HTML-entity-escape
 * text children of a `<script>` element (browsers parse `<script>`
 * content as raw text, where HTML entities are never decoded, so
 * encoding `<` as `&lt;` there would corrupt the JSON rather than
 * protect anything), which is why `serializeJsonLd`'s own
 * `<`/`>`/`&`/U+2028/U+2029 escaping -- not React's default escaping --
 * is what keeps this safe. Verified against the built HTML in
 * apps/web/out: the emitted `<script>` body is exactly
 * `serializeJsonLd(buildHomeJsonLd())`, byte for byte.
 */
export function HomeJsonLd() {
  return <script type="application/ld+json">{serializeJsonLd(buildHomeJsonLd())}</script>;
}
