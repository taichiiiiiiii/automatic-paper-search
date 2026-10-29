// @vitest-environment jsdom
//
// #444: Semantic Scholar's "influential + methodology" judgement on a plain
// citation edge is shown (an evidence-panel row, a legend sentence) and never
// alters the relation label.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeEvidencePanel } from "../../components/themes/EdgeEvidence";
import { ReadingGuide } from "../../components/themes/ReadingGuide";
import { isS2Influential, S2_INFLUENTIAL_LABEL_JA } from "../../lib/lineage/s2-signal";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";

const NODES = new Map<string, LineageNode>([
  ["p1", { id: "p1", is_focus: true, title: "Chain-of-Thought Prompting", year: 2022 }],
  ["p2", { id: "p2", is_focus: false, title: "Self-Consistency", year: 2022 }],
] as [string, LineageNode][]);
const EDGE = {
  src: "p1",
  dst: "p2",
  relation: "baseline_only",
  confidence: 0.6,
  rationale:
    '「Self-Consistency」は「CoT」を背景として引用している。引用文: "We compare with CoT-prompting."',
} as LineageEdge;

afterEach(cleanup);

describe("isS2Influential", () => {
  it("is true only for the influential_methodology signal", () => {
    expect(isS2Influential({ s2_signal: "influential_methodology" })).toBe(true);
    expect(isS2Influential({})).toBe(false);
    expect(isS2Influential({ s2_signal: "other" })).toBe(false);
    expect(isS2Influential({ s2_signal: null })).toBe(false);
  });
});

describe("evidence panel", () => {
  it("shows the S2 row on a marked edge and keeps the relation label", () => {
    render(
      <EdgeEvidencePanel
        edge={{ ...EDGE, s2_signal: "influential_methodology" } as LineageEdge}
        nodeById={NODES}
        onClose={() => {}}
      />,
    );
    const panel = screen.getByTestId("edge-evidence-panel");
    expect(panel.querySelector("[data-evidence-s2-influential]")?.textContent).toBe(
      S2_INFLUENTIAL_LABEL_JA,
    );
    expect(panel.textContent).toContain("参照（背景）");
  });

  it("shows nothing extra on an unmarked edge", () => {
    render(<EdgeEvidencePanel edge={EDGE} nodeById={NODES} onClose={() => {}} />);
    expect(
      screen.getByTestId("edge-evidence-panel").querySelector("[data-evidence-s2-influential]"),
    ).toBeNull();
  });
});

describe("reading guide", () => {
  it("explains the thicker line without changing the relation legend", () => {
    const { container } = render(
      <ReadingGuide open onToggle={() => {}} mainPathCount={0} hasCodeLinks={false} />,
    );
    const note = container.querySelector("[data-s2-influential-legend]");
    expect(note?.textContent).toContain("Semantic Scholar");
    expect(note?.textContent).toContain("関係の種類や強い関係の数は変わりません");
    expect(container.querySelectorAll("[data-relation-legend] li").length).toBe(6);
  });
});
