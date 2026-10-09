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
    // min(20, node count) = 2 distinct nodes must be sampled.
    sample_labels: [
      { node_id: "focus", on_topic: true },
      { node_id: "related", on_topic: true },
    ],
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

// MEDIUM-11 (#review, LIN-51): each of these three golden-fixture rules
// was previously untested in isolation — a mutant breaking any ONE of
// them left a bad fixture reading as "passed" (confirmed red below).
describe("collectionRow (LIN-51): the three golden-fixture label rules, each in isolation", () => {
  it("FAILs when a focus node has no on_topic=true label in focus_labels (build.ts:452-453)", () => {
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
      fixture: {
        input_sha256: sha,
        reviewer: "alice",
        reviewed_at: "2026-08-30T00:00:00Z",
        focus_labels: [], // "focus" node is never labelled
        sample_labels: [
          { node_id: "focus", on_topic: true },
          { node_id: "related", on_topic: true },
        ],
      },
      asOfText: "2026-09-01T00:00:00Z",
      maxAgeDays: 365,
      catalogIds: null,
    });
    expect(row.audit_status).toBe("failed");
    const golden = row.audit.checks.find((c) => c.name === "golden_fixture");
    expect(golden?.status).toBe("failed");
    expect(golden?.evidence).toContain("focus:focus");
  });

  it("FAILs when sample_labels has more than 20 entries (build.ts:456)", () => {
    const docsRoot = tmpDocsDir();
    const sha = writeArtifact(docsRoot, "lineage.json");
    const sampleLabels = Array.from({ length: 21 }, () => ({
      node_id: "related",
      on_topic: true, // every sample on-topic -> isolates the limit check
    }));
    const row = collectionRow({
      docsRoot,
      kind: "theme",
      slug: "t",
      label: "T",
      relativePath: "lineage.json",
      snapshotDate: null,
      generatedHint: null,
      fixture: {
        input_sha256: sha,
        reviewer: "alice",
        reviewed_at: "2026-08-30T00:00:00Z",
        focus_labels: [{ node_id: "focus", on_topic: true }],
        sample_labels: sampleLabels,
      },
      asOfText: "2026-09-01T00:00:00Z",
      maxAgeDays: 365,
      catalogIds: null,
    });
    expect(row.audit_status).toBe("failed");
    const golden = row.audit.checks.find((c) => c.name === "golden_fixture");
    expect(golden?.status).toBe("failed");
    expect(golden?.evidence).toContain("sample-limit-exceeded");
  });

  it("FAILs when more than 10% of labelled samples are off-topic (build.ts:467-469)", () => {
    const docsRoot = tmpDocsDir();
    const sha = writeArtifact(docsRoot, "lineage.json");
    // 10 samples, 2 off-topic -> 20% > the 10% threshold. Sample count
    // (10) stays under the 20-sample limit so this isolates the
    // off-topic-rate rule alone.
    const sampleLabels = [
      ...Array.from({ length: 8 }, () => ({ node_id: "related", on_topic: true })),
      ...Array.from({ length: 2 }, () => ({ node_id: "related", on_topic: false })),
    ];
    const row = collectionRow({
      docsRoot,
      kind: "theme",
      slug: "t",
      label: "T",
      relativePath: "lineage.json",
      snapshotDate: null,
      generatedHint: null,
      fixture: {
        input_sha256: sha,
        reviewer: "alice",
        reviewed_at: "2026-08-30T00:00:00Z",
        focus_labels: [{ node_id: "focus", on_topic: true }],
        sample_labels: sampleLabels,
      },
      asOfText: "2026-09-01T00:00:00Z",
      maxAgeDays: 365,
      catalogIds: null,
    });
    expect(row.audit_status).toBe("failed");
    const golden = row.audit.checks.find((c) => c.name === "golden_fixture");
    expect(golden?.status).toBe("failed");
    expect(golden?.evidence).toContain("sample-off-topic-rate");
  });
});

function bigArtifactText(nonFocusCount: number): string {
  const base = artifact();
  const nodes = [
    { id: "focus", title: "Focus", is_focus: true, seed_paper_id: PAPER_ID },
    ...Array.from({ length: nonFocusCount }, (_, i) => ({
      id: `n${String(i).padStart(2, "0")}`,
      title: `Node ${i}`,
      is_focus: false,
    })),
  ];
  const edges = nodes.slice(1).map((n) => ({
    src: "focus",
    dst: n.id,
    rel: "extends",
    relation: "extends",
    conf: 0.8,
    confidence: 0.8,
    rationale: "Specific evidence",
    provenance: provenance(),
  }));
  return JSON.stringify({ ...base, nodes, edges });
}

function rowFor(text: string, sampleLabels: unknown): ReturnType<typeof collectionRow> {
  const docsRoot = tmpDocsDir();
  writeFileSync(join(docsRoot, "lineage.json"), text);
  const sha = createHash("sha256").update(text, "utf8").digest("hex");
  return collectionRow({
    docsRoot,
    kind: "theme",
    slug: "t",
    label: "T",
    relativePath: "lineage.json",
    snapshotDate: null,
    generatedHint: null,
    fixture: {
      input_sha256: sha,
      reviewer: "alice",
      reviewed_at: "2026-08-30T00:00:00Z",
      focus_labels: [{ node_id: "focus", on_topic: true }],
      sample_labels: sampleLabels,
    },
    asOfText: "2026-09-01T00:00:00Z",
    maxAgeDays: 365,
    catalogIds: null,
  });
}

function golden(row: ReturnType<typeof collectionRow>) {
  return row.audit.checks.find((c) => c.name === "golden_fixture");
}

// R2: an empty (or one-node, repeated) sample list used to pass the
// <=10% off-topic rule vacuously, so a fixture that sampled nothing
// read as a reviewed graph.
describe("collectionRow (LIN-51): sample coverage floor min(20, node count) distinct node_ids", () => {
  it("FAILs an empty sample_labels list", () => {
    const row = rowFor(JSON.stringify(artifact()), []);
    expect(row.audit_status).toBe("failed");
    expect(golden(row)?.status).toBe("failed");
    expect(golden(row)?.evidence).toEqual(["sample-coverage:0<2"]);
  });

  it("FAILs a sample list that repeats one node instead of covering distinct nodes", () => {
    const row = rowFor(JSON.stringify(artifact()), [
      { node_id: "related", on_topic: true },
      { node_id: "related", on_topic: true },
    ]);
    expect(golden(row)?.status).toBe("failed");
    expect(golden(row)?.evidence).toEqual(["sample-duplicate:related", "sample-coverage:1<2"]);
  });

  it("does not count unknown node ids toward coverage", () => {
    const row = rowFor(JSON.stringify(artifact()), [
      { node_id: "related", on_topic: true },
      { node_id: "ghost", on_topic: true },
    ]);
    expect(golden(row)?.evidence).toEqual(["sample:ghost", "sample-coverage:1<2"]);
  });

  it("caps the floor at 20 for a graph larger than 20 nodes", () => {
    const text = bigArtifactText(30); // 31 nodes
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      node_id: `n${String(i).padStart(2, "0")}`,
      on_topic: true,
    }));
    expect(golden(rowFor(text, twenty))?.status).toBe("passed");
    expect(golden(rowFor(text, twenty.slice(0, 19)))?.evidence).toEqual(["sample-coverage:19<20"]);
  });

  it("still applies the 10% off-topic rule once coverage is met (2/20 = 10% passes, 3/20 fails)", () => {
    const text = bigArtifactText(25);
    const rows = (offTopic: number) =>
      Array.from({ length: 20 }, (_, i) => ({
        node_id: `n${String(i).padStart(2, "0")}`,
        on_topic: i >= offTopic,
      }));
    expect(golden(rowFor(text, rows(2)))?.status).toBe("passed");
    expect(golden(rowFor(text, rows(3)))?.evidence).toEqual(["sample-off-topic-rate"]);
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

// MEDIUM-12 (#review, buildLineageQuality.ts:70): `parseTime` must
// require a timezone offset — a mutant that drops the
// `offset === undefined` check would silently accept a naive timestamp
// (no `Z`/`+HH:MM`) and treat it as already UTC, exactly the ambiguity
// this port's doc comment says it exists to remove.
describe("parseTime: rejects a timestamp with no timezone (MEDIUM-12)", () => {
  it("throws for a naive (timezone-less) ISO timestamp", () => {
    expect(() => parseTime("2026-01-01T00:00:00")).toThrow(/timezone/);
  });

  it("still accepts the same timestamp WITH an explicit offset", () => {
    expect(() => parseTime("2026-01-01T00:00:00+00:00")).not.toThrow();
  });
});

// MEDIUM-12 (#review, buildLineageQuality.ts:606-616): an artifact that
// exists but fails to parse (or parses to a non-object) must read as
// availability "failed" — not "unavailable" (reserved for "genuinely
// nothing published yet") and not "unknown". A mutant that changed this
// branch's `availability` field to one of those two values passed every
// OTHER test in this suite, because none of them inspected `availability`
// on the malformed-JSON path directly.
describe("collectionRow (MEDIUM-12): an unparseable artifact is availability/audit_status 'failed'", () => {
  it("is 'failed', not 'unavailable' or 'unknown', when the file exists but is not valid JSON", () => {
    const docsRoot = mkdtempSync(join(tmpdir(), "quality-row-"));
    writeFileSync(join(docsRoot, "lineage.json"), "{not valid json");
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
    expect(row.availability).toBe("failed");
    expect(row.audit_status).toBe("failed");
  });

  it("is also 'failed' when the file parses to valid JSON that is not an object (e.g. an array)", () => {
    const docsRoot = mkdtempSync(join(tmpdir(), "quality-row-"));
    writeFileSync(join(docsRoot, "lineage.json"), "[]");
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
    expect(row.availability).toBe("failed");
    expect(row.audit_status).toBe("failed");
  });
});

// LIN-50 (#review): an empty-stub artifact (`nodes: [] edges: []`) is a
// genuine fact — nothing has been generated yet — and must read as
// availability "unavailable", distinct from "sparse" (has nodes, no
// edges) and "failed" (couldn't even be parsed). Previously only
// exercised end-to-end via the golden/parity fixture, which can't isolate
// this one branch from everything else `buildManifest` touches.
describe("collectionRow (LIN-50): an empty-stub artifact is availability 'unavailable'", () => {
  it("reads nodes=[] edges=[] as 'unavailable', not 'sparse' or 'failed'", () => {
    const docsRoot = mkdtempSync(join(tmpdir(), "quality-row-"));
    writeFileSync(
      join(docsRoot, "lineage.json"),
      JSON.stringify({ schema_version: "lineage-artifact-v1", root: null, nodes: [], edges: [] }),
    );
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
    expect(row.availability).toBe("unavailable");
  });
});
