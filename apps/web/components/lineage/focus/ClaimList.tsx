"use client";

/**
 * Paginated relation list -- ported from docs/assets/lineage-focus.js
 * `renderList`/`claimCard`. 20 claims per page (`FocusViewState.pageSize`).
 *
 * `pendingListHeadingFocus` mirrors the original's paging handler
 * moving focus to `#lineage-list-heading` after a page change (never
 * leaving focus on a since-removed "次へ"/"前へ" button).
 */
import { useEffect, useRef } from "react";
import { labelForRelation } from "../../../lib/lineage/v2/layout";
import type { FocusProjection } from "../../../lib/lineage/v2/projection";
import type { LineageV2Claim, LineageV2Node } from "../../../lib/lineage/v2/types";
import styles from "./focus.module.css";

const TRUST_LABELS: Record<string, string> = {
  verified: "人手検証済み",
  corroborated: "複数の根拠で支持",
  tentative: "要確認の推定",
};

export interface ClaimListProps {
  projection: FocusProjection;
  page: number;
  onPageChange: (page: number) => void;
  onInspect: (claimId: string, trigger: HTMLElement) => void;
  pendingListHeadingFocus: boolean;
  onListHeadingFocusApplied: () => void;
}

const PAGE_SIZE = 20;

function ClaimCard({
  claim,
  nodeById,
  onInspect,
}: {
  claim: LineageV2Claim;
  nodeById: Map<string, LineageV2Node>;
  onInspect: (claimId: string, trigger: HTMLElement) => void;
}) {
  const srcTitle = nodeById.get(claim.src)?.title || claim.src;
  const dstTitle = nodeById.get(claim.dst)?.title || claim.dst;
  const heading = `${srcTitle} → ${dstTitle}`;
  return (
    <article className={styles.claim}>
      <h3>{heading}</h3>
      <p className={styles.claimMeta}>
        {`${labelForRelation(claim.relation)} · ${
          claim.claim_family === "comparison" ? "比較（継承ではありません）" : "研究の継承"
        } · ${TRUST_LABELS[claim.trust_tier] || "未確認"}`}
      </p>
      <p>{`関係の解釈: ${claim.rationale || "説明は収録されていません。根拠を確認してください。"}`}</p>
      <button
        type="button"
        aria-label={`${heading}の根拠と監査を確認`}
        onClick={(event) => onInspect(claim.id, event.currentTarget)}
      >
        根拠と監査を確認
      </button>
    </article>
  );
}

export function ClaimList({
  projection,
  page,
  onPageChange,
  onInspect,
  pendingListHeadingFocus,
  onListHeadingFocusApplied,
}: ClaimListProps) {
  const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
  const claims = projection.claims;
  const pages = Math.max(1, Math.ceil(claims.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const shown = claims.slice(start, start + PAGE_SIZE);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!pendingListHeadingFocus) return;
    headingRef.current?.focus({ preventScroll: true });
    onListHeadingFocusApplied();
  }, [pendingListHeadingFocus, onListHeadingFocusApplied]);

  return (
    <section id="lineage-list-panel" aria-labelledby="lineage-list-heading">
      <div className={styles.listHead}>
        <h2 id="lineage-list-heading" ref={headingRef} tabIndex={-1}>
          関係一覧
        </h2>
        <p>{`${currentPage} / ${pages} ページ（${claims.length} 件）`}</p>
      </div>
      <div className={styles.claimList}>
        {shown.length === 0 ? (
          <p>現在の条件で表示できる関係はありません。</p>
        ) : (
          shown.map((claim) => (
            <ClaimCard key={claim.id} claim={claim} nodeById={nodeById} onInspect={onInspect} />
          ))
        )}
      </div>
      {pages > 1 && (
        <nav className={styles.pagination} aria-label="関係一覧のページ">
          <button
            type="button"
            disabled={currentPage === 1}
            onClick={() => onPageChange(currentPage - 1)}
          >
            前へ
          </button>
          <button
            type="button"
            disabled={currentPage === pages}
            onClick={() => onPageChange(currentPage + 1)}
          >
            次へ
          </button>
        </nav>
      )}
    </section>
  );
}
