// @vitest-environment jsdom
//
// R2 UX review P0-1 / P0-2 / P2-8 / P2-9 on the theme viewer
// (components/themes/LineageTree.tsx): baseline_only edges are visible by
// default, a notice says how many relations a filter hides (with a
// show-all button), clicking / pressing Enter on an edge opens a pinned
// evidence panel with the quote as a blockquote, and a relation list
// renders under the graph.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

function prov(method: string): LineageEdge["provenance"] {
  return {
    producer: { name: "test", version: "1" },
    evidence: { source: "semantic_scholar", kind: "citation-context", sha256: "a".repeat(64) },
    classification: {
      method,
      provider: null,
      model: null,
      prompt_version: null,
      schema_version: "relation-classification-v1",
    },
  };
}

const QUOTE = "We adopt the sparsely-gated mixture-of-experts layer of Shazeer et al. [12].";

const ARTIFACT: LineageArtifact = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [
    { id: "p1", is_focus: true, title: "Outrageously Large Neural Networks", year: 2017 },
    { id: "p2", is_focus: false, title: "Switch Transformers", year: 2021, arxiv_id: "2101.03961" },
    { id: "p3", is_focus: false, title: "GLaM", year: 2022 },
  ],
  edges: [
    {
      src: "p1",
      dst: "p2",
      relation: "baseline_only",
      confidence: 0.6,
      rationale: `「Switch Transformers」(2021) は「Outrageously Large…」(2017) を背景・関連研究として引用している（Semantic Scholar の引用文・引用の意図から規則で判定）。引用文: "${QUOTE}"`,
      provenance: prov("s2_context_rule"),
    },
    {
      src: "p1",
      dst: "p3",
      relation: "baseline_only",
      confidence: 0.6,
      rationale: "「GLaM」は「Outrageously Large…」を背景として引用している。",
      provenance: prov("s2_context_rule"),
    },
    {
      src: "p2",
      dst: "p3",
      relation: "contrasts",
      confidence: 0.5,
      rationale: "GLaM は Switch と異なる設計をとる。",
      provenance: prov("llm"),
    },
  ],
  clusters: [],
  meta: {},
};

beforeEach(() => {
  localStorage.clear();
  // Skip the onboarding coach-mark so it does not interfere.
  localStorage.setItem("pp.theme.onboarded", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function edgeButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('line[role="button"]')];
}

describe("LineageTree evidence UX (R2 UX P0-1 / P0-2)", () => {
  it("draws baseline_only edges by default and announces the hidden contrasts edge", () => {
    render(<LineageTree artifact={ARTIFACT} slug="mixture-of-experts" />);
    // Both baseline_only edges are drawn; the contrasts edge is not.
    expect(edgeButtons()).toHaveLength(2);
    const notice = screen.getByTestId("hidden-edges-notice");
    expect(notice.textContent).toContain("1 件の関係を非表示中");
    fireEvent.click(within(notice).getByRole("button", { name: "すべての関係を表示" }));
    expect(edgeButtons()).toHaveLength(3);
    expect(screen.queryByTestId("hidden-edges-notice")).toBeNull();
    // The active-filter chip uses Japanese labels, never raw keys.
    const status = screen.getByText(/🔗 関係:/);
    expect(status.textContent).toContain("参照（背景）");
    expect(status.textContent).not.toMatch(/baseline_only|contrasts|supersedes/);
  });

  it("opens a pinned evidence panel on click with the quote as a blockquote", () => {
    render(<LineageTree artifact={ARTIFACT} slug="mixture-of-experts" />);
    const first = edgeButtons().find((l) => l.getAttribute("aria-label")?.includes("Switch"));
    expect(first).toBeTruthy();
    fireEvent.click(first as HTMLElement);
    const panel = screen.getByTestId("edge-evidence-panel");
    expect(within(panel).getByRole("heading").textContent).toContain("参照（背景）");
    const quote = panel.querySelector("blockquote");
    expect(quote?.textContent).toContain(QUOTE);
    expect(panel.textContent).toContain("出典: Semantic Scholar");
    expect(panel.textContent).toContain("Semantic Scholar の引用文");
    expect(panel.textContent).toContain("確信度");
    expect(panel.textContent).toContain("0.60");
    const hrefs = [...panel.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://arxiv.org/abs/2101.03961");
    expect(hrefs.some((h) => h?.startsWith("https://www.semanticscholar.org/"))).toBe(true);
    // Focus moves to the panel heading so keyboard/screen-reader users land on it.
    expect(document.activeElement).toBe(within(panel).getByRole("heading"));
    fireEvent.click(within(panel).getByRole("button", { name: "根拠パネルを閉じる" }));
    expect(screen.queryByTestId("edge-evidence-panel")).toBeNull();
  });

  it("is keyboard accessible: Enter on a focused edge opens it, Escape closes it", () => {
    render(<LineageTree artifact={ARTIFACT} slug="mixture-of-experts" />);
    const line = edgeButtons()[0] as HTMLElement;
    expect(line.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(line, { key: "Enter" });
    expect(screen.getByTestId("edge-evidence-panel")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("edge-evidence-panel")).toBeNull();
  });

  it("lists the visible relations under the graph and opens evidence from the list", () => {
    render(<LineageTree artifact={ARTIFACT} slug="mixture-of-experts" />);
    expect(screen.getByText("関係の一覧（2 件）")).toBeTruthy();
    const list = screen.getByTestId("edge-relation-list");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list.textContent).toContain("（引用文あり）");
    fireEvent.click(within(list).getAllByRole("button", { name: "根拠を表示" })[0] as HTMLElement);
    expect(screen.getByTestId("edge-evidence-panel")).toBeTruthy();
  });

  it("uses Japanese UI strings (no X-axis / Export / confidence leftovers)", () => {
    const { container } = render(<LineageTree artifact={ARTIFACT} slug="mixture-of-experts" />);
    expect(container.textContent).not.toMatch(/X-axis|Export|confidence|edges\)/);
    expect(container.innerHTML).not.toMatch(/hub paper|citation velocity/);
    // Thin-lineage banner: 3 papers / 3 relations -> 3 < 5 relations.
    expect(container.textContent).toContain("（3 論文 / 3 関係）");
  });
});
