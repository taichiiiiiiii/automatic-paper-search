/**
 * Global site footer: site-info links (仕組み, 出典とライセンス, R2-27
 * プライバシー and the private 削除依頼 route, GitHub) and the linked
 * data sources (R2 compliance: Semantic Scholar attribution). Styled with
 * Tailwind utilities from the ported design tokens.
 *
 * UX audit (design 53, トップ・共通): links are padded to a 24px+ target
 * (they were 17-20px and wrapped into each other on phones), the data
 * sources moved out of the "documents" nav into their own line, and the
 * English "Built by PaperPilot" became a one-line Japanese statement of
 * who runs the site.
 */
import Link from "next/link";
import { PRIVACY_PATH, PRIVATE_REPORT_URL, REPO_URL } from "../lib/site-links";

const LINK = "inline-flex min-h-6 items-center py-1 text-accent-strong";

const DATA_SOURCES = [
  { href: "https://arxiv.org/", label: "arXiv" },
  { href: "https://www.semanticscholar.org/", label: "Semantic Scholar" },
  { href: "https://openalex.org/", label: "OpenAlex" },
  { href: "https://openreview.net/", label: "OpenReview" },
  { href: "https://aclanthology.org/", label: "ACL Anthology" },
  { href: "https://openaccess.thecvf.com/", label: "CVF Open Access" },
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-auto flex flex-col gap-2 border-t border-rule px-4 py-6 text-sm text-ink-muted sm:px-6">
      <nav aria-label="サイト情報">
        <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0">
          <li>
            <Link href="/how-it-works/" prefetch={false} className={LINK}>
              仕組み
            </Link>
          </li>
          <li>
            <Link href="/how-it-works/#credits" prefetch={false} className={LINK}>
              出典とライセンス
            </Link>
          </li>
          <li>
            <Link href={PRIVACY_PATH} prefetch={false} className={LINK}>
              プライバシー
            </Link>
          </li>
          <li>
            <a href={PRIVATE_REPORT_URL} rel="noopener" className={LINK}>
              削除依頼
            </a>
          </li>
          <li>
            <a href={REPO_URL} rel="noopener" className={LINK}>
              GitHub
            </a>
          </li>
        </ul>
      </nav>
      <p className="m-0 leading-relaxed">
        データ:{" "}
        {DATA_SOURCES.map((source, index) => (
          <span key={source.href}>
            {index > 0 ? " / " : null}
            <a href={source.href} rel="noopener" className="text-accent-strong">
              {source.label}
            </a>
          </span>
        ))}
      </p>
      <p className="m-0">PaperPilot は個人が運営する非営利のサイトです。</p>
    </footer>
  );
}
