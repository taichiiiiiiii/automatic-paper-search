/**
 * Global site footer, matching the copy of the current docs/index.html
 * `<footer class="s0-footer">` (built-by credit, 仕組み / GitHub links,
 * data-source line), plus linked data sources and the 出典とライセンス
 * section link (R2 compliance: Semantic Scholar attribution), and since
 * R2-27 the プライバシー section and the private 削除依頼 route. Styled with Tailwind utilities from the ported
 * design tokens rather than the original `.s0-footer` CSS (see
 * site-header.tsx for why).
 */
import Link from "next/link";
import { PRIVACY_PATH, PRIVATE_REPORT_URL, REPO_URL } from "../lib/site-links";

export function SiteFooter() {
  return (
    <footer className="mt-auto flex flex-col gap-2 border-t border-rule px-4 py-6 text-sm text-ink-muted sm:px-6">
      <div>
        Built by{" "}
        <a href={REPO_URL} rel="noopener" className="text-accent">
          PaperPilot
        </a>
      </div>
      <nav className="flex flex-wrap gap-4" aria-label="関連ドキュメント">
        <Link href="/how-it-works/" className="text-accent">
          仕組み
        </Link>
        <a href={REPO_URL} rel="noopener" className="text-accent">
          GitHub
        </a>
        <Link href="/how-it-works/#credits" className="text-accent">
          出典とライセンス
        </Link>
        <Link href={PRIVACY_PATH} className="text-accent">
          プライバシー
        </Link>
        <a href={PRIVATE_REPORT_URL} rel="noopener" className="text-accent">
          削除依頼
        </a>
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
          </a>{" "}
          /{" "}
          <a href="https://openreview.net/" rel="noopener" className="text-accent">
            OpenReview
          </a>{" "}
          /{" "}
          <a href="https://aclanthology.org/" rel="noopener" className="text-accent">
            ACL Anthology
          </a>{" "}
          /{" "}
          <a href="https://openaccess.thecvf.com/" rel="noopener" className="text-accent">
            CVF Open Access
          </a>
        </span>
      </nav>
    </footer>
  );
}
