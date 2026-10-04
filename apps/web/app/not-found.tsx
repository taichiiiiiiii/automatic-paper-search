/**
 * Cloudflare Pages requires a 404.html at the output root or it treats
 * the deploy as an SPA and returns 200 for any unknown path (design doc
 * §4.2-4). Next's static export writes this file's output to
 * `out/404.html` automatically as the App Router's not-found page.
 *
 * P2 review LOW-2: this metadata object does NOT go through
 * `buildMetadata()` -- the 404 page must not inherit the root layout's
 * canonical URL / og:url (both "/", design doc's home page), which
 * would tell a crawler or a shared link preview that the 404 is really
 * the home page. `alternates.canonical: undefined` and
 * `openGraph.url: undefined` override (not merge with) the inherited
 * values from `app/layout.tsx`'s root metadata. Deliberately no
 * `robots` field here: Next.js's app-render unconditionally injects its
 * own `<meta name="robots" content="noindex">` for the literal `/404`
 * page path (`NonIndex` in next/dist/server/app-render/app-render.js),
 * so adding our own `robots` metadata produces a second, redundant
 * `<meta name="robots">` tag rather than replacing that one.
 *
 * P2 review round 3 LOW-D: LOW-2 above only dropped `canonical`/`og:url`
 * -- it never gave this page its OWN `description`/`openGraph.description`,
 * so both kept inheriting the ROOT layout's home-page description (and,
 * via Next's own openGraph->twitter auto-fill, the home-page description
 * leaked into the `twitter:description` tag too). A crawler or shared
 * link preview of the 404 page described it as the home page's search
 * tool, not as a 404. `description` and `openGraph.description` below
 * are this page's own copy (mirrors the on-page text), same pattern as
 * `alternates.canonical`/`openGraph.url` -- a child's `openGraph` object
 * REPLACES the parent's rather than merging with it, so `type`/`images`
 * must be restated here too (see the comment above the object).
 *
 * `twitter: undefined` is set for the same reason as `openGraph.url`:
 * it forces Next to drop the inherited (home-page) twitter object
 * instead of keeping it verbatim. This does NOT suppress the
 * `twitter:*` meta tags outright -- Next.js's metadata post-processing
 * (`postProcessMetadata` in
 * node_modules/next/dist/lib/metadata/resolve-metadata.js) unconditionally
 * re-derives a twitter card from `openGraph`'s title/description/images
 * whenever `openGraph` is present and `twitter` resolves to nothing, so
 * there is no supported way to emit zero `twitter:*` tags while keeping
 * `openGraph` (docs/404.html, which predates this migration and has no
 * `openGraph` block at all, could omit twitter entirely; this page
 * cannot without also dropping the OG preview card). The practical
 * effect of `twitter: undefined` here is therefore not suppression but
 * CORRECTNESS: the re-derived twitter card now describes this 404 page
 * (via `openGraph.description` above), not the home page it used to
 * silently inherit.
 */
import { canonicalUrl } from "../lib/config";

const DESCRIPTION =
  "お探しのページは見つかりませんでした。トップページから論文カタログへ戻ってください。";

// Keep the original docs/404.html preview card (og:type website + the
// site OG image, fully qualified) while still dropping og:url: Next
// replaces a child's openGraph object instead of merging it, so the
// fields must be restated here.
export const metadata = {
  title: "404 — このページは見つかりません · PaperPilot",
  description: DESCRIPTION,
  alternates: { canonical: undefined },
  openGraph: {
    url: undefined,
    description: DESCRIPTION,
    type: "website",
    images: [{ url: canonicalUrl("/assets/og-image.png"), width: 1200, height: 630 }],
  },
  twitter: undefined,
};

export default function NotFound() {
  return (
    <main id="main-content" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-16 sm:px-6">
      <h1 className="font-serif text-2xl font-bold text-ink">404 — このページは見つかりません</h1>
      <p className="text-base text-ink-muted">
        お探しのページは見つかりませんでした。トップページから論文カタログへ戻ってください。
      </p>
    </main>
  );
}
