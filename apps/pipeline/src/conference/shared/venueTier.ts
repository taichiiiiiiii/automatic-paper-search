/**
 * Venue tier lookup for the authoritative conference collectors
 * (OpenReview / CVF) — TS port of the `TIER_1`/`TIER_2`/`TIER_3` sets
 * `collect_openreview.py` and `collect_cvf.py` import from
 * `paperpilot/signals/venue_signal.py`.
 *
 * KNOWN DUPLICATION: `apps/pipeline/src/collect/signals/venue.ts` already
 * defines the same three sets, but keeps them module-private (`VenueSignal`
 * only exports the `classify()` method, not the sets themselves), and this
 * task's edit scope (`apps/pipeline/src/conference/**`) does not include
 * `collect/signals/**`. The values below are copied verbatim from that
 * file and MUST be kept in sync with it (this mirrors the Python
 * collectors' own direct import of the pipeline's tier sets, just without
 * the ability to export/import across the module boundary here). A
 * follow-up that can touch `collect/signals/venue.ts` should export the
 * sets there and delete this duplicate.
 */

const TIER_1 = new Set(["NEURIPS", "NIPS", "ICML", "ICLR"]);
const TIER_2 = new Set(["AAAI", "CVPR", "ACL", "EMNLP"]);
const TIER_3 = new Set(["AISTATS", "NAACL", "ECCV", "ICCV", "IJCAI", "KDD", "WWW"]);

/** Tier (1/2/3) for a VenueSignal token, or 0 when the venue is in none of the tier sets. */
export function venueTier(venue: string): number {
  const v = venue.toUpperCase();
  if (TIER_1.has(v)) return 1;
  if (TIER_2.has(v)) return 2;
  if (TIER_3.has(v)) return 3;
  return 0;
}
