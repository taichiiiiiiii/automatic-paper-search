/**
 * System test (R2-32): the LLM-free conference ("edition") lineage, end to
 * end through the REAL CLIs with recorded Semantic Scholar answers
 * (`fixtures/conference-edition-icml-2025`, see fixtures/README.md).
 *
 *  - build: ICML 2025, 3 seeds x 3 ancestors x 3 descendants; every request
 *    is served from the fixtures, the artifact meets contract v1 with
 *    catalog-bound seeds, carries no LLM provenance, and two runs are
 *    byte-identical (cache-backed, deterministic);
 *  - quality table: the conference row gets the SAME automatic gate as a
 *    theme (evidence rate, edges, nodes, review share, lineage relations,
 *    generator_current) and is `unaudited` once it passes;
 *  - publish guard (R2-37 parity): a rebuild the gate would block never
 *    replaces a published conference lineage (exit 6, bytes kept);
 *  - fault: S2 unreachable for the venue ranking -> exit 4, bytes kept.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { describeRun, runCli } from "./support/runCli.js";
import { createSandbox, type Sandbox } from "./support/sandbox.js";

const CLI = "lineage/conference/editionLineageCli.ts";
const QUALITY_CLI = "lineage/quality/buildLineageQualityCli.ts";
const FIXTURES = ["conference-edition-icml-2025"];
const CONF = "icml-2025";
const LINEAGE = `data/published/${CONF}/lineage.json`;
const POLICY = "data/config/lineage-quality-policy-v1.json";
const ARGS = [
  "--conference",
  CONF,
  "--seeds",
  "3",
  "--parents",
  "3",
  "--children",
  "3",
  "--now",
  "2026-10-12T15:00:00Z",
];
const AS_OF = "2026-10-12T16:00:00Z";

let sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes) s.cleanup();
  sandboxes = [];
});

const realPolicy = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../../${POLICY}`, import.meta.url), "utf8"));

function sandbox(policyPatch: Record<string, unknown> = {}): Sandbox {
  const sb = createSandbox({
    copyData: [`data/published/${CONF}/papers.json`],
    files: {
      [POLICY]: { ...realPolicy(), ...policyPatch },
      "data/published/conferences.json": [{ name: CONF, generated: "2026-10-01" }],
      "data/published/themes/themes-manifest.json": [],
      "data/config/lineage-audit-fixtures-v1.json": {
        schema_version: "lineage-audit-fixtures-v1",
        collections: [],
      },
    },
  });
  sandboxes.push(sb);
  return sb;
}

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

type Row = {
  collection_id: string;
  publication_tier: string;
  audit: { checks: { name: string; status: string; observed: unknown }[] };
};

async function qualityRow(sb: Sandbox): Promise<Row> {
  const run = await runCli(sb, QUALITY_CLI, ["--as-of", AS_OF]);
  expect(run.code, describeRun(run)).toBe(0);
  const q = sb.readJson<{ collections: Row[] }>("data/published/lineage-quality-v1.json");
  return q.collections.find((c) => c.collection_id === `conference:${CONF}`) as Row;
}

describe("edition lineage (R2-32)", () => {
  it("builds ICML 2025 LLM-free from recorded S2 answers, deterministically", async () => {
    const sb = sandbox();
    const run = await runCli(sb, CLI, ARGS, { fixtures: FIXTURES });
    expect(run.code, describeRun(run)).toBe(0);
    expect(run.requests.filter((r) => r.outcome !== "fixture")).toEqual([]);
    expect(run.requests.every((r) => r.url.startsWith("https://api.semanticscholar.org/"))).toBe(
      true,
    );
    const first = readFileSync(sb.path(LINEAGE), "utf8");
    const lin = JSON.parse(first) as {
      schema_version: string;
      root: string;
      nodes: { id: string; is_focus: boolean; seed_paper_id?: string; aliases?: string[][] }[];
      edges: { relation: string; provenance: { classification: { method: string } } }[];
      meta: Record<string, unknown>;
    };
    expect(lin.schema_version).toBe("lineage-artifact-v1");
    expect(lin.meta.lineage_llm).toBe("off");
    const catalog = new Set(
      sb
        .readJson<{ paper_id: string }[]>(`data/published/${CONF}/papers.json`)
        .map((r) => r.paper_id),
    );
    const focus = lin.nodes.filter((n) => n.is_focus);
    expect(focus.length).toBeGreaterThan(0);
    for (const f of focus) {
      expect(catalog.has(f.seed_paper_id as string)).toBe(true);
      expect(f.aliases?.some((a) => a[0] === "openreview")).toBe(true);
    }
    expect(lin.edges.length).toBeGreaterThan(0);
    for (const e of lin.edges) expect(e.provenance.classification.method).not.toBe("llm");

    // Same cache + same clock -> same bytes (the second run reads the seed
    // ranking and S2 contexts from the lineage cache).
    const again = await runCli(sb, CLI, ARGS, { fixtures: FIXTURES });
    expect(again.code, describeRun(again)).toBe(0);
    expect(readFileSync(sb.path(LINEAGE), "utf8")).toBe(first);
  });

  it("gates the conference row like a theme; passing it is unaudited", async () => {
    const strict = sandbox();
    expect((await runCli(strict, CLI, ARGS, { fixtures: FIXTURES })).code).toBe(0);
    const row = await qualityRow(strict);
    const names = row.audit.checks.map((c) => c.name);
    for (const n of [
      "evidence_classified_rate",
      "edge_density",
      "node_count",
      "review_share",
      "lineage_relation_count",
      "generator_current",
      "artifact_contract_v1",
      "root_focus_resolve",
      "catalog_seed_membership",
    ]) {
      expect(names).toContain(n);
    }
    // The recorded 3-seed slice quotes only 2 lineage relations.
    const failed = row.audit.checks.filter((c) => c.status === "failed").map((c) => c.name);
    expect(failed).toEqual(["lineage_relation_count"]);
    expect(row.publication_tier).toBe("blocked");

    const relaxed = sandbox({ theme_min_lineage_edges: 2 });
    expect((await runCli(relaxed, CLI, ARGS, { fixtures: FIXTURES })).code).toBe(0);
    expect((await qualityRow(relaxed)).publication_tier).toBe("unaudited");
  });

  it("refuses to replace a published conference lineage with a blocked rebuild (exit 6)", async () => {
    const sb = sandbox({ theme_min_lineage_edges: 2 });
    expect((await runCli(sb, CLI, ARGS, { fixtures: FIXTURES })).code).toBe(0);
    sb.git("add", "-A");
    sb.git("commit", "-qm", "test: published unaudited conference lineage");
    const before = sha(sb.path(LINEAGE));
    // A much smaller rebuild (1 seed) fails node_count etc.: blocked.
    const small = ["--conference", CONF, "--seeds", "1", "--parents", "1", "--children", "1"];
    const run = await runCli(sb, CLI, [...small, "--now", "2026-10-12T15:00:00Z"], {
      fixtures: FIXTURES,
    });
    expect(run.code, describeRun(run)).toBe(6);
    expect(run.stderr).toContain("refusing to replace the published unaudited conference lineage");
    expect(sha(sb.path(LINEAGE))).toBe(before);
  });

  it("exits 4 and keeps the published file when S2 cannot rank the edition", async () => {
    const sb = sandbox();
    const marker = '{"root":null,"nodes":[],"edges":[]}\n';
    writeFileSync(sb.path(LINEAGE), marker);
    const run = await runCli(sb, CLI, ARGS, {
      fixtures: FIXTURES,
      faults: [{ match: "/paper/search/bulk", kind: "status", status: 503 }],
    });
    expect(run.code, describeRun(run)).toBe(4);
    expect(readFileSync(sb.path(LINEAGE), "utf8")).toBe(marker);
  });
});
