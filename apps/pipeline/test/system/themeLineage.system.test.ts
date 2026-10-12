/**
 * System test (a): theme lineage, end to end through the REAL CLIs.
 *
 *   theme CLI (LLM off, recorded OpenAlex / Semantic Scholar / GitHub)
 *   -> release CLI `package` (candidate, as regen-themes.yml)
 *   -> promote() into a bare origin with the real refresh table
 *      (themes manifest, theme quality, lineage-quality at as_of) and the
 *      data audits
 *   -> schema validation + publication invariants on what origin now holds.
 *
 * Fixtures: `fixtures/theme-http` — one polite live recording of
 * `--theme "Flash Attention" --depth 1 --seeds 5 --width 8` (the
 * production regen parameters), trimmed and replay-verified byte-identical
 * (see fixtures/README.md).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { validateArtifact } from "@paperpilot/core/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evidenceClassifiedRate,
  UNCLASSIFIED_METHODS,
} from "../../src/lineage/theme/classificationGate.js";
import { originFile, promoteInSandbox, type SpawnRecord } from "./support/promoteHarness.js";
import { type CliRun, describeRun, runCli } from "./support/runCli.js";
import { createSandbox, type Sandbox } from "./support/sandbox.js";
import { THEME_ARGS, THEME_DIR } from "./support/scenarios.js";

const LINEAGE = `${THEME_DIR}/lineage.json`;
const LLM_HOSTS = ["api.groq.com", "generativelanguage.googleapis.com", "api.anthropic.com"];
const PUBLISHED_SEEDS = [
  "openalex:W4281758439",
  "openalex:W4384648639",
  "openalex:W4400611982",
  "openalex:W4405090274",
  "openalex:W7154502343",
];

interface Edge {
  src: string;
  dst: string;
  rel: string;
  provenance: {
    evidence: { source: string; kind: string; sha256?: string };
    classification: { method: string; provider: string | null; model: string | null };
  };
}
interface Lineage {
  root: string;
  nodes: { id: string; citation_count?: number; citation_count_source?: string }[];
  edges: Edge[];
  meta: Record<string, unknown> & { provenance_breakdown: Record<string, number> };
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function expectSchema(name: string, data: unknown): void {
  const r = validateArtifact(name, data);
  expect(r.errors ?? [], `${name}: ${JSON.stringify(r.errors?.slice(0, 5))}`).toEqual([]);
  expect(r.ok).toBe(true);
}

const policy = JSON.parse(
  readFileSync(
    new URL("../../../../data/config/lineage-quality-policy-v1.json", import.meta.url),
    "utf8",
  ),
) as { strong_relations: string[]; theme_min_evidence_classified_rate: number };

describe("theme lineage: build (LLM off) -> package -> promote -> validate", () => {
  let sb: Sandbox;
  let build: CliRun;
  let oldLineage: string;
  const spawnLog: SpawnRecord[] = [];

  beforeAll(async () => {
    sb = createSandbox({
      copyData: [THEME_DIR, "data/published/identity-aliases-v1.json"],
      // A themes-only tree: no conference catalogs to fold into lineage-quality.
      files: { "data/published/conferences.json": [] },
    });
    oldLineage = readFileSync(sb.path(LINEAGE), "utf8");
    build = await runCli(
      sb,
      "lineage/theme/cli.ts",
      [...THEME_ARGS, "--result-json", sb.path("..", "result.json")],
      { fixtures: ["theme-s2-counts", "theme-http"] },
    );
  });
  afterAll(() => sb?.cleanup());

  it("builds from recorded APIs only, with no LLM call", () => {
    expect(build.code, describeRun(build)).toBe(0);
    expect(build.requests.filter((r) => r.outcome === "miss")).toEqual([]);
    expect(build.requests.some((r) => LLM_HOSTS.some((h) => r.url.includes(h)))).toBe(false);
    const result = JSON.parse(readFileSync(sb.path("..", "result.json"), "utf8"));
    expect(result).toMatchObject({ status: "ok", exit_code: 0, lineage_llm: "off" });
  });

  it("writes a schema-valid artifact with canonical seeds and evidence-backed relations", () => {
    const text = readFileSync(sb.path(LINEAGE), "utf8");
    expect(text).not.toBe(oldLineage);
    const lin = JSON.parse(text) as Lineage;
    expectSchema("lineage-artifact-v1", lin);

    // Canonical seeds: the same five FlashAttention papers production picked.
    expect(lin.meta.seeds).toEqual(PUBLISHED_SEEDS);
    expect(lin.root).toBe("openalex:W4281758439");
    expect(lin.meta.lineage_llm).toBe("off");
    expect(lin.nodes.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(lin.nodes.map((n) => n.id));
    expect(ids.size).toBe(lin.nodes.length);

    // The breakdown in meta is exactly what the edges carry …
    const recount: Record<string, number> = {};
    for (const e of lin.edges) {
      const m = e.provenance.classification.method;
      recount[m] = (recount[m] ?? 0) + 1;
      expect(ids.has(e.src) && ids.has(e.dst), `${e.src}->${e.dst}`).toBe(true);
      // LLM off: no edge may claim an LLM provider/model.
      expect(e.provenance.classification.provider).toBeNull();
      expect(e.provenance.classification.model).toBeNull();
    }
    expect(recount).toEqual(lin.meta.provenance_breakdown);
    // … and its evidence-classified share clears the publication policy.
    const rate = evidenceClassifiedRate(recount);
    expect(rate.ratio ?? 0).toBeGreaterThanOrEqual(policy.theme_min_evidence_classified_rate);

    // Every strong relation is backed by API evidence, never a guess.
    const strong = lin.edges.filter((e) => policy.strong_relations.includes(e.rel));
    expect(strong.length).toBeGreaterThanOrEqual(3);
    for (const e of strong) {
      expect(UNCLASSIFIED_METHODS.has(e.provenance.classification.method)).toBe(false);
      expect(e.provenance.evidence.source).toBe("semantic_scholar");
      expect(e.provenance.evidence.sha256 ?? "").toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("publishes the larger of OpenAlex's and Semantic Scholar's citation count (R2-36)", () => {
    const lin = JSON.parse(readFileSync(sb.path(LINEAGE), "utf8")) as Lineage;
    const old = JSON.parse(oldLineage) as Lineage;
    const byId = new Map(lin.nodes.map((n) => [n.id, n]));
    const oldById = new Map(old.nodes.map((n) => [n.id, n]));
    // FlashAttention: S2 6,543 > OpenAlex 454 -> S2's count, source recorded.
    const fa = byId.get("openalex:W4281758439");
    expect(fa?.citation_count).toBe(6543);
    expect(fa?.citation_count_source).toBe("semantic_scholar");
    expect((oldById.get("openalex:W4281758439")?.citation_count ?? 0) < 6543).toBe(true);
    // FlashAttention-2: S2 12 < OpenAlex -> OpenAlex's count, no source field.
    const fa2 = byId.get("openalex:W4384648639");
    expect(fa2?.citation_count).toBe(oldById.get("openalex:W4384648639")?.citation_count);
    expect(fa2?.citation_count).toBeGreaterThan(12);
    expect(fa2).not.toHaveProperty("citation_count_source");
    // The only S2 count request is one keyless batch POST.
    const batches = build.requests.filter((r) => r.url.includes("/paper/batch"));
    expect(batches.map((r) => r.method)).toEqual(["POST"]);
  });

  it("promotes into origin with refreshed, hash-bound quality data", async () => {
    const candidate = sb.path("..", "candidate");
    const allowed = [
      "data/published/themes",
      "data/state/lineage-cache/s2_references.json",
      "data/state/lineage-cache/github_stars.json",
    ].filter((p) => existsSync(sb.path(p)));
    const pkg = await runCli(sb, "release/cli.ts", ["package", candidate, ...allowed], {
      env: { PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED: "1" },
    });
    expect(pkg.code, describeRun(pkg)).toBe(0);

    const asOf = `${new Date().toISOString().slice(0, 19)}Z`;
    const baseSha = sb.git("rev-parse", "HEAD");
    const res = await promoteInSandbox(sb, {
      kind: "themes",
      candidateDir: candidate,
      allowedPaths: allowed,
      baseSha,
      asOf,
      log: spawnLog,
    }).catch((e: Error) => {
      throw new Error(
        `${e.message}\n${spawnLog.map((s) => `${s.argv.join(" ")} -> ${s.exitCode}\n${s.output.slice(-1500)}`).join("\n")}`,
      );
    });
    expect(res.changed).toBe(true);
    expect(spawnLog.map((s) => s.exitCode)).toEqual(spawnLog.map(() => 0));
    expect(spawnLog.map((s) => s.argv[3])).toEqual([
      "apps/pipeline/src/lineage/theme/generateThemesManifestCli.ts",
      "apps/pipeline/src/lineage/theme/computeThemeQualityCli.ts",
      "apps/pipeline/src/lineage/quality/buildLineageQualityCli.ts",
      "apps/pipeline/src/lineage/theme/auditThemeSeedsCli.ts",
      "apps/pipeline/src/lineage/quality/auditLineageQualityCli.ts",
    ]);

    const promoted = originFile(sb, LINEAGE);
    expect(promoted).toBe(readFileSync(sb.path(LINEAGE), "utf8"));
    const quality = JSON.parse(originFile(sb, "data/published/lineage-quality-v1.json"));
    expectSchema("lineage-quality-v1", quality);
    expect(quality.as_of).toBe(asOf);
    const row = quality.collections.find(
      (c: { collection_id: string }) => c.collection_id === "theme:flash-attention",
    );
    // Hash binding: the quality row describes exactly the promoted bytes …
    expect(row.input_sha256).toBe(sha256(promoted));
    expect(row.availability).toBe("ready");
    const checks = Object.fromEntries(
      row.audit.checks.map((c: { name: string; status: string }) => [c.name, c.status]),
    );
    expect(checks.evidence_classified_rate).toBe("passed");
    expect(checks.edge_semantics_complete).toBe("passed");
    expect(checks.root_focus_resolve).toBe("passed");
    // … so the human audit recorded for the OLD bytes no longer applies.
    expect(sha256(oldLineage)).not.toBe(row.input_sha256);
    expect(row.publication_tier).not.toBe("audited");

    const manifest = JSON.parse(originFile(sb, "data/published/themes/themes-manifest.json"));
    expect(manifest).toEqual([
      expect.objectContaining({
        slug: "flash-attention",
        paper_count: JSON.parse(promoted).nodes.length,
      }),
    ]);
  });
});

describe("theme lineage: LLM on, Groq answers 429 (daily quota)", () => {
  let sb: Sandbox;
  afterAll(() => sb?.cleanup());

  it("degrades to API evidence and still publishes a valid artifact", async () => {
    sb = createSandbox({ copyData: [THEME_DIR] });
    const run = await runCli(
      sb,
      "lineage/theme/cli.ts",
      [...THEME_ARGS, "--lineage-llm", "on", "--llm-strict", "ambiguous"],
      {
        fixtures: ["theme-s2-counts", "theme-http"],
        env: { GROQ_API_KEY: "gsk_system_test_not_a_key" },
        faults: [
          {
            match: "api.groq.com",
            kind: "status",
            status: 429,
            headers: { "retry-after": "86400" },
            body: JSON.stringify({
              error: {
                message:
                  "Rate limit reached for model on tokens per day (TPD): Limit 100000, Used 100000. Please try again in 23h59m.",
                type: "tokens",
                code: "rate_limit_exceeded",
              },
            }),
          },
        ],
      },
    );
    expect(run.code, describeRun(run)).toBe(0);
    const groq = run.requests.filter((r) => r.url.includes("api.groq.com"));
    // The LLM really was asked (otherwise this case proves nothing) …
    expect(groq.length).toBeGreaterThan(0);
    // … and a daily-quota 429 latches instead of being retried per pair.
    expect(groq.length).toBeLessThanOrEqual(10);
    expect(run.requests.filter((r) => r.outcome === "miss")).toEqual([]);
    const lin = JSON.parse(readFileSync(sb.path(LINEAGE), "utf8")) as Lineage;
    expectSchema("lineage-artifact-v1", lin);
    // `lineage_llm` is only stamped on no-LLM builds.
    expect(lin.meta.lineage_llm).toBeUndefined();
    expect(run.stderr).toMatch(/groq/i);
    for (const e of lin.edges) expect(e.provenance.classification.provider).toBeNull();
    expect(evidenceClassifiedRate(lin.meta.provenance_breakdown).ratio ?? 0).toBeGreaterThanOrEqual(
      policy.theme_min_evidence_classified_rate,
    );
  });
});
