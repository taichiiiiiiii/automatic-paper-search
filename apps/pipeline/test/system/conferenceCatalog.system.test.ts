/**
 * System test (b): a proceedings-only conference edition, end to end
 * through the REAL CLIs, from saved HTML/API fixtures.
 *
 *   approveCli --edition iclr-2025 --execute   (collect from proceedings.iclr.cc,
 *       display copy, summary.csv, the promote refresh chain)
 *   -> linkExternalIdsCli (DBLP SPARQL) -> resolveAbstractReplacementsCli
 *      (arXiv title search, S2 bulk listing + TLDR batch)
 *   -> refresh chain again (buildPages, identityLite, searchIndex, lineageQuality)
 *   -> release CLI `package` + promote("conference") into a bare origin
 *   -> schema validation and the web-facing invariants (paper-links rows,
 *      licence / attribution of every abstract).
 *
 * Fixtures: `fixtures/conference-iclr-2025` — a 20-paper slice of the ICLR
 * 2025 proceedings listing and the DBLP / arXiv / S2 answers for it, all
 * derived from the committed `data/inputs/iclr-2025` files (README.md).
 */

import { readdirSync, readFileSync } from "node:fs";
import { ABSTRACT_LICENSE, type AbstractSource } from "@paperpilot/core/licensing";
import { validateArtifact } from "@paperpilot/core/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPaperLinkRows,
  estimateRenderedBytes,
  NOJS_MAX_RENDERED_BYTES,
} from "../../../web/app/[conf]/paper-links/logic.js";
import { originFile, promoteInSandbox, type SpawnRecord } from "./support/promoteHarness.js";
import { type CliRun, describeRun, runCli } from "./support/runCli.js";
import { createSandbox, type Sandbox, SYSTEM_FIXTURES } from "./support/sandbox.js";
import { CONF_AS_OF as AS_OF, CONF, emptyPublishedTree } from "./support/scenarios.js";

const FIXTURE = "conference-iclr-2025";
const expected = JSON.parse(
  readFileSync(`${SYSTEM_FIXTURES}/${FIXTURE}/expected.json`, "utf8"),
) as { titles: Record<string, AbstractSource>; openreview: Record<string, string> };

interface Paper {
  title: string;
  paper_id: string;
  source: string;
  arxiv_url: string;
  pdf_url: string;
  arxiv_id: string;
  abstract?: string;
  abstract_source: AbstractSource;
  abstract_license: string;
}

function expectSchema(name: string, data: unknown, where = name): void {
  const r = validateArtifact(name, data);
  expect(r.errors ?? [], `${where}: ${JSON.stringify(r.errors?.slice(0, 5))}`).toEqual([]);
}

describe("conference catalog: proceedings-only edition -> abstracts -> published", () => {
  let sb: Sandbox;
  const runs: Record<string, CliRun> = {};
  const fx = { fixtures: [FIXTURE] };

  beforeAll(async () => {
    sb = createSandbox({ files: emptyPublishedTree() });
    runs.approve = await runCli(
      sb,
      "conference/watch/approveCli.ts",
      ["--edition", CONF, "--execute"],
      fx,
    );
    runs.link = await runCli(sb, "catalog/linkExternalIdsCli.ts", ["--conference", CONF], fx);
    runs.resolve = await runCli(
      sb,
      "catalog/resolveAbstractReplacementsCli.ts",
      ["--conference", CONF],
      fx,
    );
    runs.resolveAgain = await runCli(
      sb,
      "catalog/resolveAbstractReplacementsCli.ts",
      ["--conference", CONF],
      fx,
    );
    for (const [name, cli, args] of [
      ["pages", "catalog/buildPagesCli.ts", []],
      ["identity", "release/derived/identityLiteCli.ts", ["--as-of", AS_OF]],
      ["search", "release/derived/searchIndexCli.ts", []],
      ["quality", "lineage/quality/buildLineageQualityCli.ts", ["--as-of", AS_OF]],
    ] as const) {
      runs[name] = await runCli(sb, cli, [...args], fx);
    }
  });
  afterAll(() => sb?.cleanup());

  it("every step exits 0 and only the recorded sources are contacted", () => {
    for (const [name, run] of Object.entries(runs)) {
      expect(run.code, `${name}\n${describeRun(run)}`).toBe(0);
      expect(
        run.requests.filter((r) => r.outcome !== "fixture"),
        name,
      ).toEqual([]);
    }
    expect(runs.approve?.requests.map((r) => r.url)).toEqual([
      "https://proceedings.iclr.cc/paper_files/paper/2025",
    ]);
    expect(runs.approve?.stdout).toContain("✅ iclr-2025 built locally");
    // Resumable: the second resolver run re-uses the cache, no network.
    expect(runs.resolveAgain?.requests).toEqual([]);
  });

  it("records the listing source licence and the DBLP/OpenReview links", () => {
    const lic = sb.readJson<Record<string, unknown>>(`data/inputs/${CONF}/source_license.json`);
    expect(lic).toMatchObject({
      conference: CONF,
      source: "iclr_proceedings",
      collection_url: "https://proceedings.iclr.cc/paper_files/paper/2025",
      license: null,
      abstracts: "omitted",
      paper_count: 20,
    });
    expect(String(lic.attribution)).toContain("https://proceedings.iclr.cc/paper_files/paper/2025");
    const ext = sb.readJson<{
      counts: Record<string, number>;
      papers: { title: string; openreview_id: string }[];
    }>(`data/inputs/${CONF}/external_ids.json`);
    expect(ext.counts).toEqual({ rows: 20, dblp_records: 20, linked: 20, openreview: 20 });
    for (const p of ext.papers) expect(p.openreview_id).toBe(expected.openreview[p.title]);
  });

  it("publishes only licensed abstracts, each labelled with its licence", () => {
    const papers = sb.readJson<Paper[]>(`data/published/${CONF}/papers.json`);
    expect(papers).toHaveLength(20);
    for (const p of papers) {
      const want = expected.titles[p.title];
      expect(want, p.title).toBeDefined();
      expect(p.abstract_source, p.title).toBe(want);
      expect(p.source).toBe("conference_site");
      // The proceedings site grants no licence: its text is never shown;
      // what is shown carries the replacement source's licence.
      expect(p.abstract_license).toBe(ABSTRACT_LICENSE[p.abstract_source]?.id ?? "");
      if (p.abstract_source === "none") expect(p.abstract ?? "").toBe("");
      else expect((p.abstract ?? "").length).toBeGreaterThan(20);
      if (p.abstract_source === "arxiv") expect(p.arxiv_id).toMatch(/^\d{4}\.\d{4,5}$/);
    }
    const counts = papers.reduce<Record<string, number>>((acc, p) => {
      acc[p.abstract_source] = (acc[p.abstract_source] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ arxiv: 13, s2_tldr: 4, none: 3 });
  });

  it("builds a no-JS paper-links page with a safe official link for every row", () => {
    const papers = sb.readJson<Paper[]>(`data/published/${CONF}/papers.json`);
    const rows = buildPaperLinkRows(papers);
    expect(rows).toHaveLength(20);
    for (const r of rows) {
      expect(r.href ?? "").toMatch(
        /^https:\/\/proceedings\.iclr\.cc\/paper_files\/paper\/2025\/hash\/[0-9a-f]{32}-Abstract-Conference\.html$/,
      );
    }
    expect(estimateRenderedBytes(rows)).toBeLessThan(NOJS_MAX_RENDERED_BYTES);
    const conferences = sb.readJson<{ name: string; papers: number }[]>(
      "data/published/conferences.json",
    );
    expect(conferences).toEqual([expect.objectContaining({ name: CONF, papers: 20 })]);
  });

  it("derived files validate against the core schemas and cover every paper", () => {
    const papers = new Map(
      sb.readJson<Paper[]>(`data/published/${CONF}/papers.json`).map((p) => [p.paper_id, p]),
    );
    expectSchema("identity-aliases-v1", sb.readJson("data/published/identity-aliases-v1.json"));
    expectSchema("identity-coverage-v1", sb.readJson("data/state/identity-coverage-v1.json"));
    expectSchema("lineage-quality-v1", sb.readJson("data/published/lineage-quality-v1.json"));
    const search = sb.readJson<{ entries?: unknown[] }>("data/published/search-index-v2.json");
    expectSchema("search-index-v2", search);
    for (const f of readdirSync(sb.path("data/published/search-paper-ids-v1"))) {
      expectSchema("search-paper-ids-v1", sb.readJson("data/published/search-paper-ids-v1", f), f);
    }
    const details = new Map<string, string>();
    for (const f of readdirSync(sb.path("data/published/paper-details-v1"))) {
      const shard = sb.readJson<{ papers: [string, string][] }>(
        "data/published/paper-details-v1",
        f,
      );
      expectSchema("paper-details-v1", shard, f);
      for (const [id, text] of shard.papers) details.set(id, text);
    }
    // One detail entry per paper; the text is non-empty exactly for the
    // rows with a licensed abstract (title-only rows keep an empty string).
    expect([...details.keys()].sort()).toEqual([...papers.keys()].sort());
    for (const [id, text] of details) {
      expect(text === "", id).toBe(papers.get(id)?.abstract_source === "none");
    }
    expect(JSON.stringify(search)).toContain(CONF);
  });

  it("promotes the edition with the real conference refresh chain", async () => {
    const candidate = sb.path("..", "candidate");
    const allowed = [
      `data/published/${CONF}`,
      `data/inputs/${CONF}`,
      `data/config/conference-copy/${CONF}.json`,
    ];
    const pkg = await runCli(sb, "release/cli.ts", ["package", candidate, ...allowed]);
    expect(pkg.code, describeRun(pkg)).toBe(0);
    const log: SpawnRecord[] = [];
    const res = await promoteInSandbox(sb, {
      kind: "conference",
      candidateDir: candidate,
      allowedPaths: allowed,
      baseSha: sb.git("rev-parse", "HEAD"),
      asOf: AS_OF,
      log,
    }).catch((e: Error) => {
      throw new Error(
        `${e.message}\n${log.map((s) => `${s.argv.join(" ")} -> ${s.exitCode}\n${s.output.slice(-1500)}`).join("\n")}`,
      );
    });
    expect(res.changed).toBe(true);
    expect(log.map((s) => [s.argv[3], s.exitCode])).toEqual([
      ["apps/pipeline/src/catalog/buildPagesCli.ts", 0],
      ["apps/pipeline/src/release/derived/identityLiteCli.ts", 0],
      ["apps/pipeline/src/release/derived/searchIndexCli.ts", 0],
      ["apps/pipeline/src/lineage/quality/buildLineageQualityCli.ts", 0],
      ["apps/pipeline/src/lineage/quality/auditLineageQualityCli.ts", 0],
      ["apps/pipeline/src/release/derived/searchIndexCli.ts", 0],
    ]);
    // The promoted tree regenerated the shared outputs byte-identically to
    // the local run: same inputs, same as_of.
    for (const rel of [
      `data/published/${CONF}/papers.json`,
      "data/published/conferences.json",
      "data/published/search-index-v2.json",
      "data/published/identity-aliases-v1.json",
      "data/published/lineage-quality-v1.json",
    ]) {
      expect(originFile(sb, rel), rel).toBe(readFileSync(sb.path(rel), "utf8"));
    }
  });
});
