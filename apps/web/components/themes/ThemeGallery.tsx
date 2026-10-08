"use client";

/**
 * Horizontal theme-card gallery. Pure-props port of docs/assets/
 * theme.js's renderThemeGallery(); every dynamic field is rendered as
 * plain text (React's default escaping) rather than the original's
 * `innerHTML` + manual `escapeHtml()` calls.
 */
import Link from "next/link";
import type { ThemeManifestEntry, ThemeQualityRollup } from "../../lib/themes-gallery";
import {
  formatThemeAge,
  qualityTierFor,
  safeDisplayCount,
  sortGalleryManifest,
} from "../../lib/themes-gallery";

export function ThemeGallery({
  manifest,
  qualityRollup,
  currentSlug,
}: {
  manifest: ThemeManifestEntry[];
  qualityRollup: ThemeQualityRollup;
  currentSlug: string | null;
}) {
  if (manifest.length === 0) return null;
  const now = Date.now();
  // LOW fix: `paper_count` is manifest-derived, untrusted data (same
  // SCR-36 concern as themes-gallery.ts's `safeDisplayCount`, which
  // this file wasn't using) -- a malformed value (negative, float,
  // non-number) must never drive the "is this card worth showing"
  // filter or render as anything but a safe integer.
  const sorted = sortGalleryManifest(manifest, qualityRollup, currentSlug).filter(
    (e) => safeDisplayCount(e.paper_count) > 0 || e.slug === currentSlug,
  );

  return (
    <section
      className="theme-gallery -mx-4 flex gap-3 overflow-x-auto px-4 py-2 sm:-mx-6 sm:px-6"
      aria-label="テーマ一覧"
    >
      {sorted.map((entry) => {
        const tier = qualityTierFor(qualityRollup[entry.slug]);
        const q = qualityRollup[entry.slug];
        const isCurrent = entry.slug === currentSlug;
        const yearRange =
          Array.isArray(entry.year_range) && entry.year_range.length === 2
            ? `${entry.year_range[0]}–${entry.year_range[1]}`
            : "";
        const borderClass =
          tier === "high"
            ? "border-l-4 border-l-[var(--rel-extends)]"
            : tier === "mixed"
              ? "border-l-4 border-l-[var(--color-oral)]"
              : tier === "generic"
                ? "border-l-4 border-l-[var(--rel-contrasts)]"
                : "border-l-4 border-l-transparent";
        // LOW fix: `entry.theme` is manifest-derived and not strictly
        // schema-checked -- `entry.theme || entry.slug` rendered
        // whatever that value was verbatim, and React throws instead
        // of rendering a non-string/non-number child (an object, an
        // array). Only a non-empty string may stand in for the slug.
        const displayTheme =
          typeof entry.theme === "string" && entry.theme ? entry.theme : entry.slug;
        return (
          <Link
            key={entry.slug}
            href={{ pathname: "/themes/", query: { theme: entry.slug } }}
            aria-current={isCurrent ? "page" : undefined}
            title={displayTheme}
            className={`flex w-48 shrink-0 flex-col gap-1 rounded-md border border-rule bg-surface px-3 py-2 text-sm hover:border-rule-strong ${borderClass} ${
              isCurrent ? "ring-1 ring-accent" : ""
            }`}
          >
            <div className="truncate font-medium text-ink">{displayTheme}</div>
            <div className="text-xs text-ink-muted">
              {safeDisplayCount(entry.paper_count)} papers · {yearRange}
            </div>
            <div className="text-xs text-ink-subtle">{formatThemeAge(entry.generated_at, now)}</div>
            {tier !== "unknown" && q && typeof q.template_ratio === "number" && (
              <div
                className="text-xs text-ink-muted"
                title={`template_ratio=${Math.round(q.template_ratio * 100)}% · ${q.template_count ?? 0}/${q.edge_count ?? 0} edges`}
              >
                {tier === "high" ? "🟢 高品質" : tier === "mixed" ? "🟡 混在" : "🔴 汎用"}
              </div>
            )}
          </Link>
        );
      })}
    </section>
  );
}
