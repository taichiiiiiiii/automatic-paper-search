"use client";

/**
 * 「この図の読み方」 — the one place on the theme page that explains the
 * terms (本流・土台・発展・根拠), the line colours per relation type and
 * the small badges on the cards (UX audit, design 53 §系譜ページ). It
 * replaced the old 横軸 coach-mark and the scattered one-line
 * explanations, so each term is defined once.
 *
 * A native <details>: keyboard and screen-reader support come for free,
 * and it renders no inline style (CSP).
 */
import { ALL_RELATIONS } from "../../lib/themes-tree";
import { RELATION_DOT_CLASS } from "../lineage/graph/relation-colors";
import { useRelationAudited } from "../lineage/relation-audit";
import { relationLabelJa } from "./EdgeEvidence";
import styles from "./LineageTree.module.css";

/** What each relation means, in reader terms (newer paper → older one). */
export const RELATION_MEANING_JA: Record<(typeof ALL_RELATIONS)[number], string> = {
  supersedes: "新しい論文が古い手法を置き換えた",
  successor: "同じ系列の後継（次の版）",
  extends: "古い論文の手法を広げた・改良した",
  ablation: "古い論文の手法を分析・検証した",
  baseline_only: "背景・関連研究として引用した（強い関係ではない）",
  contrasts: "古い論文と異なる立場・設計をとる（初期状態では非表示）",
};

export function ReadingGuide({
  open,
  onToggle,
  mainPathCount,
  hasCodeLinks,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  mainPathCount: number;
  hasCodeLinks: boolean;
}) {
  const audited = useRelationAudited();
  return (
    <details
      className="mt-3 rounded-md border border-rule bg-surface px-3 py-2 text-xs text-ink-muted"
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) onToggle(next);
      }}
      data-reading-guide
    >
      <summary className="cursor-pointer py-1 text-sm font-semibold text-ink">
        この図の読み方
      </summary>
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        <section aria-labelledby="guide-terms">
          <h3 id="guide-terms" className="font-semibold text-ink">
            ことば
          </h3>
          <dl className="mt-1 space-y-1">
            <div>
              <dt className="inline font-semibold text-ink">本流</dt>
              <dd className="inline">
                ：引用の流れがいちばん多く通る経路（強い関係を重く数える）。太い線と「本流」の印で示します
                {mainPathCount > 0 ? `（${mainPathCount} 本の線）` : ""}。
                <a href="/how-it-works/#main-path" className="ml-1 text-accent-strong underline">
                  計算のしかた
                </a>
              </dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">土台</dt>
              <dd className="inline">：選んだ論文が基にした、古い論文。</dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">発展</dt>
              <dd className="inline">：選んだ論文を基にした、新しい論文。</dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">根拠</dt>
              <dd className="inline">
                ：関係をそう判定した理由と、引用元の 1 文。線や「根拠」ボタンで表示します。
              </dd>
            </div>
          </dl>
        </section>
        <section aria-labelledby="guide-lines">
          <h3 id="guide-lines" className="font-semibold text-ink">
            線の色（古い論文 → 新しい論文）
          </h3>
          <ul className="mt-1 space-y-1" data-relation-legend>
            {ALL_RELATIONS.map((r) => (
              <li key={r} className="flex items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className={`inline-block h-1 w-5 shrink-0 translate-y-[-2px] rounded-full ${RELATION_DOT_CLASS[r]}`}
                />
                <span>
                  <span className="font-semibold text-ink">{relationLabelJa(r, audited)}</span>：
                  {RELATION_MEANING_JA[r]}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1">線が太いほど、判定の確信度が高い関係です。</p>
          <p className="mt-1" data-s2-influential-legend>
            「引用」の線でも、Semantic Scholar
            が影響の大きい方法論の引用と判定したものは、やや太く濃く描きます（関係の種類や強い関係の数は変わりません）。
          </p>
        </section>
        <section aria-labelledby="guide-badges">
          <h3 id="guide-badges" className="font-semibold text-ink">
            カードの印
          </h3>
          <ul className="mt-1 space-y-1">
            <li>
              <span className={`${styles.badge} ${styles.badgeMain}`}>本流</span> 本流の上にある論文
            </li>
            <li>
              <span className={`${styles.badge} ${styles.badgeHub}`}>HUB</span>{" "}
              ほかの論文との関係が特に多い論文
            </li>
            <li>
              <span className={`${styles.badge} ${styles.badgeTrend}`}>TREND</span>{" "}
              最近、引用が伸びている論文
            </li>
            <li>
              <span className={`${styles.badge} ${styles.badgeOrphan}`}>孤立</span> 関係の線が 1
              本もない論文（初期状態では非表示）
            </li>
            {hasCodeLinks && (
              <li>
                <span className="rounded bg-surface-2 px-1 text-[0.6rem] font-semibold">
                  コード
                </span>{" "}
                <span className="rounded bg-surface-2 px-1 text-[0.6rem] font-semibold">HF</span>{" "}
                公開コード・Hugging Face のページがある論文
              </li>
            )}
            <li>📖 被引用数（データの日付の値）</li>
          </ul>
          <p className="mt-1">
            「監査済み」は人が内容を確認した系譜、「未監査（自動生成）」は自動検査だけに合格した系譜です。
          </p>
        </section>
      </div>
    </details>
  );
}
