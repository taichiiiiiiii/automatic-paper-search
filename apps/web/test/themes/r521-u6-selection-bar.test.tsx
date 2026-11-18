// @vitest-environment jsdom
//
// #521 U6: at 1280x800 the 70vh tree box plus the toolbar pushed the 選択中
// bar below the fold, so a card click showed no visible reaction. From `sm`
// up the bar is sticky to the viewport bottom (it only pins while its flow
// position is off screen); below `sm` it keeps its old in-flow look. jsdom has
// no layout, so these tests pin the classes; the on-screen check runs in
// Playwright (e2e/themes.e2e.ts, "U6").
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

function e(src: string, dst: string, relation: string): LineageEdge {
  return {
    src,
    dst,
    relation,
    confidence: 0.8,
    rationale: `${dst} cites ${src}`,
    provenance: {
      producer: { name: "test", version: "1" },
      evidence: { source: "semantic_scholar", kind: "citation-context", sha256: "a".repeat(64) },
      classification: {
        method: "s2_context_rule",
        provider: null,
        model: null,
        prompt_version: null,
        schema_version: "relation-classification-v1",
      },
    },
  } as LineageEdge;
}

const ARTIFACT: LineageArtifact = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [
    { id: "a", is_focus: true, title: "Alpha", year: 2018 },
    { id: "b", is_focus: false, title: "Beta", year: 2019 },
    { id: "c", is_focus: false, title: "Gamma", year: 2020 },
  ],
  edges: [e("a", "b", "extends"), e("b", "c", "supersedes")],
  clusters: [],
  meta: {},
};

/** The bar's classes before U6 (= what phones must still get). */
const PHONE_CLASSES = [
  "mt-2",
  "flex",
  "flex-wrap",
  "items-center",
  "gap-x-2",
  "gap-y-1",
  "rounded-md",
  "border",
  "border-accent",
  "bg-accent/5",
  "px-3",
  "py-2",
  "text-xs",
  "text-ink",
];

function selectBeta(): HTMLElement {
  render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
  const card = document.querySelector('g[data-node-id="b"] [data-node-card]') as HTMLElement;
  fireEvent.click(card);
  return document.querySelector("[data-selected-paper-bar]") as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("pp.theme.onboarded", "1");
  window.history.replaceState(null, "", "/themes/?theme=t");
});
afterEach(() => cleanup());

describe("#521 U6 selection bar on wide screens", () => {
  it("is sticky to the viewport bottom from sm up, above the tree", () => {
    const classes = selectBeta().className.split(/\s+/);
    expect(classes).toContain("sm:sticky");
    expect(classes.some((c) => /^sm:bottom-\d/.test(c))).toBe(true);
    expect(classes.some((c) => /^sm:z-\d/.test(c))).toBe(true);
  });

  it("gets an opaque background from sm up (it may sit over the tree)", () => {
    const classes = selectBeta().className.split(/\s+/);
    const smBg = classes.filter((c) => c.startsWith("sm:bg-"));
    expect(smBg).toHaveLength(1);
    // The tint mixes into the page colour, not into transparent.
    expect(smBg[0]).toContain("var(--color-bg)");
    expect(smBg[0]).not.toContain("transparent");
  });

  it("keeps the phone look: unprefixed classes are exactly the pre-U6 ones", () => {
    const bar = selectBeta();
    const unprefixed = bar.className.split(/\s+/).filter((c) => c && !c.includes(":"));
    expect(unprefixed).toEqual(PHONE_CLASSES);
    // Wording and counts are unchanged.
    expect(bar.textContent).toBe("選択中:Beta土台 1 本・発展 1 本一覧を見る");
  });
});
