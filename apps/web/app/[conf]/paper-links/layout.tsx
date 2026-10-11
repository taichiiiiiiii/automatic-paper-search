import type { Metadata } from "next";
import type { ReactNode } from "react";
import { buildMetadata } from "../../../lib/metadata";

/**
 * The no-JS link-list route (`docs/<conf>/paper-links.html` today, design
 * doc §8 P2 row "`/<conf>/paper-links/`"). A Server Component, same split
 * as `app/[conf]/page.tsx`: `generateStaticParams`/`generateMetadata`
 * read `public/conferences.json` at build time with plain `node:fs` (that
 * file has already been copied from `docs/` by the `prebuild` step, so
 * this reads the same bytes the browser would fetch).
 *
 * One route per catalog conference -- every one of today's 10
 * `docs/<conf>/paper-links.html` files exists because `build_pages.py`
 * writes it for every conference it builds a catalog for. R3-2:
 * `generateStaticParams` moved from here to `page.tsx`. A layout-level
 * `generateStaticParams` would feed `{conf}` into `[page]/page.tsx` as
 * parent params, and Next 15's static export rejects the whole
 * `[page]` route ("missing generateStaticParams()") as soon as one
 * conference yields no page 2 (a partially-known route counts as a
 * fallback). With no parent here, `[page]/page.tsx` enumerates its
 * own `{conf, page}` pairs.
 *
 * `robots: { index: false, follow: true }` matches the original page's
 * `<meta name="robots" content="noindex" />` -- this is a duplicate
 * projection of `/<conf>/`'s content for no-JS clients, not a page search
 * engines should index separately. `scripts/sitemap.ts` relies on exactly
 * this meta to keep it out of `out/sitemap.xml`.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ conf: string }>;
}): Promise<Metadata> {
  const { conf } = await params;
  const base = buildMetadata({
    path: `/${conf}/paper-links/`,
    title: `${conf} 論文リンク一覧 — PaperPilot`,
    description: "論文タイトルから原論文を開けます。JavaScript なしで利用できる簡易一覧です。",
  });
  // No canonical link here: this page IS noindex (a duplicate no-JS
  // projection of `/<conf>/`), and the original
  // docs/<conf>/paper-links.html never carried a self-canonical tag
  // either -- a canonical pointing at a noindex page is a contradictory
  // signal to crawlers. Omitting `alternates` entirely would NOT do
  // this: Next's metadata merging inherits an unset field from the
  // nearest ancestor that sets one (here, the root layout's `/`
  // canonical) rather than leaving it empty, which is worse than a
  // self-canonical (it would point this page's canonical at the home
  // page). `canonical: undefined` is what actually clears it.
  return {
    title: base.title,
    description: base.description,
    openGraph: base.openGraph,
    twitter: base.twitter,
    alternates: { canonical: undefined },
    robots: { index: false, follow: true },
  };
}

export default function ConferencePaperLinksLayout({ children }: { children: ReactNode }) {
  return children;
}
