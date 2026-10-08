import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { buildMetadata } from "../lib/metadata";
import { fontVariables } from "./fonts";
import "./globals.css";

// `icons` set on the root layout's metadata is inherited by every page
// that does not set its own (Next.js metadata merging), so this is the
// one place favicon parity with docs/*.html's `<link rel="icon">` tags
// needs to be declared. Assets copied from docs/assets/ by
// scripts/copy-data.ts into public/assets/ -- see lib/metadata.ts's
// DEFAULT_OG_IMAGE doc comment for the same asset-provenance note.
const ICONS: Metadata["icons"] = {
  icon: [
    { url: "/assets/favicon.svg", type: "image/svg+xml" },
    { url: "/assets/favicon-32.png", sizes: "32x32", type: "image/png" },
  ],
};

export const metadata: Metadata = {
  ...buildMetadata({
    path: "/",
    title: "PaperPilot",
    description: "AI/ML トップ会議の採択論文をタイトル・著者・タグから横断検索できるツール。",
  }),
  icons: ICONS,
};

/**
 * Every page's top-level element must be `<main id="main-content">` so
 * the skip link below actually skips to it. The skip link, header and
 * footer are rendered once here; a page component itself should render
 * `<main id="main-content">...</main>` and nothing else at its top level.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" className={fontVariables}>
      <body className="flex min-h-screen flex-col bg-paper text-ink antialiased">
        <a className="skip-link" href="#main-content">
          本文へスキップ
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
