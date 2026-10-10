import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prf } from "../../../src/lineage/theme/eval/evalRelevanceCli.js";

const dir = join(import.meta.dirname, "fixtures");
const fixture = JSON.parse(readFileSync(join(dir, "relevance-eval-v1.json"), "utf8")) as {
  themes: Record<
    string,
    {
      theme: string;
      seeds: string[];
      candidates: { id: string; on_topic: unknown; reason: unknown }[];
    }
  >;
};
const scores = JSON.parse(readFileSync(join(dir, "relevance-eval-v1.scores.json"), "utf8")) as {
  models: Record<string, { scores: Record<string, Record<string, Record<string, number>>> }>;
};

describe("relevance-eval-v1 fixture (R2-4, design doc 42)", () => {
  it("labels every candidate of the four themes", () => {
    expect(Object.keys(fixture.themes).sort()).toEqual([
      "flash-attention",
      "graph-neural-network",
      "mixture-of-experts",
      "vision-transformer",
    ]);
    let n = 0;
    for (const t of Object.values(fixture.themes)) {
      const ids = t.candidates.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const c of t.candidates) {
        expect(typeof c.on_topic).toBe("boolean");
        expect(typeof c.reason).toBe("string");
      }
      for (const s of t.seeds) expect(ids).toContain(s);
      n += ids.length;
    }
    expect(n).toBeGreaterThanOrEqual(200);
  });

  it("has embedding scores for every candidate and model", () => {
    for (const m of Object.values(scores.models)) {
      for (const [slug, t] of Object.entries(fixture.themes)) {
        for (const c of t.candidates) expect(m.scores[slug]?.[c.id]).toBeDefined();
      }
    }
  });

  it("prf counts precision / recall / F1 of the positive class", () => {
    const r = prf([
      { pred: true, gold: true },
      { pred: true, gold: false },
      { pred: false, gold: true },
      { pred: false, gold: false },
    ]);
    expect([r.tp, r.fp, r.fn, r.tn]).toEqual([1, 1, 1, 1]);
    expect(r.p).toBe(0.5);
    expect(r.f1).toBe(0.5);
  });
});
