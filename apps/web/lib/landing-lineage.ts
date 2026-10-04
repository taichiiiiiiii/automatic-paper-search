/**
 * Pure port of docs/assets/landing.js's audited-lineage shelf logic
 * (`#s0-lineages`, SCR-11, docs/migration/safety-contracts.md): which
 * quality rows may appear on the S0 shelf, their link target, and
 * their display text.
 *
 * Eligibility itself (`qualityRowIsEligible`) is NOT re-ported here --
 * it is imported from lib/lineage/core.ts, the single fail-closed
 * reader shared with every other lineage page (that file's header
 * comment explains why a second copy would be exactly the drift
 * SCR-23/SCR-45 exist to prevent). This module only adds the shelf's
 * own extra, defensive filtering on top (slug/label shape, node_count
 * > 0, and the conference-viewer allowlist), exactly as
 * docs/assets/landing.js does around its call to
 * `LineageCore.qualityRowIsEligible`.
 *
 * DOM wiring (the fetch, rendering the list) lives in
 * components/landing/landing.tsx. `test/landing/landing-lineage.test.ts`
 * covers this file.
 */
import { type QualityManifest, type QualityRow, qualityRowIsEligible } from "./lineage/core";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A passed audit is not enough to expose a conference lineage route:
 * only conferences that also ship a fail-closed `/<slug>/lineage/` page
 * may be linked from the shelf (docs/assets/landing.js's
 * `CONFERENCE_VIEWERS`). Themes have no such restriction -- every
 * theme row links into the `/themes/` picker, which exists for every
 * theme.
 */
export const CONFERENCE_LINEAGE_VIEWERS: ReadonlySet<string> = new Set(["eccv-2024", "iclr-2026"]);

function isShelfCandidate(row: QualityRow): boolean {
  return (
    (row.kind === "theme" || row.kind === "conference") &&
    typeof row.slug === "string" &&
    SLUG_RE.test(row.slug) &&
    typeof row.label === "string" &&
    row.label.length > 0 &&
    Number.isSafeInteger(row.node_count) &&
    row.node_count > 0 &&
    Number.isSafeInteger(row.edge_count) &&
    row.edge_count >= 0 &&
    (row.kind === "theme" || CONFERENCE_LINEAGE_VIEWERS.has(row.slug)) &&
    qualityRowIsEligible(row)
  );
}

/**
 * Rows the shelf may show, in manifest order (already sorted by
 * `collection_id` -- `parseQualityManifest` enforces that order and
 * rejects anything else). landing.js never re-sorts this list, so
 * neither does this port.
 */
export function selectLineageShelfRows(quality: QualityManifest | null): QualityRow[] {
  if (!quality || !Array.isArray(quality.collections)) return [];
  return quality.collections.filter(isShelfCandidate);
}

/**
 * Theme rows deep-link into the `/themes/` picker (query-string state,
 * ported separately by the themes page agent); conference rows go
 * straight to that conference's own `/lineage/` route. Both
 * percent-encode the slug, same rule as `conferenceHref` in
 * lib/landing.ts.
 */
export function lineageShelfHref(row: QualityRow): string {
  if (row.kind === "theme") {
    return `/themes/?theme=${encodeURIComponent(row.slug)}`;
  }
  return `/${encodeURIComponent(row.slug)}/lineage/`;
}

function lineageShelfKindLabel(row: QualityRow): string {
  return row.kind === "theme" ? "テーマ" : "学会";
}

export function lineageShelfMeta(row: QualityRow): string {
  return `${lineageShelfKindLabel(row)} · ${row.node_count} 論文 · ${row.edge_count} 関係`;
}

/** `null` when the row is fresh -- the caller renders nothing extra. */
export function lineageShelfStaleNote(row: QualityRow): string | null {
  if (row.freshness !== "stale") return null;
  const date = row.snapshot_date ?? row.generated_at ?? "日付不明";
  return `更新確認が必要 · ${String(date).slice(0, 10)}`;
}
