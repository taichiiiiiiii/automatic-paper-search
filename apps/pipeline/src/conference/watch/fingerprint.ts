/**
 * Canonical immutable snapshot fingerprinting — TS port of
 * `paperpilot/conference_watch/fingerprint.py` (CNF-30). Built on
 * `./canonicalJson.ts` (`@paperpilot/core`'s `pyJsonDumps` plus a local
 * non-finite/circular rejection walk — see that module's doc comment).
 */

import { createHash } from "node:crypto";
import { codepointCompare } from "@paperpilot/core";
import { canonicalJsonBytes } from "./canonicalJson.js";
import { fingerprintFields, type NormalizedPaper } from "./models.js";

export interface FingerprintPayloadInput {
  adapterVersion: string;
  editionId: string;
  sourceId: string;
  rows: readonly NormalizedPaper[];
}

/** Serialize the exact v1 fingerprint payload with one trailing LF. */
export function canonicalFingerprintBytes(input: FingerprintPayloadInput): Buffer {
  const sortedRows = [...input.rows].sort((a, b) => codepointCompare(a.sourceId, b.sourceId));
  const payload = {
    adapter_version: input.adapterVersion,
    edition_id: input.editionId,
    source_id: input.sourceId,
    rows: sortedRows.map(fingerprintFields),
  };
  return canonicalJsonBytes(payload);
}

/** Return the deterministic SHA-256 source fingerprint. */
export function sourceFingerprint(input: FingerprintPayloadInput): string {
  return createHash("sha256").update(canonicalFingerprintBytes(input)).digest("hex");
}
