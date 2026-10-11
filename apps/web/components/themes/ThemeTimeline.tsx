"use client";

/**
 * Year × citation-count view of a theme lineage — design doc 48 P1-5
 * (I7). One dot per paper (x = year, y = log citations), the lineage
 * edges as thin lines, the main path and the selected path drawn
 * thicker. Clicking a dot selects the paper for the Prior / Derivative
 * panel. Plain SVG with attribute positioning only (no inline styles,
 * no chart library).
 */
import { forwardRef, useMemo } from "react";
import { layoutYearCitationTimeline } from "../../lib/lineage/theme-timeline";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";
import { edgeKey, relationLabelJa } from "./EdgeEvidence";

const RELATION_STROKE_CLASS: Record<string, string> = {
  supersedes: "stroke-[var(--rel-supersedes)]",
  successor: "stroke-[var(--rel-successor)]",
  extends: "stroke-[var(--rel-extends)]",
  ablation: "stroke-[var(--rel-ablation)]",
  baseline_only: "stroke-[var(--rel-baseline)]",
  contrasts: "stroke-[var(--rel-contrasts)]",
};
const DEFAULT_STROKE_CLASS = "stroke-[var(--rel-baseline)]";

function shortTitle(n: LineageNode): string {
  const t = typeof n.title === "string" && n.title ? n.title : n.id;
  return t.length > 28 ? `${t.slice(0, 27)}…` : t;
}

export const ThemeTimeline = forwardRef<
  SVGSVGElement,
  {
    nodes: readonly LineageNode[];
    edges: readonly LineageEdge[];
    selectedId: string | null;
    onSelectPaper: (id: string) => void;
    mainPathKeys: ReadonlySet<string> | null;
    mainPathNodeIds: ReadonlySet<string> | null;
    pathKeys: ReadonlySet<string>;
    pathNodeIds: ReadonlySet<string>;
    matchSet: ReadonlySet<string> | null;
  }
>(function ThemeTimeline(
  {
    nodes,
    edges,
    selectedId,
    onSelectPaper,
    mainPathKeys,
    mainPathNodeIds,
    pathKeys,
    pathNodeIds,
    matchSet,
  },
  ref,
) {
  const layout = useMemo(() => layoutYearCitationTimeline(nodes, { minWidth: 640 }), [nodes]);
  const pointById = useMemo(() => new Map(layout.points.map((p) => [p.id, p])), [layout]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const { plot } = layout;

  // Background edges first, then main path, then the selected path.
  const drawn = useMemo(() => {
    const rank = (e: LineageEdge): number => {
      const k = edgeKey(e);
      if (pathKeys.has(k)) return 2;
      if (mainPathKeys?.has(k)) return 1;
      return 0;
    };
    return edges
      .filter((e) => pointById.has(e.src) && pointById.has(e.dst))
      .sort((a, b) => rank(a) - rank(b));
  }, [edges, pointById, mainPathKeys, pathKeys]);

  return (
    <div className="mt-3 max-h-[70vh] overflow-auto rounded-md border border-rule bg-surface">
      <svg
        ref={ref}
        role="img"
        aria-label="年（横）と被引用数（縦、対数）で並べた論文の分布"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        data-theme-timeline
      >
        {layout.yTicks.map((t) => (
          <g key={`y${t.value}`}>
            <line
              x1={plot.left}
              x2={plot.right}
              y1={t.pos}
              y2={t.pos}
              className="stroke-rule"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text
              x={plot.left - 6}
              y={t.pos + 4}
              textAnchor="end"
              className="fill-ink-subtle text-[10px]"
            >
              {t.label}
            </text>
          </g>
        ))}
        {layout.xTicks.map((t) => (
          <text
            key={`x${t.value}`}
            x={t.pos}
            y={plot.bottom + 18}
            textAnchor="middle"
            className="fill-ink-subtle text-[10px]"
          >
            {t.label}
          </text>
        ))}
        <line
          x1={plot.left}
          x2={plot.right}
          y1={plot.bottom}
          y2={plot.bottom}
          className="stroke-rule-strong"
          strokeWidth={1}
        />
        <line
          x1={plot.left}
          x2={plot.left}
          y1={plot.top}
          y2={plot.bottom}
          className="stroke-rule-strong"
          strokeWidth={1}
        />
        <text x={plot.left} y={plot.top - 4} className="fill-ink-subtle text-[10px]">
          被引用数
        </text>
        <text
          x={plot.right}
          y={layout.height - 4}
          textAnchor="end"
          className="fill-ink-subtle text-[10px]"
        >
          年
        </text>

        {drawn.map((e) => {
          const a = pointById.get(e.src);
          const b = pointById.get(e.dst);
          if (!a || !b) return null;
          const k = edgeKey(e);
          const onPath = pathKeys.has(k);
          const onMain = mainPathKeys?.has(k) ?? false;
          return (
            <line
              key={k}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={RELATION_STROKE_CLASS[e.relation] ?? DEFAULT_STROKE_CLASS}
              strokeWidth={onPath ? 4 : onMain ? 3 : 1}
              strokeOpacity={onPath || onMain ? 1 : 0.35}
              strokeLinecap="round"
              data-timeline-path={onPath ? "1" : undefined}
            >
              <title>{`${relationLabelJa(e.relation)}: ${e.rationale}`}</title>
            </line>
          );
        })}

        {layout.points.map((p) => {
          const n = nodeById.get(p.id);
          if (!n) return null;
          const selected = p.id === selectedId;
          const onMain = mainPathNodeIds?.has(p.id) ?? false;
          const onPath = pathNodeIds.has(p.id);
          const dim = matchSet !== null && !matchSet.has(p.id);
          const r = selected ? 8 : onMain || onPath ? 6 : 4.5;
          // Only the selected paper and the selected path get a text label;
          // labelling the whole main path overlaps on dense themes.
          const label = selected || onPath;
          return (
            <g key={p.id} data-timeline-node={p.id} opacity={dim ? 0.3 : 1}>
              {/* Invisible 28 px tap area around the small dot (touch). The
                  focusable circle below carries the keyboard handling. */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only enlargement of the dot below, which is the focusable control with Enter/Space handling. */}
              <circle
                cx={p.x}
                cy={p.y}
                r={14}
                className="cursor-pointer fill-transparent"
                onClick={() => onSelectPaper(p.id)}
              />
              {/* biome-ignore lint/a11y/useSemanticElements: an SVG <circle> cannot be an HTML <button>; role="button" + tabIndex + Enter/Space give it button semantics inside the chart. */}
              <circle
                cx={p.x}
                cy={p.y}
                r={r}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${p.year} 年・被引用 ${p.citations.toLocaleString()}: ${
                  n.title ?? n.id
                }（選ぶと土台と発展を表示）`}
                className={`cursor-pointer ${
                  selected
                    ? "fill-accent stroke-ink"
                    : onMain || onPath
                      ? "fill-accent stroke-surface"
                      : "fill-ink-subtle stroke-surface"
                }`}
                strokeWidth={selected ? 2 : 1}
                onClick={() => onSelectPaper(p.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelectPaper(p.id);
                  }
                }}
              >
                <title>{`${n.title ?? n.id}（${p.year}・被引用 ${p.citations.toLocaleString()}）`}</title>
              </circle>
              {label && (
                <text
                  x={p.x + r + 3}
                  y={p.y + 3}
                  className={`pointer-events-none text-[10px] ${
                    selected ? "fill-ink font-semibold" : "fill-ink-muted"
                  }`}
                >
                  {shortTitle(n)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {layout.missingYear > 0 && (
        <p className="px-3 pb-2 text-xs text-ink-subtle">
          出版年のない論文 {layout.missingYear} 本は表示していません。
        </p>
      )}
    </div>
  );
});
