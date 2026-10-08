/**
 * Pure helpers for `app/[conf]/lineage/layout.tsx`, kept in a plain .ts
 * module (not the .tsx layout itself) so they are unit-testable without
 * exercising JSX -- same separation as `app/[conf]/paper-links/logic.ts`.
 */
import {
  parseQualityManifest,
  qualityRowIsEligible,
  resolveQualityCollection,
} from "../../../lib/lineage/core";

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

/**
 * True when the lineage quality manifest (`lineage-quality-v1.json`)
 * marks this conference's `conference` collection row `ready` +
 * `passed` under the FULL audit contract (safety contracts CAT-39),
 * using the same strict reader + eligibility rule as the client
 * (`lib/lineage/core.ts`'s `parseQualityManifest` +
 * `qualityRowIsEligible`, via `resolveQualityCollection` for the exact
 * row selector) instead of a loose `availability`/`audit_status`
 * string check (P2 review MEDIUM-2). The previous loose check could
 * accept a row with `audit_status: "passed"` whose audit itself was
 * inconsistent or incomplete (e.g. missing the `golden_fixture` check)
 * -- a shape the client's `qualityRowIsEligible` already rejects -- so
 * this page could be left indexable while the client-side gate in
 * `page.tsx` still renders the "監査待ち" pending shell for the exact
 * same row. A missing/malformed manifest, or any row failing strict
 * validation, is NOT eligible -- the same fail-closed rule
 * `scripts/sitemap.ts`'s `eligibleLineageRoutes` now shares, used here
 * to decide whether the built page itself should carry `robots:
 * noindex` (the client-side gate in `page.tsx` separately decides
 * whether to render the real graph or the "監査待ち" pending shell; this
 * is the server-rendered head-metadata signal to crawlers).
 */
export function conferenceLineageIsEligible(manifestRaw: string | null, conf: string): boolean {
  if (manifestRaw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return false;
  }
  const quality = parseQualityManifest(parsed);
  if (!quality) return false;
  const row = resolveQualityCollection(quality, {
    kind: "conference",
    slug: conf,
    path: `${conf}/lineage.json`,
  });
  return qualityRowIsEligible(row);
}
