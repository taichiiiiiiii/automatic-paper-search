import type { ReactNode } from "react";
import { buildMetadata } from "../../lib/metadata";

// page.tsx is a Client Component (it fetches papers.json), and Next.js
// does not allow exporting `metadata` from a Client Component file --
// hence this small server-component layout alongside it.
export const metadata = buildMetadata({
  path: "/cvpr-2026/",
  title: "CVPR 2026 — PaperPilot",
  description:
    "CVPR 2026 採択論文のフィルタブル一覧。タイトル・著者・要旨での検索、トピックタグ、採択形式（Oral / Poster）、並び替えで絞り込めます。",
});

export default function Cvpr2026Layout({ children }: { children: ReactNode }) {
  return children;
}
