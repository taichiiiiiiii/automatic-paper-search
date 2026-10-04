/**
 * Port of `test_conference_watch_openreview.py::test_probe_and_collect_share_deterministic_order_independent_fingerprint`
 * and `test_conference_watch_stability.py::test_reducer_retry_and_serialization_are_byte_identical`
 * (CNF-30, docs/migration/safety-contracts.md). No dedicated test file for
 * `fingerprint.ts` existed before this (it was only exercised indirectly
 * through `openreview.test.ts`/`stability.test.ts`/`candidate.test.ts`
 * fixtures), so the module's own determinism/order-independence and
 * NaN-rejection contracts had no direct, isolated coverage.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalFingerprintBytes,
  type FingerprintPayloadInput,
  sourceFingerprint,
} from "../../../src/conference/watch/fingerprint.js";
import type { NormalizedPaper } from "../../../src/conference/watch/models.js";

function row(sourceId: string, title = "T"): NormalizedPaper {
  return {
    source: "openreview",
    sourceId,
    paperId: sourceId.padStart(40, "0"),
    title,
    authors: ["A"],
    abstract: "abs",
    landingUrl: `https://openreview.net/forum?id=${sourceId}`,
    pdfUrl: `https://openreview.net/pdf?id=${sourceId}`,
    decisionLabel: "accept",
  };
}

function input(rows: NormalizedPaper[]): FingerprintPayloadInput {
  return { adapterVersion: "1", editionId: "iclr-2026", sourceId: "ICLR.cc/2026/Conference", rows };
}

describe("canonicalFingerprintBytes / sourceFingerprint (CNF-30)", () => {
  it("is deterministic and independent of row insertion order", () => {
    const rowsA = [row("1"), row("2"), row("3")];
    const rowsB = [row("3"), row("1"), row("2")]; // same rows, different order
    expect(canonicalFingerprintBytes(input(rowsA))).toEqual(
      canonicalFingerprintBytes(input(rowsB)),
    );
    expect(sourceFingerprint(input(rowsA))).toBe(sourceFingerprint(input(rowsB)));
  });

  it("changes when any field changes", () => {
    const base = sourceFingerprint(input([row("1"), row("2")]));
    const changedTitle = sourceFingerprint(input([row("1", "Different Title"), row("2")]));
    expect(changedTitle).not.toBe(base);
  });

  it("is a 64-char lowercase-hex SHA-256 digest", () => {
    expect(sourceFingerprint(input([row("1")]))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CNF-30: rejects a non-finite number in the payload (defense in depth — no NormalizedPaper field is itself numeric, so this exercises the canonicalJsonBytes guard this module's payload is built through, not a field that could legitimately be NaN)", () => {
    const tainted: FingerprintPayloadInput = {
      ...input([row("1")]),
      // `adapterVersion` is typed `string`, but nothing stops a caller
      // from constructing one dynamically; cast past the type system to
      // prove `canonicalFingerprintBytes` doesn't have its own separate,
      // un-guarded serialization path that would let a non-finite value
      // slip through into `adapter_version`.
      adapterVersion: Number.NaN as unknown as string,
    };
    expect(() => canonicalFingerprintBytes(tainted)).toThrow();
  });
});
