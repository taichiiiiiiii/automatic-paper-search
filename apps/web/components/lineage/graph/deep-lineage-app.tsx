"use client";

/**
 * Ready-state body for the deep-lineage page's single selected
 * artifact -- the deep equivalent of lineage-graph-app.tsx's
 * `<LineageGraph>`, scoped to deep.js's much smaller state machine: ONE
 * layout (the unbounded tree, lib/lineage/layout/deep-tree.ts) and a
 * single `visibleRelations` filter shared by BOTH the list and graph
 * views (ported from deep.js's single `#relation-filter` bar, which --
 * unlike lineage.js -- is never duplicated per view). `view` and
 * `visibleRelations` are therefore owned by the caller
 * (app/[conf]/deep/page.tsx, which persists them to
 * `localStorage["pp.deep.prefs"]` + `?view=&relations=` via
 * lib/lineage/deep-prefs.ts) -- this component only owns the one piece
 * of state deep.js's `state.focusId` holds that the page does not need:
 * which node WITHIN this artifact is centered.
 *
 * The caller must remount this component (e.g. `key={paperId}`) when a
 * different paper's artifact is selected, so `focusId` resets to the
 * new artifact's root instead of carrying over a node id that may not
 * exist in it.
 *
 * Owns the three DOM-measurement behaviours lib/lineage/layout/* stays
 * pure for -- same pattern as lineage-graph-app.tsx's header comment:
 *  - `heights`: post-font-load card height measurement, fed back into
 *    `buildDeepGraphModel` so edges land on the real card bottom.
 *  - `scrollToFocus`: centers the focus card, instant on first mount,
 *    smooth afterwards (incl. when switching from list back to graph,
 *    a deliberate small improvement over deep.js -- which keeps one
 *    always-mounted, merely `hidden`, canvas and so never needs to
 *    re-scroll on a view switch; this port instead conditionally mounts
 *    the canvas per view, so it re-centers on remount rather than
 *    starting scrolled to the top-left).
 *  - keyboard-focus handoff after `focusPaper` re-renders the tree
 *    around a new center, same as lineage-graph-app.tsx's
 *    `pendingKeyboardFocusRef`.
 */
import { useEffect, useRef, useState } from "react";
import type { LineageArtifact, Relation } from "../../../lib/lineage/core";
import { DEEP_NODE_H, DEEP_NODE_W } from "../../../lib/lineage/layout/deep-tree";
import {
  buildDeepGraphModel,
  type DeepNodeHeights,
} from "../../../lib/lineage/layout/deep-view-model";
import { truncateTitle } from "../../../lib/lineage/layout/format";
import { RelationList } from "../relation-list";
import { GraphCanvas } from "./graph-canvas";
import { RelationFilter } from "./relation-filter";
import { SearchBox } from "./search-box";

export type DeepView = "list" | "graph";

export interface DeepLineageAppProps {
  artifact: LineageArtifact;
  view: DeepView;
  visibleRelations: ReadonlySet<Relation>;
  onToggleRelation: (relation: Relation) => void;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** Ported from deep.js's footer-hint text once the graph is ready
 * (`els.footerHint.textContent` in `init()`) -- the same hint is shown
 * for both list and graph view in the original (it is set once, not
 * per-render), so this is a static string here too. */
const FOOTER_HINT = "エッジにホバー → 分類理由 · カードクリック → 中心を切替";

export function DeepLineageApp({
  artifact,
  view,
  visibleRelations,
  onToggleRelation,
}: DeepLineageAppProps) {
  const [focusId, setFocusId] = useState<string | null>(artifact.root);
  const [heights, setHeights] = useState<DeepNodeHeights>(new Map());

  const cardRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingKeyboardFocusRef = useRef(false);
  const listSectionRef = useRef<HTMLDivElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const hasScrolledToFocusRef = useRef(false);

  // Ported from deep.js `focusPaper`: re-centers the tree on `id` and
  // (if the previous focus card had keyboard focus) moves keyboard
  // focus to the new center card once it re-renders.
  function focusPaper(id: string): void {
    if (!id || focusId === id) return;
    const active = document.activeElement;
    pendingKeyboardFocusRef.current =
      active instanceof HTMLElement && active.hasAttribute("data-node-id");
    setFocusId(id);
  }

  // Ported from deep.js `updateTitle`.
  useEffect(() => {
    const node = artifact.nodes.find((n) => n.id === focusId);
    if (node?.title) document.title = `${truncateTitle(node.title)} — Deep Lineage — PaperPilot`;
  }, [artifact, focusId]);

  useEffect(() => {
    if (!pendingKeyboardFocusRef.current) return;
    pendingKeyboardFocusRef.current = false;
    const raf = requestAnimationFrame(() => {
      cardRefs.current.get(focusId ?? "")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusId]);

  // Ported from deep.js `setView`'s `if (view === "list")
  // els.relationList?.focus({ preventScroll: true })`.
  useEffect(() => {
    if (view !== "list") return;
    const raf = requestAnimationFrame(() => {
      listSectionRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [view]);

  const model = buildDeepGraphModel(artifact, { focusId, visibleRelations }, heights);

  function registerCard(id: string, el: HTMLButtonElement | null): void {
    cardRefs.current.set(id, el);
  }

  // Ported from deep.js `drawSvg`'s post-render measurement pass -- see
  // lineage-graph-app.tsx's equivalent effect for the full rationale.
  // Keyed on the sorted set of currently-positioned node ids so
  // re-measuring (which never changes which nodes are positioned)
  // cannot loop.
  const positionedKey = model.positioned
    .map((n) => n.id)
    .sort()
    .join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: positionedKey captures the real dependency (see comment above); the effect body only touches cardRefs/document/setHeights.
  useEffect(() => {
    if (view !== "graph") return;
    let cancelled = false;
    async function measure(): Promise<void> {
      if (document.fonts?.ready) {
        try {
          await document.fonts.ready;
        } catch {
          /* ignore -- fall back to whatever is already painted */
        }
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled) return;
      setHeights((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, el] of cardRefs.current) {
          if (!el) continue;
          const measured = Math.ceil(el.getBoundingClientRect().height) || DEEP_NODE_H;
          if (next.get(id) !== measured) {
            next.set(id, measured);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    measure();
    return () => {
      cancelled = true;
    };
  }, [positionedKey, view]);

  // Ported from deep.js `scrollToFocus`.
  function scrollToFocus(smooth: boolean): void {
    requestAnimationFrame(() => {
      const canvas = canvasScrollRef.current;
      const svg = svgRef.current;
      const positioned = model.positioned.find((n) => n.id === focusId);
      if (!canvas || !svg || !positioned) return;
      const x = positioned._x + DEEP_NODE_W / 2;
      const y = positioned._y + DEEP_NODE_H / 2;
      const svgRect = svg.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const declaredWidth = Number.parseFloat(svg.getAttribute("width") || String(svgRect.width));
      const declaredHeight = Number.parseFloat(
        svg.getAttribute("height") || String(svgRect.height),
      );
      const scaleX = svgRect.width / declaredWidth;
      const scaleY = svgRect.height / declaredHeight;
      const targetLeft = x * scaleX - canvasRect.width / 2;
      const targetTop = y * scaleY - canvasRect.height / 2;
      canvas.scrollTo({
        left: Math.max(0, targetLeft),
        top: Math.max(0, targetTop),
        behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
      });
    });
  }

  // First run (mount, matching deep.js `init()`'s `scrollToFocus(false)`)
  // snaps instantly; every later focus change -- including switching
  // back to graph view, see this file's header -- scrolls smoothly.
  // scrollToFocus closes over the latest `model`/refs each render; only
  // a real focusId/view change should trigger a (re-)scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (view !== "graph") return;
    const smooth = hasScrolledToFocusRef.current;
    hasScrolledToFocusRef.current = true;
    scrollToFocus(smooth);
  }, [focusId, view]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox nodes={artifact.nodes} onSelect={focusPaper} />
        {view === "graph" && (
          <RelationFilter visible={visibleRelations} onToggle={onToggleRelation} />
        )}
      </div>

      {view === "list" && (
        <div ref={listSectionRef} tabIndex={-1}>
          <RelationList
            artifact={artifact}
            focusId={focusId}
            visibleRelations={visibleRelations}
            onToggleRelation={onToggleRelation}
          />
        </div>
      )}

      {view === "graph" && (
        <div
          ref={canvasScrollRef}
          className="overflow-auto rounded-md border border-rule bg-surface"
        >
          <GraphCanvas
            ref={svgRef}
            graph={model}
            onSelect={focusPaper}
            registerCard={registerCard}
            nodeWidth={DEEP_NODE_W}
            cardVariant="deep"
          />
        </div>
      )}

      <p aria-live="polite" className="text-xs text-ink-subtle">
        {FOOTER_HINT}
      </p>
    </div>
  );
}
