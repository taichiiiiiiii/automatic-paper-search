"use client";

/**
 * The "関係の監査詳細" (relation audit detail) dialog -- ported from
 * docs/lineage/index.html's `<dialog id="lineage-inspector">` +
 * docs/assets/lineage-focus.js `openInspector`/`closeInspector`/the
 * `cancel`/`Escape`/`Tab`-trap handlers in `bindEvents`.
 *
 * Section boundaries are pinned by
 * test_lineage_focus_route.py::test_focus_view_keeps_observation_review_and_navigation_boundaries:
 * "観測された事実" (facts actually observed -- citation links +
 * evidence provenance, no interpretation) is kept separate from
 * "解釈と判定" (the derived relation/decision/trust-tier judgment),
 * and review-binding lookup matches on BOTH `review_id` AND
 * `evidence_sha256` (never `src`/`dst` alone, which would let a
 * same-named label from a different edge get attributed here).
 *
 * `open`/`onRequestClose` is a controlled pattern: the PARENT
 * (FocusView) decides whether closing should restore focus to the
 * trigger element (`closeInspector(true)`, the normal case) or not
 * (`closeInspector(false)`, used when the page is navigating/
 * tearing the release down) -- this component only ever asks to
 * close, never decides what happens to focus afterward.
 */
import { useEffect, useRef } from "react";
import { fixtureLabel, safeEvidenceLink } from "../../../lib/lineage/v2/layout";
import type { FocusProjection } from "../../../lib/lineage/v2/projection";
import type { LineageV2Claim, LineageV2Node, Release } from "../../../lib/lineage/v2/types";
import styles from "./focus.module.css";

export interface InspectorDialogProps {
  release: Release;
  projection: FocusProjection;
  claimId: string | null;
  open: boolean;
  onRequestClose: () => void;
}

function ValueRow({ term, value }: { term: string; value: string | number | null | undefined }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value === null || value === undefined || value === "" ? "—" : String(value)}</dd>
    </>
  );
}

function locatorText(locator: Record<string, unknown>): string {
  return Object.entries(locator)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

export function InspectorDialog({
  release,
  projection,
  claimId,
  open,
  onRequestClose,
}: InspectorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      closeButtonRef.current?.focus();
    } else {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      onRequestClose();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onRequestClose]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onRequestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])'),
    ].filter((item) => !(item as HTMLButtonElement).disabled && !item.hidden);
    if (!focusable.length) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const claim = claimId ? projection.claims.find((item) => item.id === claimId) || null : null;
  const nodeById = new Map<string, LineageV2Node>(projection.nodes.map((node) => [node.id, node]));
  const evidenceById = new Map(release.artifact.evidence.map((item) => [item.id, item]));

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="lineage-inspector-title"
      onKeyDown={onKeyDown}
    >
      <div className={styles.dialogHead}>
        <h2 id="lineage-inspector-title">関係の監査詳細</h2>
        <button
          type="button"
          ref={closeButtonRef}
          aria-label="監査詳細を閉じる"
          onClick={onRequestClose}
        >
          閉じる
        </button>
      </div>
      <div className={styles.dialogBody}>
        {claim && (
          <InspectorBody
            release={release}
            claim={claim}
            nodeById={nodeById}
            evidenceById={evidenceById}
          />
        )}
      </div>
    </dialog>
  );
}

function InspectorBody({
  release,
  claim,
  nodeById,
  evidenceById,
}: {
  release: Release;
  claim: LineageV2Claim;
  nodeById: Map<string, LineageV2Node>;
  evidenceById: Map<string, Release["artifact"]["evidence"][number]>;
}) {
  const label = fixtureLabel(release, claim);
  const evidenceRows = claim.evidence_ids
    .map((id) => evidenceById.get(id))
    .filter(Boolean) as Array<Release["artifact"]["evidence"][number]>;
  const claimEvidenceIds = new Set(claim.evidence_ids);
  const citationLinks = release.artifact.links.filter((link) =>
    link.evidence_ids.some((id) => claimEvidenceIds.has(id)),
  );

  return (
    <>
      <h3>観測された事実</h3>
      <dl className={styles.facts}>
        {citationLinks.map((link) => (
          <ValueRowGroup key={link.id}>
            <ValueRow term="観測リンク" value={`${link.src} → ${link.dst}`} />
            <ValueRow term="リンク種別" value={link.type} />
          </ValueRowGroup>
        ))}
        {evidenceRows.map((item) => (
          <ValueRowGroup key={item.id}>
            <ValueRow term="引用側 work ID" value={item.citing_work_id} />
            <ValueRow term="被引用側 work ID" value={item.cited_work_id} />
            <ValueRow term="取得元 work ID" value={item.source_work_id} />
            <ValueRow term="取得ソース / 種類" value={`${item.source} / ${item.kind}`} />
            <ValueRow
              term="引用位置"
              value={locatorText(item.locator as unknown as Record<string, unknown>)}
            />
          </ValueRowGroup>
        ))}
      </dl>

      <h3>解釈と判定</h3>
      <dl className={styles.facts}>
        <ValueRow term="起点" value={nodeById.get(claim.src)?.title || claim.src} />
        <ValueRow term="終点" value={nodeById.get(claim.dst)?.title || claim.dst} />
        <ValueRow term="推定された関係" value={claim.relation ?? "未分類"} />
        <ValueRow term="関係族" value={claim.claim_family} />
        <ValueRow term="判定" value={claim.decision} />
        <ValueRow term="信頼段階" value={claim.trust_tier} />
      </dl>
      <p>{`関係の解釈: ${claim.rationale || "説明は収録されていません。"}`}</p>
      <p>
        {claim.raw_score === null
          ? "モデル自己評価は収録されていません。"
          : `モデル自己評価 ${claim.raw_score.toFixed(2)}（未較正）`}
      </p>
      <p>
        {claim.calibrated_probability === null
          ? "検証データに基づく推定正答率は収録されていません。"
          : `検証データに基づく推定正答率 ${Math.round(claim.calibrated_probability * 100)}%`}
      </p>
      <p>
        {`分類: ${claim.classification.method} / ${claim.classification.provider || "非LLM"} / ${
          claim.classification.model || "—"
        } / ${claim.classification.schema_version}`}
      </p>

      <h3>根拠</h3>
      <ol className={styles.evidenceList}>
        {evidenceRows.map((item) => {
          const href = safeEvidenceLink(item.url);
          return (
            <li key={item.id}>
              <strong>{`${item.source} / ${item.kind}`}</strong>
              <p>{item.excerpt}</p>
              <p>{locatorText(item.locator as unknown as Record<string, unknown>)}</p>
              <p className={styles.hash}>
                {`retrieved ${item.retrieved_at} · excerpt sha256 ${item.excerpt_sha256} · input sha256 ${item.input_sha256} · snapshot ${item.snapshot_ref}`}
              </p>
              {href && (
                <a href={href} target="_blank" rel="noopener">
                  原典を開く
                </a>
              )}
            </li>
          );
        })}
      </ol>

      <h3>人手レビュー</h3>
      {!label ? (
        <p>公開されたレビュー対応情報はありません。</p>
      ) : (
        <div>
          <p>
            {`裁定: citation ${label.adjudication.citation_valid ? "valid" : "invalid"} · ${
              label.adjudication.gold_family || "familyなし"
            } / ${label.adjudication.gold_relation || "relationなし"} · ${label.adjudication.evidence_support}`}
          </p>
          <ul>
            {label.reviews.map((item) => (
              <li key={item.reviewer_id}>
                {`${item.reviewer_id}: citation ${item.citation_valid ? "valid" : "invalid"} · ${
                  item.gold_family || "familyなし"
                } / ${item.gold_relation || "relationなし"} · ${item.evidence_support}${
                  item.notes ? ` — ${item.notes}` : ""
                }`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ValueRowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
