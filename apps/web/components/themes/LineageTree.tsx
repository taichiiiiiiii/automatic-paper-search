"use client";

/**
 * Chronological family-tree SVG renderer + interactive chrome. Port of
 * docs/assets/theme.js's render()/drawSvg() plus the surrounding
 * interactive features listed as not-yet-ported in
 * docs/migration/p2-parity-gaps.md row 5: pan (a bounded, scrollable
 * canvas) + minimap, client-side SVG/PNG export, keyboard shortcuts
 * (`?` help, `1`-`6` modes, `/` search focus, `F` filters, `Esc`),
 * a first-visit onboarding coach-mark, a sparse-graph hint, the
 * search/year-range/relation-chip filter UI (wired to the already-
 * ported `matchesSearch`/`matchesYear` in lib/themes-tree.ts), a card
 * hover popover, an edge tooltip, and computeModeData's per-card
 * tier/novelty/lineage-hue visual hooks.
 *
 * No inline `style=` attributes anywhere below: every dynamic value
 * (card/popover/tooltip position, minimap dots/viewport) is set via
 * SVG attributes (`x`, `y`, `transform`, `width`) or plain <canvas>
 * pixel calls; everything else is a CSS class, either a literal
 * Tailwind utility string or a class from the adjacent CSS module
 * (LineageTree.module.css) for the handful of effects Tailwind can't
 * express statically (per-card mode accents, hover-delayed popover/
 * tooltip visibility, the onboarding arrow).
 */
import { useSearchParams } from "next/navigation";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  copyText,
  downloadText,
  exportFilename,
  themeEdgesToCsv,
  themeNodesToBibtex,
  themeNodesToCsv,
} from "../../lib/export-formats";
import { abstractExcerptSourceLabel } from "../../lib/lineage/evidence";
import { computeMainPath } from "../../lib/lineage/main-path";
import { priorDerivative, shortestLineagePath } from "../../lib/lineage/paper-neighbors";
import { exportPng, exportSvg } from "../../lib/themes-export";
import type { ThemeCodeLinks } from "../../lib/themes-feed";
import { formatStars, formatVenue } from "../../lib/themes-format";
import type { LineageArtifact } from "../../lib/themes-quality";
import { resolveFocus } from "../../lib/themes-quality";
import {
  ALL_RELATIONS,
  computeHubSet,
  computeModeData,
  computeOrphanSet,
  DEFAULT_RELATIONS,
  DEFAULT_X_AXIS_MODE,
  heatBucket,
  hiddenEdgeCount,
  isSparseLineage,
  layoutChronological,
  matchesSearch,
  matchesYear,
  NODE_H,
  NODE_W,
  type Relation,
  sparseLineageNotice,
  X_AXIS_MODES,
  type XAxisMode,
} from "../../lib/themes-tree";
import {
  DEFAULT_MAIN_PATH_MODE,
  loadThemePrefs,
  type MainPathMode,
  readTreeUrlState,
  saveThemePrefs,
  type ThemeView,
  writeTreeUrlParams,
} from "../../lib/themes-url-state";
import { EdgeEvidencePanel, EdgeRelationList, edgeKey, relationLabelJa } from "./EdgeEvidence";
import styles from "./LineageTree.module.css";
import { PaperNeighborsPanel } from "./PaperNeighborsPanel";
import { ReadingGuide } from "./ReadingGuide";
import { CodeBadges } from "./ThemeFeedSections";
import { ThemeTimeline } from "./ThemeTimeline";

// UX audit (design 53 §系譜ページ): the six X-axis modes used to be six
// emoji buttons with one-word labels (「log」「中心」) that a first-time
// reader could not decode. They are now one <select> whose options say
// what the ordering means; `title` is shown as the hint under it.
const X_AXIS_OPTION: Record<XAxisMode, { label: string; title: string }> = {
  rank: { label: "被引用の多い順（年ごと）", title: "同じ年の中で、被引用数の多い論文ほど左" },
  citation_log: {
    label: "被引用数（対数の目盛り）",
    title: "被引用数の対数で左右に並べ、年をまたいで影響の大きさを比べる",
  },
  genealogy: {
    label: "研究の流れでまとめる",
    title: "基にした論文の近くに並べ、同じ研究の流れが縦にそろう（左端の色 = 流れ）",
  },
  centrality: {
    label: "中心性（つながりの中心ほど左）",
    title: "PageRank で、つながりの中心にある論文ほど左",
  },
  venue: {
    label: "会議の格",
    title: "会議の格の順（左端の色: 金 = Tier1、青 = Tier2、灰 = Tier3）、査読前は右",
  },
  novelty: {
    label: "新しさの種類",
    title: "左端の色: 赤 = 置き換え・対立（破壊的）、緑 = 拡張・後継（漸進的）",
  },
};

/** Zoom steps for the family tree (1 = cards at their natural size). */
const ZOOM_STEPS: readonly number[] = [0.35, 0.5, 0.65, 0.8, 1, 1.25];
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 1.25;
const MOBILE_ZOOM = 0.65;

// Tailwind's build-time scanner only picks up class names it can see as
// complete literal strings in the source -- a template-interpolated
// `stroke-[var(${x})]` would silently fail to generate any CSS. Each
// branch here is written out in full so every edge color actually
// ships in the built stylesheet.
const RELATION_STROKE_CLASS: Record<string, string> = {
  supersedes: "stroke-[var(--rel-supersedes)]",
  successor: "stroke-[var(--rel-successor)]",
  extends: "stroke-[var(--rel-extends)]",
  ablation: "stroke-[var(--rel-ablation)]",
  baseline_only: "stroke-[var(--rel-baseline)]",
  contrasts: "stroke-[var(--rel-contrasts)]",
};
const DEFAULT_STROKE_CLASS = "stroke-[var(--rel-baseline)]";

function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return (el as HTMLElement).isContentEditable === true;
}

/** True for keyboard focus (`:focus-visible`); a tap or click also
 * focuses the card/edge, and must not pop a hover box up on a phone. */
function isKeyboardFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true; // selector unsupported: keep the old behaviour
  }
}

/** Per-node CSS class for computeModeData's visual hook, or `null` for
 * a mode without one ("rank" / "citation_log" / "centrality") or a
 * neutral/unknown value. */
function modeAccentClass(
  modeData: ReturnType<typeof computeModeData>,
  nodeId: string,
): string | null {
  const datum = modeData.get(nodeId);
  if (!datum) return null;
  if (datum.kind === "tier" && datum.value) return styles[`tier${datum.value}`] ?? null;
  if (datum.kind === "novelty" && datum.value !== "neutral") {
    return (datum.value === "disrupt" ? styles.noveltyDisrupt : styles.noveltyIncremental) ?? null;
  }
  if (datum.kind === "lineage") {
    const bucket = Math.floor(datum.value / 30) % 12;
    return styles[`hue${bucket}`] ?? null;
  }
  return null;
}

const ONBOARDING_KEY = "pp.theme.onboarded";
const POPOVER_HOVER_DELAY_MS = 700;

const MAIN_PATH_BUTTON: Record<MainPathMode, { label: string; title: string }> = {
  highlight: { label: "強調", title: "本流（主経路）の線を太くして、ほかの線を薄くする" },
  only: { label: "本流だけ", title: "本流（主経路）の線だけを表示する" },
  off: { label: "オフ", title: "本流を強調しない" },
};
const MAIN_PATH_MODES: readonly MainPathMode[] = ["highlight", "only", "off"];

const VIEW_BUTTON: Record<ThemeView, { label: string; title: string }> = {
  tree: { label: "家系図", title: "年ごとの家系図" },
  timeline: { label: "年×被引用", title: "横軸に年、縦軸に被引用数（対数）で並べる" },
};
const VIEWS: readonly ThemeView[] = ["tree", "timeline"];

export function LineageTree({
  artifact,
  slug,
  themeName,
  codeLinks,
}: {
  artifact: LineageArtifact;
  slug?: string | null;
  themeName?: string | null;
  /** R4-3: "コード" / "HF" badges per node id (optional side file). */
  codeLinks?: ThemeCodeLinks | null;
}) {
  // ---- URL state (?xaxis=&ymin=&ymax=&q=&rels=&orphan=&node=) ----------
  // M8a port of docs/assets/theme.js's readUrlState(): read once per
  // mount (this component remounts on theme switch -- see the `key=
  // {currentSlug}` comment in ThemesClient.tsx) so a shared link
  // ("I'm looking at this theme in genealogy mode filtered to
  // 2020-2024") reproduces the same view. Every field is whitelist-
  // validated by readTreeUrlState itself.
  const searchParams = useSearchParams();
  const urlState = useMemo(() => readTreeUrlState(searchParams.toString()), [searchParams]);

  const [mode, setMode] = useState<XAxisMode>(() => urlState.xAxisMode ?? DEFAULT_X_AXIS_MODE);
  const [mainPathMode, setMainPathMode] = useState<MainPathMode>(
    () => urlState.mainPath ?? DEFAULT_MAIN_PATH_MODE,
  );
  // Main path (design doc 48 P0-1): computed once from ALL edges so the
  // relation chips never reshuffle it.
  const mainPath = useMemo(
    () => computeMainPath(artifact.nodes, artifact.edges),
    [artifact.nodes, artifact.edges],
  );
  const mainPathKeys = useMemo(() => new Set(mainPath.edges.map(edgeKey)), [mainPath]);
  const mainPathNodeIds = useMemo(() => new Set(mainPath.nodeIds), [mainPath]);
  const showMainPath = mainPathMode !== "off" && mainPathKeys.size > 0;

  // ---- View (family tree / year × citation) + selected paper -------------
  // Design doc 48 P0-5 / P1-5: `?focus=` selects a paper for the Prior /
  // Derivative panel, `?to=` the other end of the two-paper path, and
  // `?view=timeline` switches to the year × citation view. Ids resolve
  // like `?node=` (canonical / alias / graph id); unknown ids are ignored.
  const [view, setView] = useState<ThemeView>(() => urlState.view ?? "tree");
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(
    () =>
      (urlState.focus
        ? resolveFocus({ nodes: artifact.nodes, root: artifact.root }, urlState.focus)?.id
        : null) ?? null,
  );
  const [pathToId, setPathToId] = useState<string | null>(
    () =>
      (urlState.pathTo
        ? resolveFocus({ nodes: artifact.nodes, root: artifact.root }, urlState.pathTo)?.id
        : null) ?? null,
  );
  const neighbors = useMemo(
    () =>
      selectedPaperId ? priorDerivative(artifact.nodes, artifact.edges, selectedPaperId) : null,
    [artifact.nodes, artifact.edges, selectedPaperId],
  );
  const lineagePath = useMemo(
    () =>
      selectedPaperId && pathToId && selectedPaperId !== pathToId
        ? shortestLineagePath(artifact.nodes, artifact.edges, selectedPaperId, pathToId)
        : null,
    [artifact.nodes, artifact.edges, selectedPaperId, pathToId],
  );
  const pathKeys = useMemo(
    () => new Set(lineagePath ? lineagePath.steps.map((st) => edgeKey(st.edge)) : []),
    [lineagePath],
  );
  const pathNodeIds = useMemo(() => new Set(lineagePath?.nodeIds ?? []), [lineagePath]);
  const selectPaper = useCallback((id: string | null) => {
    setSelectedPaperId(id);
    setPathToId((cur) => (cur !== null && cur === id ? null : cur));
  }, []);

  // ---- Filters (search / year range / relation chips) -----------------
  const [searchQuery, setSearchQuery] = useState(() => urlState.searchQuery ?? "");
  const dataYearExtentsRef = useRef<{ min: number; max: number } | null>(null);
  if (dataYearExtentsRef.current === null) {
    const years = artifact.nodes
      .map((n) => n.year)
      .filter((y): y is number => typeof y === "number");
    dataYearExtentsRef.current = years.length
      ? { min: Math.min(...years), max: Math.max(...years) }
      : null;
  }
  const dataYearExtents = dataYearExtentsRef.current;
  const [yearRange, setYearRange] = useState<{ min: number; max: number } | null>(() => {
    if (!dataYearExtents) return null;
    return {
      min: urlState.yearMin ?? dataYearExtents.min,
      max: urlState.yearMax ?? dataYearExtents.max,
    };
  });
  const [visibleRelations, setVisibleRelations] = useState<Set<Relation>>(
    () => new Set(urlState.visibleRelations ?? DEFAULT_RELATIONS),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // URL writes are suppressed until after the mount-time prefs
  // hydration below has had a chance to run, mirroring the original's
  // `_urlSyncSuppressed` bootstrap guard -- otherwise the very first
  // render's URL-sync effect could fire before a stored xAxisMode/
  // visibleRelations preference was applied and briefly write the
  // pre-prefs defaults back into the URL.
  const urlSyncSuppressedRef = useRef(true);

  // M8a port of loadPrefs(): mount-only, localStorage-backed fallback
  // for xAxisMode/visibleRelations when the URL didn't already decide
  // them (URL > prefs > built-in default, matching the original's
  // `prefs` var feeding `state`'s initial values before readUrlState()
  // overrides them). try/catch lives inside loadThemePrefs itself;
  // this wraps the `window.localStorage` property access too, since
  // some private-mode browsers throw on that access, not just on
  // `getItem`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by design -- this must run exactly once per theme (per LineageTree mount) and never re-apply stored prefs over a user's later in-session choice, so `urlState.xAxisMode`/`urlState.visibleRelations` (read only to decide whether to apply them) are intentionally frozen at their mount-time value.
  useEffect(() => {
    try {
      if (!urlState.xAxisMode || !urlState.visibleRelations) {
        const prefs = loadThemePrefs(window.localStorage);
        if (prefs) {
          if (!urlState.xAxisMode) setMode(prefs.xAxisMode);
          if (!urlState.visibleRelations) setVisibleRelations(new Set(prefs.visibleRelations));
        }
      }
    } catch {
      /* ignore -- localStorage disabled */
    } finally {
      urlSyncSuppressedRef.current = false;
    }
  }, []);

  // M8a port of savePrefs(): persists only the two prefs fields
  // (xAxisMode, visibleRelations), matching the original's call sites
  // (the X-axis button handler and the relation-chip handler).
  useEffect(() => {
    if (urlSyncSuppressedRef.current) return;
    try {
      saveThemePrefs(window.localStorage, {
        xAxisMode: mode,
        visibleRelations: [...visibleRelations],
      });
    } catch {
      /* ignore -- localStorage disabled */
    }
  }, [mode, visibleRelations]);

  // Hide orphan papers (no incident edge) by default -- ported from
  // docs/assets/theme.js's state.hideOrphans. hubSet/orphanSet are
  // computed once against the FULL node+edge set (never the relation-
  // filtered visibleEdges) so toggling relation chips or the orphan
  // toggle itself never reshuffles which papers count as hub/orphan.
  const [hideOrphans, setHideOrphans] = useState(() => urlState.hideOrphans ?? true);
  const hubSet = useMemo(
    () => computeHubSet(artifact.nodes, artifact.edges),
    [artifact.nodes, artifact.edges],
  );
  const orphanSet = useMemo(
    () => computeOrphanSet(artifact.nodes, artifact.edges),
    [artifact.nodes, artifact.edges],
  );
  // The toggle stays mounted (discoverability) even for a theme with
  // zero orphans, but disables itself instead of doing nothing.
  const orphanToggleDisabled = orphanSet.size === 0;
  const effectiveHideOrphans = hideOrphans && !orphanToggleDisabled;
  const nodesForLayout = useMemo(
    () =>
      effectiveHideOrphans ? artifact.nodes.filter((n) => !orphanSet.has(n.id)) : artifact.nodes,
    [artifact.nodes, orphanSet, effectiveHideOrphans],
  );

  // M8a port of syncUrlState(): writes the filter state back into the
  // URL via history.replaceState (not pushState -- a filter twiddle
  // must never add a back-button entry) so the view stays shareable at
  // any moment. Suppressed until the mount-time prefs hydration above
  // has settled. Declared after `hideOrphans` (its dependency) rather
  // than alongside the other two URL/prefs effects above.
  useEffect(() => {
    if (urlSyncSuppressedRef.current) return;
    try {
      const url = new URL(window.location.href);
      writeTreeUrlParams(url.searchParams, {
        xAxisMode: mode,
        yearRange,
        dataYearExtents,
        searchQuery,
        visibleRelations,
        hideOrphans,
        mainPath: mainPathMode,
        focus: selectedPaperId,
        pathTo: selectedPaperId ? pathToId : null,
        view,
      });
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* ignore -- URL/history access unexpectedly unavailable */
    }
  }, [
    mode,
    yearRange,
    searchQuery,
    visibleRelations,
    hideOrphans,
    dataYearExtents,
    mainPathMode,
    selectedPaperId,
    pathToId,
    view,
  ]);

  const toggleRelation = useCallback((r: Relation) => {
    setVisibleRelations((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  }, []);

  const activeSearch = searchQuery.trim();
  const isYearFiltered =
    yearRange !== null &&
    dataYearExtents !== null &&
    (yearRange.min !== dataYearExtents.min || yearRange.max !== dataYearExtents.max);
  const relationsAreDefault =
    visibleRelations.size === DEFAULT_RELATIONS.length &&
    DEFAULT_RELATIONS.every((r) => visibleRelations.has(r));

  function clearFilter(kind: "search" | "year" | "relations" | "orphan") {
    if (kind === "search") setSearchQuery("");
    else if (kind === "year") setYearRange(dataYearExtents);
    else if (kind === "relations") setVisibleRelations(new Set(DEFAULT_RELATIONS));
    else setHideOrphans(false);
  }
  function showAllRelations() {
    setVisibleRelations(new Set(ALL_RELATIONS));
  }
  function clearAllFilters() {
    setSearchQuery("");
    setYearRange(dataYearExtents);
    setVisibleRelations(new Set(DEFAULT_RELATIONS));
    setHideOrphans(false);
  }

  const activeFilterChips: Array<{
    kind: "search" | "year" | "relations" | "orphan";
    label: string;
  }> = [];
  if (activeSearch) activeFilterChips.push({ kind: "search", label: `🔍 検索: "${activeSearch}"` });
  if (isYearFiltered && yearRange) {
    activeFilterChips.push({ kind: "year", label: `📅 年: ${yearRange.min}〜${yearRange.max}` });
  }
  if (!relationsAreDefault) {
    activeFilterChips.push({
      kind: "relations",
      label: `🔗 関係: ${
        ALL_RELATIONS.filter((r) => visibleRelations.has(r))
          .map(relationLabelJa)
          .join("・") || "なし"
      }`,
    });
  }
  if (effectiveHideOrphans) {
    activeFilterChips.push({
      kind: "orphan",
      label: `🔗 孤立論文 ${orphanSet.size} 件を非表示`,
    });
  }

  // ---- Pinned evidence panel (click / tap / Enter on an edge) -----------
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const evidenceHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusPanelOnOpenRef = useRef(false);
  // Focus returns to whatever opened the panel (an edge, a 根拠 button)
  // when it closes, so keyboard / screen-reader users keep their place.
  // Click handlers pass the clicked element explicitly: Safari and Firefox
  // on macOS do not focus a button on mouse click, so
  // `document.activeElement` is <body> there and focus would be lost.
  const evidenceOpenerRef = useRef<HTMLElement | null>(null);
  const selectEdge = useCallback((key: string, opener?: Element | null) => {
    focusPanelOnOpenRef.current = true;
    const active = opener ?? (typeof document !== "undefined" ? document.activeElement : null);
    if (active instanceof HTMLElement || active instanceof SVGElement) {
      evidenceOpenerRef.current = active as HTMLElement;
    }
    setSelectedEdgeKey(key);
  }, []);
  const closeEvidence = useCallback(() => {
    setSelectedEdgeKey(null);
    const opener = evidenceOpenerRef.current;
    evidenceOpenerRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, []);
  const selectedEdge = useMemo(
    () =>
      selectedEdgeKey ? (artifact.edges.find((e) => edgeKey(e) === selectedEdgeKey) ?? null) : null,
    [artifact.edges, selectedEdgeKey],
  );
  useEffect(() => {
    if (!selectedEdge || !focusPanelOnOpenRef.current) return;
    focusPanelOnOpenRef.current = false;
    const heading = evidenceHeadingRef.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "nearest" });
  }, [selectedEdge]);

  // ---- Keyboard-help + reading guide ------------------------------------
  // The reading guide (「この図の読み方」: terms, line colours, card
  // badges) replaced the old 横軸 coach-mark. It starts open on a first
  // visit and stays closed once the reader has closed it (same storage
  // key as the old coach-mark, so returning readers are not re-shown it).
  const [kbdHelpOpen, setKbdHelpOpen] = useState(false);
  const kbdCloseRef = useRef<HTMLButtonElement>(null);
  const kbdOpenerRef = useRef<HTMLElement | null>(null);
  // `opener` is the clicked ⌨ button (see selectEdge: a mouse click does
  // not focus a button in Safari / macOS Firefox); the "?" key path falls
  // back to the focused element.
  const openKbdHelp = useCallback((opener?: Element | null) => {
    const active = opener ?? document.activeElement;
    kbdOpenerRef.current =
      active instanceof HTMLElement || active instanceof SVGElement
        ? (active as HTMLElement)
        : null;
    setKbdHelpOpen(true);
  }, []);
  useEffect(() => {
    if (kbdHelpOpen) {
      kbdCloseRef.current?.focus();
      return;
    }
    const opener = kbdOpenerRef.current;
    kbdOpenerRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, [kbdHelpOpen]);
  // Read synchronously on the first render (this tree only renders on the
  // client, after the artifact fetch -- never during hydration), so a
  // first visit paints the guide open right away. Opening it in an effect
  // pushed the whole tree ~180px down after its first paint (CLS 0.04-0.1
  // on every first visit; Lighthouse 2026-10-12).
  const [guideOpen, setGuideOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(ONBOARDING_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const onGuideToggle = useCallback((open: boolean) => {
    setGuideOpen(open);
    if (open) return;
    try {
      localStorage.setItem(ONBOARDING_KEY, "1");
    } catch {
      /* ignore -- private mode / blocked storage */
    }
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (kbdHelpOpen) {
          setKbdHelpOpen(false);
          e.preventDefault();
          return;
        }
        if (selectedEdgeKey) {
          closeEvidence();
          e.preventDefault();
          return;
        }
        return;
      }
      if (isEditableTarget(document.activeElement)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (/^[1-6]$/.test(e.key)) {
        const target = X_AXIS_MODES[Number.parseInt(e.key, 10) - 1];
        if (target) {
          setMode(target);
          e.preventDefault();
        }
        return;
      }
      if (e.key === "/") {
        setFiltersOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        e.preventDefault();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        setFiltersOpen((v) => !v);
        e.preventDefault();
        return;
      }
      if (e.key === "?") {
        openKbdHelp();
        e.preventDefault();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [kbdHelpOpen, selectedEdgeKey, closeEvidence, openKbdHelp]);

  // ---- Layout + per-mode visual hooks -----------------------------------
  // Both take nodesForLayout (orphans already dropped when hidden) --
  // otherwise the layout would reserve an empty row for any year that
  // contained only orphans (docs/assets/theme.js's render() comment).
  const { positioned, yearLabels, totalW, totalH } = useMemo(
    () => layoutChronological(nodesForLayout, artifact.edges, mode),
    [nodesForLayout, artifact.edges, mode],
  );
  const modeData = useMemo(
    () => computeModeData(nodesForLayout, artifact.edges, mode),
    [nodesForLayout, artifact.edges, mode],
  );
  const positionById = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const p of positioned) map.set(p.id, { x: p._x, y: p._y });
    return map;
  }, [positioned]);

  const visibleEdges = useMemo(
    () =>
      artifact.edges.filter(
        (e) =>
          visibleRelations.has(e.relation as Relation) &&
          (mainPathMode !== "only" || mainPathKeys.has(edgeKey(e))),
      ),
    [artifact.edges, visibleRelations, mainPathMode, mainPathKeys],
  );
  // Main-path edges are drawn last so they sit on top of the others.
  const drawnEdges = useMemo(() => {
    if (!showMainPath) return visibleEdges;
    const rest = visibleEdges.filter((e) => !mainPathKeys.has(edgeKey(e)));
    const main = visibleEdges.filter((e) => mainPathKeys.has(edgeKey(e)));
    return [...rest, ...main];
  }, [visibleEdges, showMainPath, mainPathKeys]);

  const matchSet = useMemo(() => {
    if (!activeSearch && !isYearFiltered) return null;
    const min = yearRange?.min ?? null;
    const max = yearRange?.max ?? null;
    return new Set(
      nodesForLayout
        .filter((n) => matchesSearch(n, activeSearch) && matchesYear(n, min, max))
        .map((n) => n.id),
    );
  }, [nodesForLayout, activeSearch, isYearFiltered, yearRange]);

  const hiddenCount = hiddenEdgeCount(artifact.edges, visibleRelations);
  const sparse = isSparseLineage(artifact.nodes.length, artifact.edges.length);
  const nodeById = useMemo(() => new Map(artifact.nodes.map((n) => [n.id, n])), [artifact.nodes]);

  // ---- Card popover (delayed show, instant hide) ------------------------
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const popoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleShowPopover = useCallback((id: string) => {
    if (popoverTimerRef.current) clearTimeout(popoverTimerRef.current);
    popoverTimerRef.current = setTimeout(() => setHoveredNodeId(id), POPOVER_HOVER_DELAY_MS);
  }, []);
  const hidePopover = useCallback(() => {
    if (popoverTimerRef.current) {
      clearTimeout(popoverTimerRef.current);
      popoverTimerRef.current = null;
    }
    setHoveredNodeId(null);
  }, []);
  useEffect(
    () => () => {
      if (popoverTimerRef.current) clearTimeout(popoverTimerRef.current);
    },
    [],
  );

  // ---- Edge tooltip (instant show/hide) ---------------------------------
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);

  // ---- Pan (bounded scroll) + minimap ------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const [minimapVisible, setMinimapVisible] = useState(false);
  const draggingRef = useRef(false);

  // ---- Zoom ---------------------------------------------------------------
  // The SVG keeps its viewBox and only its rendered width/height change,
  // so every position inside stays in layout units (no inline style; CSP).
  // On a phone the cards start at MOBILE_ZOOM so more than one card fits.
  // Read on the first render, like the reading guide above (this tree only
  // renders on the client, after the artifact fetch): setting it in an
  // effect painted one frame at 100% first (a layout shift on phones), and
  // a zoom click in that frame was overridden.
  const [zoom, setZoom] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < 640 ? MOBILE_ZOOM : 1,
  );
  const zoomRef = useRef(zoom);
  const changeZoom = useCallback((next: number) => {
    const container = scrollRef.current;
    const prev = zoomRef.current;
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (z === prev) return;
    zoomRef.current = z;
    setZoom(z);
    if (!container) return;
    // Keep the point at the centre of the viewport where it was.
    const cx = (container.scrollLeft + container.clientWidth / 2) / prev;
    const cy = (container.scrollTop + container.clientHeight / 2) / prev;
    requestAnimationFrame(() => {
      container.scrollLeft = Math.max(0, cx * z - container.clientWidth / 2);
      container.scrollTop = Math.max(0, cy * z - container.clientHeight / 2);
    });
  }, []);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  function zoomStep(dir: 1 | -1) {
    const cur = zoomRef.current;
    const steps =
      dir > 0
        ? ZOOM_STEPS.filter((z) => z > cur + 1e-6)
        : [...ZOOM_STEPS].reverse().filter((z) => z < cur - 1e-6);
    const target = steps[0];
    if (target !== undefined) changeZoom(target);
  }
  const yearRailRef = useRef<SVGGElement>(null);
  useEffect(() => {
    const container = scrollRef.current;
    const rail = yearRailRef.current;
    if (!container || !rail) return;
    const update = () => {
      rail.setAttribute("transform", `translate(0 ${-container.scrollTop}) scale(${zoom})`);
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => container.removeEventListener("scroll", update);
  }, [zoom]);

  // Mouse drag-to-pan on the tree background (touch scrolls natively).
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  function onPanStart(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.pointerType !== "mouse" || ev.button !== 0) return;
    const target = ev.target as Element;
    if (target.closest("button, a, [role='button'], input, select")) return;
    const c = scrollRef.current;
    if (!c) return;
    panRef.current = { x: ev.clientX, y: ev.clientY, left: c.scrollLeft, top: c.scrollTop };
  }
  function onPanMove(ev: React.PointerEvent<HTMLDivElement>) {
    const start = panRef.current;
    const c = scrollRef.current;
    if (!start || !c) return;
    c.scrollLeft = start.left - (ev.clientX - start.x);
    c.scrollTop = start.top - (ev.clientY - start.y);
  }
  function onPanEnd() {
    panRef.current = null;
  }
  function zoomToFit() {
    const container = scrollRef.current;
    if (!container) return;
    changeZoom(Math.min(1, (container.clientWidth - 8) / Math.max(totalW, 1)));
  }

  useEffect(() => {
    function onUp() {
      draggingRef.current = false;
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // ---- ?node= permalink focus --------------------------------------------
  // M8a port of resolveFocus() + init()'s "#65: if the URL carried a
  // ?node=, scroll to it" landing behaviour. Canonical-only resolution
  // (SCR-24): an unrecognised/mismatched ?node= value never falls back
  // to the root or "first node" -- resolveFocus itself returns `null`
  // in that case, and this effect then simply does nothing.
  // `?focus=` (design doc 48 P1-3, the catalog's "系譜での位置" link) is
  // also a scroll target when `?node=` is absent.
  const permalinkRaw = urlState.node ?? urlState.focus;
  const permalinkFocus = useMemo(
    () =>
      permalinkRaw
        ? resolveFocus({ nodes: artifact.nodes, root: artifact.root }, permalinkRaw)
        : null,
    [artifact.nodes, artifact.root, permalinkRaw],
  );
  const scrolledToPermalinkRef = useRef(false);
  useEffect(() => {
    if (!permalinkRaw || !permalinkFocus || scrolledToPermalinkRef.current) return;
    const container = scrollRef.current;
    const pos = positionById.get(permalinkFocus.id);
    // The focus node might not be in `positionById` yet (hidden by the
    // orphan/relation filters, or the layout hasn't committed this
    // frame) -- leave the ref unset so a later render (e.g. the user
    // clearing the filter that hid it) can still complete the scroll.
    if (!container || !pos) return;
    scrolledToPermalinkRef.current = true;
    const z = zoomRef.current;
    container.scrollTo({
      left: Math.max(0, (pos.x + NODE_W / 2) * z - container.clientWidth / 2),
      top: Math.max(0, (pos.y + NODE_H / 2) * z - container.clientHeight / 2),
      behavior: "auto",
    });
  }, [permalinkRaw, permalinkFocus, positionById]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `view` / `zoom` are not read in the body (zoom via zoomRef) -- switching back from the timeline or zooming must re-run the paint so the minimap is recomputed.
  useEffect(() => {
    const container = scrollRef.current;
    const canvas = minimapCanvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function paint() {
      const z = zoomRef.current;
      const needs =
        totalW * z > container!.clientWidth + 40 || totalH * z > container!.clientHeight + 40;
      setMinimapVisible(needs);
      if (!needs) return;
      const cw = canvas!.width;
      const ch = canvas!.height;
      const s = Math.min(cw / totalW, ch / totalH);
      const ox = (cw - totalW * s) / 2;
      const oy = (ch - totalH * s) / 2;
      ctx!.clearRect(0, 0, cw, ch);
      ctx!.fillStyle = "rgba(255, 250, 240, 0.95)";
      ctx!.fillRect(0, 0, cw, ch);
      ctx!.fillStyle = "rgba(80, 60, 40, 0.55)";
      for (const n of positioned) {
        const x = ox + (n._x + NODE_W / 2) * s;
        const y = oy + (n._y + NODE_H / 2) * s;
        ctx!.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
      const vx = ox + (container!.scrollLeft / z) * s;
      const vy = oy + (container!.scrollTop / z) * s;
      const vw = (container!.clientWidth / z) * s;
      const vh = (container!.clientHeight / z) * s;
      const rx = Math.max(0, Math.min(cw, vx));
      const ry = Math.max(0, Math.min(ch, vy));
      const rw = Math.max(0, Math.min(cw - rx, vw));
      const rh = Math.max(0, Math.min(ch - ry, vh));
      ctx!.fillStyle = "rgba(255, 110, 0, 0.12)";
      ctx!.strokeStyle = "rgb(181, 73, 10)";
      ctx!.lineWidth = 1.5;
      ctx!.fillRect(rx, ry, rw, rh);
      ctx!.strokeRect(rx, ry, rw, rh);
    }

    paint();
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        paint();
        raf = 0;
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", paint);
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", paint);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [positioned, totalW, totalH, view, zoom]);

  function panToMinimapPoint(ev: { clientX: number; clientY: number }) {
    const canvas = minimapCanvasRef.current;
    const container = scrollRef.current;
    if (!canvas || !container) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (ev.clientX - rect.left) * scaleX;
    const py = (ev.clientY - rect.top) * scaleY;
    const s = Math.min(canvas.width / totalW, canvas.height / totalH);
    const ox = (canvas.width - totalW * s) / 2;
    const oy = (canvas.height - totalH * s) / 2;
    const z = zoomRef.current;
    const targetX = ((px - ox) / s) * z - container.clientWidth / 2;
    const targetY = ((py - oy) / s) * z - container.clientHeight / 2;
    container.scrollTo({
      left: Math.max(0, targetX),
      top: Math.max(0, targetY),
      behavior: "smooth",
    });
  }

  // ---- Export ------------------------------------------------------------
  function handleExportSvg() {
    if (!svgRef.current) return;
    try {
      exportSvg(svgRef.current, { slug });
    } catch (err) {
      console.error("export failed:", err);
    }
  }
  async function handleExportPng() {
    if (!svgRef.current) return;
    const background =
      getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim() || "#fdfaf3";
    try {
      await exportPng(svgRef.current, { slug, background });
    } catch (err) {
      console.error("export failed:", err);
    }
  }

  // ---- BibTeX / CSV / share URL (design doc 48 P0-3) ----------------------
  // Exports what is on screen: the laid-out nodes (orphans dropped when
  // hidden) narrowed by the search/year filter, and the visible edges
  // between them.
  const [shareStatus, setShareStatus] = useState<string>("");
  function exportedNodes() {
    return nodesForLayout.filter((n) => !matchSet || matchSet.has(n.id));
  }
  function handleExportBibtex() {
    downloadText(
      exportFilename(`${slug || "theme"}-papers`, "bib"),
      themeNodesToBibtex(exportedNodes()),
      "application/x-bibtex",
    );
  }
  function handleExportNodesCsv() {
    downloadText(
      exportFilename(`${slug || "theme"}-papers`, "csv"),
      themeNodesToCsv(exportedNodes(), mainPathNodeIds),
      "text/csv",
    );
  }
  function handleExportEdgesCsv() {
    const ids = new Set(exportedNodes().map((n) => n.id));
    const edges = visibleEdges.filter((e) => ids.has(e.src) && ids.has(e.dst));
    downloadText(
      exportFilename(`${slug || "theme"}-relations`, "csv"),
      themeEdgesToCsv(edges, nodeById, (e) => mainPathKeys.has(edgeKey(e))),
      "text/csv",
    );
  }
  async function handleCopyUrl() {
    const ok = await copyText(window.location.href);
    setShareStatus(
      ok ? "URL をコピーしました" : "コピーできませんでした。アドレス欄の URL を使ってください",
    );
  }

  const feedbackTheme = slug ? { name: themeName || slug, slug } : null;
  const svgW = Math.max(totalW, 320);
  const svgH = Math.max(totalH, 200);

  const btnBase = "inline-flex min-h-9 items-center rounded-md border px-2.5 py-1 text-xs";
  const btnOff = "border-rule text-ink-muted hover:border-rule-strong";
  const btnOn = "border-accent bg-accent/10 text-accent-strong";
  const zoomPct = Math.round(zoom * 100);

  return (
    <div className="mt-4">
      {/* ---- Toolbar: what to show (view / 本流 / ordering) + filter, then
          export & share folded into one disclosure (design 53 §系譜ページ). */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2" data-theme-toolbar>
        <fieldset
          className="flex flex-wrap items-center gap-1 border-0 p-0 text-xs"
          data-view-toggle
        >
          <legend className="mb-0.5 text-ink-subtle">表示</legend>
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              title={VIEW_BUTTON[v].title}
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`${btnBase} ${view === v ? btnOn : btnOff}`}
            >
              {VIEW_BUTTON[v].label}
            </button>
          ))}
        </fieldset>

        {mainPathKeys.size > 0 && (
          <fieldset
            className="flex flex-wrap items-center gap-1 border-0 p-0 text-xs"
            data-main-path-toggle
          >
            <legend className="mb-0.5 text-ink-subtle">
              本流<span className="sr-only">（{mainPathKeys.size} 本の線）</span>
            </legend>
            {MAIN_PATH_MODES.map((m) => (
              <button
                key={m}
                type="button"
                title={MAIN_PATH_BUTTON[m].title}
                aria-pressed={mainPathMode === m}
                onClick={() => setMainPathMode(m)}
                className={`${btnBase} ${mainPathMode === m ? btnOn : btnOff}`}
              >
                {MAIN_PATH_BUTTON[m].label}
              </button>
            ))}
          </fieldset>
        )}

        {view === "tree" && (
          <label className="flex flex-col gap-0.5 text-xs text-ink-subtle" data-xaxis-select>
            <span>並べ方</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as XAxisMode)}
              aria-describedby="theme-xaxis-hint"
              className="min-h-9 max-w-[16rem] rounded-md border border-rule bg-surface px-2 py-1 text-xs text-ink"
            >
              {X_AXIS_MODES.map((m) => (
                <option key={m} value={m}>
                  {X_AXIS_OPTION[m].label}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="theme-filters-panel"
            onClick={() => setFiltersOpen((v) => !v)}
            title="検索・年の範囲・関係の種類で絞り込む（F キー）"
            className={`${btnBase} ${btnOff}`}
          >
            絞り込み
            {activeFilterChips.length > 0 && (
              <span className="ml-1 rounded-full bg-accent/10 px-1.5 text-accent-strong">
                {activeFilterChips.length}
              </span>
            )}
          </button>
          <details className="relative" data-export-menu>
            <summary className={`${btnBase} ${btnOff} cursor-pointer list-none`}>
              書き出し・共有{" "}
              <span aria-hidden="true" className="ml-1">
                ▾
              </span>
            </summary>
            <div className="absolute right-0 z-30 mt-1 flex w-56 flex-col gap-1 rounded-md border border-rule bg-surface-elevated p-2 shadow-lg">
              <button
                type="button"
                title="今の表示（絞り込みを含む）の URL をコピーする"
                onClick={handleCopyUrl}
                data-share-url
                className={`${btnBase} ${btnOff} justify-start`}
              >
                URL をコピー
              </button>
              <p className="mt-1 text-[0.68rem] text-ink-subtle">表示中の論文・関係を書き出す</p>
              <button
                type="button"
                onClick={handleExportBibtex}
                data-export="bibtex"
                className={`${btnBase} ${btnOff} justify-start`}
              >
                BibTeX（論文）
              </button>
              <button
                type="button"
                onClick={handleExportNodesCsv}
                data-export="nodes-csv"
                className={`${btnBase} ${btnOff} justify-start`}
              >
                CSV（論文）
              </button>
              <button
                type="button"
                onClick={handleExportEdgesCsv}
                data-export="edges-csv"
                className={`${btnBase} ${btnOff} justify-start`}
              >
                CSV（関係と根拠）
              </button>
              <button
                type="button"
                onClick={handleExportSvg}
                className={`${btnBase} ${btnOff} justify-start`}
              >
                画像（SVG）
              </button>
              <button
                type="button"
                onClick={handleExportPng}
                className={`${btnBase} ${btnOff} justify-start`}
              >
                画像（PNG）
              </button>
            </div>
          </details>
          <span
            role="status"
            aria-live="polite"
            className="text-xs text-ink-subtle"
            data-share-status
          >
            {shareStatus}
          </span>
          <button
            type="button"
            onClick={(ev) => openKbdHelp(ev.currentTarget)}
            title="キーボード操作の一覧（? キー）"
            aria-label="キーボード操作の一覧"
            className={`hidden min-h-9 items-center rounded-md border px-2.5 py-1 text-xs sm:inline-flex ${btnOff}`}
          >
            ⌨
          </button>
        </div>
      </div>
      {view === "tree" && (
        <p id="theme-xaxis-hint" className="mt-1 text-xs text-ink-subtle">
          並べ方: {X_AXIS_OPTION[mode].title}
        </p>
      )}

      <div
        id="theme-filters-panel"
        className={
          filtersOpen
            ? "mt-2 flex flex-wrap items-center gap-4 rounded-md border border-rule bg-surface p-3"
            : "hidden"
        }
      >
        <label className="flex items-center gap-1 text-xs text-ink-muted">
          <span aria-hidden="true">🔍</span>
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="タイトル / 著者で検索"
            aria-label="タイトル・著者で論文を検索"
            autoComplete="off"
            className="min-h-9 rounded-md border border-rule px-2 py-1 text-sm"
          />
        </label>

        {dataYearExtents && yearRange && (
          <fieldset className="flex items-center gap-1 border-0 p-0 text-xs text-ink-muted">
            <legend className="sr-only">年の範囲</legend>
            <span aria-hidden="true">📅</span>
            <span>{yearRange.min}</span>
            <input
              type="range"
              min={dataYearExtents.min}
              max={dataYearExtents.max}
              value={yearRange.min}
              aria-label="開始年"
              onChange={(e) => {
                const lo = Math.min(Number(e.target.value), yearRange.max);
                setYearRange({ min: lo, max: yearRange.max });
              }}
            />
            <input
              type="range"
              min={dataYearExtents.min}
              max={dataYearExtents.max}
              value={yearRange.max}
              aria-label="終了年"
              onChange={(e) => {
                const hi = Math.max(Number(e.target.value), yearRange.min);
                setYearRange({ min: yearRange.min, max: hi });
              }}
            />
            <span>{yearRange.max}</span>
          </fieldset>
        )}

        <fieldset className="flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">関係の種類</legend>
          {ALL_RELATIONS.map((r) => {
            const on = visibleRelations.has(r);
            const count = artifact.edges.filter((e) => e.relation === r).length;
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                onClick={() => toggleRelation(r)}
                className={`${btnBase} ${on ? "border-accent text-accent-strong" : btnOff}`}
              >
                {relationLabelJa(r)} <span className="ml-1 text-ink-subtle">{count}</span>
              </button>
            );
          })}
        </fieldset>

        {/* Orphan toggle: hide papers with no edge in the lineage. Always
            rendered (even at 0 orphans) so the feature stays discoverable;
            it disables itself instead of vanishing. */}
        <label
          title="孤立論文 = 他の論文との分類関係が見つからず、家系図のどのエッジにも乗らなかった論文"
          className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-3 py-1 text-xs text-ink-muted ${
            orphanToggleDisabled
              ? "cursor-help border-rule opacity-65"
              : "cursor-pointer border-rule hover:border-rule-strong"
          }`}
        >
          <input
            type="checkbox"
            checked={effectiveHideOrphans}
            disabled={orphanToggleDisabled}
            onChange={(e) => setHideOrphans(e.target.checked)}
            aria-label="孤立論文を非表示"
          />
          <span>
            孤立論文 (<span>{orphanSet.size}</span>) を非表示
          </span>
        </label>
      </div>

      {activeFilterChips.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted"
        >
          <span>絞り込み中:</span>
          {activeFilterChips.map((c) => (
            <span
              key={c.kind}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2 pr-0.5"
            >
              {c.label}
              <button
                type="button"
                aria-label="この絞り込みを解除"
                title="この絞り込みを解除"
                onClick={() => clearFilter(c.kind)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface"
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" onClick={clearAllFilters} className="text-accent-strong underline">
            すべて解除
          </button>
        </div>
      )}

      {hiddenCount > 0 && (
        <p
          role="status"
          data-testid="hidden-edges-notice"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-rule bg-surface-2 px-3 py-2 text-xs text-ink-muted"
        >
          <span>
            {hiddenCount} 件の関係を非表示中（全 {artifact.edges.length} 件）。
          </span>
          <button type="button" onClick={showAllRelations} className="text-accent-strong underline">
            すべての関係を表示
          </button>
        </p>
      )}

      {sparse && (
        <p
          role="status"
          className="mt-2 rounded-md border border-rule bg-surface-2 px-3 py-2 text-xs text-ink-muted"
        >
          {sparseLineageNotice(artifact.nodes.length, artifact.edges.length)}
        </p>
      )}

      <ReadingGuide
        open={guideOpen}
        onToggle={onGuideToggle}
        mainPathCount={mainPathKeys.size}
        hasCodeLinks={Boolean(codeLinks && Object.keys(codeLinks).length > 0)}
      />

      {view === "timeline" && (
        <ThemeTimeline
          ref={svgRef}
          nodes={nodesForLayout}
          edges={visibleEdges}
          selectedId={selectedPaperId}
          onSelectPaper={selectPaper}
          mainPathKeys={showMainPath ? mainPathKeys : null}
          mainPathNodeIds={showMainPath ? mainPathNodeIds : null}
          pathKeys={pathKeys}
          pathNodeIds={pathNodeIds}
          matchSet={matchSet}
        />
      )}

      <div className={view === "tree" ? "relative mt-3" : "hidden"} data-tree-frame>
        <a
          href="#theme-after-tree"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-30 focus:rounded-md focus:bg-surface-elevated focus:px-2 focus:py-1 focus:text-xs"
        >
          家系図を飛ばして一覧へ
        </a>
        <div className="mb-1 flex items-center justify-end gap-1 text-ink-muted" data-zoom-controls>
          <span className="mr-auto text-xs text-ink-subtle">ドラッグ・スワイプで移動</span>
          <button
            type="button"
            onClick={() => zoomStep(-1)}
            disabled={zoom <= (ZOOM_STEPS[0] ?? ZOOM_MIN) + 1e-6}
            aria-label="縮小"
            title="縮小"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-rule bg-surface text-base text-ink disabled:opacity-40"
          >
            −
          </button>
          <span
            className="w-10 text-center font-mono text-[0.68rem] text-ink-subtle"
            aria-live="polite"
          >
            {zoomPct}%
          </span>
          <button
            type="button"
            onClick={() => zoomStep(1)}
            disabled={zoom >= ZOOM_MAX - 1e-6}
            aria-label="拡大"
            title="拡大"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-rule bg-surface text-base text-ink disabled:opacity-40"
          >
            ＋
          </button>
          <button
            type="button"
            onClick={zoomToFit}
            title="横幅に合わせて全体を表示"
            className="inline-flex h-9 items-center justify-center rounded-md border border-rule bg-surface px-2 text-xs text-ink-muted"
          >
            全体
          </button>
        </div>
        <div className="relative">
          {/* Year labels pinned to the left edge: the in-graph labels scroll
            away when the tree is panned sideways (mobile). Moved with an SVG
            `transform` attribute, never an inline style (CSP). */}
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-px left-px z-10 h-[calc(100%-2px)] w-12"
            data-year-rail
          >
            <g ref={yearRailRef}>
              <rect x={0} y={0} width={46} height={svgH} className="fill-surface opacity-90" />
              {yearLabels.map((yl) => (
                <text
                  key={yl.label}
                  x={8}
                  y={yl.y}
                  className={
                    yl.importance === "decade-major"
                      ? "fill-ink text-xs font-semibold"
                      : yl.importance === "decade"
                        ? "fill-ink-muted text-xs font-medium"
                        : "fill-ink-subtle text-xs"
                  }
                >
                  {yl.label}
                </text>
              ))}
            </g>
          </svg>
          {/* Mouse drag-to-pan on the scroll area; keyboard and touch users scroll it natively. */}
          <div
            ref={scrollRef}
            className="max-h-[70vh] cursor-grab select-none overflow-auto overscroll-contain rounded-md border border-rule bg-surface active:cursor-grabbing"
            onPointerDown={onPanStart}
            onPointerMove={onPanMove}
            onPointerUp={onPanEnd}
            onPointerCancel={onPanEnd}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: role="img" made every card and edge inside presentational (hidden from screen readers); an <svg> cannot be a <fieldset>, so it is a labelled group. */}
            <svg
              ref={view === "tree" ? svgRef : undefined}
              role="group"
              aria-label="テーマの時系列家系図。カードを選ぶと土台と発展、線を選ぶと根拠を表示"
              width={Math.round(svgW * zoom)}
              height={Math.round(svgH * zoom)}
              viewBox={`0 0 ${svgW} ${svgH}`}
              data-zoom={zoom}
            >
              {yearLabels.map((yl) => (
                <text
                  key={yl.label}
                  x={12}
                  y={yl.y}
                  className={
                    yl.importance === "decade-major"
                      ? "fill-ink text-xs font-semibold"
                      : yl.importance === "decade"
                        ? "fill-ink-muted text-xs font-medium"
                        : "fill-ink-subtle text-xs"
                  }
                >
                  {yl.label}
                </text>
              ))}

              {drawnEdges
                .filter((e) => positionById.has(e.src) && positionById.has(e.dst))
                .map((e) => {
                  const src = positionById.get(e.src);
                  const dst = positionById.get(e.dst);
                  if (!src || !dst) return null;
                  const x1 = src.x + NODE_W / 2;
                  const y1 = src.y + NODE_H;
                  const x2 = dst.x + NODE_W / 2;
                  const y2 = dst.y;
                  const key = edgeKey(e);
                  const strokeClass = RELATION_STROKE_CLASS[e.relation] ?? DEFAULT_STROKE_CLASS;
                  const onMain = showMainPath && mainPathKeys.has(key);
                  const onPath = pathKeys.has(key);
                  const baseWidth = Math.max(1, e.confidence * 2);
                  const strokeWidth =
                    selectedEdgeKey === key
                      ? onMain || onPath
                        ? 7
                        : 4
                      : onPath
                        ? 6
                        : onMain
                          ? 5
                          : baseWidth;
                  const strokeOpacity =
                    selectedEdgeKey === key || onMain || onPath ? 1 : showMainPath ? 0.45 : 0.75;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: mirrors hover/focus bubbling from the focusable hit-area <line> below (tabIndex + aria-label) to show the tooltip; no WAI-ARIA role Biome suggests (group/fieldset) applies to a non-form SVG grouping element.
                    <g
                      key={key}
                      data-main-path={onMain ? "1" : undefined}
                      data-lineage-path={onPath ? "1" : undefined}
                      onPointerEnter={(ev) => {
                        if (ev.pointerType === "mouse") setHoveredEdgeKey(key);
                      }}
                      onPointerLeave={() =>
                        setHoveredEdgeKey((current) => (current === key ? null : current))
                      }
                      onFocus={(ev) => {
                        if (isKeyboardFocus(ev.target)) setHoveredEdgeKey(key);
                      }}
                      onBlur={() =>
                        setHoveredEdgeKey((current) => (current === key ? null : current))
                      }
                    >
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        className={strokeClass}
                        strokeWidth={strokeWidth}
                        strokeOpacity={strokeOpacity}
                        strokeLinecap="round"
                      />
                      {/* biome-ignore lint/a11y/useSemanticElements: an SVG <line> hit area cannot be an HTML <button>; role="button" + tabIndex + Enter/Space handling give it button semantics inside the graph. */}
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        className={styles.edgeHit}
                        tabIndex={0}
                        role="button"
                        aria-pressed={selectedEdgeKey === key}
                        aria-label={`${onMain ? "本流・" : ""}${relationLabelJa(e.relation)}: ${e.rationale}（Enter で根拠を表示）`}
                        onClick={(ev) => selectEdge(key, ev.currentTarget)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            selectEdge(key);
                          }
                        }}
                      />
                    </g>
                  );
                })}

              {positioned.map((p) => {
                const authors = (p.authors ?? []).slice(0, 3).join(", ");
                const extra =
                  (p.authors ?? []).length > 3 ? ` +${(p.authors ?? []).length - 3}` : "";
                const accentClass = modeAccentClass(modeData, p.id);
                const filteredClass = matchSet && !matchSet.has(p.id) ? "opacity-40" : "";
                // #83: hub -- degree above the 90th percentile across the
                // theme. #68: trending -- citation velocity, sourced
                // directly from the artifact's is_trending flag. Orphan --
                // no incident edge (dropped upstream entirely when
                // effectiveHideOrphans, so this path never runs for them
                // in that mode). Hub's halo REPLACES the citation-heat
                // halo below (not additive -- mirrors docs/assets/
                // theme.js's CSS specificity override).
                const isHub = hubSet.has(p.id);
                const isOrphan = orphanSet.has(p.id);
                const isTrending = p.is_trending === true;
                const shadowClass = isHub
                  ? styles.hubCard
                  : styles[`heat${heatBucket(p.citation_count)}`];
                const orphanClass = isOrphan ? styles.orphanCard : "";
                // M8a: ?node= permalink highlight -- a visible ring on
                // the card the URL asked to focus, separate from
                // `p.is_focus` (which marks the theme's own seed papers,
                // not an arbitrary shared-link target).
                const permalinkClass =
                  (permalinkFocus && p.id === permalinkFocus.id) ||
                  p.id === selectedPaperId ||
                  pathNodeIds.has(p.id)
                    ? "ring-2 ring-accent"
                    : "";
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: same rationale as the edge <g> above -- mirrors hover/focus bubbling from the focusable card <a> inside the foreignObject to show the popover.
                  <g
                    key={p.id}
                    data-node-id={p.id}
                    onPointerEnter={(ev) => {
                      // Touch taps fire enter events too; on a phone the
                      // popover would cover the tree, so mouse only.
                      if (ev.pointerType === "mouse") scheduleShowPopover(p.id);
                    }}
                    onPointerLeave={hidePopover}
                    onFocus={(ev) => {
                      if (isKeyboardFocus(ev.target)) scheduleShowPopover(p.id);
                    }}
                    onBlur={hidePopover}
                  >
                    <foreignObject
                      x={p._x}
                      y={p._y}
                      width={NODE_W}
                      height={NODE_H}
                      overflow="visible"
                    >
                      <button
                        type="button"
                        data-node-card
                        aria-pressed={p.id === selectedPaperId}
                        onClick={() => selectPaper(p.id === selectedPaperId ? null : p.id)}
                        title="選ぶと、この論文の土台と発展を下に表示"
                        aria-label={`${p.title ?? p.id}（${typeof p.year === "number" ? p.year : "年不明"}）: 選ぶと土台と発展を表示`}
                        className={`flex h-full w-full flex-col justify-start overflow-hidden rounded-md border px-3 py-2 text-left text-xs ${
                          p.is_focus
                            ? "border-accent bg-accent/5"
                            : "border-rule bg-surface-elevated"
                        } ${accentClass ?? ""} ${filteredClass} ${shadowClass ?? ""} ${orphanClass} ${permalinkClass}`}
                      >
                        <span className="flex items-center justify-between gap-1">
                          <span className="min-w-0 truncate text-[0.68rem] text-ink-subtle">
                            {p.venue || "—"}
                          </span>
                          {isHub && (
                            <span
                              role="img"
                              aria-label="ハブ論文: 接続数が多い"
                              title="ハブ論文: 他の論文との関係が多い"
                              className={`${styles.badge} ${styles.badgeHub}`}
                            >
                              HUB
                            </span>
                          )}
                          {showMainPath && mainPathNodeIds.has(p.id) && (
                            <span
                              role="img"
                              aria-label="本流（主経路）上の論文"
                              title="本流（主経路）上の論文"
                              className={`${styles.badge} ${styles.badgeMain}`}
                            >
                              本流
                            </span>
                          )}
                          <CodeBadges link={codeLinks?.[p.id]} />
                          {isTrending && (
                            <span
                              role="img"
                              aria-label="注目: 引用が伸びている"
                              title="注目: 最近の引用の伸びが大きい"
                              className={`${styles.badge} ${styles.badgeTrend}`}
                            >
                              TREND
                            </span>
                          )}
                          {isOrphan && (
                            <span
                              role="img"
                              aria-label="孤立: この家系図では他論文との関係がありません"
                              title="他の論文との分類関係がないため、この家系図では孤立しています"
                              className={`${styles.badge} ${styles.badgeOrphan}`}
                            >
                              孤立
                            </span>
                          )}
                        </span>
                        <span className="mt-1 line-clamp-2 font-medium text-ink">
                          {p.title || p.id}
                        </span>
                        {p.tldr && (
                          <span className="mt-1 line-clamp-2 text-ink-muted">{p.tldr}</span>
                        )}
                        <span className="mt-1 block truncate text-ink-subtle">
                          {authors}
                          {extra}
                        </span>
                        {typeof p.citation_count === "number" && p.citation_count > 0 && (
                          <span className="mt-1 block text-ink-subtle">
                            📖 {p.citation_count.toLocaleString()}
                          </span>
                        )}
                      </button>
                    </foreignObject>
                  </g>
                );
              })}

              {hoveredNodeId &&
                (() => {
                  const p = positioned.find((n) => n.id === hoveredNodeId);
                  if (!p) return null;
                  const popW = 300;
                  const popH = 200;
                  const gap = 12;
                  const flip = p._x + NODE_W + gap + popW > totalW;
                  const px = Math.max(0, flip ? p._x - popW - gap : p._x + NODE_W + gap);
                  const py = Math.max(0, Math.min(p._y, totalH - popH));
                  const metaParts = [
                    typeof p.citation_count === "number" && p.citation_count > 0
                      ? `📖 ${p.citation_count.toLocaleString()}`
                      : null,
                    formatStars(typeof p.github_stars === "number" ? p.github_stars : null)
                      ? `⭐${formatStars(p.github_stars as number)}`
                      : null,
                    typeof p.arxiv_id === "string" && p.arxiv_id
                      ? `arXiv:${p.arxiv_id}`
                      : typeof p.doi === "string" && p.doi
                        ? `DOI:${p.doi}`
                        : null,
                  ].filter((part): part is string => Boolean(part));
                  const authors = Array.isArray(p.authors) ? p.authors.join(", ") : "";
                  return (
                    <foreignObject x={px} y={py} width={popW} height={popH} overflow="visible">
                      <div
                        role="tooltip"
                        aria-label={`${p.title ?? p.id} の詳細`}
                        className={`${styles.popoverPanel} ${styles.popoverVisible} w-full rounded-md border border-rule bg-surface-elevated p-3 text-xs`}
                      >
                        <div className="text-[0.68rem] text-ink-subtle">
                          {formatVenue(p.venue, p.year) || "—"}
                        </div>
                        <h3 className="mt-1 font-medium text-ink">{p.title || p.id}</h3>
                        {p.tldr && (
                          <>
                            <p lang="en" className="mt-1 text-ink-muted">
                              {p.tldr}
                            </p>
                            <p
                              className="mt-0.5 text-[0.62rem] text-ink-subtle"
                              data-abstract-excerpt
                            >
                              要旨の冒頭（{abstractExcerptSourceLabel(p.id)}
                              経由。著作権は著者に帰属）
                            </p>
                          </>
                        )}
                        {authors && <div className="mt-1 text-ink-subtle">{authors}</div>}
                        {metaParts.length > 0 && (
                          <div className="mt-1 text-ink-subtle">{metaParts.join("  ·  ")}</div>
                        )}
                      </div>
                    </foreignObject>
                  );
                })()}

              {hoveredEdgeKey &&
                (() => {
                  const e = visibleEdges.find((edge) => edgeKey(edge) === hoveredEdgeKey);
                  if (!e) return null;
                  const src = positionById.get(e.src);
                  const dst = positionById.get(e.dst);
                  if (!src || !dst) return null;
                  const midX = (src.x + NODE_W / 2 + (dst.x + NODE_W / 2)) / 2;
                  const midY = (src.y + NODE_H + dst.y) / 2;
                  const ttW = 260;
                  const ttH = 110;
                  const ttX = Math.max(0, Math.min(midX - ttW / 2, totalW - ttW));
                  const ttY = Math.max(0, midY - ttH - 8);
                  return (
                    <foreignObject x={ttX} y={ttY} width={ttW} height={ttH} overflow="visible">
                      <div
                        role="tooltip"
                        className={`${styles.tooltipPanel} ${styles.tooltipVisible} rounded-md border border-rule bg-surface-elevated p-2 text-xs`}
                      >
                        <div className="font-medium text-ink">{relationLabelJa(e.relation)}</div>
                        <div className="mt-1 line-clamp-3 text-ink-muted">{e.rationale}</div>
                        <div className="mt-1 text-ink-subtle">
                          確信度 {e.confidence.toFixed(2)} ・ クリックで根拠を表示
                        </div>
                      </div>
                    </foreignObject>
                  );
                })()}
            </svg>
          </div>
        </div>

        {minimapVisible && (
          <div
            role="img"
            aria-label="家系図の縮小表示"
            className="pointer-events-none absolute bottom-2 right-2 hidden rounded-md border border-rule bg-surface-elevated p-1 shadow sm:block"
          >
            <canvas
              ref={minimapCanvasRef}
              width={180}
              height={110}
              className={`${styles.minimapCanvas} pointer-events-auto`}
              onMouseDown={(e) => {
                draggingRef.current = true;
                panToMinimapPoint(e);
              }}
              onMouseMove={(e) => {
                if (draggingRef.current) panToMinimapPoint(e);
              }}
            />
          </div>
        )}
      </div>

      {selectedPaperId && neighbors && nodeById.get(selectedPaperId) && (
        <p
          role="status"
          className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-accent bg-accent/5 px-3 py-2 text-xs text-ink"
          data-selected-paper-bar
        >
          <span className="text-ink-subtle">選択中:</span>
          <strong className="min-w-0 break-words font-medium">
            {String(nodeById.get(selectedPaperId)?.title || selectedPaperId)}
          </strong>
          <span className="text-ink-muted">
            土台 {neighbors.prior.length} 本・発展 {neighbors.derivative.length} 本
          </span>
          <a href="#paper-neighbors-title" className="text-accent-strong underline">
            一覧を見る
          </a>
        </p>
      )}

      <p id="theme-after-tree" tabIndex={-1} className="mt-2 text-xs text-ink-subtle">
        {view === "tree"
          ? "カードを選ぶと土台と発展、線を選ぶと関係の根拠を表示します（キーボードは Tab で選んで Enter）。"
          : "点を選ぶと、その論文の土台と発展を下に表示します。線の上に置くと関係が出ます。"}
      </p>

      {selectedEdge && (
        <EdgeEvidencePanel
          ref={evidenceHeadingRef}
          edge={selectedEdge}
          nodeById={nodeById}
          onClose={closeEvidence}
          theme={feedbackTheme}
          onMainPath={mainPathKeys.has(edgeKey(selectedEdge))}
        />
      )}

      <PaperNeighborsPanel
        nodes={artifact.nodes}
        nodeById={nodeById}
        selectedId={selectedPaperId}
        onSelectPaper={selectPaper}
        neighbors={neighbors}
        pathToId={pathToId}
        onPathTo={setPathToId}
        path={lineagePath}
        onShowEvidence={selectEdge}
        mainPathNodeIds={mainPathNodeIds}
      />

      <EdgeRelationList
        edges={visibleEdges}
        nodeById={nodeById}
        selectedKey={selectedEdgeKey}
        onSelect={selectEdge}
        theme={feedbackTheme}
        mainPathKeys={showMainPath ? mainPathKeys : undefined}
      />

      {kbdHelpOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="kbd-help-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setKbdHelpOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setKbdHelpOpen(false);
            // Modal: Tab stays on the one control inside (the close button).
            if (e.key === "Tab") {
              e.preventDefault();
              kbdCloseRef.current?.focus();
            }
          }}
        >
          <div className="w-full max-w-sm rounded-md border border-rule bg-surface-elevated p-4">
            <h2 id="kbd-help-title" className="font-serif text-base font-semibold text-ink">
              ⌨️ キーボードショートカット
            </h2>
            <table className="mt-2 w-full text-xs text-ink-muted">
              <tbody>
                <tr>
                  <td className="w-10 pr-2 font-mono text-ink">1</td>
                  <td>並べ方: 被引用の多い順</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">2</td>
                  <td>並べ方: 被引用数（対数）</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">3</td>
                  <td>並べ方: 研究の流れ</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">4</td>
                  <td>並べ方: 中心性</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">5</td>
                  <td>並べ方: 会議の格</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">6</td>
                  <td>並べ方: 新しさの種類</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">/</td>
                  <td>論文検索フォーカス</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">F</td>
                  <td>絞り込みパネル開閉</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">?</td>
                  <td>このヘルプ表示</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">Enter</td>
                  <td>選んだ線の根拠を表示</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">Esc</td>
                  <td>閉じる / 解除</td>
                </tr>
              </tbody>
            </table>
            <button
              ref={kbdCloseRef}
              type="button"
              onClick={() => setKbdHelpOpen(false)}
              className="mt-3 min-h-9 w-full rounded-md border border-rule px-2 py-1 text-xs text-ink-muted"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
