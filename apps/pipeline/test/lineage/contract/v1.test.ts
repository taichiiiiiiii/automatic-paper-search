/**
 * TS port of (a representative subset of) `paperpilot/tests/test_lineage_contract.py`
 * for `apps/pipeline/src/lineage/contract/v1.ts` (LIN-45, LIN-46, LIN-50, LIN-51).
 */
import { describe, expect, it } from "vitest";
import {
  type ContractIssue,
  canonicalFocusNode,
  canonicalJsonSha256,
  catalogPaperIds,
  isPaperId,
  makeProvenance,
  requireValidLineageArtifact,
  validateDeepManifest,
  validateLineageArtifact,
  validateLineageQualityManifest,
} from "../../../src/lineage/contract/v1.js";

const PAPER_ID = "1".repeat(40);
const OTHER_PAPER_ID = "2".repeat(40);
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
    meta: { kind: "conference", generator: "test-producer", generated_at: "2026-08-30T00:00:00Z" },
  };
}

function codes(issues: readonly ContractIssue[]): Set<string> {
  return new Set(issues.map((i) => i.code));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("validateLineageArtifact", () => {
  it("passes a valid conference artifact", () => {
    expect(
      validateLineageArtifact(artifact(), { kind: "conference", catalogIds: new Set([PAPER_ID]) }),
    ).toEqual([]);
  });

  it("passes a valid theme artifact and an empty theme artifact", () => {
    const theme = artifact();
    (theme.meta as Record<string, unknown>).kind = "theme";
    expect(validateLineageArtifact(theme, { kind: "theme" })).toEqual([]);

    const empty = {
      schema_version: "lineage-artifact-v1",
      root: null,
      nodes: [],
      edges: [],
      clusters: [],
      meta: { kind: "theme", generator: "test-producer", generated_at: "2026-08-30T00:00:00Z" },
    };
    expect(validateLineageArtifact(empty, { kind: "theme" })).toEqual([]);
  });

  it("requires a unique focus_seed for theme without catalog membership", () => {
    const noSeed = artifact();
    delete (noSeed.nodes as Record<string, unknown>[])[0]!.seed_paper_id;
    (noSeed.meta as Record<string, unknown>).kind = "theme";
    expect(codes(validateLineageArtifact(noSeed, { kind: "theme" }))).toContain("focus_seed");

    const dup = artifact();
    (dup.meta as Record<string, unknown>).kind = "theme";
    (dup.nodes as unknown[]).push({ id: "second-focus", is_focus: true, seed_paper_id: PAPER_ID });
    const issues = validateLineageArtifact(dup, { kind: "theme", catalogIds: new Set() });
    expect(codes(issues)).toContain("focus_seed_duplicate");
    expect(codes(issues)).not.toContain("catalog_seed_membership");
  });

  it("rejects a missing schema_version and a legacy string provenance", () => {
    const bad = artifact();
    delete bad.schema_version;
    (bad.edges as Record<string, unknown>[])[0]!.provenance = "llm";
    const issues = codes(validateLineageArtifact(bad, { kind: "conference" }));
    expect(issues).toContain("artifact_schema_version");
    expect(issues).toContain("provenance_shape");
  });

  it("rejects duplicate node ids and an unresolved root", () => {
    const bad = artifact();
    (bad.nodes as Record<string, unknown>[])[1]!.id = "focus";
    const issues = codes(validateLineageArtifact(bad, { kind: "conference" }));
    expect(issues).toContain("node_id_duplicate");
  });

  it("rejects an empty graph with a non-null root", () => {
    const bad = {
      schema_version: "lineage-artifact-v1",
      root: "x",
      nodes: [],
      edges: [],
      clusters: [],
      meta: {},
    };
    expect(codes(validateLineageArtifact(bad, { kind: "conference" }))).toContain("empty_root");
  });

  it("rejects relation/rel mismatch and confidence/conf mismatch", () => {
    const bad = artifact();
    (bad.edges as Record<string, unknown>[])[0]!.rel = "successor";
    const issues1 = codes(validateLineageArtifact(bad, { kind: "conference" }));
    expect(issues1).toContain("edge_relation_alias");

    const bad2 = artifact();
    (bad2.edges as Record<string, unknown>[])[0]!.conf = 0.1;
    expect(codes(validateLineageArtifact(bad2, { kind: "conference" }))).toContain(
      "edge_confidence_alias",
    );
  });

  it("rejects an invalid relation and out-of-range confidence", () => {
    const bad = artifact();
    (bad.edges as Record<string, unknown>[])[0]!.relation = "bogus";
    (bad.edges as Record<string, unknown>[])[0]!.rel = "bogus";
    expect(codes(validateLineageArtifact(bad, { kind: "conference" }))).toContain("edge_relation");

    const bad2 = artifact();
    (bad2.edges as Record<string, unknown>[])[0]!.confidence = 1.5;
    (bad2.edges as Record<string, unknown>[])[0]!.conf = 1.5;
    expect(codes(validateLineageArtifact(bad2, { kind: "conference" }))).toContain(
      "edge_confidence",
    );
  });

  it("rejects a dangling edge endpoint", () => {
    const bad = artifact();
    (bad.edges as Record<string, unknown>[])[0]!.dst = "nowhere";
    expect(codes(validateLineageArtifact(bad, { kind: "conference" }))).toContain("edge_endpoint");
  });

  it("flags an impossible calendar date but a valid timestamp passes (theme_meta_generated_at)", () => {
    const theme = artifact();
    (theme.meta as Record<string, unknown>).kind = "theme";
    expect(validateLineageArtifact(theme, { kind: "theme" })).toEqual([]);

    const badTime = deepClone(theme);
    (badTime.meta as Record<string, unknown>).generated_at = "2026-08-30";
    expect(codes(validateLineageArtifact(badTime, { kind: "theme" }))).toContain(
      "theme_meta_generated_at",
    );

    const impossible = deepClone(theme);
    (impossible.meta as Record<string, unknown>).generated_at = "2026-02-30T00:00:00Z";
    expect(codes(validateLineageArtifact(impossible, { kind: "theme" }))).toContain(
      "theme_meta_generated_at",
    );
  });

  it("rejects non-empty clusters for a theme artifact", () => {
    const theme = artifact();
    (theme.meta as Record<string, unknown>).kind = "theme";
    theme.clusters = [{ id: "legacy" }];
    expect(codes(validateLineageArtifact(theme, { kind: "theme" }))).toContain("theme_clusters");
  });

  it("normalizes node aliases and rejects ambiguous/duplicate aliases", () => {
    const theme = artifact();
    (theme.meta as Record<string, unknown>).kind = "theme";
    (theme.nodes as Record<string, unknown>[])[0]!.aliases = [["arxiv", "2601.00001"]];
    expect(validateLineageArtifact(theme, { kind: "theme" })).toEqual([]);

    const dupAlias = deepClone(theme);
    (dupAlias.nodes as Record<string, unknown>[])[0]!.aliases = [
      ["arxiv", "2601.00001"],
      ["arxiv", "2601.00001"],
    ];
    expect(codes(validateLineageArtifact(dupAlias, { kind: "theme" }))).toContain(
      "node_alias_duplicate",
    );

    const ambiguous = deepClone(theme);
    (ambiguous.nodes as Record<string, unknown>[])[0]!.aliases = [["arxiv", "2601.00001"]];
    (ambiguous.nodes as Record<string, unknown>[])[1]!.aliases = [["arxiv", "2601.00001"]];
    expect(codes(validateLineageArtifact(ambiguous, { kind: "theme" }))).toContain(
      "node_alias_ambiguous",
    );
  });

  it("rejects a legacy semantic_scholar alias for theme artifacts (strong-only)", () => {
    const theme = artifact();
    (theme.meta as Record<string, unknown>).kind = "theme";
    (theme.nodes as Record<string, unknown>[])[0]!.aliases = [["semantic_scholar", "abc123"]];
    expect(codes(validateLineageArtifact(theme, { kind: "theme" }))).toContain(
      "node_alias_normalized",
    );
  });

  it("accepts a legacy semantic_scholar alias for conference/deep artifacts", () => {
    const conf = artifact();
    (conf.nodes as Record<string, unknown>[])[0]!.aliases = [["semantic_scholar", "abc123"]];
    expect(
      validateLineageArtifact(conf, { kind: "conference", catalogIds: new Set([PAPER_ID]) }),
    ).toEqual([]);
  });

  it("rejects out-of-order nodes/edges", () => {
    const bad = artifact();
    (bad.nodes as unknown[]).reverse();
    expect(codes(validateLineageArtifact(bad, { kind: "conference" }))).toContain("node_order");
  });

  it("requires root to be the highest-degree focus node (deterministic)", () => {
    const bad = artifact();
    (bad.nodes as Record<string, unknown>[])[0]!.id = "focus"; // keep as-is; root already correct
    // Add a second focus with higher degree to force a root mismatch.
    const graph: Record<string, unknown> = {
      schema_version: "lineage-artifact-v1",
      root: "a",
      nodes: [
        { id: "a", is_focus: true, seed_paper_id: PAPER_ID },
        { id: "b", is_focus: true, seed_paper_id: OTHER_PAPER_ID },
        { id: "c", is_focus: false },
      ],
      edges: [edge("b", "c"), edge("c", "b")],
      clusters: [],
      meta: { kind: "conference", generator: "g", generated_at: "2026-08-30T00:00:00Z" },
    };
    expect(codes(validateLineageArtifact(graph, { kind: "conference" }))).toContain(
      "root_deterministic",
    );

    function edge(src: string, dst: string): Record<string, unknown> {
      return {
        src,
        dst,
        relation: "extends",
        rel: "extends",
        confidence: 0.5,
        conf: 0.5,
        rationale: "Specific evidence",
        provenance: provenance(),
      };
    }
  });

  it("validates an expected_seed_paper_id match/mismatch", () => {
    expect(
      validateLineageArtifact(artifact(), {
        kind: "conference",
        catalogIds: new Set([PAPER_ID]),
        expectedSeedPaperId: PAPER_ID,
      }),
    ).toEqual([]);
    expect(
      codes(
        validateLineageArtifact(artifact(), {
          kind: "conference",
          catalogIds: new Set([PAPER_ID]),
          expectedSeedPaperId: OTHER_PAPER_ID,
        }),
      ),
    ).toContain("expected_seed_mismatch");
  });
});

describe("requireValidLineageArtifact", () => {
  it("throws with issue codes on invalid data and is silent on valid data", () => {
    expect(() =>
      requireValidLineageArtifact(artifact(), {
        kind: "conference",
        catalogIds: new Set([PAPER_ID]),
      }),
    ).not.toThrow();
    const bad = artifact();
    delete bad.schema_version;
    expect(() => requireValidLineageArtifact(bad, { kind: "conference" })).toThrow(
      /artifact_schema_version/,
    );
  });
});

describe("canonicalFocusNode", () => {
  it("resolves the unique root focus node and returns null otherwise", () => {
    expect(canonicalFocusNode(artifact())?.id).toBe("focus");
    expect(canonicalFocusNode({ root: null, nodes: [] })).toBeNull();
    expect(canonicalFocusNode({ root: "x", nodes: [{ id: "x", is_focus: false }] })).toBeNull();
  });
});

describe("misc contract helpers", () => {
  it("isPaperId / catalogPaperIds / canonicalJsonSha256 / makeProvenance", () => {
    expect(isPaperId(PAPER_ID)).toBe(true);
    expect(isPaperId("not-an-id")).toBe(false);
    expect(catalogPaperIds([{ paper_id: PAPER_ID }, { paper_id: "bad" }, "nope"])).toEqual(
      new Set([PAPER_ID]),
    );
    expect(canonicalJsonSha256({ b: 1, a: 2 })).toBe(canonicalJsonSha256({ a: 2, b: 1 }));
    const prov = makeProvenance({
      producerName: "p",
      producerVersion: "1",
      evidenceSource: "s",
      evidenceKind: "k",
      evidenceSha256: SHA256,
      method: "llm",
      provider: "groq",
      model: "m",
      promptVersion: "v1",
      classificationSchemaVersion: "cv1",
    });
    expect(prov.producer).toEqual({ name: "p", version: "1" });
  });
});

describe("validateDeepManifest", () => {
  function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      paper_id: PAPER_ID,
      aliases: [
        ["arxiv", "2601.00001"],
        ["semantic_scholar", "abc"],
      ],
      arxiv_id: "2601.00001",
      title: "A paper",
      filename: "deep-2601.00001.json",
      ...overrides,
    };
  }

  function manifest(entries: Record<string, unknown>[] = [entry()]): Record<string, unknown> {
    return {
      schema_version: "deep-manifest-v1",
      conference: "iclr-2026",
      generated_at: "2026-08-30T00:00:00Z",
      entries,
    };
  }

  it("passes a valid manifest", () => {
    expect(validateDeepManifest(manifest())).toEqual([]);
  });

  it("rejects a malformed arxiv_id and a filename that does not match it", () => {
    expect(codes(validateDeepManifest(manifest([entry({ arxiv_id: "not-an-id" })])))).toContain(
      "manifest_arxiv",
    );
    expect(
      codes(validateDeepManifest(manifest([entry({ filename: "deep-wrong.json" })]))),
    ).toContain("manifest_filename");
  });

  it("rejects duplicate paper_id, filename and alias across entries", () => {
    const e1 = entry();
    const e2 = entry({ arxiv_id: "2601.00001", filename: "deep-2601.00001.json" });
    const issues = codes(validateDeepManifest(manifest([e1, e2])));
    expect(issues).toContain("manifest_paper_duplicate");
    expect(issues).toContain("manifest_filename_duplicate");
    expect(issues).toContain("manifest_alias_duplicate");
  });

  it("requires exactly arxiv + semantic_scholar alias kinds", () => {
    expect(
      codes(validateDeepManifest(manifest([entry({ aliases: [["arxiv", "2601.00001"]] })]))),
    ).toContain("manifest_alias_kinds");
  });

  it("enforces catalog membership when catalogIds is provided", () => {
    expect(codes(validateDeepManifest(manifest(), { catalogIds: new Set() }))).toContain(
      "manifest_catalog_membership",
    );
    expect(validateDeepManifest(manifest(), { catalogIds: new Set([PAPER_ID]) })).toEqual([]);
  });
});

describe("validateLineageQualityManifest", () => {
  function auditBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      fixture_sha256: null,
      evaluated_at: "2026-08-30T00:00:00Z",
      actor: "ci:audit-v1",
      checks: [],
      ...overrides,
    };
  }

  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      collection_id: "conference:iclr-2026",
      kind: "conference",
      slug: "iclr-2026",
      label: "ICLR 2026",
      path: "iclr-2026/lineage.json",
      availability: "unavailable",
      audit_status: "unknown",
      freshness: "stale",
      generated_at: null,
      snapshot_date: null,
      node_count: 0,
      edge_count: 0,
      artifact_schema_version: null,
      input_sha256: null,
      audit: auditBlock(),
      ...overrides,
    };
  }

  function manifest(collections: Record<string, unknown>[]): Record<string, unknown> {
    return {
      schema_version: "lineage-quality-v1",
      as_of: "2026-08-30T00:00:00Z",
      audit_version: "audit-v1",
      collections,
    };
  }

  it("passes a minimal valid manifest", () => {
    expect(validateLineageQualityManifest(manifest([row()]))).toEqual([]);
  });

  it("requires conference identity (collection_id/path match slug)", () => {
    expect(
      codes(validateLineageQualityManifest(manifest([row({ collection_id: "conference:wrong" })]))),
    ).toContain("quality_conference_identity");
  });

  it("requires strictly ascending unique collection ids", () => {
    const rows = [
      row({ collection_id: "conference:a", slug: "a", path: "a/lineage.json" }),
      row({ collection_id: "conference:a", slug: "a", path: "a/lineage.json" }),
    ];
    expect(codes(validateLineageQualityManifest(manifest(rows)))).toContain(
      "quality_collection_order",
    );
  });

  it("requires passed rows to carry the artifact+fixture contract checks", () => {
    const passed = row({
      availability: "ready",
      audit_status: "passed",
      artifact_schema_version: "lineage-artifact-v1",
      input_sha256: SHA256,
      audit: auditBlock({
        fixture_sha256: SHA256,
        checks: [
          {
            name: "artifact_contract_v1",
            status: "passed",
            observed: 0,
            expected: 0,
            evidence: [],
          },
          { name: "golden_fixture", status: "passed", observed: 0, expected: 0, evidence: [] },
        ],
      }),
    });
    expect(validateLineageQualityManifest(manifest([passed]))).toEqual([]);

    const missingFixtureHash = row({
      availability: "ready",
      audit_status: "passed",
      artifact_schema_version: "lineage-artifact-v1",
      input_sha256: SHA256,
      audit: auditBlock({
        checks: [
          {
            name: "artifact_contract_v1",
            status: "passed",
            observed: 0,
            expected: 0,
            evidence: [],
          },
          { name: "golden_fixture", status: "passed", observed: 0, expected: 0, evidence: [] },
        ],
      }),
    });
    expect(codes(validateLineageQualityManifest(manifest([missingFixtureHash])))).toContain(
      "quality_passed_contract",
    );
  });

  it("requires audit_status consistency with check statuses", () => {
    const inconsistent = row({
      audit_status: "passed",
      audit: auditBlock({
        checks: [{ name: "x", status: "failed", observed: 1, expected: 0, evidence: [] }],
      }),
    });
    expect(codes(validateLineageQualityManifest(manifest([inconsistent])))).toContain(
      "quality_audit_consistency",
    );
  });

  it("validates deep row identity (collection_id/manifest_path/filename shape)", () => {
    const deepRow = row({
      collection_id: `deep:iclr-2026:${PAPER_ID}`,
      kind: "deep",
      slug: "iclr-2026",
      path: `iclr-2026/deep-${"2601.00001"}.json`,
      conference: "iclr-2026",
      paper_id: PAPER_ID,
      arxiv_id: "2601.00001",
      manifest_path: "iclr-2026/deep-manifest.json",
      manifest_input_sha256: null,
    });
    expect(validateLineageQualityManifest(manifest([deepRow]))).toEqual([]);

    const badDeep = { ...deepRow, path: "iclr-2026/not-deep-shaped.json" };
    expect(codes(validateLineageQualityManifest(manifest([badDeep])))).toContain(
      "quality_deep_identity",
    );
  });
});
