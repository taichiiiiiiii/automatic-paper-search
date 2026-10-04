import type { ReactNode } from "react";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { buildMetadata } from "../lib/metadata";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata = buildMetadata({
  path: "/",
  title: "PaperPilot",
  description: "AI/ML トップ会議の採択論文をタイトル・著者・タグから横断検索できるツール。",
});

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
