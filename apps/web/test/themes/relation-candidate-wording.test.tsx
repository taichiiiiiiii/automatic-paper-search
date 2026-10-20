// @vitest-environment jsdom
//
// D-R2-40: strong relations (拡張・対比・置き換え…) are rule-inferred from a
// citation sentence, so they are shown as candidates ("拡張（候補）") with the
// quoted sentence prominent, except in an audited collection, which keeps the
// plain label plus "人が確認済み".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Legend } from "../../components/lineage/graph/legend";
import { RelationAuditProvider } from "../../components/lineage/relation-audit";
import { EdgeEvidencePanel, EdgeRelationList } from "../../components/themes/EdgeEvidence";
import { relationLabelFor } from "../../lib/lineage/relations";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";

const QUOTE = "We build on the sparsely-gated mixture-of-experts layer of Shazeer et al.";
const EDGE = {
  src: "p1",
  dst: "p2",
  relation: "extends",
  confidence: 0.8,
  rationale: `p2 は p1 を拡張している。引用文: "${QUOTE}"`,
} as LineageEdge;
const NODES = new Map<string, LineageNode>([
  ["p1", { id: "p1", is_focus: true, title: "Outrageously Large Neural Networks", year: 2017 }],
  ["p2", { id: "p2", is_focus: false, title: "Switch Transformers", year: 2021 }],
] as [string, LineageNode][]);

afterEach(cleanup);

describe("relationLabelFor", () => {
  it("adds （候補） to strong relations unless audited", () => {
    expect(relationLabelFor("extends", false)).toBe("拡張（候補）");
    expect(relationLabelFor("contrasts", false)).toBe("対立（候補）");
    expect(relationLabelFor("supersedes", false)).toBe("置換（候補）");
    expect(relationLabelFor("extends", true)).toBe("拡張");
  });
  it("never marks a background citation as a candidate", () => {
    expect(relationLabelFor("baseline_only", false)).toBe("参照（背景）");
  });
});

describe("evidence panel", () => {
  it("unaudited: candidate heading, note, and the quoted sentence before the metadata", () => {
    render(<EdgeEvidencePanel edge={EDGE} nodeById={NODES} onClose={() => {}} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("引用文から推定した関係（候補）");
    const panel = screen.getByTestId("edge-evidence-panel");
    expect(panel.textContent).toContain("規則で推定した候補です。引用文で確かめてください。");
    expect(panel.textContent).not.toContain("人が確認済み");
    const quote = panel.querySelector("blockquote");
    expect(quote?.textContent).toContain(QUOTE);
    const dl = panel.querySelector("dl");
    expect(
      quote && dl && quote.compareDocumentPosition(dl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("audited: plain label and 人が確認済み, no candidate wording", () => {
    render(
      <RelationAuditProvider value={true}>
        <EdgeEvidencePanel edge={EDGE} nodeById={NODES} onClose={() => {}} />
      </RelationAuditProvider>,
    );
    const panel = screen.getByTestId("edge-evidence-panel");
    expect(panel.textContent).toContain("人が確認済み");
    expect(panel.textContent).not.toContain("候補");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("関係の根拠: 拡張");
  });
});

describe("relation list and legend", () => {
  it("relation list labels read as candidates by default and plain when audited", () => {
    const { unmount } = render(
      <EdgeRelationList edges={[EDGE]} nodeById={NODES} selectedKey={null} onSelect={() => {}} />,
    );
    expect(screen.getByTestId("edge-relation-list").textContent).toContain("拡張（候補）");
    unmount();
    render(
      <RelationAuditProvider value={true}>
        <EdgeRelationList edges={[EDGE]} nodeById={NODES} selectedKey={null} onSelect={() => {}} />
      </RelationAuditProvider>,
    );
    const text = screen.getByTestId("edge-relation-list").textContent ?? "";
    expect(text).toContain("拡張");
    expect(text).not.toContain("候補");
  });

  it("legend shows 拡張（候補） and the note unless audited", () => {
    const { container, unmount } = render(<Legend />);
    expect(container.textContent).toContain("拡張（候補）");
    expect(container.textContent).toContain("規則で推定した候補です。引用文で確かめてください。");
    expect(container.textContent).toContain("参照（背景）");
    unmount();
    const audited = render(
      <RelationAuditProvider value={true}>
        <Legend />
      </RelationAuditProvider>,
    );
    expect(audited.container.textContent).not.toContain("候補");
  });
});
