import type { ReactNode } from "react";
import { buildMetadata } from "../../lib/metadata";

// app/themes/page.tsx is a Client Component (useSearchParams + the
// theme-request form), so metadata lives in this small server-component
// layout alongside it.
export const metadata = buildMetadata({
  path: "/themes/",
  title: "テーマ別の系譜 | PaperPilot",
  description:
    "テーマごとに論文の系譜（家系図）を時系列で表示します。各関係の根拠と Semantic Scholar の引用文を確認できます。自動検査に合格した系譜だけを公開します。",
});

export default function ThemesLayout({ children }: { children: ReactNode }) {
  return children;
}
