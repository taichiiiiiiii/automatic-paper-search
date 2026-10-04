import type { ReactNode } from "react";
import { buildMetadata } from "../../lib/metadata";

// app/themes/page.tsx is a Client Component (useSearchParams + the
// theme-request form), so metadata lives in this small server-component
// layout alongside it, matching docs/themes/index.html's <title> /
// <meta name="description"> exactly.
export const metadata = buildMetadata({
  path: "/themes/",
  title: "系譜の公開準備状況 | PaperPilot",
  description:
    "PaperPilot の論文系譜について、品質監査を通過した公開対象の準備状況を案内します。未合格のデータは表示しません。",
});

export default function ThemesLayout({ children }: { children: ReactNode }) {
  return children;
}
