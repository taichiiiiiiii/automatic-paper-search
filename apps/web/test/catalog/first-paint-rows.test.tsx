// @vitest-environment jsdom
//
// #469: a fresh load commits the first FIRST_PAINT_ROWS rows, then the rest
// of the first page in the next task, so the 30-row commit never forms one
// long task on a phone.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogApp } from "../../components/catalog/catalog-app";
import { FIRST_PAINT_ROWS, PAGE_SIZE } from "../../lib/catalog-constants";
import type { CatalogCopy } from "../../lib/catalog-copy";
import type { CatalogPaper } from "../../lib/catalog-core";
import * as catalogData from "../../lib/catalog-data";

const COPY: CatalogCopy = { display: "T", description: "d", tagline: "t", lede: "l", source: "s" };
const papers: CatalogPaper[] = Array.from({ length: 50 }, (_, i) => ({
  paper_id: i.toString(16).padStart(40, "0"),
  title: `Paper ${i}`,
  authors: ["A"],
  tags: ["x"],
  abstract: "",
  type: "Poster",
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const rows = () => document.querySelectorAll("li[data-paper-id]").length;

describe("first paint rows (#469)", () => {
  it("commits FIRST_PAINT_ROWS first, then the full first page", async () => {
    vi.useFakeTimers();
    vi.spyOn(catalogData, "fetchCatalogPapers").mockResolvedValue({
      status: "ok",
      papers,
      byId: new Map(papers.map((p) => [p.paper_id, p])),
    });
    vi.spyOn(catalogData, "fetchPilotLineageIndex").mockResolvedValue(null);
    render(<CatalogApp conf="test-conf" generated="2026-01-01" copy={COPY} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Paper 0")).toBeTruthy();
    expect(rows()).toBe(FIRST_PAINT_ROWS);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(rows()).toBe(PAGE_SIZE);
  });
});
