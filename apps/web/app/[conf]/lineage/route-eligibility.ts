/**
 * Pure helpers for `app/[conf]/lineage/layout.tsx`, kept in a plain .ts
 * module (not the .tsx layout itself) so they are unit-testable without
 * exercising JSX -- same separation as `app/[conf]/paper-links/logic.ts`.
 */

interface LineageArtifactShape {
  readonly nodes?: unknown;
}

/**
 * True when a conference's `lineage.json` carries real graph data, not
 * the intentionally-empty placeholder `docs/` ships for a conference
 * with no generated lineage yet (design doc §9 "消さないもの": the empty
 * file exists only so the viewer's optional lineage probe resolves 200
 * instead of 404). Only `eccv-2024` and `iclr-2026` have non-stub data
 * today (CLAUDE.md "実装ステータス") -- the other 8 catalog conferences
 * must not get a `/[conf]/lineage/` route at all, matching which
 * conferences ever shipped a `lineage.html` page originally.
 */
export function lineageDataIsNonStub(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const nodes = (parsed as LineageArtifactShape | null)?.nodes;
  return Array.isArray(nodes) && nodes.length > 0;
}

interface LineageQualityRow {
  readonly kind?: unknown;
  readonly slug?: unknown;
  readonly availability?: unknown;
  readonly audit_status?: unknown;
}

/**
 * True when the lineage quality manifest (`lineage-quality-v1.json`)
 * marks this conference's `conference` collection row `ready` +
 * `passed` (safety contracts CAT-39). A missing/malformed manifest, or
 * any row shape other than an exact match, is NOT eligible -- the same
 * fail-closed rule as `scripts/sitemap.ts`'s `eligibleLineageRoutes`,
 * used here to decide whether the built page itself should carry
 * `robots: noindex` (the client-side gate in `page.tsx` already decides
 * whether to render the real graph or the "監査待ち" pending shell; this
 * is the separate, server-rendered head-metadata signal to crawlers).
 */
export function conferenceLineageIsEligible(manifestRaw: string | null, conf: string): boolean {
  if (manifestRaw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const collections = (parsed as { collections?: unknown }).collections;
  if (!Array.isArray(collections)) return false;
  return (collections as LineageQualityRow[]).some(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      row.kind === "conference" &&
      row.slug === conf &&
      row.availability === "ready" &&
      row.audit_status === "passed",
  );
}
