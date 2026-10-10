/**
 * Global site footer, matching the copy of the current docs/index.html
 * `<footer class="s0-footer">` (built-by credit, 仕組み / GitHub links,
 * data-source line), plus linked data sources and the 出典とライセンス
 * section link (R2 compliance: Semantic Scholar attribution). Styled with Tailwind utilities from the ported
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
        <Link href="/how-it-works/#credits" className="text-accent">
          出典とライセンス
        </Link>
        <span>
          データ:{" "}
          <a href="https://arxiv.org/" rel="noopener" className="text-accent">
            arXiv
          </a>{" "}
          /{" "}
          <a href="https://www.semanticscholar.org/" rel="noopener" className="text-accent">
            Semantic Scholar
          </a>{" "}
          /{" "}
          <a href="https://openalex.org/" rel="noopener" className="text-accent">
            OpenAlex
          </a>
        </span>
      </nav>
    </footer>
  );
}
