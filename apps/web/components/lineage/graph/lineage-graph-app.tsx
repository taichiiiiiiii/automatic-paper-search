"use client";

/**
 * Top-level client component for the lineage graph's "ready" state --
 * owns the `{layout, view, focusId, currentCluster, visibleRelations}`
 * state that docs/assets/lineage.js keeps in its module-level `state`
 * object, and wires it to the URL (`?layout=&view=&relations=&focus=`),
 * `localStorage["pp.lineage.prefs"]`, and the mode-bar / canvas / list
 * sub-components. This is the only place in this area that touches
 * `window`/`localStorage`/`document` directly; everything it calls
 * into (lib/lineage/layout/*, the other components/lineage/graph/*
 * files) is pure or DOM-light.
 *
 * Mounted only from app/[conf]/lineage/page.tsx once the quality gate
 * has already resolved to `{phase: "ready", artifact}` -- it never
 * renders during the server-exported HTML snapshot (that snapshot is
 * always the "pending" gate state), so reading `window` in a lazy
 * `useState` initializer below is safe: this component's first render
 * only ever happens in the browser.
 *
 * This component also owns the three DOM-measurement behaviours
 * lib/lineage/layout/* intentionally stays pure for:
 *
 *  - `heights`: after each paint where the graph is visible, waits for
 *    `document.fonts.ready` + one animation frame, measures every
 *    mounted card's actual rendered height via
 *    `getBoundingClientRect()`, and (if any changed) feeds the result
 *    back into `buildLineageViewModel` so edges land on the real card
 *    bottom and the SVG canvas grows to fit -- the same two-pass
 *    measure-then-redraw as lineage.js `drawSvg`.
 *  - `scrollToFocus`: mirrors lineage.js's own `scrollToFocus` --
 *    centers the focus card in the scroll container, instantly on
 *    first mount (matches `init()`'s `scrollToFocus(false)`) and
 *    smoothly on every subsequent focus change (matches
 *    `focusPaper`'s default `smooth: true`), except when the visitor
 *    has `prefers-reduced-motion: reduce` set (the original has no
 *    such check; this one does, as a deliberate a11y improvement).
 *  - the Timeline-mode rightmost-column auto-scroll: mirrors
 *    lineage.js `render()`'s `els.canvas.scrollLeft =
 *    els.canvas.scrollWidth` for `layout === "timeline"`, re-applied
 *    whenever the timeline's content could have changed (focus,
 *    relation filter) -- the dense, most-recent year column is the
 *    user's first impression, same as the original.
 */
import { useEffect, useRef, useState } from "react";
import {
  type LineageArtifact,
  type Relation,
  resolveFocus,
  resolveView,
} from "../../../lib/lineage/core";
import {
  FOOTER_HINT,
  LIST_FOOTER_HINT,
  type LineageLayout,
  type LineageView,
  NODE_H,
  NODE_W,
  STORAGE_KEY,
} from "../../../lib/lineage/layout/constants";
import { truncateTitle } from "../../../lib/lineage/layout/format";
import {
  buildPrefsPayload,
  parsePrefsJson,
  resolveInitialLayout,
  resolveInitialRelations,
  serializeRelationsParam,
} from "../../../lib/lineage/layout/prefs";
import { buildLineageViewModel, type NodeHeights } from "../../../lib/lineage/layout/view-model";
import { RelationList } from "../relation-list";
import { Crumb } from "./crumb";
import { GraphCanvas } from "./graph-canvas";
import { Legend } from "./legend";
import { ModeToolbar } from "./mode-toolbar";
import { RelationFilter } from "./relation-filter";
import { TopicsGallery } from "./topics-gallery";

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* localStorage may be disabled */
  }
}

export interface LineageGraphProps {
  artifact: LineageArtifact;
  initialFocusId: string | null;
}

export function LineageGraph({ artifact, initialFocusId }: LineageGraphProps) {
  const initialParams = new URLSearchParams(window.location.search);
  const initialPrefs = parsePrefsJson(safeLocalStorageGet(STORAGE_KEY));

  const [layout, setLayoutState] = useState<LineageLayout>(() =>
    resolveInitialLayout(initialParams.get("layout"), initialPrefs),
  );
  const [view, setViewState] = useState<LineageView>(() =>
    resolveView({
      urlView: initialParams.get("view"),
      savedView: typeof initialPrefs?.view === "string" ? initialPrefs.view : null,
      matchMedia: window.matchMedia?.bind(window),
    }),
  );
  const [visibleRelations, setVisibleRelations] = useState<ReadonlySet<Relation>>(() =>
    resolveInitialRelations(initialParams.get("relations"), initialPrefs),
  );
  const [focusId, setFocusId] = useState<string | null>(initialFocusId ?? artifact.root);
  const [currentCluster, setCurrentCluster] = useState<string | null>(null);
  const [heights, setHeights] = useState<NodeHeights>(new Map());

  const cardRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingKeyboardFocusRef = useRef(false);
  const listSectionRef = useRef<HTMLDivElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const hasScrolledToFocusRef = useRef(false);

  function persist(
    nextLayout: LineageLayout,
    nextView: LineageView,
    nextRelations: ReadonlySet<Relation>,
  ): void {
    safeLocalStorageSet(
      STORAGE_KEY,
      JSON.stringify(buildPrefsPayload(nextLayout, nextView, nextRelations)),
    );
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    url.searchParams.set("layout", nextLayout);
    url.searchParams.set("relations", serializeRelationsParam(nextRelations));
    window.history.replaceState({}, "", url);
  }

  function setLayout(next: LineageLayout): void {
    if (layout === next) return;
    setLayoutState(next);
    persist(next, view, visibleRelations);
  }

  function setView(next: LineageView): void {
    if (view === next) return;
    const nextLayout = next === "list" && layout === "topics" ? "tree" : layout;
    setViewState(next);
    if (nextLayout !== layout) setLayoutState(nextLayout);
    persist(nextLayout, next, visibleRelations);
    if (next === "list") {
      requestAnimationFrame(() => listSectionRef.current?.focus({ preventScroll: true }));
    }
  }

  function toggleRelation(relation: Relation): void {
    const next = new Set(visibleRelations);
    if (next.has(relation)) next.delete(relation);
    else next.add(relation);
    setVisibleRelations(next);
    persist(layout, view, next);
  }

  function selectFocus(id: string, { push = true }: { push?: boolean } = {}): void {
    if (focusId === id) return;
    const active = document.activeElement;
    pendingKeyboardFocusRef.current =
      active instanceof HTMLElement && active.hasAttribute("data-node-id");
    setFocusId(id);
    const node = artifact.nodes.find((n) => n.id === id);
    const url = new URL(window.location.href);
    url.searchParams.set("focus", (node?.seed_paper_id as string | undefined) || id);
    if (push) window.history.pushState({}, "", url);
    else window.history.replaceState({}, "", url);
    if (node?.title) document.title = `${truncateTitle(node.title)} — Lineage — PaperPilot`;
  }

  function goToTree(id: string): void {
    selectFocus(id);
    if (layout !== "tree") setLayout("tree");
  }

  useEffect(() => {
    if (!pendingKeyboardFocusRef.current) return;
    pendingKeyboardFocusRef.current = false;
    const raf = requestAnimationFrame(() => {
      cardRefs.current.get(focusId ?? "")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusId]);

  /**
   * `selectFocus` is a plain function (not useCallback) redefined every
   * render, not a ref; this effect already re-subscribes on every
   * `artifact`/`focusId` change (its real dependencies), which re-closes
   * over the latest `selectFocus` too, so listing it would only add
   * churn, not fix a staleness bug.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    function onPopState(): void {
      const params = new URLSearchParams(window.location.search);
      const requested = params.get("focus");
      const next = resolveFocus(artifact, requested);
      if (next && focusId !== next.id) selectFocus(next.id, { push: false });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [artifact, focusId]);

  const model = buildLineageViewModel(
    artifact,
    { layout, view, focusId, currentCluster, visibleRelations },
    heights,
  );

  function registerCard(id: string, el: HTMLButtonElement | null): void {
    cardRefs.current.set(id, el);
  }

  // Ported from lineage.js `drawSvg`'s post-render measurement pass:
  // once fonts are loaded and the graph has painted, measure every
  // mounted card's real height and feed it back into the view model so
  // edges land on the actual card bottom (see this file's header and
  // lib/lineage/layout/view-model.ts `buildGraph`). Keyed on the sorted
  // set of currently-positioned node ids, not on `heights` itself --
  // re-measuring never changes which nodes are positioned, so this
  // can't loop.
  const positionedKey = model.graph
    ? model.graph.positioned
        .map((n) => n.id)
        .sort()
        .join("\u0000")
    : "";
  // positionedKey captures the real dependency (which nodes are on
  // screen to measure); `model.isGraphSvg` gates it to graph view; the
  // effect body itself only touches `cardRefs`/`document`/`setHeights`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!model.isGraphSvg) return;
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
          const measured = Math.ceil(el.getBoundingClientRect().height) || NODE_H;
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
  }, [positionedKey, model.isGraphSvg]);

  // Ported from lineage.js `scrollToFocus`: centers the focus card in
  // the scroll container. Deferred to `requestAnimationFrame` like the
  // original, so it always reads the fully-settled DOM (including any
  // layout change batched in the same event, e.g. `goToTree`'s
  // `selectFocus` + `setLayout` pair) regardless of which state update
  // triggered this effect.
  function scrollToFocus(smooth: boolean): void {
    requestAnimationFrame(() => {
      const canvas = canvasScrollRef.current;
      const svg = svgRef.current;
      const positioned = model.graph?.positioned.find((n) => n.id === focusId);
      if (!canvas || !svg || !positioned) return;
      const x = positioned._x + NODE_W / 2;
      const y = positioned._y + NODE_H / 2;
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

  // First run (component mount, matching lineage.js `init()` calling
  // `scrollToFocus(false)`) snaps instantly; every subsequent focus
  // change (matching `focusPaper`'s default `smooth: true`) scrolls
  // smoothly. A no-op (canvas/svg not mounted, e.g. topics/list view)
  // is harmless and matches the original's own early return.
  // scrollToFocus closes over the latest `model`/refs each render (it
  // is redefined every render, not a stable callback); only a real
  // `focusId` change should trigger a (re-)scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    const smooth = hasScrolledToFocusRef.current;
    hasScrolledToFocusRef.current = true;
    scrollToFocus(smooth);
  }, [focusId]);

  // Ported from lineage.js `render()`: in Timeline layout, the dense
  // most-recent-year column sits at the right edge, so re-snap the
  // canvas's horizontal scroll to the far right whenever the timeline
  // could have changed (focus, relation filter) -- same trigger set as
  // the original's unconditional post-`drawSvg` auto-scroll. Declared
  // after the scroll-to-focus effect so, in the same frame, Timeline's
  // rightmost-column scroll wins when both would otherwise apply.
  // `focusId`/`visibleRelations` are intentional re-trigger-only deps
  // (the body itself only reads `view`/`layout` and the ref).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (view === "list" || layout !== "timeline") return;
    const raf = requestAnimationFrame(() => {
      const canvas = canvasScrollRef.current;
      if (canvas) canvas.scrollLeft = canvas.scrollWidth;
    });
    return () => cancelAnimationFrame(raf);
  }, [view, layout, focusId, visibleRelations]);

  const footerHint = model.isList ? LIST_FOOTER_HINT : FOOTER_HINT[layout] || "";

  return (
    <div className="flex flex-col gap-6">
      <ModeToolbar
        layout={layout}
        view={view}
        onSetLayout={setLayout}
        onSetView={setView}
        onRoot={() => {
          if (artifact.root) goToTree(artifact.root);
        }}
        nodes={artifact.nodes}
        onSearchSelect={(id) => goToTree(id)}
      />
      {model.isGraphSvg && <RelationFilter visible={visibleRelations} onToggle={toggleRelation} />}

      {model.isList && (
        <div ref={listSectionRef} tabIndex={-1}>
          <RelationList
            artifact={artifact}
            focusId={focusId}
            visibleRelations={visibleRelations}
            onToggleRelation={toggleRelation}
          />
        </div>
      )}

      {!model.isList && (
        <>
          <Crumb
            crumb={model.crumb}
            onGoToTopics={() => {
              setCurrentCluster(null);
              setLayout("topics");
            }}
            onGoToCluster={(clusterId) => {
              setCurrentCluster(clusterId);
              setLayout("topics");
            }}
          />
          {model.isGraphSvg && <Legend />}
          {model.isTopics && model.topics && (
            <TopicsGallery
              topics={model.topics}
              onSelect={(nodeId, clusterId) => {
                setCurrentCluster(clusterId);
                goToTree(nodeId);
              }}
            />
          )}
          {model.isGraphSvg && model.graph && (
            <div
              ref={canvasScrollRef}
              className="overflow-auto rounded-md border border-rule bg-surface"
            >
              <GraphCanvas
                ref={svgRef}
                graph={model.graph}
                onSelect={selectFocus}
                registerCard={registerCard}
              />
            </div>
          )}
        </>
      )}

      <p aria-live="polite" className="text-xs text-ink-subtle">
        {footerHint}
      </p>
    </div>
  );
}
