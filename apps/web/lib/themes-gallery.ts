/**
 * Ported pure gallery/picker logic from docs/assets/theme.js: quality-
 * tier badge classification, the gallery's sort order, and the
 * "pick the most impressive theme for a first-time visitor" default
 * slug. All pure functions over already-fetched data -- the fetch
 * helpers themselves live in lib/data-themes.ts.
 */

import { type PublishedTier, publishedTierRank, qualityRowPublishedTier } from "./lineage/core";
import type { QualityManifest } from "./themes-quality";
import { resolveQualityCollection } from "./themes-quality";
import { SLUG_RE } from "./themes-slug";

export interface ThemeManifestEntry {
  slug: string;
  theme?: string;
  generated_at?: string | null;
  paper_count?: number;
  year_range?: [number, number];
  /** Set by `eligibleThemeManifest` from the quality row (design doc 41
   * D1); never read from the raw themes-manifest.json. */
  publication_tier?: PublishedTier;
  [key: string]: unknown;
}

/** One entry of the optional `_quality.json` badge telemetry rollup.
 * Missing/malformed entries degrade silently (no badge) -- this is
 * telemetry only, never a publication gate (that's `lineage-quality-v1.json`
 * via themes-quality.ts). */
export interface ThemeQualityEntry {
  theme?: string;
  node_count?: number;
  focus_count?: number;
  off_topic_focus?: number;
  edge_count?: number;
  template_count?: number;
  template_ratio?: number;
  popularity_sinks?: number;
  year_reversals?: number;
  [key: string]: unknown;
}

export type ThemeQualityRollup = Record<string, ThemeQualityEntry | undefined>;

export type QualityTierName = "high" | "mixed" | "generic" | "unknown";

export interface QualityTier {
  rank: number;
  icon: string;
  label: string;
  desc: string;
}

/** Lower template_ratio = more paper-specific classification rationale
 * = higher tier. "unknown" (no _quality.json entry yet) sorts last. */
export const QUALITY_TIERS: Record<QualityTierName, QualityTier> = {
  high: { rank: 0, icon: "🟢", label: "高品質", desc: "論文ごとに特化した分類根拠が中心" },
  mixed: { rank: 1, icon: "🟡", label: "混在", desc: "特化根拠と汎用テンプレートが半々" },
  generic: {
    rank: 2,
    icon: "🔴",
    label: "汎用",
    desc: "テンプレート根拠が中心。再生成で改善見込み",
  },
  unknown: { rank: 3, icon: "", label: "", desc: "" },
};

export function qualityTierFor(quality: ThemeQualityEntry | null | undefined): QualityTierName {
  if (!quality || typeof quality.template_ratio !== "number") return "unknown";
  if (quality.template_ratio < 0.3) return "high";
  if (quality.template_ratio < 0.7) return "mixed";
  return "generic";
}

/**
 * Only strict quality-manifest rows with a published tier (audited, or
 * unaudited = every automatic check passed; design doc 41 D1) may enter
 * the picker/gallery or become a default selection (SCR-32). Each
 * returned entry carries that tier in `publication_tier`. The legacy
 * `themes-manifest.json` and `_quality.json` are discovery/telemetry
 * inputs, never publication gates -- this is the ONLY function that
 * decides what the user-facing gallery/picker shows.
 */
export function eligibleThemeManifest(
  manifest: unknown,
  quality: QualityManifest | null,
): ThemeManifestEntry[] {
  if (!Array.isArray(manifest) || !quality) return [];
  const eligible: ThemeManifestEntry[] = [];
  for (const entry of manifest as unknown[]) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { slug?: unknown }).slug !== "string" ||
      !SLUG_RE.test((entry as { slug: string }).slug)
    ) {
      continue;
    }
    const row = resolveQualityCollection(quality, {
      kind: "theme",
      slug: (entry as { slug: string }).slug,
    });
    const tier = qualityRowPublishedTier(row);
    if (tier === null) continue;
    eligible.push({ ...(entry as ThemeManifestEntry), publication_tier: tier });
  }
  return eligible;
}

function publicationRank(entry: ThemeManifestEntry): number {
  return publishedTierRank(entry.publication_tier ?? null);
}

/** Sort order shared by the gallery render and `pickDefaultSlug`: the
 * currently-selected theme (if any) pinned first, then audited before
 * unaudited (design doc 41 D1), then quality tier
 * (high -> mixed -> generic -> unknown), then freshest `generated_at`
 * first. Returns a new array; never mutates its input. */
export function sortGalleryManifest(
  manifest: ThemeManifestEntry[],
  qualityRollup: ThemeQualityRollup,
  currentSlug: string | null,
): ThemeManifestEntry[] {
  return [...manifest].sort((a, b) => {
    if (a.slug === currentSlug) return -1;
    if (b.slug === currentSlug) return 1;
    const pubA = publicationRank(a);
    const pubB = publicationRank(b);
    if (pubA !== pubB) return pubA - pubB;
    const tierA = QUALITY_TIERS[qualityTierFor(qualityRollup[a.slug])].rank;
    const tierB = QUALITY_TIERS[qualityTierFor(qualityRollup[b.slug])].rank;
    if (tierA !== tierB) return tierA - tierB;
    const tA = Date.parse(a.generated_at || "") || 0;
    const tB = Date.parse(b.generated_at || "") || 0;
    return tB - tA;
  });
}

/** Default landing slug when the URL has no `?theme=` or the requested
 * slug isn't eligible: the theme most likely to look impressive on a
 * first visit (audited first, then highest quality tier, then freshest). `manifest` must
 * already be the eligible subset (see `eligibleThemeManifest`). */
export function pickDefaultSlug(
  manifest: ThemeManifestEntry[],
  qualityRollup: ThemeQualityRollup,
): string | null {
  if (manifest.length === 0) return null;
  const ranked = manifest
    .filter((e) => typeof e.slug === "string" && SLUG_RE.test(e.slug))
    .filter((e) => (e.paper_count || 0) > 0)
    .sort((a, b) => {
      const pubA = publicationRank(a);
      const pubB = publicationRank(b);
      if (pubA !== pubB) return pubA - pubB;
      const tierA = QUALITY_TIERS[qualityTierFor(qualityRollup[a.slug])].rank;
      const tierB = QUALITY_TIERS[qualityTierFor(qualityRollup[b.slug])].rank;
      if (tierA !== tierB) return tierA - tierB;
      const tA = Date.parse(a.generated_at || "") || 0;
      const tB = Date.parse(b.generated_at || "") || 0;
      return tB - tA;
    });
  return ranked[0]?.slug ?? manifest[0]?.slug ?? null;
}

/**
 * SCR-36: a manifest/artifact-derived `paper_count` is untrusted data
 * (it comes from `themes-manifest.json`, generated but not strictly
 * schema-checked). A malicious or malformed value (a markup string, a
 * negative number, a float) must never reach the display as anything
 * other than `0` — never splice the raw value into markup.
 */
export function safeDisplayCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

/** Relative "N days ago" age hint. Empty string on a missing/invalid
 * timestamp (never renders a bogus age). */
export function formatThemeAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.max(0, Math.floor((now - t) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
