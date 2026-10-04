import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { selectCatalogConferences } from "../../../lib/catalog-conferences";
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
 * writes it for every conference it builds a catalog for.
 *
 * `robots: { index: false, follow: true }` matches the original page's
 * `<meta name="robots" content="noindex" />` -- this is a duplicate
 * projection of `/<conf>/`'s content for no-JS clients, not a page search
 * engines should index separately. `scripts/sitemap.ts` relies on exactly
 * this meta to keep it out of `out/sitemap.xml`.
 */

function readConferenceSlugs(): string[] {
  const path = join(process.cwd(), "public", "conferences.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return selectCatalogConferences(raw).map((row) => row.name);
}

export function generateStaticParams(): Array<{ conf: string }> {
  return readConferenceSlugs().map((conf) => ({ conf }));
}

export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ conf: string }>;
}): Promise<Metadata> {
  const { conf } = await params;
  return {
    ...buildMetadata({
      path: `/${conf}/paper-links/`,
      title: `${conf} 論文リンク一覧 — PaperPilot`,
      description: "論文タイトルから原論文を開けます。JavaScript なしで利用できる簡易一覧です。",
    }),
    robots: { index: false, follow: true },
  };
}

export default function ConferencePaperLinksLayout({ children }: { children: ReactNode }) {
  return children;
}
