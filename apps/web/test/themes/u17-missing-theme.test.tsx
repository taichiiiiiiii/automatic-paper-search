// @vitest-environment jsdom
//
// #521 U17: `/themes/?theme=<unknown slug>` used to show another theme
// (the default, e.g. Graph Neural Network) with the only hint BELOW its h1,
// and its one action opened GitHub Issues even though the site has its own
// request form. The notice now comes before the h1, says the tree below is
// shown instead (代わりに表示中), and its button opens this page's request
// panel with the requested words filled in -- the GitHub Issue link is
// kept only for degraded mode (no API_BASE). The URL is never rewritten.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemesClient } from "../../components/themes/ThemesClient";
import * as dataThemes from "../../lib/data-themes";
import { ARTIFACT_VERSION, QUALITY_VERSION, type QualityRow } from "../../lib/lineage/core";
import * as themesFeed from "../../lib/themes-feed";
import type { LineageArtifact } from "../../lib/themes-quality";

let apiBase: string | null = "https://api.example.test";
vi.mock("../../lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/config")>();
  return {
    ...actual,
    get API_BASE() {
      return apiBase;
    },
  };
});

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

function row(slug: string, label: string, published = true): QualityRow {
  return {
    collection_id: `theme:${slug}`,
    kind: "theme",
    slug,
    label,
    path: `themes/${slug}/lineage.json`,
    availability: published ? "ready" : "blocked",
    audit_status: published ? "passed" : "failed",
    freshness: "fresh",
    generated_at: "2026-08-30T00:00:00Z",
    snapshot_date: null,
    node_count: 2,
    edge_count: 1,
    artifact_schema_version: "lineage-artifact-v1",
    input_sha256: "b".repeat(64),
    audit: {
      fixture_sha256: "9".repeat(64),
      evaluated_at: "2026-08-30T00:00:00Z",
      actor: "ci:audit-v1",
      checks: [
        {
          name: "artifact_contract_v1",
          status: published ? "passed" : "failed",
          observed: 0,
          expected: 0,
          evidence: [],
        },
        {
          name: "golden_fixture",
          status: published ? "passed" : "failed",
          observed: "fixture-sha",
          expected: "matching frozen fixture",
          evidence: [],
        },
      ],
    },
  } as QualityRow;
}

const ARTIFACT: LineageArtifact = {
  schema_version: ARTIFACT_VERSION,
  root: null,
  nodes: [
    { id: "a", is_focus: true, title: "Alpha", year: 2018, citation_count: 100 },
    { id: "b", is_focus: false, title: "Beta", year: 2020, citation_count: 10 },
  ],
  edges: [],
  clusters: [],
  meta: { generated_at: "2026-10-11T00:00:00Z", keywords: ["graph neural network"] },
};

function mockData(accepting: boolean, extraRows: QualityRow[] = []) {
  vi.spyOn(dataThemes, "fetchThemesManifest").mockResolvedValue({
    status: "ok",
    data: [
      { slug: "gnn", theme: "Graph Neural Network", paper_count: 2, year_range: [2018, 2020] },
      { slug: "moe", theme: "Mixture of Experts", paper_count: 2, year_range: [2018, 2020] },
    ],
  });
  vi.spyOn(dataThemes, "fetchThemeQualityRollup").mockResolvedValue({});
  vi.spyOn(dataThemes, "fetchLineageQualityManifest").mockResolvedValue({
    schema_version: QUALITY_VERSION,
    as_of: "2026-08-30T00:00:00Z",
    audit_version: "audit-v1",
    collections: [
      row("gnn", "Graph Neural Network"),
      row("moe", "Mixture of Experts"),
      ...extraRows,
    ],
  });
  vi.spyOn(dataThemes, "fetchThemeArtifact").mockResolvedValue(ARTIFACT);
  const health = vi.spyOn(dataThemes, "fetchThemeApiAccepting").mockResolvedValue(accepting);
  vi.spyOn(themesFeed, "fetchThemeNewPapers").mockResolvedValue(null);
  vi.spyOn(themesFeed, "fetchThemeCodeLinks").mockResolvedValue(null);
  return { health };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

function openAt(query: string) {
  search = query;
  window.history.replaceState(null, "", `/themes/?${query}`);
}

/** The fallback notice: the status line that names the requested slug. */
function notice(slug: string): HTMLElement {
  const found = screen.getAllByRole("status").find((el) => el.textContent?.includes(`"${slug}"`)) as
    | HTMLElement
    | undefined;
  if (!found) throw new Error("fallback notice not rendered");
  return found;
}

beforeEach(() => {
  apiBase = "https://api.example.test";
  localStorage.clear();
  localStorage.setItem("pp.theme.onboarded", "1");
  openAt("theme=does-not-exist");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("#521 U17: an unknown ?theme= slug", () => {
  it("puts the notice before the h1 and says the tree below is shown instead", async () => {
    mockData(true);
    render(<ThemesClient />);
    const h1 = await screen.findByRole("heading", { level: 1 });
    const box = notice("does-not-exist");
    // The notice precedes the h1 in document (= reading) order.
    expect(box.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.textContent).toContain("代わりに表示中");
    expect(box.textContent).toContain("Graph Neural Network");
    // The h1 still names what is actually shown.
    expect(h1.textContent).toContain("Graph Neural Network");
  });

  it("opens this page's request panel with the requested words, without sending or touching the URL", async () => {
    mockData(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<ThemesClient />);
    await screen.findByRole("heading", { level: 1 });
    const box = notice("does-not-exist");
    // Not a GitHub Issues link while the site's own form is available.
    expect(within(box).queryByRole("link", { name: /Issue/ })).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: /このテーマを依頼/ }));
    const panel = await screen.findByRole("region", { name: "新しいテーマの依頼" });
    const input = (await within(panel).findByRole("textbox")) as HTMLInputElement;
    expect(input.name).toBe("theme");
    expect(input.value).toBe("does not exist");
    await flush();
    // Pre-filling only: nothing was POSTed and ?theme= is unchanged.
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
    expect(window.location.search).toBe("?theme=does-not-exist");
    expect(screen.getByRole("button", { name: "✕ 閉じる" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("keeps an already-open panel's draft instead of remounting the form", async () => {
    mockData(true);
    render(<ThemesClient />);
    await screen.findByRole("heading", { level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "＋ 新しいテーマを依頼" }));
    const panel = await screen.findByRole("region", { name: "新しいテーマの依頼" });
    const input = (await within(panel).findByRole("textbox")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "My Draft" } });
    fireEvent.click(
      within(notice("does-not-exist")).getByRole("button", { name: /このテーマを依頼/ }),
    );
    await flush();
    expect(within(panel).getByRole("textbox")).toBe(input);
    expect(input.value).toBe("My Draft");
    expect(document.activeElement).toBe(panel);
  });

  it("shows the existing paused notice in the panel when the Worker is not accepting", async () => {
    mockData(false);
    render(<ThemesClient />);
    await screen.findByRole("heading", { level: 1 });
    fireEvent.click(
      within(notice("does-not-exist")).getByRole("button", { name: /このテーマを依頼/ }),
    );
    const panel = await screen.findByRole("region", { name: "新しいテーマの依頼" });
    expect(await within(panel).findByText(/新しいテーマの受付を停止しています/)).toBeTruthy();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(window.location.search).toBe("?theme=does-not-exist");
  });

  it("falls back to a GitHub Issue link only in degraded mode (no API_BASE)", async () => {
    apiBase = null;
    mockData(false);
    render(<ThemesClient />);
    await screen.findByRole("heading", { level: 1 });
    const box = notice("does-not-exist");
    expect(within(box).queryByRole("button", { name: /このテーマを依頼/ })).toBeNull();
    const link = within(box).getByRole("link", { name: /Issue/ });
    const url = new URL(link.getAttribute("href") ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/taichiiiiiiii/automatic-paper-search/issues/new",
    );
    expect(url.searchParams.get("title")).toBe("[theme request] does-not-exist");
    expect(box.textContent).toContain("代わりに表示中");
  });

  it("keeps the blocked wording (no request action) and also marks the substitute", async () => {
    openAt("theme=hidden-theme");
    mockData(true, [row("hidden-theme", "Hidden Theme", false)]);
    render(<ThemesClient />);
    const h1 = await screen.findByRole("heading", { level: 1 });
    const box = notice("hidden-theme");
    expect(box.textContent).toContain("自動検査に合格しなかったため非公開です");
    expect(box.textContent).toContain("代わりに表示中");
    expect(box.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(box).queryByRole("button", { name: /このテーマを依頼/ })).toBeNull();
    expect(within(box).queryByRole("link")).toBeNull();
  });

  it("shows no notice for a published slug", async () => {
    openAt("theme=moe");
    mockData(true);
    render(<ThemesClient />);
    await screen.findByRole("heading", { level: 1 });
    await flush();
    expect(screen.queryByText(/代わりに表示中/)).toBeNull();
  });
});
