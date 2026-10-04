/**
 * Direct unit tests of `collectionRow`'s per-collection audit (LIN-51):
 * `buildLineageQuality.parity.test.ts` only exercises it end-to-end
 * against the real `docs/` tree (byte-equality against a committed
 * manifest), which can't isolate any ONE check — a mutant breaking just
 * the golden-fixture sha comparison, for instance, did not change the
 * real tree's manifest output at all (confirmed: that mutant left the
 * parity test green).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectionRow,
  type GoldenFixture,
  parseTime,
} from "../../../src/lineage/quality/buildLineageQuality.js";

const PAPER_ID = "1".repeat(40);
const SHA256 = "a".repeat(64);

function provenance(): Record<string, unknown> {
  return {
    producer: { name: "test-producer", version: "1" },
    evidence: { source: "fixture", kind: "citation", sha256: SHA256 },
    classification: {
      method: "citation_heuristic",
      provider: null,
      model: null,
      prompt_version: null,
      schema_version: "fixture-v1",
    },
  };
}

function artifact(): Record<string, unknown> {
  return {
    schema_version: "lineage-artifact-v1",
    root: "focus",
    nodes: [
      { id: "focus", title: "Focus", is_focus: true, seed_paper_id: PAPER_ID },
      { id: "related", title: "Related", is_focus: false },
    ],
    edges: [
      {
        src: "focus",
        dst: "related",
        rel: "extends",
        relation: "extends",
        conf: 0.8,
        confidence: 0.8,
        rationale: "Specific evidence",
        provenance: provenance(),
      },
    ],
    clusters: [],
    meta: { kind: "theme", generator: "test-producer", generated_at: "2026-08-30T00:00:00Z" },
  };
}

function writeArtifact(docsRoot: string, relativePath: string): string {
  const text = JSON.stringify(artifact());
  writeFileSync(join(docsRoot, relativePath), text);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function goodFixture(inputSha256: string): GoldenFixture {
  return {
    input_sha256: inputSha256,
    reviewer: "alice",
    reviewed_at: "2026-08-30T00:00:00Z",
    focus_labels: [{ node_id: "focus", on_topic: true }],
    sample_labels: [{ node_id: "related", on_topic: true }],
  };
}

function tmpDocsDir(): string {
  return mkdtempSync(join(tmpdir(), "quality-row-"));
}

describe("collectionRow (LIN-51): fail-closed golden-fixture matching", () => {
  it("passes when every check — including the frozen fixture's input_sha256 — matches", () => {
    const docsRoot = tmpDocsDir();
    const sha = writeArtifact(docsRoot, "lineage.json");
    const row = collectionRow({
      docsRoot,
      kind: "theme",
      slug: "t",
      label: "T",
      relativePath: "lineage.json",
      snapshotDate: null,
      generatedHint: null,
      fixture: goodFixture(sha),
      asOfText: "2026-09-01T00:00:00Z",
      maxAgeDays: 365,
      catalogIds: null,
    });
    expect(row.audit_status).toBe("passed");
    expect(row.audit.checks.find((c) => c.name === "golden_fixture")?.status).toBe("passed");
  });

  // LIN-51: a mismatched input_sha256 — the artifact changed since the
  // fixture was reviewed — must fail the audit even though every
  // structural check (contract, ids, root/focus, timestamps) is clean.
  // This is the "matching frozen fixture" half of the fail-closed model;
  // nothing else in the test suite drove this specific branch.
  it("FAILs (not 'passed') when the fixture's input_sha256 does not match the artifact's actual hash", () => {
    const docsRoot = tmpDocsDir();
    const sha = writeArtifact(docsRoot, "lineage.json");
    const wrongSha = sha === "b".repeat(64) ? "c".repeat(64) : "b".repeat(64);
    const row = collectionRow({
      docsRoot,
      kind: "theme",
      slug: "t",
      label: "T",
      relativePath: "lineage.json",
      snapshotDate: null,
      generatedHint: null,
      fixture: goodFixture(wrongSha),
      asOfText: "2026-09-01T00:00:00Z",
      maxAgeDays: 365,
      catalogIds: null,
    });
    expect(row.audit_status).toBe("failed");
    const golden = row.audit.checks.find((c) => c.name === "golden_fixture");
    expect(golden?.status).toBe("failed");
    expect(golden?.evidence).toContain("input-sha-mismatch");
  });

  it("stays 'unknown' (not 'passed') when there is no frozen fixture at all", () => {
    const docsRoot = tmpDocsDir();
    writeArtifact(docsRoot, "lineage.json");
    const row = collectionRow({
      docsRoot,
      kind: "theme",
      slug: "t",
      label: "T",
      relativePath: "lineage.json",
      snapshotDate: null,
      generatedHint: null,
      fixture: null,
      asOfText: "2026-09-01T00:00:00Z",
      maxAgeDays: 365,
      catalogIds: null,
    });
    expect(row.audit_status).toBe("unknown");
  });
});

// LOW (#review): Python's `_parse_time` (`datetime.fromisoformat`) keeps
// fractional seconds; verified against real CPython that
// "2026-01-01T00:00:00.5Z" parses to microsecond 500000, not 0.
describe("parseTime: fractional seconds (LOW)", () => {
  it("keeps sub-second precision instead of silently truncating to the whole second", () => {
    const a = parseTime("2026-01-01T00:00:00.5Z");
    const b = parseTime("2026-01-01T00:00:00Z");
    expect(a.getTime()).not.toBe(b.getTime());
    expect(a.getTime() - b.getTime()).toBe(500);
  });

  it("still parses a plain (fraction-less) timestamp the same as before", () => {
    expect(parseTime("2026-01-01T00:00:00Z").getTime()).toBe(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
  });
});
