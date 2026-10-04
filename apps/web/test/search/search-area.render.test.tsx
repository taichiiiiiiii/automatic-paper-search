// @vitest-environment jsdom
/**
 * Component-level contract tests for SearchArea (M6, the search half):
 * these render the real React component (jsdom + Testing Library) and
 * drive it through `fetch`, unlike lib/search-core.ts's pure-function
 * tests, which cannot see the async state machine in
 * components/search/search-area.tsx (ensureIndex/ensureIdBlock caching,
 * the monotonic `runSerial` staleness guard, showError wiring).
 *
 * Each scenario below is paired with a known code mutation (see the
 * comment above each `it`) that was manually applied and reverted while
 * writing this file to confirm the test goes red without the guard it
 * is meant to pin -- not just green with it.
 *
 * NOTE for local runs: jsdom@30 (-> undici@8.11.2) needs Node >= 22.19
 * (`engines.node` in undici's own package.json); it hard-crashes at
 * import time on this repo's Node 20 baseline with "webidl.util.
 * markAsUncloneable is not a function" before any test executes.
 * `.github/workflows/ts-ci.yml` runs Node 22, so CI is unaffected; to
 * run this file locally on a Node-20 machine, point `node` at an
 * already-installed Node >= 22 (e.g.
 * `PATH="/opt/homebrew/Cellar/node@22/<version>/bin:$PATH"`) --
 * do not add a polyfill or new dependency for this.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchArea } from "../../components/search/search-area";

const SEARCH_INPUT_LABEL = "タイトル・著者・タグで横断検索";
const RETRY_LABEL = "再試行";
const LOAD_ERROR_MESSAGE = "検索データを読み込めませんでした。再試行してください。";

function hexId(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function jsonResponse(body: unknown): { ok: true; status: 200; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

function notFoundResponse(): { ok: false; status: 404; json: () => Promise<unknown> } {
  return { ok: false, status: 404, json: async () => null };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function typeQuery(query: string) {
  const input = screen.getByLabelText(SEARCH_INPUT_LABEL);
  fireEvent.change(input, { target: { value: query } });
}

describe("SearchArea: search index failure", () => {
  // Mutation checked: in runQuery's `catch` block, replacing
  // `showError(error)` with `renderEmptyResults(query, false)` (or just
  // deleting the catch so the rejection is swallowed) makes this test
  // fail -- the retry button never appears and "0 件" shows instead.
  it("shows the retry control and never '0 件' when the index fetch fails with HTTP 500 (SCR-06)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => notFoundResponse()),
    );

    const { container } = render(<SearchArea />);
    await typeQuery("diffusion");

    await waitFor(() => {
      const retry = screen.getByRole("button", { name: RETRY_LABEL });
      expect(retry.hasAttribute("hidden")).toBe(false);
    });
    expect(screen.getByRole("status").textContent).toBe(LOAD_ERROR_MESSAGE);
    expect(container.textContent).not.toContain("0 件");
  });
});

describe("SearchArea: paper-id block failure", () => {
  // Mutation checked: same catch-block mutation as above also flips
  // this test red (a 404'd id block throws inside resolvePaperIds,
  // which only matters if runQuery's catch still calls showError).
  it("shows an error, not a partial render, when a matched paper's id-block fetch 404s (SCR-05)", async () => {
    const rows = [["Diffusion Models For Everyone", "aaai-2026", 0, [], [], 2026, "Oral"]];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("search-index-v2.json")) return jsonResponse(rows);
        return notFoundResponse(); // every search-paper-ids-v1 block fails closed
      }),
    );

    const { container } = render(<SearchArea />);
    await typeQuery("diffusion");

    await waitFor(() => {
      const retry = screen.getByRole("button", { name: RETRY_LABEL });
      expect(retry.hasAttribute("hidden")).toBe(false);
    });
    expect(screen.getByRole("status").textContent).toBe(LOAD_ERROR_MESSAGE);
    // Scoped to the suggestions listbox: the facet <select>s legitimately
    // populate their own native <option>s from the loaded index before
    // the id-block fetch fails, which is not the partial render this
    // guards against.
    const listbox = document.getElementById("s0-search-listbox");
    expect(listbox).not.toBeNull();
    expect(within(listbox as HTMLElement).queryAllByRole("option", { hidden: true })).toHaveLength(
      0,
    );
    expect(container.textContent).not.toContain("0 件");
  });
});

describe("SearchArea: out-of-order responses", () => {
  // 257 rows so "alpha" (ordinal 256) and "beta" (ordinal 0) resolve
  // through two *different* search-paper-ids-v1 blocks (256/256=1 vs.
  // 0/256=0) -- each independently controllable, so the test proves the
  // `runSerial` staleness guard, not an artifact of both queries
  // sharing one cached block promise.
  function buildRows() {
    const rows: Array<[string, string, number, string[], string[], number | null, string]> = [];
    for (let i = 0; i < 257; i++) {
      if (i === 0) rows.push(["Beta Quantum Networks", "aaai-2026", 0, [], [], 2026, "Poster"]);
      else if (i === 256)
        rows.push(["Alpha Diffusion Models", "aaai-2026", 256, [], [], 2026, "Poster"]);
      else rows.push([`Filler Paper ${i}`, "aaai-2026", i, [], [], 2026, "Poster"]);
    }
    return rows;
  }

  function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  // Mutation checked: deleting the `if (serial !== runSerialRef.current)
  // return;` line that runs right after `resolvePaperIds` resolves (the
  // second of the two serial checks in runQuery) makes this test fail --
  // "Alpha Diffusion Models" ends up on screen after block1 resolves,
  // clobbering the already-rendered "beta" result.
  it("renders only the latest query when an earlier query's id-block response arrives after a later one", async () => {
    const rows = buildRows();
    const block0 = createDeferred(); // beta's block (typed second, resolved first)
    const block1 = createDeferred(); // alpha's block (typed first, resolved last -- stale)

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("search-index-v2.json")) return jsonResponse(rows);
      if (url.includes("0000.json")) {
        await block0.promise;
        return jsonResponse({
          schema_version: "search-paper-ids-v1",
          block: 0,
          start: 0,
          paper_ids: Array.from({ length: 256 }, (_, i) => hexId(i)),
        });
      }
      if (url.includes("0001.json")) {
        await block1.promise;
        return jsonResponse({
          schema_version: "search-paper-ids-v1",
          block: 1,
          start: 256,
          paper_ids: [hexId(256)],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchArea />);

    await typeQuery("alpha");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("0001.json"),
        expect.anything(),
      ),
    );

    await typeQuery("beta");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("0000.json"),
        expect.anything(),
      ),
    );

    // Resolve the *later* query's (beta's) block first.
    block0.resolve();
    await waitFor(() => expect(screen.getByText("Beta Quantum Networks")).toBeTruthy());

    // Now let the *earlier* query's (alpha's) response arrive late.
    block1.resolve();
    await new Promise((r) => setTimeout(r, 50));

    expect(screen.queryByText("Alpha Diffusion Models")).toBeNull();
    expect(screen.getByText("Beta Quantum Networks")).toBeTruthy();
  });
});
