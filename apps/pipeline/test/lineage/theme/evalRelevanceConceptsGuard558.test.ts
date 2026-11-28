// #558: OpenAlex `concepts` is deprecated and frozen. When the labelled
// set carries no concepts at all, the "OA concept" row of the relevance
// evaluation must not silently report TP 0 / FP 0 with exit 0; a missing
// `concepts` key must not crash the run with a TypeError either.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  conceptCoverage,
  conceptCoverageFailure,
  runEval,
} from "../../../src/lineage/theme/eval/evalRelevanceCli.js";

const dir = join(import.meta.dirname, "fixtures");
const CONCEPT_ROW = "OA concept (L>=2) shared by subject seeds";

type Json = Record<string, unknown>;

/** Read-only load of the labelled set; every test works on a fresh copy. */
function loadFixture(): { themes: Record<string, { candidates: Json[] }> } {
  return JSON.parse(readFileSync(join(dir, "relevance-eval-v1.json"), "utf8"));
}
const scores = JSON.parse(readFileSync(join(dir, "relevance-eval-v1.scores.json"), "utf8"));

function mapCandidates(
  fx: ReturnType<typeof loadFixture>,
  f: (c: Json, i: number) => void,
): ReturnType<typeof loadFixture> {
  let i = 0;
  for (const t of Object.values(fx.themes)) for (const c of t.candidates) f(c, i++);
  return fx;
}

const conceptRow = (fx: ReturnType<typeof loadFixture>) =>
  // biome-ignore lint/suspicious/noExplicitAny: synthetic copies of the fixture
  runEval(fx as any, scores).rows.find((r) => r.method.startsWith(CONCEPT_ROW))!;

// runEval over the whole labelled set takes ~2 s; allow for a loaded host.
describe("evalRelevanceCli concepts guard (#558)", { timeout: 60_000 }, () => {
  it("counts the candidates whose concepts are usable on the real fixture", () => {
    const fx = loadFixture();
    const cov = conceptCoverage(fx);
    const total = Object.values(fx.themes).reduce((n, t) => n + t.candidates.length, 0);
    expect(cov.total).toBe(total);
    expect(cov.usable).toBeGreaterThan(0);
    expect(conceptCoverageFailure(cov)).toBeNull();
  });

  it("keeps the concept row of the real fixture unchanged (34/37/44)", () => {
    const row = conceptRow(loadFixture());
    expect(row.method).toBe(CONCEPT_ROW);
    expect([row.micro.tp, row.micro.fp, row.micro.fn]).toEqual([34, 37, 44]);
  });

  it("fails with a reason when every candidate has concepts: []", () => {
    const fx = mapCandidates(loadFixture(), (c) => {
      c.concepts = [];
    });
    const cov = conceptCoverage(fx);
    expect(cov.usable).toBe(0);
    expect(cov.total).toBeGreaterThan(0);
    expect(conceptCoverageFailure(cov)).toMatch(/concepts/);
    const row = conceptRow(fx);
    expect(row.method).toContain("データなし");
  });

  it("treats a missing concepts key as no data instead of throwing", () => {
    const fx = mapCandidates(loadFixture(), (c) => {
      delete c.concepts;
    });
    expect(conceptCoverage(fx).usable).toBe(0);
    expect(conceptCoverageFailure(conceptCoverage(fx))).not.toBeNull();
    let row: ReturnType<typeof conceptRow> | undefined;
    expect(() => {
      row = conceptRow(fx);
    }).not.toThrow();
    expect(row?.method).toContain("データなし");
  });

  it("passes when only one candidate keeps its concepts", () => {
    const fx = loadFixture();
    let kept = false;
    mapCandidates(fx, (c) => {
      if (!kept && Array.isArray(c.concepts) && c.concepts.length > 0) kept = true;
      else c.concepts = [];
    });
    const cov = conceptCoverage(fx);
    expect(cov.usable).toBe(1);
    expect(conceptCoverageFailure(cov)).toBeNull();
    expect(conceptRow(fx).method).toBe(CONCEPT_ROW);
  });
});
