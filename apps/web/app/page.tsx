import { HomeJsonLd } from "../components/landing/json-ld";
import { Landing } from "../components/landing/landing";
import { buildMetadata } from "../lib/metadata";

/**
 * S0 search-first top page (port of docs/index.html). A server component
 * so it can export `metadata` directly (no sibling layout.tsx needed at
 * the route root, unlike apps/web/app/cvpr-2026 -- see that directory's
 * layout.tsx for why nested client routes need one); all interactive
 * behavior lives in the client component it renders.
 *
 * `<HomeJsonLd />` (row 4 of docs/migration/p2-parity-gaps.md) is a
 * sibling, not a child, of `<Landing />`: it is inert `<head>` data
 * (Next.js App Router hoists the `<script>` it renders into `<head>`
 * automatically), not part of the `<main id="main-content">` page
 * content that `<Landing />` itself renders.
 */
export const metadata = buildMetadata({
  path: "/",
  title: "PaperPilot — AI 論文を横断検索。トップ会議 10 学会・28,000 本から探す",
  description:
    "AI/ML トップ会議 10 学会・28,000 本以上の採択論文を、タイトル・著者・タグから横断検索できます。",
});

export default function HomePage() {
  return (
    <>
      <HomeJsonLd />
      <Landing />
    </>
  );
}
