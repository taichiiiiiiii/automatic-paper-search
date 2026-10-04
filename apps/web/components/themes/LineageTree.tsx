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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportPng, exportSvg } from "../../lib/themes-export";
import { formatStars, formatVenue } from "../../lib/themes-format";
import type { LineageArtifact, LineageEdge, LineageNode } from "../../lib/themes-quality";
import {
  ALL_RELATIONS,
  computeHubSet,
  computeModeData,
  computeOrphanSet,
  DEFAULT_RELATIONS,
  DEFAULT_X_AXIS_MODE,
  heatBucket,
  isSparseLineage,
  layoutChronological,
  matchesSearch,
  matchesYear,
  NODE_H,
  NODE_W,
  type Relation,
  X_AXIS_MODES,
  type XAxisMode,
} from "../../lib/themes-tree";
import styles from "./LineageTree.module.css";

const X_AXIS_BUTTON: Record<XAxisMode, { icon: string; label: string; title: string }> = {
  rank: { icon: "📊", label: "順位", title: "年内の引用数ランキング (既定): 左ほど高被引用" },
  citation_log: { icon: "📈", label: "log", title: "log(引用数+1) — 連続軸で影響度を比較" },
  genealogy: {
    icon: "🌳",
    label: "系譜",
    title: "親論文の平均 X 位置に寄せる: 同じ研究ラインが縦に並ぶ",
  },
  centrality: { icon: "⭐", label: "中心", title: "PageRank: テーマのハブ論文ほど左に" },
  venue: { icon: "🏛", label: "会議", title: "会議格 Tier1 → Tier2 → Tier3 → 未査読" },
  novelty: {
    icon: "💥",
    label: "新規",
    title: "新規性: supersedes/contrasts = 破壊的革新、extends/successor = 漸進的改良",
  },
};

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

const RELATION_LABEL_JA: Record<string, string> = {
  supersedes: "置換",
  successor: "後継",
  extends: "拡張",
  ablation: "分析",
  baseline_only: "比較",
  contrasts: "対立",
};

const ARXIV_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;
const DOI_RE = /^10\.\d{4,9}\/[A-Za-z0-9._;()/:-]+$/;

/** arXiv > DOI > Semantic Scholar fallback -- both regexes are strict
 * shape checks so the id is well-formed before encodeURIComponent. */
function resolvePaperLink(node: LineageNode): { url: string; label: string } {
  if (typeof node.arxiv_id === "string" && ARXIV_RE.test(node.arxiv_id)) {
    return { url: `https://arxiv.org/abs/${encodeURIComponent(node.arxiv_id)}`, label: "arXiv" };
  }
  if (typeof node.doi === "string" && DOI_RE.test(node.doi)) {
    return { url: `https://doi.org/${encodeURIComponent(node.doi)}`, label: "DOI" };
  }
  return {
    url: `https://www.semanticscholar.org/paper/${encodeURIComponent(node.id)}`,
    label: "Semantic Scholar",
  };
}

function edgeKey(e: LineageEdge): string {
  return `${e.src}\u0000${e.dst}\u0000${e.relation}`;
}

function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return (el as HTMLElement).isContentEditable === true;
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

export function LineageTree({
  artifact,
  slug,
}: {
  artifact: LineageArtifact;
  slug?: string | null;
}) {
  const [mode, setMode] = useState<XAxisMode>(DEFAULT_X_AXIS_MODE);

  // ---- Filters (search / year range / relation chips) -----------------
  const [searchQuery, setSearchQuery] = useState("");
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
  const [yearRange, setYearRange] = useState<{ min: number; max: number } | null>(dataYearExtents);
  const [visibleRelations, setVisibleRelations] = useState<Set<Relation>>(
    () => new Set(DEFAULT_RELATIONS),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Hide orphan papers (no incident edge) by default -- ported from
  // docs/assets/theme.js's state.hideOrphans. hubSet/orphanSet are
  // computed once against the FULL node+edge set (never the relation-
  // filtered visibleEdges) so toggling relation chips or the orphan
  // toggle itself never reshuffles which papers count as hub/orphan.
  const [hideOrphans, setHideOrphans] = useState(true);
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
      label: `🔗 関係: ${[...visibleRelations].sort().join(", ") || "なし"}`,
    });
  }
  if (effectiveHideOrphans) {
    activeFilterChips.push({
      kind: "orphan",
      label: `🔗 孤立論文 ${orphanSet.size} 件を非表示`,
    });
  }

  // ---- Keyboard-help + onboarding ---------------------------------------
  const [kbdHelpOpen, setKbdHelpOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(ONBOARDING_KEY) === "1";
    } catch {
      dismissed = false;
    }
    setOnboardingDismissed(dismissed);
  }, []);
  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    try {
      localStorage.setItem(ONBOARDING_KEY, "1");
    } catch {
      /* ignore -- private mode / blocked storage: just stop pestering this session */
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
        if (onboardingDismissed === false) {
          dismissOnboarding();
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
          dismissOnboarding();
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
        setKbdHelpOpen(true);
        e.preventDefault();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [kbdHelpOpen, onboardingDismissed, dismissOnboarding]);

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
    () => artifact.edges.filter((e) => visibleRelations.has(e.relation as Relation)),
    [artifact.edges, visibleRelations],
  );

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

  const sparse = isSparseLineage(artifact.nodes.length, artifact.edges.length);

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

  useEffect(() => {
    function onUp() {
      draggingRef.current = false;
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    const canvas = minimapCanvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function paint() {
      const needs = totalW > container!.clientWidth + 40 || totalH > container!.clientHeight + 40;
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
      const vx = ox + container!.scrollLeft * s;
      const vy = oy + container!.scrollTop * s;
      const vw = container!.clientWidth * s;
      const vh = container!.clientHeight * s;
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
  }, [positioned, totalW, totalH]);

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
    const targetX = (px - ox) / s - container.clientWidth / 2;
    const targetY = (py - oy) / s - container.clientHeight / 2;
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

  const svgW = Math.max(totalW, 320);
  const svgH = Math.max(totalH, 200);

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0">
          <legend className="text-xs text-ink-subtle">📐 横軸 (X-axis encoding)</legend>
          {X_AXIS_MODES.map((m) => (
            <button
              key={m}
              type="button"
              title={X_AXIS_BUTTON[m].title}
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m);
                dismissOnboarding();
              }}
              className={`rounded-md border px-2 py-1 text-xs ${
                mode === m
                  ? "border-accent bg-accent/10 text-accent-strong"
                  : "border-rule text-ink-muted hover:border-rule-strong"
              }`}
            >
              {X_AXIS_BUTTON[m].icon} {X_AXIS_BUTTON[m].label}
            </button>
          ))}
        </fieldset>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="theme-filters-panel"
            onClick={() => setFiltersOpen((v) => !v)}
            title="検索 / 年範囲 / 関係フィルタを開く"
            className="rounded-md border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong"
          >
            🔍 絞り込み
            {activeFilterChips.length > 0 && (
              <span className="ml-1 rounded-full bg-accent/10 px-1.5 text-accent-strong">
                {activeFilterChips.length}
              </span>
            )}
          </button>
          <fieldset className="flex items-center gap-1 border-0 p-0">
            <legend className="sr-only">Export</legend>
            <button
              type="button"
              title="SVG をダウンロード"
              onClick={handleExportSvg}
              className="rounded-md border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong"
            >
              📥 SVG
            </button>
            <button
              type="button"
              title="PNG をダウンロード"
              onClick={handleExportPng}
              className="rounded-md border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong"
            >
              📥 PNG
            </button>
          </fieldset>
        </div>
      </div>

      <div
        id="theme-filters-panel"
        className={
          filtersOpen
            ? "mt-3 flex flex-wrap items-center gap-4 rounded-md border border-rule bg-surface p-3"
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
            aria-label="Search papers by title or author"
            autoComplete="off"
            className="rounded-md border border-rule px-2 py-1 text-xs"
          />
        </label>

        {dataYearExtents && yearRange && (
          <fieldset className="flex items-center gap-1 border-0 p-0 text-xs text-ink-muted">
            <legend className="sr-only">Year range filter</legend>
            <span aria-hidden="true">📅</span>
            <span>{yearRange.min}</span>
            <input
              type="range"
              min={dataYearExtents.min}
              max={dataYearExtents.max}
              value={yearRange.min}
              aria-label="Minimum year"
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
              aria-label="Maximum year"
              onChange={(e) => {
                const hi = Math.max(Number(e.target.value), yearRange.min);
                setYearRange({ min: yearRange.min, max: hi });
              }}
            />
            <span>{yearRange.max}</span>
          </fieldset>
        )}

        <fieldset className="flex flex-wrap gap-1 border-0 p-0">
          <legend className="sr-only">Relation filter</legend>
          {ALL_RELATIONS.map((r) => {
            const on = visibleRelations.has(r);
            const count = artifact.edges.filter((e) => e.relation === r).length;
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                onClick={() => toggleRelation(r)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  on
                    ? "border-accent text-accent-strong"
                    : "border-rule text-ink-muted hover:border-rule-strong"
                }`}
              >
                {RELATION_LABEL_JA[r] ?? r} <span className="text-ink-subtle">{count}</span>
              </button>
            );
          })}
        </fieldset>

        {/* Orphan toggle: hide papers with no edge in the lineage. Always
            rendered (even at 0 orphans) so the feature stays discoverable;
            it disables itself instead of vanishing. */}
        <label
          title="孤立論文 = 他の論文との分類関係が見つからず、家系図のどのエッジにも乗らなかった論文"
          className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs text-ink-muted ${
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
          <span aria-hidden="true">🔗</span>
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
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1"
            >
              {c.label}
              <button
                type="button"
                aria-label="この絞り込みを解除"
                title="この絞り込みを解除"
                onClick={() => clearFilter(c.kind)}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" onClick={clearAllFilters} className="text-accent underline">
            すべて解除
          </button>
        </div>
      )}

      {sparse && (
        <p
          role="status"
          className="mt-2 rounded-md border border-rule bg-surface-2 px-3 py-2 text-xs text-ink-muted"
        >
          🌱 このテーマは家系図がまだ薄いです ({artifact.nodes.length} 件 / {artifact.edges.length}{" "}
          edges)。引用グラフが熟成すると毎週日曜の再生成で密になります。
        </p>
      )}

      {onboardingDismissed === false && (
        <div
          role="dialog"
          aria-labelledby="theme-onboarding-title"
          className="mt-2 inline-flex max-w-sm flex-col items-start gap-1 rounded-md border border-accent bg-surface-elevated p-3"
        >
          <span className={styles.onboardingArrow} aria-hidden="true" />
          <strong id="theme-onboarding-title" className="text-sm text-ink">
            📐 横軸を切り替えてみよう
          </strong>
          <p className="text-xs text-ink-muted">
            論文の並び方が変わります。
            <br />
            <em>順位 / log / 系譜 / 中心 / 会議 / 新規</em> の 6 種類。
          </p>
          <button
            type="button"
            onClick={dismissOnboarding}
            className="self-end rounded-md border border-rule px-2 py-1 text-xs text-ink-muted"
          >
            わかった ✓
          </button>
        </div>
      )}

      <div className="relative mt-3">
        <div
          ref={scrollRef}
          className="max-h-[70vh] overflow-auto rounded-md border border-rule bg-surface"
        >
          <svg
            ref={svgRef}
            role="img"
            aria-label="Theme chronological lineage graph"
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
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

            {visibleEdges
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
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: mirrors hover/focus bubbling from the focusable hit-area <line> below (tabIndex + aria-label) to show the tooltip; no WAI-ARIA role Biome suggests (group/fieldset) applies to a non-form SVG grouping element.
                  <g
                    key={key}
                    onMouseEnter={() => setHoveredEdgeKey(key)}
                    onMouseLeave={() =>
                      setHoveredEdgeKey((current) => (current === key ? null : current))
                    }
                    onFocus={() => setHoveredEdgeKey(key)}
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
                      strokeWidth={Math.max(1, e.confidence * 2)}
                      strokeOpacity={0.7}
                    />
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      className={styles.edgeHit}
                      tabIndex={0}
                      aria-label={`${RELATION_LABEL_JA[e.relation] ?? e.relation}: ${e.rationale}`}
                    />
                  </g>
                );
              })}

            {positioned.map((p) => {
              const link = resolvePaperLink(p);
              const authors = (p.authors ?? []).slice(0, 3).join(", ");
              const extra = (p.authors ?? []).length > 3 ? ` +${(p.authors ?? []).length - 3}` : "";
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
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: same rationale as the edge <g> above -- mirrors hover/focus bubbling from the focusable card <a> inside the foreignObject to show the popover.
                <g
                  key={p.id}
                  data-node-id={p.id}
                  onMouseEnter={() => scheduleShowPopover(p.id)}
                  onMouseLeave={hidePopover}
                  onFocus={() => scheduleShowPopover(p.id)}
                  onBlur={hidePopover}
                >
                  <foreignObject
                    x={p._x}
                    y={p._y}
                    width={NODE_W}
                    height={NODE_H}
                    overflow="visible"
                  >
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`クリックで ${link.label} に開く`}
                      aria-label={`論文を新しいタブで開く: ${link.label} — ${p.title ?? p.id}`}
                      className={`block h-full w-full overflow-hidden rounded-md border px-3 py-2 text-xs ${
                        p.is_focus ? "border-accent bg-accent/5" : "border-rule bg-surface-elevated"
                      } ${accentClass ?? ""} ${filteredClass} ${shadowClass ?? ""} ${orphanClass}`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="min-w-0 truncate text-[0.68rem] text-ink-subtle">
                          {p.venue || "—"}
                        </span>
                        {isHub && (
                          <span
                            role="img"
                            aria-label="ハブ論文: 接続数が多い"
                            title="hub paper: high connectivity"
                            className={`${styles.badge} ${styles.badgeHub}`}
                          >
                            HUB
                          </span>
                        )}
                        {isTrending && (
                          <span
                            role="img"
                            aria-label="注目: 引用が伸びている"
                            title="citation velocity: trending"
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
                      </div>
                      <div className="mt-1 line-clamp-2 font-medium text-ink">
                        {p.title || p.id}
                      </div>
                      {p.tldr && <div className="mt-1 line-clamp-2 text-ink-muted">{p.tldr}</div>}
                      <div className="mt-1 truncate text-ink-subtle">
                        {authors}
                        {extra}
                      </div>
                      {typeof p.citation_count === "number" && p.citation_count > 0 && (
                        <div className="mt-1 text-ink-subtle">
                          📖 {p.citation_count.toLocaleString()}
                        </div>
                      )}
                    </a>
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
                      role="dialog"
                      aria-label={`${p.title ?? p.id} の詳細`}
                      className={`${styles.popoverPanel} ${styles.popoverVisible} w-full rounded-md border border-rule bg-surface-elevated p-3 text-xs`}
                    >
                      <div className="text-[0.68rem] text-ink-subtle">
                        {formatVenue(p.venue, p.year) || "—"}
                      </div>
                      <h3 className="mt-1 font-medium text-ink">{p.title || p.id}</h3>
                      {p.tldr && <p className="mt-1 text-ink-muted">{p.tldr}</p>}
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
                      <div className="font-medium text-ink">
                        {RELATION_LABEL_JA[e.relation] ?? e.relation}
                      </div>
                      <div className="mt-1 line-clamp-3 text-ink-muted">{e.rationale}</div>
                      <div className="mt-1 text-ink-subtle">
                        confidence {e.confidence.toFixed(2)}
                      </div>
                    </div>
                  </foreignObject>
                );
              })()}
          </svg>
        </div>

        {minimapVisible && (
          <div
            role="img"
            aria-label="Graph minimap"
            className="pointer-events-none absolute bottom-2 right-2 rounded-md border border-rule bg-surface-elevated p-1 shadow"
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
                  <td>📊 順位</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">2</td>
                  <td>📈 log</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">3</td>
                  <td>🌳 系譜</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">4</td>
                  <td>⭐ 中心</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">5</td>
                  <td>🏛 会議</td>
                </tr>
                <tr>
                  <td className="pr-2 font-mono text-ink">6</td>
                  <td>💥 新規</td>
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
                  <td className="pr-2 font-mono text-ink">Esc</td>
                  <td>閉じる / 解除</td>
                </tr>
              </tbody>
            </table>
            <button
              type="button"
              onClick={() => setKbdHelpOpen(false)}
              className="mt-3 w-full rounded-md border border-rule px-2 py-1 text-xs text-ink-muted"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
