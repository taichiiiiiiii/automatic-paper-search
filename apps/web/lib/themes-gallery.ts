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
// R2 UX P1-3: this is template_ratio telemetry (how many rationales are
// paper-specific), NOT a quality verdict -- the old "🟢 高品質" label sat
// under the 未監査 badge and read as an endorsement. Labels describe the
// rationale style only, and the gallery shows them for audited themes only.
export const QUALITY_TIERS: Record<QualityTierName, QualityTier> = {
  high: { rank: 0, icon: "", label: "根拠: 論文ごと", desc: "論文ごとに書かれた根拠が中心" },
  mixed: { rank: 1, icon: "", label: "根拠: 一部定型", desc: "論文ごとの根拠と定型文が半々" },
  generic: {
    rank: 2,
    icon: "",
    label: "根拠: 定型が中心",
    desc: "定型文の根拠が中心。作り直しで改善する見込み",
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

/** Number of relations in a theme for default-picking: the
 * `_quality.json` rollup's `edge_count` (telemetry, safe-integer only),
 * else 0. */
export function themeEdgeCount(qualityRollup: ThemeQualityRollup, slug: string): number {
  const n = qualityRollup[slug]?.edge_count;
  return Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : 0;
}

/** Default landing slug when the URL has no `?theme=` or the requested
 * slug isn't eligible (R2 UX P1-7): an audited theme first; otherwise
 * the theme with the most relations (the richest graph -- the old
 * "freshest high-tier" rule opened a 4-paper theme), then freshest.
 * `manifest` must already be the eligible subset (see
 * `eligibleThemeManifest`). */
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
      const edgesA = themeEdgeCount(qualityRollup, a.slug);
      const edgesB = themeEdgeCount(qualityRollup, b.slug);
      if (edgesA !== edgesB) return edgesB - edgesA;
      const papersA = safeDisplayCount(a.paper_count);
      const papersB = safeDisplayCount(b.paper_count);
      if (papersA !== papersB) return papersB - papersA;
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

/** Relative age hint in Japanese ("今日" / "3 日前" / "2 か月前" /
 * "1 年前"). Empty string on a missing/invalid timestamp (never renders
 * a bogus age). */
export function formatThemeAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.max(0, Math.floor((now - t) / 86_400_000));
  if (days === 0) return "今日";
  if (days < 30) return `${days} 日前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} か月前`;
  return `${Math.floor(days / 365)} 年前`;
}
