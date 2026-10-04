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
 */
import { canonicalUrl } from "../lib/config";

// Keep the original docs/404.html preview card (og:type website + the
// site OG image, fully qualified) while still dropping og:url: Next
// replaces a child's openGraph object instead of merging it, so the
// fields must be restated here.
export const metadata = {
  title: "404 — このページは見つかりません · PaperPilot",
  alternates: { canonical: undefined },
  openGraph: {
    url: undefined,
    type: "website",
    images: [{ url: canonicalUrl("/assets/og-image.png"), width: 1200, height: 630 }],
  },
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
