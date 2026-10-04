/**
 * Port of `paperpilot/tests/test_collect_conference.py` (CNF-11..13,
 * docs/migration/safety-contracts.md). The Python suite mocks the
 * `arxiv` package's `Client`/`fetch_results` directly; this port has no
 * such third-party client, so every test here instead injects
 * `arxiv.fetchText` and supplies canned Atom-feed HTTP bodies — the
 * "canned HTTP fixtures" approach the migration's parity tool uses
 * (docs/design/39 §7.2). Fetch/filter semantics themselves (CNF-14..19)
 * are exercised by `../shared/arxivOral.test.ts` and
 * `../shared/writeOutputs.test.ts`; this file focuses on
 * `runCollectConferenceMain`'s own primary-fetch gating.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCollectConferenceMain } from "../../../src/conference/arxiv/collect.js";
import type { ArxivFetchDeps, ArxivTextResponse } from "../../../src/conference/shared/index.js";

function atomFeed(opts: {
  totalResults?: number;
  entries: {
    id: string;
    title?: string;
    authorName?: string;
    comment?: string;
    summary?: string;
  }[];
}): string {
  const entries = opts.entries
    .map(
      (e) =>
        `<entry><id>${e.id}</id><updated>2025-01-01T00:00:00Z</updated><published>2025-01-01T00:00:00Z</published>` +
        `<title>${e.title ?? "Paper"}</title><summary>${e.summary ?? "abs"}</summary>` +
        `<author><name>${e.authorName ?? "Author"}</name></author>` +
        (e.comment ? `<arxiv:comment>${e.comment}</arxiv:comment>` : "") +
        `</entry>`,
    )
    .join("");
  const total = opts.totalResults ?? opts.entries.length;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">` +
    `<opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex>` +
    entries +
    `</feed>`
  );
}

function fixedFetch(body: string, status = 200): ArxivFetchDeps {
  const resp: ArxivTextResponse = { status, text: async () => body };
  return { fetchText: async () => resp };
}

let outputRoot: string;
beforeEach(() => {
  outputRoot = mkdtempSync(join(tmpdir(), "arxiv-conf-test-"));
});

describe("runCollectConferenceMain (CNF-11/12/13)", () => {
  const baseArgv = ["--conference", "cvpr-2026", "--venue", "CVPR", "--query", 'co:"CVPR 2026"'];

  it("CNF-11: refuses a malformed arxiv feed, writes nothing", async () => {
    const code = await runCollectConferenceMain(baseArgv, {
      arxiv: fixedFetch("<html>bad</html>"),
      outputRoot,
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "cvpr-2026"))).toBe(false);
  });

  it("H3: refuses a fetch where page 2 reports a different totalResults than page 1, writes nothing", async () => {
    // Page 1: totalResults=250, a full 100-entry page (pageSize default is
    // 100) — so pagination continues to page 2 instead of stopping. Page 2:
    // totalResults drifts to 150. The fetch must not keep paging against
    // whichever total it last saw; it refuses the whole run instead.
    const page1Entries = Array.from({ length: 100 }, (_, i) => ({
      id: `http://arxiv.org/abs/2501.${String(i).padStart(5, "0")}`,
      comment: "Accepted to CVPR 2026",
    }));
    const page2Entries = Array.from({ length: 100 }, (_, i) => ({
      id: `http://arxiv.org/abs/2502.${String(i).padStart(5, "0")}`,
      comment: "Accepted to CVPR 2026",
    }));
    const fetchText = async (url: string) => ({
      status: 200,
      text: async () =>
        url.includes("start=0")
          ? atomFeed({ entries: page1Entries, totalResults: 250 })
          : atomFeed({ entries: page2Entries, totalResults: 150 }),
    });
    const code = await runCollectConferenceMain([...baseArgv, "--max", "1000"], {
      arxiv: { fetchText },
      outputRoot,
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "cvpr-2026"))).toBe(false);
  });

  it("CNF-11: a well-formed feed with one skipped entry (missing <updated>) still refuses, writes nothing", async () => {
    const goodEntry =
      `<entry><id>http://arxiv.org/abs/2501.00001</id><updated>2025-01-01T00:00:00Z</updated>` +
      `<published>2025-01-01T00:00:00Z</published><title>Good</title><summary>abs</summary>` +
      `<author><name>A</name></author><arxiv:comment>Accepted to CVPR 2026</arxiv:comment></entry>`;
    // Missing <updated> — buildEntry() skips this one (COL-01/06), but the
    // page itself still parses as a well-formed Atom feed.
    const skippedEntry =
      `<entry><id>http://arxiv.org/abs/2501.00002</id>` +
      `<published>2025-01-01T00:00:00Z</published><title>Skipped</title><summary>abs</summary>` +
      `<author><name>A</name></author><arxiv:comment>Accepted to CVPR 2026</arxiv:comment></entry>`;
    const feed =
      `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">` +
      `<opensearch:totalResults>2</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex>` +
      goodEntry +
      skippedEntry +
      `</feed>`;
    const code = await runCollectConferenceMain(baseArgv, {
      arxiv: fixedFetch(feed),
      outputRoot,
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "cvpr-2026"))).toBe(false);
  });

  it("CNF-12: refuses a fetch that filled the --max window, no override exists", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `http://arxiv.org/abs/2501.0000${i}`,
      comment: "Accepted to CVPR 2026",
    }));
    const code = await runCollectConferenceMain([...baseArgv, "--max", "5"], {
      arxiv: fixedFetch(atomFeed({ entries, totalResults: 10000 })),
      outputRoot,
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "cvpr-2026"))).toBe(false);
  });

  it("CNF-12: no --allow-truncated escape hatch exists (unknown flag rejected)", async () => {
    await expect(
      runCollectConferenceMain([...baseArgv, "--allow-truncated"], {
        arxiv: fixedFetch(atomFeed({ entries: [] })),
        outputRoot,
      }),
    ).rejects.toThrow();
  });

  it("writes when the window came back short of --max", async () => {
    const entries = Array.from({ length: 2 }, (_, i) => ({
      id: `http://arxiv.org/abs/2501.0000${i}`,
      comment: "Accepted to CVPR 2026",
    }));
    const code = await runCollectConferenceMain([...baseArgv, "--max", "800"], {
      arxiv: fixedFetch(atomFeed({ entries })),
      outputRoot,
    });
    expect(code).toBe(0);
    expect(existsSync(join(outputRoot, "cvpr-2026"))).toBe(true);
  });

  it("CNF-13: writes nothing on zero matched papers and does not overwrite an existing same-day CSV", async () => {
    mkdirSync(join(outputRoot, "cvpr-2026"), { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const existingPath = join(outputRoot, "cvpr-2026", `papers_${day}.csv`);
    writeFileSync(existingPath, "PRE-EXISTING\n");

    const entries = [{ id: "http://arxiv.org/abs/2501.00001", comment: "nothing relevant" }];
    const code = await runCollectConferenceMain(baseArgv, {
      arxiv: fixedFetch(atomFeed({ entries })),
      outputRoot,
    });
    expect(code).toBe(1);
    expect(readFileSync(existingPath, "utf-8")).toBe("PRE-EXISTING\n");
  });

  it("writes a CSV with source/source_id derived from the native URL", async () => {
    const entries = [{ id: "http://arxiv.org/abs/2501.00001", comment: "Accepted to CVPR 2026" }];
    const code = await runCollectConferenceMain(baseArgv, {
      arxiv: fixedFetch(atomFeed({ entries })),
      outputRoot,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(code).toBe(0);
    const csv = readFileSync(join(outputRoot, "cvpr-2026", "papers_2026-01-01.csv"), "utf-8");
    expect(csv).toContain("arxiv");
    expect(csv).toContain("2501.00001");
  });
});
