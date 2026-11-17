// @vitest-environment jsdom
/**
 * #521 U18: from 721px up the top-20 suggestion list is an absolutely
 * positioned dropdown (z-index 20). The "すべての N 件を見る" link used to be
 * the next in-flow sibling of that list, so the list was painted right on
 * top of it: a click on the link opened the first suggestion instead.
 * The link now sits in the same overlay panel as the list, after it, so the
 * list can never cover it, and clicking it still opens the full results.
 *
 * jsdom has no layout, so the overlap itself is measured in
 * e2e/search-more-link.e2e.ts; this file pins the structure and the click.
 * The ranking (search-core.ts) is untouched.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchArea } from "../../components/search/search-area";

const SEARCH_INPUT_LABEL = "タイトル・著者・タグで横断検索";
const WAIT = { timeout: 10_000 };
vi.setConfig({ testTimeout: 30_000 });

function hexId(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function rows() {
  return [
    ["Alpha Diffusion Models", "aaai-2026", 0, [], [], 2026, "Poster"],
    ["Alpha Diffusion Transformers", "iclr-2025", 1, [], [], 2025, "Oral"],
  ];
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("search-index-v2.json")) {
        return { ok: true, status: 200, json: async () => rows() };
      }
      if (url.includes("0000.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schema_version: "search-paper-ids-v1",
            block: 0,
            start: 0,
            paper_ids: [hexId(0), hexId(1)],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function suggestionOptions(): HTMLElement[] {
  const listbox = document.getElementById("s0-search-listbox");
  if (listbox === null || listbox.hidden) return [];
  return within(listbox).queryAllByRole("option");
}

async function openSuggestions() {
  render(<SearchArea />);
  fireEvent.change(screen.getByLabelText(SEARCH_INPUT_LABEL), { target: { value: "alpha" } });
  await waitFor(() => expect(suggestionOptions().length).toBe(2), WAIT);
}

function moreLink(): HTMLElement {
  return screen.getByRole("link", { name: /^すべての 2 件を見る$/ });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SearchArea: the open list never covers 'すべての N 件を見る' (#521 U18)", () => {
  it("puts the link in the list's own overlay panel, after the list and outside the listbox", async () => {
    await openSuggestions();
    const listbox = screen.getByRole("listbox", { name: "検索結果" });
    const more = moreLink();
    const panel = listbox.parentElement;
    expect(panel).not.toBeNull();
    // The panel is a wrapper of its own, not the form: positioning the
    // panel (not the bare list) is what keeps the link out from under it.
    expect(panel?.tagName).not.toBe("FORM");
    expect(more.parentElement).toBe(panel);
    expect(listbox.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A link inside role=listbox would be a nested interactive control.
    expect(listbox.contains(more)).toBe(false);
    // Still inside the form, so moving focus to it keeps the list open.
    expect(listbox.closest("form")?.contains(more)).toBe(true);
  });

  it("opens the full results and closes the list when the link is clicked while the list is open", async () => {
    await openSuggestions();
    const input = screen.getByLabelText(SEARCH_INPUT_LABEL);
    const more = moreLink();
    // Pointer path: the input loses focus to the link first.
    fireEvent.blur(input, { relatedTarget: more });
    fireEvent.click(more);
    await waitFor(() => expect(suggestionOptions()).toHaveLength(0), WAIT);
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "「alpha」の検索結果" })).toBeTruthy(),
      WAIT,
    );
    const params = new URLSearchParams(window.location.search);
    expect(params.get("q")).toBe("alpha");
    expect(params.get("page")).toBe("1");
    expect(window.location.pathname).toBe("/");
  });
});
