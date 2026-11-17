// @vitest-environment jsdom
//
// #521 U9: on a desktop, a large theme (NeRF: 1868px of tree in a 1208px
// box) opened at 100% and its right side was cut off. The tree now starts
// fitted to the box width -- from the first paint (no 100% frame), never
// below the 全体 floor, untouched once the user zooms, and a ?node=
// permalink scrolls to its card at the fitted zoom. Trees that already
// fit stay at 100%.

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";
import { NODE_W, treeWidthFor } from "../../lib/themes-tree";

function edge(src: string, dst: string, relation: string): LineageEdge {
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

function artifact(papersIn2021: number): LineageArtifact {
  return {
    schema_version: ARTIFACT_VERSION,
    root: null,
    nodes: [
      { id: "root", is_focus: true, title: "Root", year: 2020, citation_count: 500 },
      ...Array.from({ length: papersIn2021 }, (_, i) => ({
        id: `p${i}`,
        is_focus: false,
        title: `Paper ${i}`,
        year: 2021,
        citation_count: 100 - i,
      })),
    ],
    edges: Array.from({ length: papersIn2021 }, (_, i) => edge("root", `p${i}`, "extends")),
    clusters: [],
    meta: { generated_at: "2026-10-11T00:00:00Z", keywords: ["test"] },
  };
}

// 1280px window, measured like production: tree box 1230px, scroll area
// 1208px (border + vertical scrollbar).
const WINDOW_W = 1280;
const BOX_W = 1230;
const SCROLL_W = 1208;
let boxWidth = BOX_W;
let scrollWidth = SCROLL_W;
const roCallbacks: Array<() => void> = [];
const restore: Array<() => void> = [];

beforeEach(() => {
  search = "";
  boxWidth = BOX_W;
  scrollWidth = SCROLL_W;
  roCallbacks.length = 0;
  localStorage.setItem("pp.theme.onboarded", "1");
  const innerDesc = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: WINDOW_W });
  const cwDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("overflow-auto") ? scrollWidth : boxWidth;
    },
  });
  const roDesc = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  restore.push(() => {
    if (innerDesc) Object.defineProperty(window, "innerWidth", innerDesc);
    if (cwDesc) Object.defineProperty(HTMLElement.prototype, "clientWidth", cwDesc);
    if (roDesc) Object.defineProperty(globalThis, "ResizeObserver", roDesc);
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });
});

afterEach(() => {
  cleanup();
  while (restore.length) restore.pop()?.();
  localStorage.clear();
  vi.restoreAllMocks();
});

function tree(): SVGSVGElement {
  return screen.getByRole("group", { name: /時系列家系図/ }) as unknown as SVGSVGElement;
}
const zoomOf = (svg: SVGSVGElement) => Number(svg.getAttribute("data-zoom"));

// Six cards per line at this width (the wrap target), like NeRF / LoRA / ViT.
const WIDE_W = treeWidthFor(6);
const FIT = (SCROLL_W - 8) / WIDE_W;

describe("#521 U9: the desktop tree starts fitted to the box width", () => {
  it("a tree wider than the box starts at the fit zoom from the first paint (no 100% frame)", () => {
    // Every data-zoom value the svg ever had, from its insertion on.
    const seen: string[] = [];
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes" && r.oldValue !== null) seen.push(r.oldValue);
      }
    });
    mo.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-zoom"],
      attributeOldValue: true,
    });
    render(<LineageTree artifact={artifact(12)} slug="t" themeName="Test" />);
    seen.push(...mo.takeRecords().flatMap((r) => (r.oldValue === null ? [] : [r.oldValue])));
    mo.disconnect();
    const svg = tree();
    expect(svg.getAttribute("data-per-line")).toBe("6");
    expect(zoomOf(svg)).toBeCloseTo(FIT, 6);
    expect(Number(svg.getAttribute("width"))).toBeLessThanOrEqual(SCROLL_W);
    // Still readable: above the wide 全体 floor.
    expect(zoomOf(svg)).toBeGreaterThanOrEqual(0.6);
    expect(seen.map(Number).filter((z) => z >= 1)).toEqual([]);
    // 全体 is then a no-op: the tree already fits.
    fireEvent.click(screen.getByRole("button", { name: "全体" }));
    expect(zoomOf(tree())).toBeCloseTo(FIT, 6);
  });

  it("a tree that already fits stays at 100%", () => {
    render(<LineageTree artifact={artifact(2)} slug="t" themeName="Test" />);
    expect(zoomOf(tree())).toBe(1);
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("never overrides the zoom once the user changed it", () => {
    render(<LineageTree artifact={artifact(12)} slug="t" themeName="Test" />);
    expect(zoomOf(tree())).toBeCloseTo(FIT, 6);
    fireEvent.click(screen.getByRole("button", { name: "拡大" }));
    const chosen = zoomOf(tree());
    expect(chosen).toBeGreaterThan(FIT);
    // A later resize (box measured again) does not re-fit.
    boxWidth = 1000;
    scrollWidth = 980;
    act(() => {
      for (const cb of roCallbacks) cb();
    });
    expect(zoomOf(tree())).toBe(chosen);
  });

  it("the initial fit is a one-off: a resize before any zoom click does not re-fit", () => {
    render(<LineageTree artifact={artifact(12)} slug="t" themeName="Test" />);
    expect(zoomOf(tree())).toBeCloseTo(FIT, 6);
    boxWidth = 1500;
    scrollWidth = 1478;
    act(() => {
      for (const cb of roCallbacks) cb();
    });
    expect(zoomOf(tree())).toBeCloseTo(FIT, 6);
  });

  it("a ?node= permalink scrolls its card into view at the fitted zoom", () => {
    search = "theme=t&node=p5";
    const spy = vi.spyOn(Element.prototype, "scrollTo");
    render(<LineageTree artifact={artifact(12)} slug="t" themeName="Test" />);
    const svg = tree();
    const z = zoomOf(svg);
    expect(z).toBeCloseTo(FIT, 6);
    const fo = svg.querySelector('g[data-node-id="p5"] foreignObject') as Element;
    const x = Number(fo.getAttribute("x"));
    const calls = spy.mock.calls
      .map((c) => c[0] as unknown)
      .filter((a): a is ScrollToOptions => typeof a === "object" && a !== null);
    expect(calls).toHaveLength(1);
    const left = calls[0]!.left ?? 0;
    expect(left).toBeCloseTo(Math.max(0, (x + NODE_W / 2) * FIT - SCROLL_W / 2), 6);
    // The whole card is inside the visible width.
    expect(x * z).toBeGreaterThanOrEqual(left);
    expect((x + NODE_W) * z).toBeLessThanOrEqual(left + SCROLL_W);
  });
});
