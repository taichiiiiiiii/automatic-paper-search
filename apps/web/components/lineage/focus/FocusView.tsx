"use client";

/**
 * The verified Focus View -- ported from docs/lineage/index.html's
 * `<article id="lineage-ready">` + the state/render orchestration in
 * docs/assets/lineage-focus.js (`normalizeAndProject`, `activate`,
 * `bindEvents`, `render`, `start`'s post-load portion).
 *
 * `app/lineage/page.tsx` owns verifying the release and computing the
 * FIRST `FocusViewState`/projection (mirroring `start()`'s single
 * codepath: a release that cannot even produce an initial projection
 * must never reach this component). From here on, this component
 * owns every subsequent URL/preference/projection transition --
 * control changes, centering, branch expand/collapse, pagination,
 * the inspector dialog, and `popstate` -- exactly the state
 * `normalizeAndProject` recomputes in the JS source. A later
 * transition that fails to project again (e.g. a manually edited
 * `?focus=` after a `popstate`) renders the SAME fail-closed message
 * the page-level gate uses, via the shared `AuditStatus` component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE_PATH } from "../../../lib/config";
import { resolveFocus, selectFocusProjection, writeState } from "../../../lib/lineage/v2";
import { type FocusViewState, readState } from "../../../lib/lineage/v2/state";
import type { Release } from "../../../lib/lineage/v2/types";
import { AuditStatus } from "../audit-status";
import { ClaimList } from "./ClaimList";
import { Controls } from "./Controls";
import styles from "./focus.module.css";
import { GraphView } from "./GraphView";
import { InspectorDialog } from "./InspectorDialog";
import { NodeCards, type PendingNodeFocus } from "./NodeCards";
import { Summary } from "./Summary";

const PREFERENCE_KEY = "paperpilotLineageFocusV1";
const CLOSED_HEADING = "監査済みの系譜は表示できません";
const CANNOT_RESTORE_MESSAGE = "指定された focus または表示条件を安全に復元できませんでした。";

function mobileMatches(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 720px)").matches === true
  );
}

function loadPreferences(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function persistPreferences(state: FocusViewState): void {
  try {
    window.localStorage.setItem(
      PREFERENCE_KEY,
      JSON.stringify({
        view: state.view,
        hops: String(state.hops),
        min_conf: String(state.minConfidence),
      }),
    );
  } catch {
    // preference storage is optional
  }
}

interface InspectorState {
  claimId: string | null;
  open: boolean;
  trigger: HTMLElement | null;
}

export interface FocusViewProps {
  release: Release;
  initialState: FocusViewState;
}

export function FocusView({ release, initialState }: FocusViewProps) {
  const [viewState, setViewState] = useState<FocusViewState>(initialState);
  const [closedMessage, setClosedMessage] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [inspector, setInspector] = useState<InspectorState>({
    claimId: null,
    open: false,
    trigger: null,
  });
  const [pendingNodeFocus, setPendingNodeFocus] = useState<PendingNodeFocus | null>(null);
  const [pendingTitleFocus, setPendingTitleFocus] = useState(false);
  const [pendingListHeadingFocus, setPendingListHeadingFocus] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const projection = useMemo(() => selectFocusProjection(release, viewState), [release, viewState]);

  useEffect(() => {
    if (!pendingTitleFocus) return;
    titleRef.current?.focus({ preventScroll: true });
    setPendingTitleFocus(false);
  }, [pendingTitleFocus]);

  // Stable callbacks (not a fresh closure every render) so the
  // one-shot focus-restoration effects in NodeCards/ClaimList can
  // list them as a dependency without re-firing on every unrelated
  // re-render of this component.
  const clearPendingNodeFocus = useCallback(() => setPendingNodeFocus(null), []);
  const clearPendingListHeadingFocus = useCallback(() => setPendingListHeadingFocus(false), []);

  // Mirrors docs/assets/lineage-focus.js's `popstate` handler: recompute
  // state from the (now-changed) URL against the SAME release, and fail
  // closed if the new URL cannot be projected. `release` never changes
  // across this component's lifetime, so binding this once is safe.
  useEffect(() => {
    function onPopState() {
      setInspector({ claimId: null, open: false, trigger: null });
      const nextState = readState(release, {
        params: new URLSearchParams(window.location.search),
        prefs: loadPreferences(),
        mobile: mobileMatches(),
      });
      const nextProjection = nextState && selectFocusProjection(release, nextState);
      if (nextProjection) {
        // P2 review LOW: a later popstate that DOES project again must
        // recover from a previously-shown closed message -- without
        // this, one bad `?focus=` (e.g. a manually edited URL) wedged
        // the page on the "監査済みの系譜は表示できません" screen even
        // after the visitor navigated Back/Forward to a URL that
        // resolves fine, since `closedMessage` was never cleared here.
        setClosedMessage(null);
        setViewState(nextState);
        setPage(1);
        return;
      }
      setClosedMessage(CANNOT_RESTORE_MESSAGE);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [release]);

  if (closedMessage || !projection) {
    return (
      <AuditStatus
        heading={CLOSED_HEADING}
        message={closedMessage ?? CANNOT_RESTORE_MESSAGE}
        backHref="/"
        backLabel="論文を探し直す →"
        headingLevel={1}
      />
    );
  }

  function normalizeAndProject(
    patch: Partial<FocusViewState>,
    options: { historyMode?: "push" | "replace" } = {},
  ): boolean {
    const desired = { ...viewState, ...patch };
    const nextUrl = writeState(new URL(window.location.href), desired);
    window.history[options.historyMode === "push" ? "pushState" : "replaceState"](
      { paperpilotLineageFocus: true },
      "",
      nextUrl,
    );
    const nextState = readState(release, {
      params: new URLSearchParams(window.location.search),
      prefs: loadPreferences(),
      mobile: mobileMatches(),
    });
    const nextProjection = nextState && selectFocusProjection(release, nextState);
    if (!nextProjection) {
      setClosedMessage(CANNOT_RESTORE_MESSAGE);
      return false;
    }
    setViewState(nextState);
    setPage(1);
    persistPreferences(nextState);
    return true;
  }

  function onPatch(patch: Partial<FocusViewState>) {
    normalizeAndProject(patch);
  }

  function onCenter(nodeId: string) {
    if (!resolveFocus(release, nodeId)) return;
    if (normalizeAndProject({ focusId: nodeId, expandedNodeIds: [] }, { historyMode: "push" })) {
      setPendingTitleFocus(true);
    }
  }

  function onExpand(nodeId: string) {
    if (normalizeAndProject({ expandedNodeIds: [...viewState.expandedNodeIds, nodeId] })) {
      setPendingNodeFocus({ nodeId, action: "collapse" });
    }
  }

  function onCollapse(nodeId: string) {
    if (
      normalizeAndProject({
        expandedNodeIds: viewState.expandedNodeIds.filter((id) => id !== nodeId),
      })
    ) {
      setPendingNodeFocus({ nodeId, action: "expand" });
    }
  }

  function onInspect(claimId: string, trigger: HTMLElement) {
    setInspector({ claimId, open: true, trigger });
  }

  function onPageChange(nextPage: number) {
    setPage(nextPage);
    setPendingListHeadingFocus(true);
  }

  function closeInspector(restoreFocus = true) {
    if (restoreFocus) inspector.trigger?.focus?.({ preventScroll: true });
    setInspector({ claimId: null, open: false, trigger: null });
  }

  const effectiveView = projection.forceList ? "list" : viewState.view;
  const evidenceSources = [...new Set(release.artifact.evidence.map((item) => item.source))].sort();
  const evidenceKinds = [...new Set(release.artifact.evidence.map((item) => item.kind))].sort();
  const backHref = `${BASE_PATH}/${encodeURIComponent(release.entry.conference)}/?paper=${release.entry.paper_id}`;

  return (
    <article aria-labelledby="lineage-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>VERIFIED PILOT RELEASE</p>
          <h1 id="lineage-title" ref={titleRef} tabIndex={-1}>
            {projection.focus.title}
          </h1>
          <p
            className={styles.meta}
          >{`${release.entry.conference.toUpperCase()} · 監査 release ${release.entry.release_id}`}</p>
        </div>
        <a id="lineage-catalog-back" className={styles.backLink} href={backHref}>
          論文一覧へ戻る
        </a>
      </header>

      <p className={styles.notice}>
        引用は研究継承を意味しません。この研究系譜は証拠と監査に基づく自動推定を含みます。
      </p>

      <Controls
        state={viewState}
        effectiveView={effectiveView}
        evidenceSources={evidenceSources}
        evidenceKinds={evidenceKinds}
        onPatch={onPatch}
      />

      <Summary projection={projection} />

      {projection.forceList && (
        <div className={styles.warning} role="status">
          表示上限を超えたため、グラフは描画していません。関係一覧で確認してください。
        </div>
      )}

      {effectiveView === "graph" ? (
        <section id="lineage-graph-panel" aria-labelledby="lineage-graph-heading">
          <h2 id="lineage-graph-heading">系譜グラフ</h2>
          <p className={styles.graphHelp}>
            実線の矢印は先行研究 →
            発展研究。比較関係は破線で示し、継承とは区別します。初期表示は直接の関係・最大7論文です。
          </p>
          <p id="lineage-graph-help" className={styles.graphHelp}>
            横にスクロールして全体を確認できます。キーボードではグラフにフォーカスして左右キーを使えます。重なる関係ラベルは省略しますが、関係自体は削除していません。線を選ぶと監査詳細を確認できます。読みづらい場合は「関係一覧」に切り替えてください。
          </p>
          <GraphView projection={projection} onCenter={onCenter} onInspect={onInspect} />
        </section>
      ) : (
        <ClaimList
          projection={projection}
          page={page}
          onPageChange={onPageChange}
          onInspect={onInspect}
          pendingListHeadingFocus={pendingListHeadingFocus}
          onListHeadingFocusApplied={clearPendingListHeadingFocus}
        />
      )}

      <section aria-labelledby="lineage-nodes-heading">
        <h2 id="lineage-nodes-heading">表示中の論文</h2>
        <p className={styles.graphHelp}>
          表示中の検証済み関係に沿って区分しています。先行・発展は継承の向き、比較は中心論文との直接の比較です。日付順の分類ではありません。その他の関連論文には、これらに分類されない論文を表示します。区分は信頼段階を表しません。根拠と信頼段階は各関係の詳細で確認できます。
        </p>
        <NodeCards
          projection={projection}
          onCenter={onCenter}
          onExpand={onExpand}
          onCollapse={onCollapse}
          pendingFocus={pendingNodeFocus}
          onFocusApplied={clearPendingNodeFocus}
        />
      </section>

      <InspectorDialog
        release={release}
        projection={projection}
        claimId={inspector.claimId}
        open={inspector.open}
        onRequestClose={() => closeInspector(true)}
      />
    </article>
  );
}
