/**
 * Ports paperpilot/tests/viewer/test_lineage_core.mjs's cases against
 * lib/lineage/core.ts (the TS port of docs/assets/lineage-core.js),
 * plus apps/web/test/fixtures/lineage-v1/node_display_cases.json (ex paperpilot/tests/fixtures/lineage-v1)
 * (shared with the Python validator) and the real, published
 * docs/lineage-quality-v1.json (so a change there that silently
 * widens eligibility is caught here too, not just in Python).
 */
// biome-ignore-all lint/suspicious/noExplicitAny: test fixtures intentionally
// build malformed shapes (deleted/mistyped fields) to probe the fail-closed
// validator, which requires loosely-typed mutation helpers throughout.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchJsonWithSha256,
  type LineageArtifact,
  MAX_JSON_BYTES,
  type Provenance,
  parseArtifact,
  parseQualityManifest,
  publishedTierRank,
  qualityRowIsAudited,
  qualityRowIsEligible,
  qualityRowIsPublishable,
  qualityRowPublishedTier,
  resolveFocus,
  resolveLineageFocusGate,
  resolveQualityCollection,
  resolveView,
  selectActiveEdges,
  withoutForeignAbstract,
} from "../../lib/lineage/core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..", "..");

const paperId = "1".repeat(40);
const otherPaperId = "2".repeat(40);

const provenance: Provenance = {
  producer: { name: "fixture", version: "1" },
  evidence: { source: "fixture", kind: "citation", sha256: "a".repeat(64) },
  classification: {
    method: "citation_heuristic",
    provider: null,
    model: null,
    prompt_version: null,
    schema_version: "fixture-v1",
  },
};

function artifact(): any {
  return {
    schema_version: "lineage-artifact-v1",
    root: "root",
    nodes: [
      {
        id: "root",
        title: "Root",
        is_focus: true,
        seed_paper_id: paperId,
        aliases: [["semantic_scholar", "root"]],
      },
      { id: "z-child", title: "Child", is_focus: false },
    ],
    edges: [
      {
        src: "root",
        dst: "z-child",
        rel: "extends",
        relation: "extends",
        conf: 0.8,
        confidence: 0.8,
        rationale: "Specific evidence",
        provenance,
      },
    ],
    clusters: [],
    meta: { kind: "conference", generated_at: "2026-08-30T00:00:00Z" },
  };
}

describe("artifact parsing", () => {
  it("accepts a valid v1 artifact and normalizes the edge", () => {
    const parsed = parseArtifact(artifact(), { kind: "conference" });
    expect(parsed).not.toBeNull();
    expect(parsed?.edges[0]?.relation).toBe("extends");
    expect(parsed?.edges[0]?.confidence).toBe(0.8);
    expect(parsed?.edges[0]).not.toHaveProperty("rel");
    expect(parsed?.edges[0]).not.toHaveProperty("conf");
  });

  it("rejects a legacy artifact missing schema_version", () => {
    const legacy = artifact();
    delete legacy.schema_version;
    expect(parseArtifact(legacy, { kind: "conference" })).toBeNull();
  });

  it("rejects root falling back to a non-focus node", () => {
    const nonFocusRoot = artifact();
    nonFocusRoot.root = "z-child";
    expect(parseArtifact(nonFocusRoot, { kind: "conference" })).toBeNull();
  });

  it("rejects when rel/relation aliases disagree", () => {
    const mismatch = artifact();
    mismatch.edges[0].rel = "contrasts";
    expect(parseArtifact(mismatch, { kind: "conference" })).toBeNull();
  });

  it("rejects legacy string provenance", () => {
    const stringProvenance = artifact();
    stringProvenance.edges[0].provenance = "llm";
    expect(parseArtifact(stringProvenance, { kind: "conference" })).toBeNull();
  });

  it("accepts the R2-10 s2_context_rule classification method and rejects unknown ones", () => {
    const s2 = artifact();
    s2.edges[0].provenance = {
      ...provenance,
      classification: { ...provenance.classification, method: "s2_context_rule" },
    };
    expect(parseArtifact(s2, { kind: "conference" })).not.toBeNull();
    // R2-24: the no-LLM mode's reference-list edges.
    s2.edges[0].provenance.classification.method = "api_citation";
    expect(parseArtifact(s2, { kind: "conference" })).not.toBeNull();
    s2.edges[0].provenance.classification.method = "s2_magic";
    expect(parseArtifact(s2, { kind: "conference" })).toBeNull();
  });

  it("rejects an empty rationale", () => {
    const missingRationale = artifact();
    missingRationale.edges[0].rationale = "";
    expect(parseArtifact(missingRationale, { kind: "conference" })).toBeNull();
  });

  it("rejects provenance nested objects with extra keys", () => {
    const extra = structuredClone(artifact());
    extra.edges[0].provenance.producer.extra = true;
    expect(parseArtifact(extra, { kind: "conference" })).toBeNull();
  });

  it("requires node order to be graph-local ID ascending", () => {
    const unsorted = artifact();
    unsorted.nodes.reverse();
    expect(parseArtifact(unsorted, { kind: "conference" })).toBeNull();
  });

  it("requires edge order to be src, dst, relation ascending", () => {
    const unsorted = artifact();
    unsorted.nodes.push({ id: "z-other", title: "Other", is_focus: false });
    unsorted.edges.push({
      src: "root",
      dst: "z-other",
      rel: "contrasts",
      relation: "contrasts",
      conf: 0.7,
      confidence: 0.7,
      rationale: "Other evidence",
      provenance,
    });
    unsorted.edges.reverse();
    expect(parseArtifact(unsorted, { kind: "conference" })).toBeNull();
  });

  it("requires root to be the highest-degree focus node (ID tie-break)", () => {
    const wrong = artifact();
    wrong.nodes.push(
      { id: "z-focus", title: "Other focus", is_focus: true, seed_paper_id: otherPaperId },
      { id: "z-other", title: "Other", is_focus: false },
    );
    wrong.nodes.sort((left: { id: string }, right: { id: string }) =>
      left.id < right.id ? -1 : 1,
    );
    wrong.edges.push(
      {
        src: "z-focus",
        dst: "z-child",
        rel: "contrasts",
        relation: "contrasts",
        conf: 0.7,
        confidence: 0.7,
        rationale: "Other evidence",
        provenance,
      },
      {
        src: "z-focus",
        dst: "z-other",
        rel: "extends",
        relation: "extends",
        conf: 0.7,
        confidence: 0.7,
        rationale: "Other evidence",
        provenance,
      },
    );
    wrong.edges.sort((left: { src: string; dst: string; relation: string }, right: typeof left) => {
      const a = `${left.src}\u0000${left.dst}\u0000${left.relation}`;
      const b = `${right.src}\u0000${right.dst}\u0000${right.relation}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    expect(parseArtifact(wrong, { kind: "conference" })).toBeNull();
  });
});

describe("focus resolution", () => {
  const parsed = parseArtifact(artifact(), { kind: "conference" }) as LineageArtifact;

  it("resolves via the canonical seed first", () => {
    expect(resolveFocus(parsed, paperId)?.id).toBe("root");
  });

  it("accepts a known graph-local ID", () => {
    expect(resolveFocus(parsed, "root")?.id).toBe("root");
  });

  it("never falls back for an unknown focus", () => {
    expect(resolveFocus(parsed, "unknown")).toBeNull();
  });

  it("a 40-hex value cannot fall through to non-focus fields or aliases", () => {
    const untrusted = artifact();
    untrusted.nodes[1].paper_id = otherPaperId;
    untrusted.nodes[1].seed_paper_id = otherPaperId;
    untrusted.nodes[1].aliases = [["legacy", otherPaperId]];
    expect(parseArtifact(untrusted, { kind: "conference" })).toBeNull();
  });

  it("a 40-hex value cannot fall through to a graph-local ID", () => {
    const hexGraphLocal = artifact();
    hexGraphLocal.nodes[1].id = otherPaperId;
    hexGraphLocal.edges[0].dst = otherPaperId;
    hexGraphLocal.nodes.sort((left: { id: string }, right: { id: string }) =>
      left.id < right.id ? -1 : 1,
    );
    const parsedHex = parseArtifact(hexGraphLocal, { kind: "conference" });
    expect(resolveFocus(parsedHex, otherPaperId)).toBeNull();
  });

  it("rejects unknown node alias namespaces", () => {
    const ambiguous = artifact();
    ambiguous.nodes.push({
      id: "other",
      title: "Other",
      is_focus: true,
      seed_paper_id: otherPaperId,
      aliases: [["legacy", paperId]],
    });
    ambiguous.nodes.sort((left: { id: string }, right: { id: string }) =>
      left.id < right.id ? -1 : 1,
    );
    expect(parseArtifact(ambiguous, { kind: "conference" })).toBeNull();
  });

  it("conference keeps Semantic Scholar alias compatibility via graph-local ID", () => {
    const s2 = artifact();
    s2.nodes[0].aliases = [["semantic_scholar", "root"]];
    const parsedS2 = parseArtifact(s2, { kind: "conference" });
    expect(parsedS2).not.toBeNull();
    expect(resolveFocus(parsedS2, "root")?.id).toBe("root");
  });
});

describe("resolveLineageFocusGate (P2 review M7)", () => {
  const parsed = parseArtifact(artifact(), { kind: "conference" }) as LineageArtifact;

  it("mounts the graph at the root when no focus was requested", () => {
    const gate = resolveLineageFocusGate(parsed, null);
    expect(gate).toEqual({ mount: true, focusId: "root", notFound: false });
  });

  it("mounts the graph at the requested node when it resolves", () => {
    const gate = resolveLineageFocusGate(parsed, paperId);
    expect(gate).toEqual({ mount: true, focusId: "root", notFound: false });
  });

  // The bug this gate fixes: an unknown `?focus=` must not draw the
  // root graph (that reads as "showing what was asked for", when it is
  // not) -- `mount` must be false, not true-with-the-root-id.
  it("does NOT mount the graph for an unknown focus -- fails closed, no root fallback", () => {
    const gate = resolveLineageFocusGate(parsed, "unknown");
    expect(gate).toEqual({ mount: false, focusId: null, notFound: true });
  });

  it("does not mount when there is no artifact at all", () => {
    expect(resolveLineageFocusGate(null, "whatever")).toEqual({
      mount: false,
      focusId: null,
      notFound: true,
    });
  });

  it("an empty string request is treated the same as no request", () => {
    expect(resolveLineageFocusGate(parsed, "")).toEqual({
      mount: true,
      focusId: "root",
      notFound: false,
    });
  });
});

describe("view and edge selection", () => {
  const mobile = () => ({ matches: true });
  it("URL view overrides saved and responsive state", () => {
    expect(resolveView({ urlView: "graph", savedView: "list", matchMedia: mobile })).toBe("graph");
  });
  it("saved view overrides responsive state", () => {
    expect(resolveView({ savedView: "graph", matchMedia: mobile })).toBe("graph");
  });
  it("720px responsive default is list", () => {
    expect(resolveView({ matchMedia: mobile })).toBe("list");
  });

  const parsed = parseArtifact(artifact(), { kind: "conference" }) as LineageArtifact;
  it("active edge survives relation and render-scope filters", () => {
    const active = selectActiveEdges(
      parsed.edges,
      new Set(["extends"]),
      new Set(["root", "z-child"]),
    );
    expect(active).toHaveLength(1);
  });
  it("relation filter applies to the shared edge set", () => {
    expect(selectActiveEdges(parsed.edges, new Set(["contrasts"]))).toHaveLength(0);
  });
  it("both list and graph drop edges with unpositioned endpoints", () => {
    expect(selectActiveEdges(parsed.edges, new Set(["extends"]), new Set(["root"]))).toHaveLength(
      0,
    );
  });
});

describe("quality gate", () => {
  function qualityRow(overrides: Record<string, unknown> = {}) {
    return {
      collection_id: "conference:test-2026",
      kind: "conference",
      slug: "test-2026",
      label: "Test 2026",
      path: "test-2026/lineage.json",
      availability: "ready",
      audit_status: "passed",
      freshness: "fresh",
      generated_at: "2026-08-30T00:00:00Z",
      snapshot_date: null,
      node_count: 12,
      edge_count: 20,
      artifact_schema_version: "lineage-artifact-v1",
      input_sha256: "b".repeat(64),
      audit: {
        fixture_sha256: "9".repeat(64),
        evaluated_at: "2026-08-30T00:00:00Z",
        actor: "ci:audit-v1",
        checks: [
          {
            name: "artifact_contract_v1",
            status: "passed",
            observed: 0,
            expected: 0,
            evidence: [],
          },
          {
            name: "golden_fixture",
            status: "passed",
            observed: "fixture-sha",
            expected: "matching frozen fixture",
            evidence: [],
          },
        ],
      },
      ...overrides,
    };
  }
  function themeRow(overrides: Record<string, unknown> = {}) {
    return qualityRow({
      collection_id: "theme:test-theme",
      kind: "theme",
      slug: "test-theme",
      label: "Test Theme",
      path: "themes/test-theme/lineage.json",
      input_sha256: "f".repeat(64),
      ...overrides,
    });
  }
  function qualityManifest(rows: unknown[], overrides: Record<string, unknown> = {}) {
    return {
      schema_version: "lineage-quality-v1",
      as_of: "2026-08-30T00:00:00Z",
      audit_version: "audit-v1",
      collections: rows,
      ...overrides,
    };
  }

  it("accepts the closed schema for conference and theme rows", () => {
    const quality = parseQualityManifest(qualityManifest([qualityRow(), themeRow()]));
    expect(quality).not.toBeNull();
  });

  it("conference row requires ready, passed, and exact artifact hash", () => {
    const quality = parseQualityManifest(qualityManifest([qualityRow(), themeRow()]));
    const conferenceQuality = resolveQualityCollection(quality, {
      kind: "conference",
      slug: "test-2026",
      path: "test-2026/lineage.json",
    });
    expect(qualityRowIsPublishable(conferenceQuality, { artifactSha256: "b".repeat(64) })).toBe(
      true,
    );
    expect(qualityRowIsPublishable(conferenceQuality, { artifactSha256: "e".repeat(64) })).toBe(
      false,
    );
  });

  it("theme row resolves uniquely and is eligible when ready+passed", () => {
    const quality = parseQualityManifest(qualityManifest([qualityRow(), themeRow()]));
    const themeQuality = resolveQualityCollection(quality, { kind: "theme", slug: "test-theme" });
    expect(themeQuality?.collection_id).toBe("theme:test-theme");
    expect(qualityRowIsEligible(themeQuality)).toBe(true);
    expect(resolveQualityCollection(quality, { kind: "theme", slug: "test-2026" })).toBeNull();
    expect(resolveQualityCollection(quality, { kind: "theme", slug: "unknown" })).toBeNull();
  });

  it("audit-failed and sparse theme rows stay ineligible", () => {
    expect(qualityRowIsEligible(themeRow({ audit_status: "failed" }) as never)).toBe(false);
    expect(qualityRowIsEligible(themeRow({ availability: "sparse" }) as never)).toBe(false);
  });

  // Design doc 41 D1: publication tiers.
  function unauditedChecks(overrides: Record<string, unknown> = {}) {
    return {
      fixture_sha256: null,
      evaluated_at: "2026-08-30T00:00:00Z",
      actor: "ci:audit-v1",
      checks: [
        { name: "artifact_contract_v1", status: "passed", observed: 0, expected: 0, evidence: [] },
        {
          name: "golden_fixture",
          status: "unknown",
          observed: null,
          expected: "matching frozen fixture",
          evidence: [],
        },
        { name: "orphan_node_count", status: "passed", observed: 0, expected: 0, evidence: [] },
      ],
      ...overrides,
    };
  }

  it("a ready row with only an unknown golden fixture is published as 'unaudited'", () => {
    const row = themeRow({ audit_status: "unknown", audit: unauditedChecks() });
    const quality = parseQualityManifest(qualityManifest([row]));
    const parsed = resolveQualityCollection(quality, { kind: "theme", slug: "test-theme" });
    expect(qualityRowPublishedTier(parsed)).toBe("unaudited");
    expect(qualityRowIsEligible(parsed)).toBe(true);
    expect(qualityRowIsAudited(parsed)).toBe(false);
    expect(qualityRowIsPublishable(parsed, { artifactSha256: "f".repeat(64) })).toBe(true);
    expect(qualityRowIsPublishable(parsed, { artifactSha256: "e".repeat(64) })).toBe(false);
    // The explicit field, when present, must agree.
    const explicit = parseQualityManifest(
      qualityManifest([{ ...row, publication_tier: "unaudited" }]),
    );
    expect(qualityRowPublishedTier(explicit?.collections[0] ?? null)).toBe("unaudited");
  });

  it("ready+passed rows are 'audited' and sort before unaudited ones", () => {
    const quality = parseQualityManifest(
      qualityManifest([{ ...themeRow(), publication_tier: "audited" }]),
    );
    const tier = qualityRowPublishedTier(quality?.collections[0] ?? null);
    expect(tier).toBe("audited");
    expect(publishedTierRank(tier)).toBeLessThan(publishedTierRank("unaudited"));
  });

  it("a failed or unknown automatic check blocks the row even when golden is unknown", () => {
    const failed = unauditedChecks();
    (failed.checks as Array<Record<string, unknown>>)[2]!.status = "failed";
    expect(qualityRowIsEligible(themeRow({ audit_status: "failed", audit: failed }) as never)).toBe(
      false,
    );
    const unknown = unauditedChecks();
    (unknown.checks as Array<Record<string, unknown>>)[2]!.status = "unknown";
    expect(
      qualityRowIsEligible(themeRow({ audit_status: "unknown", audit: unknown }) as never),
    ).toBe(false);
    // A failed golden fixture blocks too.
    const goldenFailed = unauditedChecks();
    (goldenFailed.checks as Array<Record<string, unknown>>)[1]!.status = "failed";
    expect(
      qualityRowIsEligible(themeRow({ audit_status: "failed", audit: goldenFailed }) as never),
    ).toBe(false);
  });

  it("an unaudited row still needs the v1 artifact contract and an input hash", () => {
    const base = { audit_status: "unknown", audit: unauditedChecks() };
    expect(
      qualityRowIsEligible(themeRow({ ...base, artifact_schema_version: null }) as never),
    ).toBe(false);
    expect(qualityRowIsEligible(themeRow({ ...base, input_sha256: null }) as never)).toBe(false);
  });

  it("rejects the manifest when a written publication_tier disagrees with the checks", () => {
    expect(
      parseQualityManifest(qualityManifest([{ ...themeRow(), publication_tier: "unaudited" }])),
    ).toBeNull();
    expect(
      parseQualityManifest(qualityManifest([{ ...themeRow(), publication_tier: "public" }])),
    ).toBeNull();
    const blocked = themeRow({ audit_status: "unknown", audit: unauditedChecks() });
    expect(
      parseQualityManifest(qualityManifest([{ ...blocked, publication_tier: "blocked" }])),
    ).toBeNull();
  });

  it.each([
    [
      "malformed quality manifest fails closed",
      { schema_version: "lineage-quality-v1", collections: [] },
    ],
    ["top-level object rejects extra keys", qualityManifest([qualityRow()], { extra: true })],
    [
      "audit_version is a closed constant",
      qualityManifest([qualityRow()], { audit_version: "audit-v2" }),
    ],
    ["row rejects a missing required key", qualityManifest([qualityRow({ label: undefined })])],
    ["row rejects extra keys", qualityManifest([qualityRow({ extra: true })])],
    ["non-deep row rejects deep-only fields", qualityManifest([qualityRow({ paper_id: paperId })])],
    [
      "a retired deep row is rejected (D-R2-41)",
      qualityManifest([
        qualityRow({
          collection_id: "deep:test-2026:file:x",
          kind: "deep",
          path: "test-2026/deep-x.json",
        }),
      ]),
    ],
    [
      "collection_id prefix must match the kind",
      qualityManifest([qualityRow({ collection_id: "theme:test-2026" })]),
    ],
    [
      "theme path must be themes/<slug>/lineage.json",
      qualityManifest([themeRow({ path: "themes/other/lineage.json" })]),
    ],
    [
      "conference path must be <slug>/lineage.json",
      qualityManifest([qualityRow({ path: "test-2026/lineage-v2.json" })]),
    ],
    ["counts must be non-negative integers", qualityManifest([qualityRow({ node_count: 12.5 })])],
    ["freshness is a closed enum", qualityManifest([qualityRow({ freshness: "unknown" })])],
    ["collections must be sorted by collection_id", qualityManifest([themeRow(), qualityRow()])],
    ["collections must be unique by collection_id", qualityManifest([qualityRow(), qualityRow()])],
  ])("%s", (_label, manifest) => {
    expect(parseQualityManifest(manifest)).toBeNull();
  });

  describe("quality audit rejections", () => {
    const base = qualityRow();
    const cases: Record<string, Record<string, unknown>> = {
      "audit rejects extra keys": { extra: true },
      "audit requires the ci actor": { actor: "human" },
      "audit timestamp requires a timezone": { evaluated_at: "2026-08-30" },
    };
    it.each(Object.entries(cases))("%s", (_label, auditOverrides) => {
      const candidate = structuredClone(base) as Record<string, unknown>;
      candidate.audit = { ...structuredClone(base.audit), ...auditOverrides };
      expect(parseQualityManifest(qualityManifest([candidate]))).toBeNull();
    });

    it("check rejects extra keys / must be sorted and unique", () => {
      const extraCheckCandidate = structuredClone(base) as Record<string, unknown>;
      (extraCheckCandidate.audit as Record<string, unknown>).checks = [{ extra: true }];
      expect(parseQualityManifest(qualityManifest([extraCheckCandidate]))).toBeNull();

      const unsorted = structuredClone(base) as Record<string, unknown>;
      (unsorted.audit as Record<string, unknown>).checks = [
        { name: "zeta", status: "passed", observed: 0, expected: 0, evidence: [] },
        { name: "alpha", status: "passed", observed: 0, expected: 0, evidence: [] },
      ];
      expect(parseQualityManifest(qualityManifest([unsorted]))).toBeNull();

      const duplicate = structuredClone(base) as Record<string, unknown>;
      (duplicate.audit as Record<string, unknown>).checks = [
        { name: "alpha", status: "passed", observed: 0, expected: 0, evidence: [] },
        { name: "alpha", status: "passed", observed: 0, expected: 0, evidence: [] },
      ];
      expect(parseQualityManifest(qualityManifest([duplicate]))).toBeNull();
    });
  });

  it("passed row requires lineage-artifact-v1, an artifact hash, a frozen fixture hash, no failed check, and artifact_contract_v1", () => {
    expect(
      parseQualityManifest(qualityManifest([qualityRow({ artifact_schema_version: "legacy" })])),
    ).toBeNull();
    expect(parseQualityManifest(qualityManifest([qualityRow({ input_sha256: null })]))).toBeNull();
    expect(
      parseQualityManifest(
        qualityManifest([qualityRow({ audit: { ...qualityRow().audit, fixture_sha256: null } })]),
      ),
    ).toBeNull();
    expect(
      parseQualityManifest(
        qualityManifest([
          qualityRow({
            audit: {
              ...qualityRow().audit,
              checks: (qualityRow().audit.checks as { name: string }[]).map((check) =>
                check.name === "golden_fixture" ? { ...check, status: "failed" } : check,
              ),
            },
          }),
        ]),
      ),
    ).toBeNull();
    expect(
      parseQualityManifest(
        qualityManifest([
          qualityRow({ audit: { ...qualityRow().audit, checks: [qualityRow().audit.checks[1]] } }),
        ]),
      ),
    ).toBeNull();
  });

  it("failed audit_status requires an actual failed check", () => {
    expect(
      parseQualityManifest(qualityManifest([qualityRow({ audit_status: "failed" })])),
    ).toBeNull();
  });

  it("rejects an impossible calendar timestamp", () => {
    expect(parseQualityManifest(qualityManifest([], { as_of: "2026-02-30T00:00:00Z" }))).toBeNull();
  });
});

describe("theme artifact parsing", () => {
  function themeArtifact(): any {
    return {
      schema_version: "lineage-artifact-v1",
      root: "seed-a",
      nodes: [
        { id: "child", title: "Child", is_focus: false },
        {
          id: "seed-a",
          title: "Seed A",
          is_focus: true,
          seed_paper_id: paperId,
          aliases: [["arxiv", "2601.00001"]],
        },
        { id: "seed-b", title: "Seed B", is_focus: true, seed_paper_id: otherPaperId },
      ],
      edges: [
        {
          src: "seed-a",
          dst: "child",
          rel: "extends",
          relation: "extends",
          conf: 0.9,
          confidence: 0.9,
          rationale: "Specific evidence",
          provenance,
        },
        {
          src: "seed-b",
          dst: "child",
          rel: "successor",
          relation: "successor",
          conf: 0.7,
          confidence: 0.7,
          rationale: "Other evidence",
          provenance,
        },
      ],
      clusters: [],
      meta: {
        kind: "theme",
        generator: "paperpilot.scripts.build_theme_lineage",
        generated_at: "2026-08-30T00:00:00Z",
      },
    };
  }

  it("accepts a strict theme artifact and resolves focus through an exact alias", () => {
    const parsed = parseArtifact(themeArtifact(), { kind: "theme" });
    expect(parsed).not.toBeNull();
    expect(resolveFocus(parsed, "2601.00001")?.id).toBe("seed-a");
  });

  it("rejects a theme focus without a canonical seed_paper_id", () => {
    const seedless = themeArtifact();
    delete seedless.nodes[2].seed_paper_id;
    expect(parseArtifact(seedless, { kind: "theme" })).toBeNull();
  });

  it("rejects legacy rel/conf-only edges", () => {
    const legacy = themeArtifact();
    for (const edge of legacy.edges) {
      delete edge.relation;
      delete edge.confidence;
    }
    expect(parseArtifact(legacy, { kind: "theme" })).toBeNull();
  });

  it.each([
    ["theme meta kind must match the requested kind", (v: any) => (v.meta.kind = "conference")],
    ["theme generator is required", (v: any) => delete v.meta.generator],
    [
      "theme generated_at must be a valid timezone timestamp",
      (v: any) => (v.meta.generated_at = "2026-02-30T00:00:00Z"),
    ],
    ["theme clusters must be empty", (v: any) => (v.clusters = [{ id: "legacy" }])],
    [
      "non-focus seed_paper_id is validated when present",
      (v: any) => (v.nodes[0].seed_paper_id = "BAD"),
    ],
    [
      "theme rejects Semantic Scholar as a canonical alias",
      (v: any) => (v.nodes[1].aliases = [["semantic_scholar", "seed-a"]]),
    ],
    [
      "node aliases must already be normalized",
      (v: any) => (v.nodes[1].aliases = [["arxiv", "2601.00001v2"]]),
    ],
    [
      "node aliases are graph-wide unique",
      (v: any) => (v.nodes[2].aliases = [["arxiv", "2601.00001"]]),
    ],
  ])("%s", (_label, mutate) => {
    const candidate = themeArtifact();
    mutate(candidate);
    expect(parseArtifact(candidate, { kind: "theme" })).toBeNull();
  });
});

describe("node display fields (shared fixture with test_lineage_contract.py)", () => {
  const fixturePath = resolve(
    REPO_ROOT,
    "apps/web/test/fixtures/lineage-v1/node_display_cases.json",
  );
  const nodeDisplayCases = JSON.parse(readFileSync(fixturePath, "utf8")).cases as Array<{
    label: string;
    delete?: string[];
    set?: Record<string, unknown>;
    id?: string;
    valid: boolean;
  }>;

  it.each(nodeDisplayCases.map((c) => [c.label, c] as const))("%s", (_label, nodeCase) => {
    const mutated = structuredClone(artifact());
    const node = mutated.nodes[1];
    for (const field of nodeCase.delete || []) delete node[field];
    Object.assign(node, nodeCase.set || {});
    if (Object.hasOwn(nodeCase, "id")) {
      node.id = nodeCase.id;
      mutated.edges[0].dst = nodeCase.id;
    }
    const accepted = parseArtifact(mutated, { kind: "conference" }) !== null;
    expect(accepted).toBe(nodeCase.valid);
  });
});

describe("the real published quality manifest stays fail-closed", () => {
  const publicQualityPath = join(layoutFor(REPO_ROOT).published, "lineage-quality-v1.json");
  const publicQuality = parseQualityManifest(JSON.parse(readFileSync(publicQualityPath, "utf8")));

  it("matches the strict reader", () => {
    expect(publicQuality).not.toBeNull();
  });

  // Counts are lower bounds, not exact: conference-on-demand and the theme
  // workflows add rows, and promote reruns this suite on the promoted tree.
  // The invariant is that every row stays fail closed until audited.
  // Design doc 41 R2-32: a conference lineage is published (as unaudited)
  // only when it passes every automatic check, including the theme gate the
  // builder applies to conference rows; eligibility matches the written tier.
  it("conference artifacts (at least the original 10) are published only through the automatic gate", () => {
    const rows = publicQuality?.collections.filter((row) => row.kind === "conference") ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const tier = qualityRowPublishedTier(row);
      expect(tier ?? "blocked").toBe(row.publication_tier);
      if (tier === null) continue;
      const names = row.audit.checks.map((c) => c.name);
      for (const gate of [
        "evidence_classified_rate",
        "lineage_relation_count",
        "node_count",
        "generator_current",
      ]) {
        expect(names, `${row.collection_id} lacks ${gate}`).toContain(gate);
      }
      if (tier === "audited") expect(row.audit.fixture_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("no deep rows remain in the public quality table (D-R2-41)", () => {
    const kinds = (
      JSON.parse(readFileSync(publicQualityPath, "utf8")).collections as { kind: string }[]
    ).map((r) => r.kind);
    expect(kinds).not.toContain("deep");
  });

  // Design doc 41 D1: themes that pass every automatic check are published
  // as unaudited; none can be audited without a human fixture, and every
  // row's eligibility must agree with the builder's written tier.
  it("theme artifacts are audited only with a human fixture, and eligibility matches the written tier", () => {
    const rows = publicQuality?.collections.filter((row) => row.kind === "theme") ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.publication_tier).toBeDefined();
      const tier = qualityRowPublishedTier(row);
      expect(tier ?? "blocked").toBe(row.publication_tier);
      if (tier === "audited") expect(row.audit.fixture_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("bounded JSON fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the existing two-argument conference fetch contract remains compatible", async () => {
    const compatibleBytes = new TextEncoder().encode('{"ok":true}');
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () =>
          compatibleBytes.buffer.slice(
            compatibleBytes.byteOffset,
            compatibleBytes.byteOffset + compatibleBytes.byteLength,
          ),
      })),
    );
    const compatible = await fetchJsonWithSha256<{ ok: boolean }>("compatible.json");
    expect(compatible?.data?.ok).toBe(true);
    expect(compatible?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an oversized Content-Length before body allocation", async () => {
    let arrayBufferCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: {
          get: (name: string) => (name === "content-length" ? String(MAX_JSON_BYTES + 1) : null),
        },
        arrayBuffer: async () => {
          arrayBufferCalled = true;
          return new ArrayBuffer(0);
        },
      })),
    );
    expect(await fetchJsonWithSha256("oversize.json")).toBeNull();
    expect(arrayBufferCalled).toBe(false);
  });

  it("cancels a streaming response as soon as the byte limit is exceeded", async () => {
    let cancelled = false;
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              reads++;
              return reads === 1
                ? { done: false, value: new Uint8Array(MAX_JSON_BYTES + 1) }
                : { done: true, value: undefined };
            },
            cancel: async () => {
              cancelled = true;
            },
          }),
        },
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    expect(await fetchJsonWithSha256("stream-oversize.json")).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("enforces the byte limit after allocation on the non-streaming fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(MAX_JSON_BYTES + 1),
      })),
    );
    expect(await fetchJsonWithSha256("fallback-oversize.json")).toBeNull();
  });

  // P2 review LOW: the `expectedSha256` verification branch itself
  // (as opposed to the byte-limit/streaming behavior above) had no
  // test -- neither the mismatch rejection nor the matching-hash
  // success path.
  function stubFetchReturning(bytes: Uint8Array) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      })),
    );
  }

  async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  it("returns the data when expectedSha256 matches the fetched bytes", async () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    const realHash = await sha256Hex(bytes);
    stubFetchReturning(bytes);
    const result = await fetchJsonWithSha256<{ ok: boolean }>("matching.json", undefined, {
      expectedSha256: realHash,
    });
    expect(result?.data?.ok).toBe(true);
    expect(result?.sha256).toBe(realHash);
  });

  it("returns null when expectedSha256 does not match the fetched bytes (hash mismatch)", async () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    const wrongHash = "0".repeat(64);
    stubFetchReturning(bytes);
    const result = await fetchJsonWithSha256("mismatch.json", undefined, {
      expectedSha256: wrongHash,
    });
    expect(result).toBeNull();
  });

  it("rejects a malformed expectedSha256 before ever calling fetch", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchJsonWithSha256("whatever.json", undefined, {
      expectedSha256: "not-a-sha256",
    });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("R2-26: a node never shows another paper's abstract", () => {
  it("drops a node's foreign abstract (the OpenAlex Longformer record carried 'Murmurative Attention')", () => {
    // Synthetic copy of the published flash-attention artifact: regenerations
    // already drop the bad abstract at generation time, so the published file
    // can no longer be the fixture for the read-time guard.
    const path = join(layoutFor(REPO_ROOT).published, "themes", "flash-attention", "lineage.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      nodes: Array<{ id: string; title?: string; tldr?: string; short_abstract?: string }>;
    };
    const target = raw.nodes.find((n) => n.tldr);
    expect(target).toBeTruthy();
    if (!target) return;
    target.title = "Longformer: The Long-Document Transformer";
    // The text OpenAlex W3015468748 actually carried (same as core's licensing test).
    target.tldr =
      "The quadratic complexity of standard attention remains the dominant bottleneck for training and deploying large language models on long sequences. We introduce Murmurative Attention, a novel attention mechanism that replaces pairwise token-token interactions with token-to-slot interactions.";
    target.short_abstract = target.tldr;
    const parsed = parseArtifact(raw, { kind: "theme" });
    expect(parsed).not.toBeNull();
    const nodes = parsed?.nodes ?? [];
    const longformer = nodes.find((n) => String(n.title).startsWith("Longformer"));
    expect(longformer).toBeTruthy();
    expect(JSON.stringify(longformer)).not.toContain("Murmurative");
    // Every other node keeps its excerpt: only the injected one is emptied.
    const withText = (list: ReadonlyArray<object>) =>
      list.filter((n) => {
        const t = (n as { tldr?: unknown }).tldr;
        return typeof t === "string" && t !== "";
      }).length;
    const baseline = parseArtifact(JSON.parse(readFileSync(path, "utf8")), { kind: "theme" });
    expect(withText(nodes)).toBe(withText(baseline?.nodes ?? []) - 1);
  });

  it("leaves a consistent node untouched", () => {
    const node = {
      id: "x",
      title: "Longformer: The Long-Document Transformer",
      tldr: "We introduce the Longformer.",
    };
    expect(withoutForeignAbstract(node)).toBe(node);
  });
});
