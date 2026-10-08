// Port of paperpilot/tests/viewer/test_theme_lineage_contract.mjs's
// BEHAVIOURAL contract (the quality-gate decision logic). The original
// file's STATIC contract half (grepping docs/assets/theme.js's source
// text for specific call-site strings) doesn't apply here: this page
// was rewritten in TypeScript/React rather than edited in place, so
// there is no theme.js source text to grep. The behaviours those greps
// stood in for are instead exercised directly and end-to-end below
// (quality-row resolution, byte-hash gating, strict artifact parsing,
// and lib/data-themes.ts's fetchThemeArtifact wiring them together the
// same way docs/assets/theme.js's loadThemeArtifact() did).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLineageQualityManifest, fetchThemeArtifact } from "../../lib/data-themes";
import { eligibleThemeManifest } from "../../lib/themes-gallery";
import type {
  LineageProvenance,
  QualityAudit,
  QualityManifest,
  QualityRow,
} from "../../lib/themes-quality";
import {
  parseArtifact,
  parseQualityManifest,
  qualityRowIsEligible,
  qualityRowIsPublishable,
  resolveFocus,
  resolveQualityCollection,
} from "../../lib/themes-quality";

const PAPER_ID = "1".repeat(40);
const OTHER_PAPER_ID = "2".repeat(40);

const provenance: LineageProvenance = {
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

function themeArtifactFixture() {
  return {
    schema_version: "lineage-artifact-v1",
    root: "seed-a",
    nodes: [
      { id: "child", title: "Child", is_focus: false },
      {
        id: "seed-a",
        title: "Seed A",
        is_focus: true,
        seed_paper_id: PAPER_ID,
        aliases: [["arxiv", "2601.00001"]],
      },
      { id: "seed-b", title: "Seed B", is_focus: true, seed_paper_id: OTHER_PAPER_ID },
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
    clusters: [] as unknown[],
    meta: {
      kind: "theme",
      generator: "paperpilot.scripts.build_theme_lineage",
      generated_at: "2026-08-30T00:00:00Z",
    },
  };
}

function qualityAuditFixture(): QualityAudit {
  return {
    fixture_sha256: "9".repeat(64),
    evaluated_at: "2026-08-30T00:00:00Z",
    actor: "ci:audit-v1",
    checks: [
      { name: "artifact_contract_v1", status: "passed", observed: 0, expected: 0, evidence: [] },
      {
        name: "golden_fixture",
        status: "passed",
        observed: "fixture-sha",
        expected: "matching frozen fixture",
        evidence: [],
      },
    ],
  };
}

function themeQualityRow(overrides: Partial<QualityRow> = {}): QualityRow {
  return {
    collection_id: "theme:test-theme",
    kind: "theme",
    slug: "test-theme",
    label: "Test Theme",
    path: "themes/test-theme/lineage.json",
    availability: "ready",
    audit_status: "passed",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 3,
    edge_count: 2,
    artifact_schema_version: "lineage-artifact-v1",
    input_sha256: null,
    audit: qualityAuditFixture(),
    ...overrides,
  };
}

function qualityManifestFixture(row: QualityRow): QualityManifest {
  return {
    schema_version: "lineage-quality-v1",
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections: [row],
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(text: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function stubFetchRoutes(routes: Record<string, Response | (() => Response)>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const route = routes[url];
      if (!route) return new Response("not found", { status: 404 });
      return typeof route === "function" ? route() : route;
    }),
  );
  return calls;
}

describe("quality gate behaviour (lib/themes-quality.ts + lib/data-themes.ts)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parseArtifact + parseQualityManifest round-trip a well-formed theme fixture", async () => {
    const artifactText = JSON.stringify(themeArtifactFixture());
    const parsed = parseArtifact(JSON.parse(artifactText), { kind: "theme" });
    expect(parsed).not.toBeNull();
    expect(parsed?.nodes).toHaveLength(3);
    expect(
      parsed?.edges.every(
        (e) => typeof e.relation === "string" && typeof e.confidence === "number",
      ),
    ).toBe(true);
  });

  it("ready+passed row with exact SHA renders the strict theme artifact via fetchThemeArtifact", async () => {
    const artifactText = JSON.stringify(themeArtifactFixture());
    const artifactSha = await sha256Hex(new TextEncoder().encode(artifactText));
    const row = themeQualityRow({ input_sha256: artifactSha });
    const manifest = qualityManifestFixture(row);
    const calls = stubFetchRoutes({
      "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)),
      "/themes/test-theme/lineage.json": jsonResponse(artifactText),
    });
    const quality = await fetchLineageQualityManifest();
    const data = await fetchThemeArtifact("test-theme", quality);
    expect(data).not.toBeNull();
    expect(data?.nodes).toHaveLength(3);
    expect(calls).toEqual(["/lineage-quality-v1.json", "/themes/test-theme/lineage.json"]);
  });

  it("audit-failed row never fetches the artifact", async () => {
    const row = themeQualityRow({ audit_status: "failed" });
    const manifest = qualityManifestFixture(row);
    const calls = stubFetchRoutes({
      "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)),
    });
    const quality = await fetchLineageQualityManifest();
    const data = await fetchThemeArtifact("test-theme", quality);
    expect(data).toBeNull();
    expect(calls).toEqual(["/lineage-quality-v1.json"]);
  });

  it("unavailable row never fetches the artifact", async () => {
    const row = themeQualityRow({ availability: "unavailable" });
    const manifest = qualityManifestFixture(row);
    stubFetchRoutes({ "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)) });
    const quality = await fetchLineageQualityManifest();
    expect(await fetchThemeArtifact("test-theme", quality)).toBeNull();
  });

  it("artifact hash mismatch fails closed before JSON parsing", async () => {
    const artifactText = JSON.stringify(themeArtifactFixture());
    const row = themeQualityRow({ input_sha256: "e".repeat(64) });
    const manifest = qualityManifestFixture(row);
    stubFetchRoutes({
      "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)),
      "/themes/test-theme/lineage.json": jsonResponse(artifactText),
    });
    const quality = await fetchLineageQualityManifest();
    expect(await fetchThemeArtifact("test-theme", quality)).toBeNull();
  });

  it("oversized artifact (declared content-length > 8MB) is rejected before body allocation", async () => {
    const artifactText = JSON.stringify(themeArtifactFixture());
    const row = themeQualityRow({
      input_sha256: await sha256Hex(new TextEncoder().encode(artifactText)),
    });
    const manifest = qualityManifestFixture(row);
    stubFetchRoutes({
      "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)),
      "/themes/test-theme/lineage.json": () =>
        jsonResponse(artifactText, { "content-length": String(8 * 1024 * 1024 + 1) }),
    });
    const quality = await fetchLineageQualityManifest();
    expect(await fetchThemeArtifact("test-theme", quality)).toBeNull();
  });

  it("legacy rel/conf-only artifact (no relation/confidence) is rejected", () => {
    const legacy = themeArtifactFixture();
    for (const edge of legacy.edges as Array<Record<string, unknown>>) {
      delete edge.relation;
      delete edge.confidence;
    }
    expect(parseArtifact(legacy, { kind: "theme" })).toBeNull();
  });

  it("theme focus without seed_paper_id is rejected", () => {
    const seedless = themeArtifactFixture();
    delete (seedless.nodes[2] as Record<string, unknown>).seed_paper_id;
    expect(parseArtifact(seedless, { kind: "theme" })).toBeNull();
  });

  it.each([
    [
      "wrong theme meta kind",
      (v: ReturnType<typeof themeArtifactFixture>) => {
        v.meta.kind = "conference";
      },
    ],
    [
      "missing theme generator",
      (v: ReturnType<typeof themeArtifactFixture>) => {
        delete (v.meta as Record<string, unknown>).generator;
      },
    ],
    [
      "invalid theme generated_at",
      (v: ReturnType<typeof themeArtifactFixture>) => {
        v.meta.generated_at = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "non-empty theme clusters",
      (v: ReturnType<typeof themeArtifactFixture>) => {
        v.clusters = [{ id: "legacy" }];
      },
    ],
  ])("%s is rejected", (_label, mutate) => {
    const invalid = themeArtifactFixture();
    mutate(invalid);
    expect(parseArtifact(invalid, { kind: "theme" })).toBeNull();
  });

  it("unknown theme alias namespace is rejected", () => {
    const invalid = themeArtifactFixture();
    (invalid.nodes[1] as { aliases: unknown }).aliases = [["semantic_scholar", "seed-a"]];
    expect(parseArtifact(invalid, { kind: "theme" })).toBeNull();
  });

  it("contradictory passed audit checks fail before the artifact fetch", async () => {
    const row = themeQualityRow();
    row.audit.checks[1] = { ...row.audit.checks[1]!, status: "failed" };
    const manifest = qualityManifestFixture(row);
    const calls = stubFetchRoutes({
      "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)),
    });
    const quality = await fetchLineageQualityManifest();
    expect(await fetchThemeArtifact("test-theme", quality)).toBeNull();
    expect(calls).toEqual(["/lineage-quality-v1.json"]);
  });

  it("passed row without a frozen fixture hash fails before the artifact fetch", async () => {
    const row = themeQualityRow();
    row.audit.fixture_sha256 = null;
    const manifest = qualityManifestFixture(row);
    stubFetchRoutes({ "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)) });
    const quality = await fetchLineageQualityManifest();
    expect(await fetchThemeArtifact("test-theme", quality)).toBeNull();
  });

  it("malformed quality manifest (bad audit_version) fails closed", async () => {
    const row = themeQualityRow();
    const manifest = qualityManifestFixture(row);
    (manifest as { audit_version: string }).audit_version = "audit-v2";
    stubFetchRoutes({ "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)) });
    expect(await fetchLineageQualityManifest()).toBeNull();
  });

  it("missing quality manifest (404) fails closed without fetching any artifact", async () => {
    const calls = stubFetchRoutes({});
    expect(await fetchLineageQualityManifest()).toBeNull();
    expect(calls).toEqual(["/lineage-quality-v1.json"]);
  });

  it("slug without a quality row never reaches the network for an artifact", async () => {
    const row = themeQualityRow();
    const manifest = qualityManifestFixture(row);
    const calls = stubFetchRoutes({
      "/lineage-quality-v1.json": jsonResponse(JSON.stringify(manifest)),
    });
    const quality = await fetchLineageQualityManifest();
    expect(await fetchThemeArtifact("other-theme", quality)).toBeNull();
    expect(calls).toEqual(["/lineage-quality-v1.json"]);
  });

  it("gallery eligibility cannot be inferred from legacy manifest counts alone", async () => {
    const passedRow = themeQualityRow({ input_sha256: "f".repeat(64) });
    const failedRow = themeQualityRow({
      collection_id: "theme:failed-theme",
      slug: "failed-theme",
      label: "Failed Theme",
      path: "themes/failed-theme/lineage.json",
      audit_status: "failed",
    });
    const manifest = [
      { slug: "test-theme", theme: "Test Theme", paper_count: 3 },
      { slug: "failed-theme", theme: "Failed Theme", paper_count: 40 },
    ];
    const passedQuality = parseQualityManifest(qualityManifestFixture(passedRow));
    expect(eligibleThemeManifest(manifest, passedQuality).map((e) => e.slug)).toEqual([
      "test-theme",
    ]);
    const failedQuality = parseQualityManifest(qualityManifestFixture(failedRow));
    expect(eligibleThemeManifest(manifest, failedQuality)).toEqual([]);
  });

  it("resolveFocus: canonical 40-hex miss never falls through to a graph-local ID", () => {
    const data = { root: "a", nodes: [{ id: "a", is_focus: true, seed_paper_id: PAPER_ID }] };
    expect(resolveFocus(data, OTHER_PAPER_ID)).toBeNull();
  });

  it("resolveFocus: empty/undefined raw resolves to the declared root", () => {
    const data = {
      root: "a",
      nodes: [
        { id: "a", is_focus: true },
        { id: "b", is_focus: false },
      ],
    };
    expect(resolveFocus(data, null)?.id).toBe("a");
  });

  it("qualityRowIsEligible / qualityRowIsPublishable agree with resolveQualityCollection", () => {
    const row = themeQualityRow({ input_sha256: "f".repeat(64) });
    const manifest = parseQualityManifest(qualityManifestFixture(row));
    const resolved = resolveQualityCollection(manifest, { kind: "theme", slug: "test-theme" });
    expect(qualityRowIsEligible(resolved)).toBe(true);
    expect(qualityRowIsPublishable(resolved, { artifactSha256: "f".repeat(64) })).toBe(true);
    expect(qualityRowIsPublishable(resolved, { artifactSha256: "0".repeat(64) })).toBe(false);
  });
});
