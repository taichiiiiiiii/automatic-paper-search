"use client";

/**
 * One paper card inside the SVG graph canvas (tree/timeline). Ported
 * from docs/assets/lineage.js `drawSvg`'s per-node `<foreignObject>` +
 * `.node-card` markup, as a real `<button>` (not a `div[role=button]`
 * -- the original's stated reason for the div, "nested anchors make
 * button semantics awkward", does not apply here: this card has no
 * nested links) so Tab/Enter/Space work via native semantics instead
 * of hand-rolled keydown handling.
 *
 * `height` is the foreignObject's viewport (static NODE_H until the
 * first post-font-load measurement, then the card's actual measured
 * height -- see lineage-graph-app.tsx's measuring effect), but the
 * `<button>` itself is NOT forced to that height: like the original's
 * `.node-card` (no fixed `height` in docs/assets/style.css), its box
 * is sized by its own content (title/TLDR wrap, author count), which
 * is exactly what makes measuring it meaningful. The foreignObject's
 * `overflow="visible"` lets that natural height render even before
 * the first measurement corrects the viewport to match.
 *
 * `variant="deep"` (default: unset, i.e. the conference lineage card)
 * switches the card body to match docs/assets/deep.js `drawSvg`'s
 * `.node-card--deep` markup instead of lineage.js's: up to 3 authors
 * (not 2) with a `+N` suffix, no `kinds` chips, no "📈 trending" badge,
 * and a `📖 <citation_count>` meta span alongside the star count --
 * deep's larger 240×180 cards show more metadata per card than the
 * conference tree/timeline's 220×150 ones. Additive: every existing
 * caller omits `variant`, so the conference lineage viewer's cards are
 * byte-identical to before this prop existed.
 */
import { forwardRef } from "react";
import type { LineageNode } from "../../../lib/lineage/core";
import { formatStars, formatVenue } from "../../../lib/lineage/layout/format";

const TIER_BADGE_CLASS: Record<"aplus" | "a" | "preprint", string> = {
  aplus: "bg-accent text-paper",
  a: "bg-ink text-paper",
  preprint: "bg-surface-2 text-ink-subtle",
};

function venueTierKey(tier: unknown): "aplus" | "a" | "preprint" {
  if (tier === "A+") return "aplus";
  if (tier === "A") return "a";
  return "preprint";
}

export interface NodeCardProps {
  node: LineageNode & { _x: number; _y: number };
  width: number;
  height: number;
  isFocus: boolean;
  onSelect: (id: string) => void;
  onHoverChange?: (id: string, hovered: boolean) => void;
  /** See this file's header. Omit for the conference lineage card. */
  variant?: "deep";
}

export const NodeCard = forwardRef<HTMLButtonElement, NodeCardProps>(function NodeCard(
  { node, width, height, isFocus, onSelect, onHoverChange, variant },
  ref,
) {
  const isDeep = variant === "deep";
  const authorsList = Array.isArray(node.authors) ? node.authors : [];
  const authorSlice = isDeep ? 3 : 2;
  const authors =
    authorsList.slice(0, authorSlice).join(", ") +
    (authorsList.length > authorSlice ? ` +${authorsList.length - authorSlice}` : "");
  const kinds = isDeep ? [] : Array.isArray(node.kinds) ? (node.kinds as unknown[]) : [];
  const stars = formatStars(node.github_stars);
  const citationCount =
    isDeep && typeof node.citation_count === "number" && node.citation_count > 0
      ? node.citation_count.toLocaleString()
      : null;
  const venue = formatVenue(node.venue, node.year);
  const tier = venueTierKey(node.venue_tier);
  const isTrending = !isDeep && node.is_trending === true;

  return (
    <foreignObject x={node._x} y={node._y} width={width} height={height} overflow="visible">
      <button
        ref={ref}
        type="button"
        data-node-id={node.id}
        aria-label={`論文を選択: ${typeof node.title === "string" && node.title ? node.title : node.id}`}
        aria-pressed={isFocus}
        onClick={() => onSelect(node.id)}
        onMouseEnter={() => onHoverChange?.(node.id, true)}
        onMouseLeave={() => onHoverChange?.(node.id, false)}
        onFocus={() => onHoverChange?.(node.id, true)}
        onBlur={() => onHoverChange?.(node.id, false)}
        className={`flex w-full flex-col gap-1 overflow-hidden rounded-md border bg-surface-elevated px-3 py-2 text-left text-xs shadow-sm transition ${
          isFocus ? "border-accent ring-2 ring-accent" : "border-rule hover:border-rule-strong"
        }`}
      >
        <div className="flex items-center justify-between gap-1">
          <span
            className={`rounded px-1.5 py-0.5 text-[0.65rem] font-semibold ${TIER_BADGE_CLASS[tier]}`}
          >
            {venue || "—"}
          </span>
          {isTrending && (
            <span className="whitespace-nowrap text-[0.65rem] text-accent-strong">📈 trending</span>
          )}
        </div>
        <h3 className="line-clamp-2 font-serif text-sm font-semibold text-ink">
          {typeof node.title === "string" ? node.title : node.id}
        </h3>
        {authors && <div className="truncate text-[0.68rem] text-ink-subtle">{authors}</div>}
        {typeof node.tldr === "string" && node.tldr && (
          <p className="line-clamp-2 text-[0.68rem] text-ink-muted">{node.tldr}</p>
        )}
        {(kinds.length > 0 || stars || citationCount) && (
          <div className="mt-auto flex flex-wrap items-center gap-1 text-[0.62rem] text-ink-subtle">
            {kinds.map((k) => (
              <span key={String(k)} className="rounded bg-surface-2 px-1 py-0.5">
                {String(k)}
              </span>
            ))}
            {citationCount && <span>📖 {citationCount}</span>}
            {stars && <span>⭐{stars}</span>}
          </div>
        )}
      </button>
    </foreignObject>
  );
});
