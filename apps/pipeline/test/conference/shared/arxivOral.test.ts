/**
 * Port of the `oral_titles_from_arxiv` / `build_rows` / `fetch_results_checked`
 * parts of `paperpilot/tests/test_collect_conference.py` (CNF-14 of
 * docs/migration/safety-contracts.md).
 */
import { describe, expect, it, vi } from "vitest";
import {
  type ArxivAcceptedResult,
  buildArxivRows,
  fetchArxivResultsChecked,
  ORAL_MALFORMED_FEED,
  ORAL_WINDOW_FILLED,
  oralTitlesFromArxiv,
} from "../../../src/conference/shared/arxivOral.js";

function entry(
  title: string,
  comment: string,
  aid: string,
  authors: string[] = ["Alice", "Bob"],
): ArxivAcceptedResult {
  return {
    title,
    summary: "an abstract about computer vision",
    comment,
    entryId: `http://arxiv.org/abs/${aid}v1`,
    pdfUrl: `https://arxiv.org/pdf/${aid}v1`,
    authorNames: authors,
  };
}

function feedBody(entries: ArxivAcceptedResult[], total?: number, startIndex = 0): string {
  const xml = entries
    .map(
      (e) => `<entry>
  <id>${e.entryId}</id>
  <updated>2026-01-01T00:00:00Z</updated>
  <published>2026-01-01T00:00:00Z</published>
  <title>${e.title}</title>
  <summary>${e.summary}</summary>
  <arxiv:comment>${e.comment}</arxiv:comment>
  ${e.authorNames.map((n) => `<author><name>${n}</name></author>`).join("\n")}
  <link title="pdf" href="${e.pdfUrl}" rel="related"/>
</entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>${total ?? entries.length}</opensearch:totalResults>
  <opensearch:itemsPerPage>${entries.length}</opensearch:itemsPerPage>
  <opensearch:startIndex>${startIndex}</opensearch:startIndex>
  ${xml}
</feed>`;
}

function fetchTextReturning(body: string, status = 200) {
  return vi.fn(async () => ({ status, text: async () => body }));
}

describe("buildArxivRows", () => {
  it("keeps genuine acceptances only and flags oral/highlight", () => {
    const results = [
      entry("Accepted paper", "Accepted to CVPR 2026", "2604.00001"),
      entry("Highlight paper", "Accepted to CVPR 2026 (Highlight)", "2604.00002"),
      entry("Workshop paper", "CVPR 2026 FGVC Workshop", "2604.00003"),
      entry("Bare mention", "CVPR 2026", "2604.00004"),
      entry("Other venue", "Accepted to ICLR 2026", "2604.00005"),
      entry("No comment", "", "2604.00006"),
    ];
    const { rows, oralTitles } = buildArxivRows(results, "CVPR");
    expect(new Set(rows.map((r) => r.title))).toEqual(
      new Set(["Accepted paper", "Highlight paper"]),
    );
    expect(rows.every((r) => r.venue === "CVPR" && r.venue_tier === 2)).toBe(true);
    expect(oralTitles).toEqual(["Highlight paper"]);
  });

  it("dedups by arXiv id, keeping the first", () => {
    const results = [
      entry("First", "Accepted to CVPR 2026", "2604.00001"),
      entry("Duplicate same id", "Accepted to CVPR 2026", "2604.00001"),
    ];
    const { rows } = buildArxivRows(results, "CVPR");
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("First");
  });

  it("drops an unparseable arXiv id", () => {
    const bad: ArxivAcceptedResult = {
      title: "No id",
      summary: "x",
      comment: "Accepted to CVPR 2026",
      entryId: "not-a-real-url",
      pdfUrl: null,
      authorNames: [],
    };
    const { rows } = buildArxivRows([bad], "CVPR");
    expect(rows).toEqual([]);
  });
});

describe("oralTitlesFromArxiv", () => {
  it("returns only the venue's oral/highlight titles", async () => {
    const results = [
      entry("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
      entry("Highlight two", "Accepted to CVPR 2025 Highlight", "2501.00002"),
      entry("Plain poster", "Accepted to CVPR 2025", "2501.00003"),
      entry("Other venue oral", "Accepted to ICLR 2025 (Oral)", "2501.00004"),
    ];
    const fetchText = fetchTextReturning(feedBody(results));
    const overlay = await oralTitlesFromArxiv('co:"CVPR 2025"', "CVPR", 1600, { fetchText });
    expect(overlay).toEqual({ titles: ["Oral one", "Highlight two"], reason: null });
  });

  it("returns null + ORAL_WINDOW_FILLED when the fetch fills the whole window", async () => {
    const results = [
      entry("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
      entry("Oral two", "Accepted to CVPR 2025 (Oral)", "2501.00002"),
      entry("Poster three", "Accepted to CVPR 2025", "2501.00003"),
    ];
    const fetchText = fetchTextReturning(feedBody(results));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    const overlay = await oralTitlesFromArxiv('co:"CVPR 2025"', "CVPR", 3, { fetchText });
    spy.mockRestore();
    expect(overlay.titles).toBeNull();
    expect(overlay.reason).toBe(ORAL_WINDOW_FILLED);
    expect(logs.some((l) => l.includes("--oral-max") && l.includes("3"))).toBe(true);
    expect(logs.some((l) => l.includes("malformed"))).toBe(false);
  });

  it("returns titles when the result count is below the cap", async () => {
    const results = [
      entry("Oral one", "Accepted to CVPR 2025 (Oral)", "2501.00001"),
      entry("Poster two", "Accepted to CVPR 2025", "2501.00002"),
    ];
    const fetchText = fetchTextReturning(feedBody(results));
    const overlay = await oralTitlesFromArxiv('co:"CVPR 2025"', "CVPR", 3, { fetchText });
    expect(overlay).toEqual({ titles: ["Oral one"], reason: null });
  });

  it("returns null + ORAL_MALFORMED_FEED on a non-feed 200 body", async () => {
    const fetchText = fetchTextReturning("<html><body>rate limited</body></html>");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    const overlay = await oralTitlesFromArxiv('co:"CVPR 2025"', "CVPR", 3, { fetchText });
    spy.mockRestore();
    expect(overlay.titles).toBeNull();
    expect(overlay.reason).toBe(ORAL_MALFORMED_FEED);
    expect(logs.some((l) => l.includes("malformed"))).toBe(true);
    expect(logs.some((l) => l.includes("--oral-max"))).toBe(false);
  });
});

describe("fetchArxivResultsChecked", () => {
  it("is complete when a page comes back short of pageSize", async () => {
    const results = [entry("P1", "Accepted to CVPR 2026", "2604.00001")];
    const fetchText = fetchTextReturning(feedBody(results, 1));
    const { results: got, complete } = await fetchArxivResultsChecked('co:"CVPR 2026"', 10, {
      fetchText,
    });
    expect(got.length).toBe(1);
    expect(complete).toBe(true);
  });

  it("is incomplete on a non-200 response", async () => {
    const fetchText = fetchTextReturning("", 503);
    const { results, complete } = await fetchArxivResultsChecked('co:"CVPR 2026"', 10, {
      fetchText,
    });
    expect(results).toEqual([]);
    expect(complete).toBe(false);
  });

  it("H3: keeps page-1's total for pagination and stops once it's covered, ignoring a later page's agreeing total", async () => {
    // page 1 total=4, page 2 (same total=4) covers the rest -> complete.
    const page1 = [
      entry("P1", "Accepted to CVPR 2026", "2604.00001"),
      entry("P2", "Accepted to CVPR 2026", "2604.00002"),
    ];
    const page2 = [
      entry("P3", "Accepted to CVPR 2026", "2604.00003"),
      entry("P4", "Accepted to CVPR 2026", "2604.00004"),
    ];
    const fetchText = async (url: string) => ({
      status: 200,
      text: async () => (url.includes("start=0") ? feedBody(page1, 4) : feedBody(page2, 4)),
    });
    const { results, complete } = await fetchArxivResultsChecked(
      'co:"CVPR 2026"',
      10,
      { fetchText },
      2,
    );
    expect(results.length).toBe(4);
    expect(complete).toBe(true);
  });

  it("H3: a later page reporting a DIFFERENT total than page 1 is incomplete (does not keep re-reading totalResults)", async () => {
    // page 1: totalResults=250, 2 entries (pageSize=2). page 2: totalResults
    // drifts to 150 (would otherwise make offset>=total trip early/wrongly) —
    // must be reported incomplete instead of trusted.
    const page1 = [
      entry("P1", "Accepted to CVPR 2026", "2604.00001"),
      entry("P2", "Accepted to CVPR 2026", "2604.00002"),
    ];
    const page2 = [
      entry("P3", "Accepted to CVPR 2026", "2604.00003"),
      entry("P4", "Accepted to CVPR 2026", "2604.00004"),
    ];
    const fetchText = async (url: string) => ({
      status: 200,
      text: async () => (url.includes("start=0") ? feedBody(page1, 250) : feedBody(page2, 150)),
    });
    const { results, complete } = await fetchArxivResultsChecked(
      'co:"CVPR 2026"',
      1000,
      { fetchText },
      2,
    );
    // Only page 1's 2 entries were kept — the drifted page-2 total aborted
    // the scan instead of being folded in as if it were trustworthy.
    expect(results.length).toBe(2);
    expect(complete).toBe(false);
  });

  it("LOW (P4 review round 2): a non-first page that comes back empty is incomplete, even though it self-reports being legitimately past the end", async () => {
    // page 1: totalResults=5, 2 entries (a full pageSize=2 page) -> our own
    // running offset becomes 2, still short of the promised total of 5, so
    // a page 2 fetch is issued. page 2 comes back with ZERO entries but
    // its OWN totalResults=5 (unchanged) and startIndex=5 (>= its own
    // total) — `parseArxivFeed` accepts this as `ok:true` (it only checks
    // THAT page's own startIndex/total agreement, not our offset), so
    // without the fix this would be trusted as "we're done" even though
    // only 2 of the promised 5 results were ever collected.
    const page1 = [
      entry("P1", "Accepted to CVPR 2026", "2604.00001"),
      entry("P2", "Accepted to CVPR 2026", "2604.00002"),
    ];
    const fetchText = async (url: string) => ({
      status: 200,
      text: async () => (url.includes("start=0") ? feedBody(page1, 5) : feedBody([], 5, 5)),
    });
    const { results, complete } = await fetchArxivResultsChecked(
      'co:"CVPR 2026"',
      1000,
      { fetchText },
      2,
    );
    expect(results.length).toBe(2);
    expect(complete).toBe(false);
  });

  it("is complete when the VERY FIRST page comes back legitimately empty (a genuine zero-result venue)", async () => {
    const fetchText = async () => ({ status: 200, text: async () => feedBody([], 0, 0) });
    const { results, complete } = await fetchArxivResultsChecked('co:"CVPR 2026"', 10, {
      fetchText,
    });
    expect(results).toEqual([]);
    expect(complete).toBe(true);
  });
});
