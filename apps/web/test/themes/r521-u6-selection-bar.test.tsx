// @vitest-environment jsdom
//
// #521 U6: at 1280x800 the 70vh tree box plus the toolbar pushed the 選択中
// bar below the fold, so a card click showed no visible reaction. #545
// follow-up (Q): from `sm` up the bar sits in a zero-height sticky slot at the
// TOP of the tree box (a bar pinned to the viewport bottom covered 34px of the
// card that straddles the bottom edge, which is where people click right after
// opening the page); below `sm` it keeps its old in-flow look under the tree.
// The placement switches on matchMedia("(min-width: 640px)"). jsdom has no
// layout, so these tests pin the structure and classes; the on-screen checks
// run in Playwright (e2e/themes.e2e.ts, "U6").
//
// Also here: a card click writes `?focus=` back into the URL, and the
// open-with-a-permalink scroll (`?node=` / `?focus=`) must not then re-centre
// the tree box on the clicked card.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineageTree } from "../../components/themes/LineageTree";
import { ARTIFACT_VERSION } from "../../lib/lineage/core";
import type { LineageArtifact, LineageEdge } from "../../lib/themes-quality";

// Like Next's hook: reflects the current URL (history.replaceState included),
// with a stable identity while the query string is unchanged.
let paramsCache: { key: string; value: URLSearchParams } | null = null;
vi.mock("next/navigation", () => ({
  useSearchParams: () => {
    const key = window.location.search;
    if (paramsCache?.key !== key) paramsCache = { key, value: new URLSearchParams(key) };
    return paramsCache.value;
  },
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

/** matchMedia stub: `wide` answers the bar's (min-width: 640px) query. */
function stubMatchMedia(wide: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({
      matches: q.includes("min-width: 640px") ? wide : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

const restore: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("pp.theme.onboarded", "1");
  window.history.replaceState(null, "", "/themes/?theme=t");
  paramsCache = null;
});
afterEach(() => {
  cleanup();
  while (restore.length) restore.pop()?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("#521 U6 selection bar on wide screens", () => {
  it("from sm up sits in a sticky zero-height slot at the top of the tree box", () => {
    stubMatchMedia(true);
    const bar = selectBeta();
    const slot = bar.closest("[data-selected-paper-bar-slot]") as HTMLElement | null;
    expect(slot, "the bar is inside the top slot").not.toBeNull();
    const slotClasses = slot!.className.split(/\s+/);
    expect(slotClasses).toContain("sticky");
    expect(slotClasses.some((c) => /^top-\d/.test(c))).toBe(true);
    expect(slotClasses).toContain("h-0");
    expect(slotClasses.some((c) => /^z-\d/.test(c))).toBe(true);
    // The slot is the first child of the tree box, i.e. above the scroll area.
    const box = slot!.parentElement as HTMLElement;
    expect(box.firstElementChild).toBe(slot);
    expect(box.querySelector('g[data-node-id="b"] [data-node-card]')).not.toBeNull();
    // Not pinned to the viewport bottom any more, and only one bar.
    expect(bar.className.split(/\s+/).some((c) => /^sm:bottom-/.test(c))).toBe(false);
    expect(document.querySelectorAll("[data-selected-paper-bar]")).toHaveLength(1);
  });

  it("below sm there is no slot and the bar stays in flow after the tree box", () => {
    stubMatchMedia(false);
    const bar = selectBeta();
    expect(document.querySelector("[data-selected-paper-bar-slot]")).toBeNull();
    const card = document.querySelector('g[data-node-id="b"] [data-node-card]') as HTMLElement;
    // DOM order: the card (inside the tree) precedes the bar.
    expect(card.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.closest("svg")).toBeNull();
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

describe("#545 follow-up: a card click does not re-centre the tree box", () => {
  // Measured like production so the tree lays out and the permalink effect can
  // run (it waits for the measured box width): 1230px box, 1208px scroll area.
  function stubLayout(): void {
    const innerDesc = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const cwDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("overflow-auto") ? 1208 : 1230;
      },
    });
    restore.push(() => {
      if (innerDesc) Object.defineProperty(window, "innerWidth", innerDesc);
      if (cwDesc) Object.defineProperty(HTMLElement.prototype, "clientWidth", cwDesc);
    });
  }

  function scrollCalls(spies: Array<{ mock: { calls: unknown[][] } }>): number {
    return spies.reduce((n, s) => n + s.mock.calls.length, 0);
  }

  it("opened without ?focus=/?node=, clicking a card never scrolls the tree box", () => {
    stubMatchMedia(true);
    stubLayout();
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    // test/setup/jsdom-scroll.ts polyfills both; restoreAllMocks puts them back.
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const view = render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    const before = scrollCalls([scrollTo, scrollIntoView]);
    const card = document.querySelector('g[data-node-id="c"] [data-node-card]') as HTMLElement;
    fireEvent.click(card);
    // The click wrote ?focus= back into the URL; Next's useSearchParams then
    // re-renders the tree with it (rerender = that update).
    expect(new URLSearchParams(window.location.search).get("focus")).toBeTruthy();
    view.rerender(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(document.querySelector("[data-selected-paper-bar]")).not.toBeNull();
    expect(scrollCalls([scrollTo, scrollIntoView]) - before).toBe(0);
  });

  it("a ?focus= the page was opened with still scrolls to its card once", () => {
    stubMatchMedia(true);
    stubLayout();
    window.history.replaceState(null, "", "/themes/?theme=t&focus=c");
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    render(<LineageTree artifact={ARTIFACT} slug="t" themeName="Test" />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
