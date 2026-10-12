import { describe, expect, it } from "vitest";
import {
  edgeMetrics,
  hasCitationEvidence,
} from "../../../src/lineage/quality/auditLineageQuality.js";

const evidenced = (src: string) => ({
  src,
  dst: "hub",
  rationale: "quoted citation context sentence for this edge",
  provenance: {
    evidence: { source: "semantic_scholar", kind: "citation-context", sha256: "x" },
    classification: { method: "s2_context_rule", provider: null, model: null },
  },
});
const llm = (src: string) => ({
  src,
  dst: "hub",
  rationale: "model-written rationale for this edge",
  provenance: {
    evidence: { source: "semantic_scholar", kind: "citation-context", sha256: "x" },
    classification: { method: "context_llm", provider: "groq", model: "gpt-oss" },
  },
});

describe("popularity sinks only count unverified edges (R2-32 hub seeds)", () => {
  it("evidence-backed citations into a seed are not a sink", () => {
    const edges = Array.from({ length: 12 }, (_, i) => evidenced(`p${i}`));
    expect(edgeMetrics({ nodes: [], edges }).popularity_sinks).toBe(0);
  });
  it("LLM-classified or evidence-less edges still count", () => {
    const edges = [
      ...Array.from({ length: 8 }, (_, i) => llm(`p${i}`)),
      ...Array.from({ length: 8 }, (_, i) => ({ src: `q${i}`, dst: "hub2", rationale: "x" })),
    ];
    expect(edgeMetrics({ nodes: [], edges }).popularity_sinks).toBe(2);
  });
  it("hasCitationEvidence needs a non-empty evidence source", () => {
    expect(hasCitationEvidence({ provenance: { evidence: { source: "" } } })).toBe(false);
    expect(hasCitationEvidence(evidenced("a"))).toBe(true);
  });
});
