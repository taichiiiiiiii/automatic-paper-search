import type { ReactNode } from "react";
import { buildMetadata } from "../../lib/metadata";

// page.tsx is a Client Component (theme-submission form), so metadata
// lives in this small server-component layout alongside it -- see the
// identical note in app/cvpr-2026/layout.tsx.
export const metadata = buildMetadata({
  path: "/themes/",
  title: "系譜 — PaperPilot",
  description: "テーマ文字列から論文の系譜（家系図）を生成・閲覧できます。",
});

export default function ThemesLayout({ children }: { children: ReactNode }) {
  return children;
}
