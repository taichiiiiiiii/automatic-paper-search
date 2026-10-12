/**
 * R2-32 (design 41): unit tests of the LLM-free conference (edition)
 * lineage — seed matching against the catalog, the seed-ranking cache, the
 * conference quality gate and the conference publish guard.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  editionOf,
  matchCatalog,
  type RankedHit,
  rankedEdition,
  SEED_CACHE_SCHEMA,
} from "../../../src/lineage/conference/editionLineage.js";
import {
  collectionRow,
  conferenceGateFromPolicy,
} from "../../../src/lineage/quality/buildLineageQuality.js";
import {
  evaluateTheme,
  loadGuardContext,
  publishedTheme,
  regressionRefusal,
} from "../../../src/lineage/theme/publishGuard.js";
import type { S2CitationSource, S2EdgePaper } from "../../../src/lineage/theme/s2Citations.js";

const PID = (n: number): string => n.toString(16).padStart(40, "0");
const S2 = (n: number): string => `a${n.toString(16).padStart(39, "0")}`;

function hit(n: number, title: string, cites: number, arxiv: string | null = null): RankedHit {
  return {
    paperId: S2(n),
    title,
    year: 2025,
    citationCount: cites,
    arxiv,
    doi: null,
    venue: "ICML",
    authors: [],
  };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("editionOf", () => {
  it("splits family and year, rejecting slugs without a year", () => {
    expect(editionOf("icml-2025")).toEqual({ family: "icml", year: 2025 });
    expect(editionOf("neurips-2025")).toEqual({ family: "neurips", year: 2025 });
    expect(() => editionOf("icml")).toThrow();
  });
});

describe("matchCatalog", () => {
  const rows = [
    { paper_id: PID(1), title: "SFT Memorizes, RL Generalizes", arxiv_id: "" },
    {
      paper_id: PID(2),
      title: "KernelBench: Can LLMs Write Efficient GPU Kernels?",
      arxiv_id: "2502.10517",
    },
    { paper_id: PID(3), title: "Duplicate Title Here", arxiv_id: "" },
    { paper_id: PID(4), title: "Duplicate Title Here", arxiv_id: "" },
    { paper_id: "not-a-paper-id", title: "Broken Row Title", arxiv_id: "" },
  ];

  it("matches by arXiv id first, then exact normalized title, in citation order", () => {
    const out = matchCatalog(
      [
        hit(2, "KernelBench (renamed)", 265, "2502.10517"),
        hit(1, "SFT memorizes, RL generalizes", 759),
        hit(9, "Unknown paper of the edition", 999),
      ],
      rows,
    );
    expect(out.map((m) => [m.paperId, m.matchedBy])).toEqual([
      [PID(1), "title"],
      [PID(2), "arxiv"],
    ]);
  });

  it("never matches an ambiguous title (two catalog rows or two hits)", () => {
    expect(matchCatalog([hit(3, "Duplicate Title Here", 10)], rows)).toEqual([]);
    expect(
      matchCatalog(
        [hit(5, "SFT Memorizes, RL Generalizes", 9), hit(6, "SFT memorizes RL generalizes", 8)],
        rows,
      ),
    ).toEqual([]);
    expect(matchCatalog([hit(7, "Broken Row Title", 10)], rows)).toEqual([]);
  });

  it("is deterministic: equal citation counts order by S2 id", () => {
    const a = matchCatalog(
      [hit(2, "x", 5, "2502.10517"), hit(1, "SFT Memorizes, RL Generalizes", 5)],
      rows,
    );
    const b = matchCatalog(
      [hit(1, "SFT Memorizes, RL Generalizes", 5), hit(2, "x", 5, "2502.10517")],
      rows,
    );
    expect(a.map((m) => m.paperId)).toEqual(b.map((m) => m.paperId));
    expect(a[0]?.hit.paperId).toBe(S2(1));
  });
});

describe("rankedEdition cache", () => {
  function fakeS2(answer: S2EdgePaper[] | null): { s2: S2CitationSource; calls: () => number } {
    let calls = 0;
    const s2 = {
      lastListFailed: false,
      async searchVenue() {
        calls += 1;
        return answer;
      },
    } as unknown as S2CitationSource;
    return { s2, calls: () => calls };
  }

  it("fetches once, then serves the cached ranking within the TTL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edition-"));
    dirs.push(dir);
    const cachePath = join(dir, "conference_seeds.json");
    const { s2, calls } = fakeS2([
      {
        paperId: S2(1),
        title: "A paper",
        year: 2025,
        citationCount: 3,
        externalIds: { ArXiv: "2501.00001" },
      },
      { paperId: "bad", title: "dropped: not an S2 id" },
    ]);
    let now = new Date("2026-10-12T00:00:00Z");
    const deps = { s2, seedCachePath: cachePath, now: () => now };
    const first = await rankedEdition("icml-2025", "ICML", 2025, deps);
    expect(first?.cached).toBe(false);
    expect(first?.hits.map((h) => [h.paperId, h.arxiv])).toEqual([[S2(1), "2501.00001"]]);
    expect(JSON.parse(readFileSync(cachePath, "utf8")).schema_version).toBe(SEED_CACHE_SCHEMA);
    now = new Date("2026-10-30T00:00:00Z");
    expect((await rankedEdition("icml-2025", "ICML", 2025, deps))?.cached).toBe(true);
    expect(calls()).toBe(1);
    now = new Date("2026-11-20T00:00:00Z"); // > 30 days: refetch
    expect((await rankedEdition("icml-2025", "ICML", 2025, deps))?.cached).toBe(false);
    expect(calls()).toBe(2);
  });

  it("returns null when S2 failed and never caches a failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edition-"));
    dirs.push(dir);
    const cachePath = join(dir, "conference_seeds.json");
    writeFileSync(cachePath, "not json");
    const { s2 } = fakeS2(null);
    expect(
      await rankedEdition("icml-2025", "ICML", 2025, {
        s2,
        seedCachePath: cachePath,
        now: () => new Date(),
      }),
    ).toBeNull();
    expect(readFileSync(cachePath, "utf8")).toBe("not json");
  });
});

/** A minimal contract-valid conference artifact. */
function conferenceArtifact(options: {
  nodes: number;
  lineageEdges: number;
  generatedAt: string;
  method?: string;
}): Record<string, unknown> {
  const ids = Array.from({ length: options.nodes }, (_, i) => S2(i + 1));
  const prov = (method: string) => ({
    producer: { name: "p", version: "1" },
    evidence: { source: "semantic_scholar", kind: "citation-context", sha256: "0".repeat(64) },
    classification: {
      method,
      provider: null,
      model: null,
      prompt_version: null,
      schema_version: "v1",
    },
  });
  const edges = ids.slice(1).map((dst, i) => {
    const relation = i < options.lineageEdges ? "extends" : "baseline_only";
    return {
      src: ids[0],
      dst,
      rel: relation,
      relation,
      conf: 0.8,
      confidence: 0.8,
      rationale: "quoted",
      provenance: prov(options.method ?? "s2_context_rule"),
    };
  });
  const breakdown = { [options.method ?? "s2_context_rule"]: edges.length };
  return {
    schema_version: "lineage-artifact-v1",
    root: ids[0],
    nodes: ids.map((id, i) => ({
      id,
      title: `Paper ${i}`,
      year: 2025,
      is_focus: i === 0,
      ...(i === 0 ? { seed_paper_id: PID(1) } : {}),
    })),
    edges,
    clusters: [],
    meta: {
      kind: "conference",
      generated_at: options.generatedAt,
      provenance_breakdown: breakdown,
    },
  };
}

const POLICY = {
  conference_max_age_days: 30,
  theme_max_age_days: 90,
  theme_min_evidence_classified_rate: 0.8,
  theme_min_generated_at: "2026-10-11T00:00:00Z",
  conference_min_generated_at: "2026-10-12T14:00:00Z",
};

function confRow(artifact: Record<string, unknown>, policy: Record<string, unknown> = POLICY) {
  return collectionRow({
    docsRoot: "",
    kind: "conference",
    slug: "icml-2025",
    label: "ICML 2025",
    relativePath: "icml-2025/lineage.json",
    snapshotDate: null,
    generatedHint: null,
    fixture: null,
    asOfText: "2026-10-13T00:00:00Z",
    maxAgeDays: 30,
    catalogIds: new Set([PID(1)]),
    themeGate: conferenceGateFromPolicy(policy as never),
    payload: Buffer.from(JSON.stringify(artifact)),
  });
}

describe("conference quality gate (design 41 R2-32)", () => {
  it("uses the theme thresholds with conference_min_generated_at", () => {
    expect(conferenceGateFromPolicy(POLICY as never)).toMatchObject({
      minClassifiedRate: 0.8,
      minGeneratedAt: "2026-10-12T14:00:00Z",
      minEdges: 3,
      minNodes: 8,
      minLineageEdges: 3,
    });
    // Always on, even when the policy has no theme keys.
    expect(
      conferenceGateFromPolicy({ conference_max_age_days: 30, theme_max_age_days: 90 }),
    ).toMatchObject({ minClassifiedRate: 0.8, minGeneratedAt: null, minNodes: 8 });
  });

  it("publishes a passing conference lineage as unaudited", () => {
    const row = confRow(
      conferenceArtifact({ nodes: 9, lineageEdges: 3, generatedAt: "2026-10-12T15:00:00Z" }),
    );
    expect(row.audit.checks.filter((c) => c.status === "failed")).toEqual([]);
    expect(row.publication_tier).toBe("unaudited");
  });

  it("blocks old-generator, small, under-evidenced or guess-only conference lineages", () => {
    const failed = (a: Record<string, unknown>) =>
      confRow(a)
        .audit.checks.filter((c) => c.status === "failed")
        .map((c) => c.name);
    expect(
      failed(
        conferenceArtifact({ nodes: 9, lineageEdges: 3, generatedAt: "2026-10-01T00:00:00Z" }),
      ),
    ).toEqual(["generator_current"]);
    expect(
      failed(
        conferenceArtifact({ nodes: 5, lineageEdges: 3, generatedAt: "2026-10-12T15:00:00Z" }),
      ),
    ).toEqual(["node_count"]);
    expect(
      failed(
        conferenceArtifact({ nodes: 9, lineageEdges: 2, generatedAt: "2026-10-12T15:00:00Z" }),
      ),
    ).toEqual(["lineage_relation_count"]);
    expect(
      failed(
        conferenceArtifact({
          nodes: 9,
          lineageEdges: 3,
          generatedAt: "2026-10-12T15:00:00Z",
          method: "citation_heuristic",
        }),
      ),
    ).toEqual(["evidence_classified_rate"]);
  });
});

describe("conference publish guard", () => {
  const ctx = loadGuardContext({
    policyPath: null,
    fixturesPath: null,
    minClassifiedRate: 0.8,
    now: () => new Date("2026-10-13T00:00:00Z"),
  });
  ctx.policy = { ...ctx.policy, ...POLICY };
  const target = { kind: "conference" as const, catalogIds: new Set([PID(1)]) };
  const bytes = (a: Record<string, unknown>) => Buffer.from(JSON.stringify(a));

  it("refuses a blocked rebuild of a published conference lineage, allows a passing one", () => {
    const good = conferenceArtifact({
      nodes: 9,
      lineageEdges: 3,
      generatedAt: "2026-10-12T15:00:00Z",
    });
    const bad = conferenceArtifact({
      nodes: 5,
      lineageEdges: 3,
      generatedAt: "2026-10-12T15:00:00Z",
    });
    const published = publishedTheme(bytes(good), "icml-2025", ctx, target);
    expect(published?.tier).toBe("unaudited");
    const refusal = regressionRefusal(
      published,
      evaluateTheme(bytes(bad), "icml-2025", ctx, { target }),
      {
        allowShrink: false,
        noun: "conference lineage",
      },
    );
    expect(refusal).toContain("published unaudited conference lineage");
    expect(
      regressionRefusal(published, evaluateTheme(bytes(good), "icml-2025", ctx, { target }), {
        allowShrink: false,
      }),
    ).toBeNull();
  });

  it("lets any build replace a blocked (old-generator) conference lineage", () => {
    const old = conferenceArtifact({
      nodes: 9,
      lineageEdges: 3,
      generatedAt: "2026-06-28T00:00:00Z",
    });
    const published = publishedTheme(bytes(old), "icml-2025", ctx, target);
    expect(published?.tier).toBe("blocked");
    const small = conferenceArtifact({
      nodes: 5,
      lineageEdges: 1,
      generatedAt: "2026-10-12T15:00:00Z",
    });
    expect(
      regressionRefusal(published, evaluateTheme(bytes(small), "icml-2025", ctx, { target }), {
        allowShrink: false,
      }),
    ).toBeNull();
  });
});
