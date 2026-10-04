/**
 * Module-private capability brands for the lineage-v2 contract --
 * ported 1:1 from the `indexBrand`/`entryBrand`/`releaseBrand`/
 * `releasePrivate` `WeakSet`/`WeakMap`s at the top of
 * docs/assets/lineage-v2-core.js.
 *
 * These are a RUNTIME security boundary, not merely a TypeScript type.
 * A `Release`/parsed `PilotIndex`/`PilotIndexEntry` is otherwise a
 * plain, fully public, JSON-shaped object -- nothing stops a caller
 * from reading or copying its fields. What a `WeakSet` keyed on object
 * identity prevents is a FORGED object (built by hand, or produced by
 * `structuredClone`/spreading a real one) from being accepted by
 * `resolveFocus`/`readState`/`selectFocusProjection`/
 * `resolvePilotEntry`/`verifyPilotRelease` as if it had gone through
 * verification. Compile-time nominal typing alone cannot do this --
 * `as Release` would happily lie to the type checker. Keep every
 * consumer's brand check (`releaseBrand.has(release)` etc.) exactly
 * where the JS has it; removing one re-opens exactly the forgery the
 * corresponding test_lineage_v2_core.mjs case pins.
 */
import type {
  LineageV2Claim,
  LineageV2Evidence,
  LineageV2Node,
  PilotIndexEntry,
  Release,
} from "./types";

export const indexBrand = new WeakSet<object>();
export const entryBrand = new WeakSet<object>();
export const releaseBrand = new WeakSet<object>();

export interface ReleaseIndexes {
  nodeById: Map<string, LineageV2Node>;
  claimById: Map<string, LineageV2Claim>;
  evidenceById: Map<string, LineageV2Evidence>;
}

export const releasePrivate = new WeakMap<object, ReleaseIndexes>();

export function isBrandedEntry(value: unknown): value is PilotIndexEntry {
  return typeof value === "object" && value !== null && entryBrand.has(value);
}

export function isBrandedRelease(value: unknown): value is Release {
  return typeof value === "object" && value !== null && releaseBrand.has(value);
}

export function releaseIndexes(release: Release): ReleaseIndexes {
  const indexes = releasePrivate.get(release as object);
  if (!indexes) throw new Error("releaseIndexes: release was not branded by verifyPilotRelease");
  return indexes;
}
