// @vitest-environment jsdom
/**
 * #521 U3: the cross-search detail dialog embeds a catalog page in an
 * iframe. Before this fix the iframe loaded the full catalog, so its own
 * 「詳細を閉じる」 (and Esc) swapped the dialog's content for an unrelated
 * conference list, and at 412px the dialog was 388px wide instead of
 * filling the screen.
 *
 * The dialog now marks the iframe URL with `embed=1` (never the 「通常ページで
 * 開く」 link), the catalog shows only the selected paper without its close
 * control when embedded, and the dialog goes full screen below 480px.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CatalogApp } from "../../components/catalog/catalog-app";
import { SearchDetailDialog } from "../../components/search/search-detail-dialog";
import type { CatalogCopy } from "../../lib/catalog-copy";
import type { CatalogPaper } from "../../lib/catalog-core";
import * as catalogData from "../../lib/catalog-data";

beforeAll(() => {
  const proto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
      Object.defineProperty(this, "open", { value: true, configurable: true });
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function close(this: HTMLDialogElement) {
      if (!this.open) return;
      this.removeAttribute("open");
      Object.defineProperty(this, "open", { value: false, configurable: true });
      this.dispatchEvent(new Event("close"));
    };
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.querySelectorAll("a.s0-results__link").forEach((node) => {
    node.remove();
  });
  delete document.documentElement.dataset.embed;
  window.history.replaceState(null, "", "/");
});

const ID = "c".repeat(40);

describe("SearchDetailDialog: embedded frame URL (#521 U3)", () => {
  it("marks the iframe src with embed=1 but keeps 通常ページで開く unmarked", () => {
    render(<SearchDetailDialog />);
    const anchor = document.createElement("a");
    anchor.className = "s0-results__link";
    anchor.href = `cvpr-2026/?paper=${ID}`;
    document.body.appendChild(anchor);
    fireEvent.click(anchor);

    const iframe = document.querySelector("#search-detail-dialog iframe") as HTMLIFrameElement;
    const src = new URL(iframe.getAttribute("src") ?? "", window.location.href);
    expect(src.searchParams.get("embed")).toBe("1");
    expect(src.searchParams.get("paper")).toBe(ID);
    expect(src.pathname).toBe("/cvpr-2026/");

    const direct = new URL(
      screen.getByRole("link", { name: /通常ページで開く/ }).getAttribute("href") ?? "",
      window.location.href,
    );
    expect(direct.searchParams.has("embed")).toBe(false);
    expect(direct.searchParams.get("paper")).toBe(ID);
  });
});

const COPY: CatalogCopy = {
  display: "Test Conf",
  description: "desc",
  tagline: "tagline",
  lede: "lede",
  source: "source",
};

function paper(key: string, title: string): CatalogPaper {
  return {
    paper_id: key.repeat(40),
    title,
    authors: ["Alice"],
    tags: ["nlp"],
    abstract: "About it.",
    type: "Poster",
  };
}

const PAPERS = [paper("a", "Paper A"), paper("b", "Paper B"), paper("c", "Paper C")];

function mockDataLayer() {
  vi.spyOn(catalogData, "fetchCatalogPapers").mockResolvedValue({
    status: "ok",
    papers: PAPERS,
    byId: new Map(PAPERS.map((p) => [p.paper_id, p])),
  });
  vi.spyOn(catalogData, "fetchFullAbstract").mockResolvedValue({ status: "ready", text: "" });
  vi.spyOn(catalogData, "fetchPilotLineageIndex").mockResolvedValue(null);
}

async function renderCatalogAt(search: string) {
  window.history.replaceState(null, "", `/test-conf/${search}`);
  mockDataLayer();
  render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
  await screen.findByRole("heading", { name: "Paper C" });
}

describe("CatalogApp embedded in the search dialog (#521 U3)", () => {
  it("shows only the selected paper, without 詳細を閉じる or the list controls", async () => {
    await renderCatalogAt(`?paper=${ID}&embed=1`);
    expect(screen.queryByRole("button", { name: "詳細を閉じる" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Paper A" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Paper B" })).toBeNull();
    expect(document.getElementById("search")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "並び替え" })).toBeNull();
    // Tags are labels there: no list to filter inside the dialog.
    expect(screen.queryByRole("button", { name: "nlp" })).toBeNull();
    expect(screen.getByText("nlp")).toBeTruthy();
    expect(document.documentElement.dataset.embed).toBe("1");
  });

  it("leaves Esc to the outer dialog: the detail stays and the event is not consumed", async () => {
    await renderCatalogAt(`?paper=${ID}&embed=1`);
    // Give the selection's passive effects time to attach (see the Esc
    // tests in catalog-app-ux.test.tsx), then check Esc is not handled.
    await waitFor(() => expect(document.documentElement.dataset.embed).toBe("1"));
    let event: KeyboardEvent | null = null;
    act(() => {
      event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
    });
    expect((event as KeyboardEvent | null)?.defaultPrevented).toBe(false);
    expect(new URL(window.location.href).searchParams.get("paper")).toBe(ID);
    expect(screen.getByRole("heading", { name: "Paper C" })).toBeTruthy();
  });

  it("keeps the normal catalog (with 詳細を閉じる) when not embedded", async () => {
    await renderCatalogAt(`?paper=${ID}`);
    expect(await screen.findByRole("button", { name: "詳細を閉じる" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Paper A" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "nlp" }).length).toBeGreaterThan(0);
    expect(document.documentElement.dataset.embed).toBeUndefined();
  });

  it("falls back to the normal list when embedded without a valid paper", async () => {
    window.history.replaceState(null, "", "/test-conf/?paper=zzz&embed=1");
    mockDataLayer();
    render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
    expect(await screen.findByRole("heading", { name: "Paper A" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Paper C" })).toBeTruthy();
  });
});

describe("search detail dialog CSS (#521 U3)", () => {
  it("goes full screen below 480px", () => {
    const css = readFileSync(
      join(__dirname, "../../components/search/search-detail-dialog.module.css"),
      "utf8",
    );
    const media = css.match(/@media \(max-width: 479\.98px\)\s*\{([\s\S]*?)\n\}/);
    expect(media).not.toBeNull();
    const body = media?.[1] ?? "";
    expect(body).toMatch(/\.dialog\s*\{[^}]*width:\s*100%/);
    expect(body).toMatch(/\.dialog\s*\{[^}]*height:\s*100dvh/);
    expect(body).toMatch(/\.dialog\s*\{[^}]*max-height:\s*none/);
    expect(body).toMatch(/\.dialog\s*\{[^}]*margin:\s*0/);
  });

  it("keeps the wide dialog centred (margin: auto beats the preflight reset)", () => {
    const css = readFileSync(
      join(__dirname, "../../components/search/search-detail-dialog.module.css"),
      "utf8",
    );
    const base = css.match(/^\.dialog\s*\{([^}]*)\}/m)?.[1] ?? "";
    expect(base).toMatch(/margin:\s*auto/);
  });

  it("hides the site header and footer inside an embedded page", () => {
    const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf8");
    expect(css).toMatch(
      /:root\[data-embed\]\s+body\s*>\s*header,\s*:root\[data-embed\]\s+body\s*>\s*footer[^{]*\{[^}]*display:\s*none/,
    );
  });
});
