// @vitest-environment jsdom
//
// Component-level coverage for the P2 review round 1 fixes this agent
// owns in components/catalog/catalog-app.tsx:
//   M8b -- Back navigation from a selected paper to the plain list must
//          restore the scroll position captured at selection time and
//          move keyboard focus back to that paper's "内容を見る" button
//          (falling back to the search input if the button is no
//          longer rendered) -- ported from docs/assets/app.js's
//          popstate handler's `else if (historyRestore)` branch
//          (app.js:1999-2006). catalog-app.tsx used to read
//          `historyRestore.scrollY`/`focusPaperId` but never act on
//          them.
//   catalog LOW -- the no-JS fallback link used to point at the
//          pre-port `paper-links.html` filename instead of the ported
//          `/<conf>/paper-links/` route.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogApp } from "../../components/catalog/catalog-app";
import type { CatalogCopy } from "../../lib/catalog-copy";
import type { CatalogPaper } from "../../lib/catalog-core";
import * as catalogData from "../../lib/catalog-data";

const COPY: CatalogCopy = {
  display: "Test Conf",
  description: "desc",
  tagline: "tagline",
  lede: "lede",
  source: "source",
};

const PAPER_A: CatalogPaper = {
  paper_id: "a".repeat(40),
  title: "Paper A",
  authors: ["Alice"],
  tags: ["nlp"],
  abstract: "Abstract A.",
  type: "Oral",
};

const PAPER_B: CatalogPaper = {
  paper_id: "b".repeat(40),
  title: "Paper B",
  authors: ["Bob"],
  tags: ["cv"],
  abstract: "Abstract B.",
  type: "Poster",
};

function mockDataLayer(papers: CatalogPaper[]) {
  const byId = new Map(papers.map((p) => [p.paper_id, p]));
  vi.spyOn(catalogData, "fetchCatalogPapers").mockResolvedValue({
    status: "ok",
    papers,
    byId,
  });
  vi.spyOn(catalogData, "fetchFullAbstract").mockResolvedValue({
    status: "ready",
    text: "full text",
  });
  vi.spyOn(catalogData, "fetchPilotLineageIndex").mockResolvedValue(null);
}

afterEach(() => {
  // Same rationale as test/themes/theme-request-form.test.tsx: this
  // workspace has no `globals: true`, so RTL's auto-cleanup never
  // self-registers.
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/test-conf/");
});

async function renderLoaded(papers: CatalogPaper[]) {
  mockDataLayer(papers);
  render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
  await screen.findByText("Paper A");
}

describe("CatalogApp Back navigation restore (M8b)", () => {
  it("restores scroll position and focuses the returned paper's select button", async () => {
    window.history.replaceState(null, "", "/test-conf/");
    await renderLoaded([PAPER_A, PAPER_B]);

    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "scrollY", { value: 777, configurable: true });

    const selectButtonA = document.querySelector<HTMLButtonElement>(
      `[data-select-paper="${PAPER_A.paper_id}"]`,
    );
    expect(selectButtonA).not.toBeNull();

    const listHref = window.location.href;
    await act(async () => {
      fireEvent.click(selectButtonA as HTMLButtonElement);
    });

    // Selecting pushed a new (SELECTED) history entry; capture the LIST
    // entry's state/url the way a real Back navigation would hand them
    // to the popstate handler, without depending on jsdom's own session
    // history traversal.
    const listState = window.history.state;
    expect(listState).not.toBeNull();

    await act(async () => {
      window.history.replaceState(listState, "", listHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: listState }));
    });
    // Flush the restore effect's requestAnimationFrame.
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(scrollToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ top: 777, behavior: "auto" }),
    );
    expect(document.activeElement).toBe(
      document.querySelector(`[data-select-paper="${PAPER_A.paper_id}"]`),
    );
  });

  it("falls back to the search input when the returned paper is no longer rendered", async () => {
    window.history.replaceState(null, "", "/test-conf/");
    await renderLoaded([PAPER_A, PAPER_B]);

    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    // Select a real paper first -- a restore snapshot can only exist in
    // history because some earlier selection wrote it (buildSelectionHistoryEntries),
    // and the fix's effect is keyed on `selectedPaperId` transitioning
    // away from a selection, so the test must go through that
    // transition too, not just dispatch a bare popstate against an
    // already-unselected page (React bails out of re-rendering, and
    // thus of re-running the restore effect, when a state setter is
    // called with the value it already holds).
    const selectButtonB = document.querySelector<HTMLButtonElement>(
      `[data-select-paper="${PAPER_B.paper_id}"]`,
    );
    await act(async () => {
      fireEvent.click(selectButtonB as HTMLButtonElement);
    });

    // A syntactically valid but unrendered paper_id (readCatalogHistoryRestore
    // only checks the 40-hex shape, not that the row still exists in the
    // current list) -- simulates returning to a LIST entry whose
    // snapshot points at a paper the list no longer shows.
    const missingId = "c".repeat(40);
    const listHref = "/test-conf/";
    const listState = {
      paperpilotCatalogRestore: {
        version: 1,
        visibleCount: 30,
        scrollY: 123,
        focusPaperId: missingId,
      },
    };

    await act(async () => {
      window.history.replaceState(listState, "", listHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: listState }));
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(scrollToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ top: 123, behavior: "auto" }),
    );
    expect(document.activeElement).toBe(document.getElementById("search"));
  });
});

describe("CatalogApp paper-links link (catalog LOW)", () => {
  it("links the no-JS fallback at the ported /<conf>/paper-links/ route, not paper-links.html", async () => {
    // The catalog-load-error state's link is the one reachable copy of
    // `paperLinksHref` under a client render: react-dom never mounts
    // <noscript>'s own children on the client (confirmed: an isolated
    // render of a bare <noscript> leaves it with zero child nodes here),
    // so the other occurrence of the same `paperLinksHref` string is the
    // only one `screen` can see.
    vi.spyOn(catalogData, "fetchCatalogPapers").mockResolvedValue({
      status: "error",
      error: "boom",
    });
    render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
    const link = await screen.findByRole("link", { name: "JavaScript なしの論文リンク一覧" });
    expect(link.getAttribute("href")).toBe("/test-conf/paper-links/");
  });
});
