/**
 * TS port of a representative subset of
 * `paperpilot/tests/test_audit_lineage_quality.py` for
 * `apps/pipeline/src/lineage/quality/auditLineageQuality.ts` (LIN-33,
 * LIN-49, LIN-50).
 */
import { describe, expect, it } from "vitest";
import { TEMPLATE_RATIONALES } from "../../../src/lineage/llm/base.js";
import {
  auditEdges,
  auditStructural,
  isEmptyStub,
  offtopicNonfocusMetric,
} from "../../../src/lineage/quality/auditLineageQuality.js";

describe("isEmptyStub", () => {
  it("is true only when both nodes and edges are empty", () => {
    expect(isEmptyStub({ nodes: [], edges: [] })).toBe(true);
    expect(isEmptyStub({ nodes: [{ id: "a" }], edges: [] })).toBe(false);
    expect(isEmptyStub({ nodes: [], edges: [{ src: "a", dst: "b" }] })).toBe(false);
  });
});

describe("auditStructural", () => {
  it("flags a lineage with no focus papers", () => {
    const problems = auditStructural(
      "docs/x/lineage.json",
      { nodes: [{ id: "a", is_focus: false }] },
      2000,
    );
    expect(problems).toContain("no focus papers");
  });

  it("does not flag a theme lineage's old focus paper (recency check is conference-only)", () => {
    const problems = auditStructural(
      "docs/themes/x/lineage.json",
      { nodes: [{ id: "a", is_focus: true, year: 1990 }] },
      2020,
    );
    expect(problems).toEqual([]);
  });

  it("flags a conference focus paper older than min_year", () => {
    const problems = auditStructural(
      "docs/iclr-2026/lineage.json",
      { nodes: [{ id: "a", is_focus: true, year: 1990, title: "Old paper" }] },
      2020,
    );
    expect(problems.some((p) => p.includes("focus paper too old"))).toBe(true);
  });

  it("flags a dangling cluster reference", () => {
    const problems = auditStructural(
      "docs/x/lineage.json",
      {
        nodes: [{ id: "a", is_focus: true, cluster: "missing" }],
        clusters: [{ id: "present" }],
      },
      2000,
    );
    expect(problems.some((p) => p.includes("dangling cluster ref"))).toBe(true);
  });
});

describe("auditEdges", () => {
  function edge(rationale: string): Record<string, unknown> {
    return { src: "a", dst: "b", rationale };
  }

  it("hard-fails strictly above the 80% template-rationale threshold", () => {
    const template: string = TEMPLATE_RATIONALES.extends_methodology ?? "";
    // 8/9 ≈ 88.9% > 80%.
    const edges = [
      ...Array(8)
        .fill(0)
        .map(() => edge(template)),
      edge("specific non-template text"),
    ];
    const { failures } = auditEdges({ edges });
    expect(failures.some((f) => f.startsWith("template_rationale_ratio="))).toBe(true);
  });

  it("does not fail at exactly the 80% boundary (strictly-greater-than semantics)", () => {
    const template: string = TEMPLATE_RATIONALES.extends_methodology ?? "";
    // 4/5 == 80% exactly: not > 80%, so warn only.
    const edges = [
      edge(template),
      edge(template),
      edge(template),
      edge(template),
      edge("specific non-template text"),
    ];
    const { warnings, failures } = auditEdges({ edges });
    expect(failures).toEqual([]);
    expect(warnings.some((w) => w.startsWith("template_rationale_ratio="))).toBe(true);
  });

  it("warns (not fails) in the 60-80% template-rationale band", () => {
    const template: string = TEMPLATE_RATIONALES.extends_methodology ?? "";
    // 5/7 ≈ 71.4%: in (60%, 80%].
    const edges = [
      edge(template),
      edge(template),
      edge(template),
      edge(template),
      edge(template),
      edge("specific a"),
      edge("specific b"),
    ];
    const { warnings, failures } = auditEdges({ edges });
    expect(failures).toEqual([]);
    expect(warnings.some((w) => w.startsWith("template_rationale_ratio="))).toBe(true);
  });
});

describe("offtopicNonfocusMetric", () => {
  it("flags a contaminated theme (all non-focus nodes off-topic)", () => {
    const data = {
      meta: { theme: "Flash Attention" },
      nodes: [
        { id: "focus", is_focus: true, title: "FlashAttention: fast attention" },
        { id: "n1", is_focus: false, title: "Lip to speech synthesis" },
      ],
    };
    const m = offtopicNonfocusMetric(data);
    expect(m.offtopic_count).toBe(1);
    expect(m.nonfocus_count).toBe(1);
    expect(m.offtopic_ratio).toBe(1);
  });

  it("exempts a foundational-allowlist ancestor from the off-topic count", () => {
    const data = {
      meta: { theme: "Flash Attention" },
      nodes: [
        { id: "focus", is_focus: true, title: "FlashAttention: fast attention" },
        { id: "n1", is_focus: false, title: "Attention Is All You Need" },
      ],
    };
    const m = offtopicNonfocusMetric(data);
    expect(m.foundational_exempt).toBe(1);
    expect(m.nonfocus_count).toBe(0);
    expect(m.offtopic_ratio).toBe(0);
  });

  it("yields ratio 0 for a non-theme lineage (no meta.theme/slug)", () => {
    const m = offtopicNonfocusMetric({ nodes: [{ id: "n1", is_focus: false, title: "x" }] });
    expect(m.offtopic_ratio).toBe(0);
  });
});
