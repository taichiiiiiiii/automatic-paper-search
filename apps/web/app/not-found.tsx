/**
 * Cloudflare Pages requires a 404.html at the output root or it treats
 * the deploy as an SPA and returns 200 for any unknown path (design doc
 * §4.2-4). Next's static export writes this file's output to
 * `out/404.html` automatically as the App Router's not-found page.
 */
export const metadata = {
  title: "404 — このページは見つかりません · PaperPilot",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main id="main-content" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-16 sm:px-6">
      <h1 className="font-serif text-2xl font-bold text-ink">404 — このページは見つかりません</h1>
      <p className="text-base text-ink-muted">
        お探しのページは見つかりませんでした。トップページから論文カタログへ戻ってください。
      </p>
    </main>
  );
}
