/**
 * System test (R2-35): the ranked descendant search through the REAL theme
 * CLI (`PAPERPILOT_S2_DESCENDANT_SEARCH=on`).
 *
 * OpenAlex's `cites:` filter misses citing papers without
 * `referenced_works` (arXiv-only / NeurIPS records: QLoRA for LoRA) and
 * S2's `/citations` lists only the newest 10,000. The search asks S2 for
 * the theme's most-cited papers once per build and keeps each hit whose
 * S2 reference list cites a seed. Fixtures: `theme-http` (the recorded
 * Flash Attention build) plus `theme-descendant-search` (synthetic: one
 * bulk-search page with a FlashAttention follow-up that cites the
 * FlashAttention seed and a highly cited video-diffusion paper that cites
 * none, and their reference lists).
 *
 *  - on: the citing hit joins as a descendant of its seed, the other one
 *    is never a node, no request misses the fixtures;
 *  - an unreachable search makes the build incomplete (exit 4) and the
 *    published lineage stays byte-identical — a failed supplement is not
 *    "nothing there";
 *  - off (the default; `themeLineage.system.test.ts`): no search request.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliRun, describeRun, runCli } from "./support/runCli.js";
import { createSandbox, type Sandbox } from "./support/sandbox.js";
import { THEME_ARGS, THEME_DIR } from "./support/scenarios.js";

const LINEAGE = `${THEME_DIR}/lineage.json`;
const FA_SEED = "openalex:W4281758439";
const HIT = "e".repeat(40);
const NOT_CITING = "f".repeat(40);
const ON = { PAPERPILOT_S2_DESCENDANT_SEARCH: "on" };
const FIXTURES = ["theme-descendant-search", "theme-http"];

interface Lineage {
  nodes: { id: string; title: string }[];
  edges: { src: string; dst: string; relation: string }[];
}

describe("theme lineage: ranked descendant search (R2-35)", () => {
  let sb: Sandbox;
  let build: CliRun;

  beforeAll(async () => {
    sb = createSandbox({ copyData: [THEME_DIR, "data/published/identity-aliases-v1.json"] });
    build = await runCli(sb, "lineage/theme/cli.ts", THEME_ARGS, { fixtures: FIXTURES, env: ON });
  });
  afterAll(() => sb?.cleanup());

  it("keeps the most-cited hit that cites a seed, as that seed's descendant", () => {
    expect(build.code, describeRun(build)).toBe(0);
    expect(build.requests.filter((r) => r.outcome === "miss")).toEqual([]);
    const searches = build.requests.filter((r) => r.url.includes("/paper/search/bulk?"));
    expect(searches).toHaveLength(1);
    const url = decodeURIComponent(searches[0]!.url);
    expect(url).toContain('query="Flash Attention"');
    expect(url).toContain("sort=citationCount:desc");
    expect(build.stderr).toMatch(/ranked descendant search: candidates=2, verified seed citers=1/);

    const lin = JSON.parse(readFileSync(sb.path(LINEAGE), "utf8")) as Lineage;
    const ids = new Set(lin.nodes.map((n) => n.id));
    expect(ids.has(HIT)).toBe(true);
    expect(ids.has(NOT_CITING)).toBe(false);
    expect(lin.edges.some((e) => e.src === FA_SEED && e.dst === HIT)).toBe(true);
  });

  it("an unreachable search refuses to publish; the previous lineage is kept", async () => {
    const bad = createSandbox({ copyData: [THEME_DIR, "data/published/identity-aliases-v1.json"] });
    try {
      const before = readFileSync(bad.path(LINEAGE), "utf8");
      const result = bad.path("..", "result.json");
      const run = await runCli(
        bad,
        "lineage/theme/cli.ts",
        [...THEME_ARGS, "--result-json", result],
        {
          fixtures: FIXTURES,
          env: ON,
          faults: [{ match: "/paper/search/bulk", kind: "status", status: 503 }],
        },
      );
      expect(
        run.requests.some((r) => r.outcome === "fault"),
        describeRun(run),
      ).toBe(true);
      expect(run.code, describeRun(run)).toBe(4);
      expect(JSON.parse(readFileSync(result, "utf8")).status).toBe("incomplete");
      expect(run.stderr).toMatch(/s2 descendant search: Semantic Scholar unreachable/);
      expect(readFileSync(bad.path(LINEAGE), "utf8")).toBe(before);
    } finally {
      bad.cleanup();
    }
  });
});
