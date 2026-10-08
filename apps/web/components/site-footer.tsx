/**
 * Global site footer, matching the copy of the current docs/index.html
 * `<footer class="s0-footer">` (built-by credit, 仕組み / GitHub links,
 * data-source line). Styled with Tailwind utilities from the ported
 * design tokens rather than the original `.s0-footer` CSS (see
 * site-header.tsx for why).
 */
import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto flex flex-col gap-2 border-t border-rule px-4 py-6 text-sm text-ink-muted sm:px-6">
      <div>
        Built by{" "}
        <a
          href="https://github.com/taichiiiiiiii/automatic-paper-search"
          rel="noopener"
          className="text-accent"
        >
          PaperPilot
        </a>
      </div>
      <nav className="flex flex-wrap gap-4" aria-label="関連ドキュメント">
        <Link href="/how-it-works/" className="text-accent">
          仕組み
        </Link>
        <a
          href="https://github.com/taichiiiiiiii/automatic-paper-search"
          rel="noopener"
          className="text-accent"
        >
          GitHub
        </a>
        <span>データ: arXiv / Semantic Scholar / OpenAlex</span>
      </nav>
    </footer>
  );
}
