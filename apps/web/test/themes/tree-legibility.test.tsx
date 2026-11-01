// @vitest-environment jsdom
//
// #459: the family tree stays legible — a seed paper's card has an opaque
// background (edges drawn under it must not show through its text), plain
// citations are drawn under the strong relations, faint and thin, and
// pointing at a paper brings its own edges forward.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }));

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
    { id: "a", is_focus: true, title: "Alpha", year: 2015, citation_count: 5000 },
    { id: "b", is_focus: true, title: "Beta", year: 2017, citation_count: 800 },
    { id: "c", is_focus: false, title: "Gamma", year: 2018, citation_count: 40 },
    { id: "d", is_focus: false, title: "Delta", year: 2020, citation_count: 300 },
  ],
  edges: [e("a", "c", "baseline_only"), e("a", "d", "baseline_only"), e("a", "b", "extends")],
  clusters: [],
  meta: { generated_at: "2026-10-11T00:00:00Z" },
};

beforeEach(() => {
  window.history.replaceState(null, "", "/themes/?theme=t");
  localStorage.setItem("pp.theme.onboarded", "1");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const lines = () =>
  [...document.querySelectorAll("g[data-main-path] > line:first-child, svg g > line")].filter(
    (l) => l.getAttribute("stroke-opacity") !== null,
  ) as SVGLineElement[];

describe("tree legibility (#459)", () => {
  it("gives a seed paper's card an opaque background, not the 5% accent fill", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="T" />);
    const card = document.querySelector('g[data-node-id="a"] [data-node-card]') as HTMLElement;
    expect(card.className).toContain("bg-surface-elevated");
    expect(card.className).not.toContain("bg-accent/5");
  });

  it("draws plain citations first (under) and fainter than a strong relation", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="T" />);
    const ls = lines();
    const opac = ls.map((l) => Number(l.getAttribute("stroke-opacity")));
    expect(opac.length).toBe(3);
    // plain, plain, strong
    expect(opac[0]).toBeLessThan(opac[2] as number);
    expect(opac[1]).toBeLessThan(opac[2] as number);
  });

  it("pointing at a paper brings its edges forward and fades the others", () => {
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="T" />);
    const before = lines().map((l) => Number(l.getAttribute("stroke-opacity")));
    fireEvent.pointerEnter(document.querySelector('g[data-node-id="c"]') as Element, {
      pointerType: "mouse",
    });
    const after = lines().map((l) => Number(l.getAttribute("stroke-opacity")));
    // a–c is the pointed paper's edge: now fully opaque; a–d is faded further
    expect(before[0]).toBeLessThan(1);
    expect(after.filter((o) => o === 1).length).toBeGreaterThanOrEqual(2);
    expect(after.filter((o) => o < 0.1).length).toBe(1);
  });
});
