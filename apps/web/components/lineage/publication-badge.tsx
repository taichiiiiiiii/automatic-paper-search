/**
 * Publication-tier badge and one-line explanation (design doc 41 D1).
 * Every lineage surface that shows a published collection renders the
 * badge next to its name, so an unaudited (machine-only) lineage is never
 * presented as if a person had checked it.
 */
import type { PublishedTier } from "../../lib/lineage/core";

export const PUBLICATION_TIER_LABEL: Record<PublishedTier, string> = {
  audited: "監査済み",
  unaudited: "未監査（自動生成）",
};

export const PUBLICATION_TIER_NOTE: Record<PublishedTier, string> = {
  audited:
    "自動検査に加えて、人が論文のテーマ適合と強い主張の関係（対比・置き換え）を確認済みです。",
  unaudited:
    "自動検査（形式・識別子・関係の根拠）には合格していますが、人による内容確認はまだです。テーマ外の論文や誤った関係を含むことがあります。",
};

export function PublicationBadge({ tier }: { tier: PublishedTier }) {
  const className =
    tier === "audited"
      ? "border-[var(--rel-extends)] text-ink"
      : "border-[var(--color-oral)] text-ink-muted";
  return (
    <span
      data-publication-tier={tier}
      title={PUBLICATION_TIER_NOTE[tier]}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {PUBLICATION_TIER_LABEL[tier]}
    </span>
  );
}

/** Badge plus the one-line explanation, for a lineage page header. */
export function PublicationNotice({ tier }: { tier: PublishedTier }) {
  return (
    <p
      className="flex flex-wrap items-center gap-2 text-sm text-ink-muted"
      data-publication-notice={tier}
    >
      <PublicationBadge tier={tier} />
      <span>{PUBLICATION_TIER_NOTE[tier]}</span>
    </p>
  );
}
