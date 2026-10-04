import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "PaperPilot",
  description: "PaperPilot TypeScript migration prototype",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
