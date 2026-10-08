import type { ReactNode } from "react";
import { buildMetadata } from "../../lib/metadata";

// page.tsx is a Client Component (it reads `?paper=` and fetches the
// pilot index), so metadata lives in this sibling server-component
// layout -- same split as app/cvpr-2026/layout.tsx. No dynamic segment
// here (this route is query-string driven, like docs/lineage/index.html),
// so no generateStaticParams is needed.
export const metadata = {
  ...buildMetadata({
    path: "/lineage/",
    title: "研究系譜 Focus View — PaperPilot",
    description: "監査済みの根拠から、研究の継承・比較関係を確認する Focus View。",
  }),
  // docs/lineage/index.html carries <meta name="robots" content="noindex">
  // (this is a pilot-release detail view, not a canonical catalog page).
  // buildMetadata() has no `robots` option, so it is added here rather
  // than editing lib/metadata.ts (out of this page's ownership).
  robots: { index: false, follow: false },
};

export default function LineageFocusLayout({ children }: { children: ReactNode }) {
  return children;
}
