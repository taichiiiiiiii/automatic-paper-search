import type { Metadata } from "next";
import { buildMetadata } from "../../../../lib/metadata";
import { buildPaperLinkPages, paperLinksPageCount, paperLinksPagePath } from "../logic";
import { readPapers } from "../read-papers";
import { PaperLinksView } from "../view";

/**
 * Pages 2..n of the split no-JS paper-links fallback (R3-2, design doc 52
 * §8): `/<conf>/paper-links/<n>/`. Page 1 stays at `/<conf>/paper-links/`
 * (`../page.tsx`), so `/<conf>/paper-links/1/` is deliberately not
 * generated. A conference with at most `NOJS_ROWS_PER_PAGE` papers gets no
 * route here at all. Same noindex/no-canonical metadata as page 1 (see
 * `../layout.tsx`): these are duplicate no-JS projections of `/<conf>/`
 * and `scripts/sitemap.ts` keeps them out of the sitemap by that meta.
 */

export function generateStaticParams({
  params,
}: {
  params: { conf: string };
}): Array<{ page: string }> {
  const count = paperLinksPageCount(readPapers(params.conf).length);
  const out: Array<{ page: string }> = [];
  for (let page = 2; page <= count; page++) out.push({ page: String(page) });
  return out;
}

export const dynamicParams = false;

function parsePage(conf: string, value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`/${conf}/paper-links/${value}/: not a page number`);
  }
  return Number(value);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ conf: string; page: string }>;
}): Promise<Metadata> {
  const { conf, page } = await params;
  const pageNumber = parsePage(conf, page);
  const base = buildMetadata({
    path: paperLinksPagePath(conf, pageNumber),
    title: `${conf} 論文リンク一覧（${pageNumber} ページ目） — PaperPilot`,
    description: "論文タイトルから原論文を開けます。JavaScript なしで利用できる簡易一覧です。",
  });
  return {
    title: base.title,
    description: base.description,
    openGraph: base.openGraph,
    twitter: base.twitter,
    alternates: { canonical: undefined },
    robots: { index: false, follow: true },
  };
}

export default async function PaperLinksSubPage({
  params,
}: {
  params: Promise<{ conf: string; page: string }>;
}) {
  const { conf, page } = await params;
  const pageNumber = parsePage(conf, page);
  const papers = readPapers(conf);
  const pages = buildPaperLinkPages(papers);
  return <PaperLinksView conf={conf} pages={pages} pageNumber={pageNumber} total={papers.length} />;
}
