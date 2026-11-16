// @vitest-environment jsdom
/**
 * #521 U4 (position only): while the top-20 suggestion list is open, the
 * "検索結果を絞り込む" fieldset used to sit AFTER the list in the DOM and
 * outside the form. The list is `position: absolute` inside the form, so
 * it painted over the filters and the facets were only reachable once the
 * list was closed. The filters now come before the list, inside the same
 * positioned form, so the list's static position is below them.
 *
 * The ranking (search-core.ts) is deliberately untouched here.
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

function filters(): HTMLElement {
  return screen.getByRole("group", { name: "検索結果を絞り込む" });
}

function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// The facet <select>s also hold role=option elements, so count only the
// suggestion list's own options.
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

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SearchArea: the filters stay above the results (#521 U4)", () => {
  it("puts the visible filters before the suggestion list and its first option", async () => {
    await openSuggestions();
    const group = filters();
    expect(group.hidden).toBe(false);
    const listbox = screen.getByRole("listbox", { name: "検索結果" });
    expect(precedes(group, listbox)).toBe(true);
    expect(precedes(group, suggestionOptions()[0] as HTMLElement)).toBe(true);
  });

  it("puts the filters in the same positioned form as the absolute list, before the 'see all' link", async () => {
    await openSuggestions();
    const group = filters();
    const listbox = screen.getByRole("listbox", { name: "検索結果" });
    const form = listbox.closest("form");
    expect(form).not.toBeNull();
    expect(form?.contains(group)).toBe(true);
    const more = screen.getByRole("link", { name: /^すべての 2 件を見る$/ });
    expect(precedes(group, more)).toBe(true);
  });

  it("keeps the list and the 'see all' link when focus moves from the input to a filter", async () => {
    // Keyboard path: Tab from the input now reaches the filters before the
    // "すべての N 件を見る" link, so a move to a filter must not hide it.
    await openSuggestions();
    const input = screen.getByLabelText(SEARCH_INPUT_LABEL);
    const select = screen.getByLabelText("学会");
    fireEvent.blur(input, { relatedTarget: select });
    await new Promise((r) => setTimeout(r, 50));
    expect(suggestionOptions()).toHaveLength(2);
    const more = screen.getByRole("link", { name: /^すべての 2 件を見る$/ });
    expect(more.hidden).toBe(false);
  });

  it("still closes the suggestion list when focus leaves the form", async () => {
    await openSuggestions();
    const outside = document.createElement("button");
    document.body.append(outside);
    fireEvent.blur(screen.getByLabelText(SEARCH_INPUT_LABEL), { relatedTarget: outside });
    await waitFor(() => expect(suggestionOptions()).toHaveLength(0), WAIT);
    outside.remove();
  });

  it("keeps the filters before the full result list when a facet is applied", async () => {
    window.history.replaceState(null, "", "/?q=alpha&conference=iclr-2025");
    render(<SearchArea />);
    const list = await screen.findByRole("heading", { level: 2 }, WAIT);
    await waitFor(
      () => expect(screen.getByText("Alpha Diffusion Transformers")).toBeTruthy(),
      WAIT,
    );
    expect(precedes(filters(), list)).toBe(true);
  });
});
