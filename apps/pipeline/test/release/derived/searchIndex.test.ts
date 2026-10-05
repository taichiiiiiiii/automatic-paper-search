/**
 * TS port of `paperpilot/tests/test_build_search_index.py` (the portable
 * unit tests; the two tests that scrape the real committed `docs/` tree
 * and `docs/index.html` are covered by the parity run instead, not here).
 */
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORS,
  buildIndex,
  buildIndexV2,
  CONFERENCE,
  checkSearchIndexes,
  INDEX_FILENAME,
  INDEX_V2_FILENAME,
  PAPER_ID_BLOCK_DIRNAME,
  PAPER_ID_BLOCK_SIZE,
  PAPER_REF,
  prunePaperIdBlocks,
  TAGS,
  TITLE,
  writeIndex,
  writeIndexV2,
  writePaperIdBlocks,
  writeSearchIndexes,
  YEAR,
} from "../../../src/release/derived/searchIndex.js";

// Same seam as apps/pipeline/test/collect/state/atomic.test.ts: node:fs's
// native namespace isn't configurable, so vi.spyOn needs a vi.mock'd copy.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});

let docs: string;

beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "paperpilot-search-index-"));
});
afterEach(() => {
  rmSync(docs, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writePapers(conf: string, rows: unknown[]): void {
  const dir = join(docs, conf);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "papers.json"), JSON.stringify(rows), "utf-8");
}

describe("buildIndex", () => {
  it("emits title and conference", () => {
    writePapers("iclr-2026", [{ title: "Attention Is All You Need" }]);
    const { entries, skipped } = buildIndex(docs);
    expect(skipped).toBe(0);
    expect(entries).toEqual([["Attention Is All You Need", "iclr-2026"]]);
  });

  it("excludes non-conference dirs", () => {
    writePapers("daily", [{ title: "Daily" }]);
    writePapers("aaai-2026", [{ title: "Real" }]);
    const { entries } = buildIndex(docs);
    expect(entries.map((e) => e[CONFERENCE])).toEqual(["aaai-2026"]);
  });

  it("skips untitled rows", () => {
    writePapers("iclr-2026", [{ title: "Keeps" }, { title: "   " }, {}]);
    const { entries, skipped } = buildIndex(docs);
    expect(entries.map((e) => e[TITLE])).toEqual(["Keeps"]);
    expect(skipped).toBe(2);
  });

  it("trims surrounding whitespace", () => {
    writePapers("iclr-2026", [{ title: "  Padded Title\n" }]);
    const { entries } = buildIndex(docs);
    expect(entries[0]?.[TITLE]).toBe("Padded Title");
  });

  // Whitespace LOW: a title that is ONLY Python-only whitespace (U+001C,
  // U+0085 — not in JS's \s/.trim() set; see packages/core/src/pycompat/
  // whitespace.ts) must still be treated as blank, and a title padded with
  // it must still be trimmed, matching `(row.get("title") or "").strip()`.
  it("skips a row whose title is only Python-only whitespace", () => {
    writePapers("iclr-2026", [{ title: "Keeps" }, { title: "\x1c\x85" }]);
    const { entries, skipped } = buildIndex(docs);
    expect(entries.map((e) => e[TITLE])).toEqual(["Keeps"]);
    expect(skipped).toBe(1);
  });

  it("trims Python-only whitespace (U+0085), not just JS's \\s", () => {
    writePapers("iclr-2026", [{ title: "\x85Padded Title\x85" }]);
    const { entries } = buildIndex(docs);
    expect(entries[0]?.[TITLE]).toBe("Padded Title");
  });

  it("sorts conferences for reproducible output", () => {
    writePapers("neurips-2025", [{ title: "N" }]);
    writePapers("acl-2025", [{ title: "A" }]);
    const { entries } = buildIndex(docs);
    expect(entries.map((e) => e[CONFERENCE])).toEqual(["acl-2025", "neurips-2025"]);
  });

  it("preserves within-conference order", () => {
    writePapers("iclr-2026", [{ title: "first" }, { title: "second" }]);
    const { entries } = buildIndex(docs);
    expect(entries.map((e) => e[TITLE])).toEqual(["first", "second"]);
  });

  it("ignores dirs without papers.json", () => {
    mkdirSync(join(docs, "assets"), { recursive: true });
    writeFileSync(join(docs, "assets", "style.css"), "body{}", "utf-8");
    writePapers("aaai-2026", [{ title: "Real" }]);
    const { entries } = buildIndex(docs);
    expect(entries.length).toBe(1);
  });
});

describe("writeIndex", () => {
  it("emits compact json", () => {
    const out = writeIndex(docs, [["T", "iclr-2026"]]);
    const text = readFileSync(out, "utf-8");
    expect(text.includes(", ")).toBe(false);
    expect(JSON.parse(text)).toEqual([["T", "iclr-2026"]]);
  });

  it("preserves non-ascii titles", () => {
    const out = writeIndex(docs, [["日本語タイトル", "iclr-2026"]]);
    expect(JSON.parse(readFileSync(out, "utf-8"))[0][0]).toBe("日本語タイトル");
  });
});

describe("buildIndexV2", () => {
  it("emits a fixed typed row", () => {
    writePapers("iclr-2026", [
      {
        title: "Attention",
        authors: ["Alice", "Bob"],
        tags: ["LLM"],
        type: "Oral",
        arxiv_url: "https://openreview.net/forum?id=AbC_123",
      },
    ]);
    const { entries, paperIds } = buildIndexV2(docs);
    expect(entries).toEqual([
      ["Attention", "iclr-2026", 0, ["Alice", "Bob"], ["LLM"], 2026, "Oral"],
    ]);
    expect(paperIds).toEqual(["b871855522b0b31384df3e40fca6800540085f1f"]);
  });

  it("trims Python-only whitespace (U+0085) from the embedded title", () => {
    writePapers("iclr-2026", [
      {
        title: "\x85Attention\x85",
        authors: [],
        tags: [],
        type: "Oral",
        arxiv_url: "https://openreview.net/forum?id=AbC_123",
      },
    ]);
    const { entries } = buildIndexV2(docs);
    expect(entries[0]?.[0]).toBe("Attention");
  });

  it("rejects a title that is only Python-only whitespace", () => {
    writePapers("iclr-2026", [
      {
        title: "\x1c\x85",
        authors: [],
        tags: [],
        type: "Oral",
        arxiv_url: "https://openreview.net/forum?id=AbC_123",
      },
    ]);
    expect(() => buildIndexV2(docs)).toThrow(/title is required/);
  });

  // LOW: Python's row validation checks `isinstance(source_year, int)`,
  // so a JSON float like 2024.5 must be rejected — not silently accepted
  // just because JS has only one `number` type (no separate int/float).
  it("rejects a non-integer embedded year (e.g. 2024.5)", () => {
    writePapers("iclr-2026", [
      {
        title: "Non-integer year",
        authors: [],
        tags: [],
        type: "Poster",
        arxiv_url: "https://arxiv.org/abs/2404.00001",
        year: 2024.5,
      },
    ]);
    expect(() => buildIndexV2(docs)).toThrow(/year must be integer/);
  });

  it("rejects mismatched embedded identity", () => {
    writePapers("acl-2025", [
      {
        title: "Mismatch",
        authors: [],
        tags: [],
        type: "Poster",
        arxiv_url: "https://aclanthology.org/2025.acl-long.153/",
        paper_id: "0".repeat(40),
      },
    ]);
    expect(() => buildIndexV2(docs)).toThrow(/paper_id/);
  });

  // CAT-29: `type` must be exactly "Oral" or "Poster" — any other value
  // (including a legitimate summary.csv value like "Workshop" or a typo)
  // must reject the row rather than silently embedding it.
  it("rejects a row whose type is neither Oral nor Poster", () => {
    writePapers("iclr-2026", [
      {
        title: "Bad Type",
        authors: [],
        tags: [],
        type: "Workshop",
        arxiv_url: "https://arxiv.org/abs/2404.00001",
      },
    ]);
    expect(() => buildIndexV2(docs)).toThrow(/type must be Oral or Poster/);
  });

  // CAT-29: an embedded source/source_id pair that is well-formed (both
  // present, both strings) but does not match the identity derived from
  // the row's own `arxiv_url` must be rejected, not silently trusted.
  it("rejects an embedded source/source_id that does not match the native URL", () => {
    writePapers("iclr-2026", [
      {
        title: "Mismatched Source",
        authors: [],
        tags: [],
        type: "Poster",
        arxiv_url: "https://openreview.net/forum?id=abc123DEF",
        source: "openreview",
        source_id: "wrongID999",
      },
    ]);
    expect(() => buildIndexV2(docs)).toThrow(/embedded source identity mismatch/);
  });

  it("row shape fields are at the documented ordinals", () => {
    writePapers("x-2025", [
      {
        title: "T",
        authors: ["A"],
        tags: ["B"],
        type: "Poster",
        arxiv_url: "https://arxiv.org/abs/2501.00001",
      },
    ]);
    const { entries } = buildIndexV2(docs);
    const row = entries[0] as unknown[];
    expect(row[AUTHORS]).toEqual(["A"]);
    expect(row[TAGS]).toEqual(["B"]);
    expect(row[YEAR]).toBe(2025);
    expect(row[PAPER_REF]).toBe(0);
  });
});

describe("writeIndexV2", () => {
  it("is compact and deterministic", () => {
    const entries: Parameters<typeof writeIndexV2>[1] = [
      ["T", "c-2025", 0, [], [], 2025, "Poster"],
    ];
    const first = readFileSync(writeIndexV2(docs, entries), "utf-8");
    const second = readFileSync(writeIndexV2(docs, entries), "utf-8");
    expect(first).toBe(second);
    expect(first.includes(", ")).toBe(false);
    expect(JSON.parse(first)).toEqual(entries);
  });
});

describe("paper ID blocks", () => {
  it("writePaperIdBlocks uses a global ordinal", () => {
    const paperIds = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(40, "0"));
    const outputs = writePaperIdBlocks(docs, paperIds);
    expect(outputs.length).toBe(2);
    const first = JSON.parse(readFileSync(outputs[0] as string, "utf-8"));
    const second = JSON.parse(readFileSync(outputs[1] as string, "utf-8"));
    expect(first.start).toBe(0);
    expect(first.paper_ids.length).toBe(256);
    expect(second.start).toBe(256);
    expect(second.paper_ids[0]).toBe(paperIds[256]);
  });

  it("prunePaperIdBlocks drops only unpublished blocks", () => {
    const blockRoot = join(docs, PAPER_ID_BLOCK_DIRNAME);
    const published = writePaperIdBlocks(
      docs,
      Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(40, "0")),
    );
    expect(published.length).toBe(2);
    writeFileSync(join(blockRoot, "9999.json"), "{}", "utf-8");

    const removed = prunePaperIdBlocks(docs, writePaperIdBlocks(docs, ["a".repeat(40)]));

    expect(removed.map((p) => p.split("/").pop()).sort()).toEqual(["0001.json", "9999.json"]);
  });
});

// CAT-30 write order: ported from
// test_main_keeps_the_published_v2_index_when_a_block_write_fails. The v2
// index is written LAST (after all paper-ID blocks), so an interrupted
// block write must leave a previously-published search-index-v2.json
// byte-identical — never replaced by an index whose blocks never landed.
describe("writeSearchIndexes two-phase publish order (CAT-30)", () => {
  it("keeps the published v2 index byte-identical when a later block write fails", () => {
    writePapers(
      "iclr-2026",
      Array.from({ length: PAPER_ID_BLOCK_SIZE + 1 }, (_, ordinal) => ({
        title: `Paper ${ordinal}`,
        authors: ["A"],
        tags: [],
        type: "Poster",
        arxiv_url: `https://arxiv.org/abs/2404.${String(ordinal).padStart(5, "0")}`,
      })),
    );
    const indexV2Path = join(docs, INDEX_V2_FILENAME);
    const published = '[["previously published index"]]';
    writeFileSync(indexV2Path, published, "utf-8");

    const blockRoot = join(docs, PAPER_ID_BLOCK_DIRNAME);
    let blockWrites = 0;
    const realRenameSync = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(
      (src: Parameters<typeof realRenameSync>[0], dst: Parameters<typeof realRenameSync>[1]) => {
        if (dirname(String(dst)) === blockRoot) {
          blockWrites += 1;
          if (blockWrites > 1) {
            throw new Error("block write interrupted");
          }
        }
        return realRenameSync(src, dst);
      },
    );

    expect(() => writeSearchIndexes(docs)).toThrow("block write interrupted");
    expect(blockWrites).toBe(2); // the 2nd (of 2) block writes is the one that fails
    expect(readFileSync(join(blockRoot, "0000.json"), "utf-8")).toContain('"block":0');
    expect(fs.existsSync(join(blockRoot, "0001.json"))).toBe(false);
    expect(readFileSync(indexV2Path, "utf-8")).toBe(published);
  });
});

it("PAPER_ID_BLOCK_SIZE matches the Python constant", () => {
  expect(PAPER_ID_BLOCK_SIZE).toBe(256);
});

// H5 (p5 review): writeSearchIndexes/checkSearchIndexes must gate v1
// (`search-index.json`) on the layout mode -- p5's data move deletes
// `docs/search-index.json` and the promoter's p5 SHARED_PATHS never
// allowlists it, so writing/checking it under p5 mode would ENOENT the
// validate step and make the conference refresh hook produce an
// untracked file `promote.ts` rejects. Each test below passes `mode`
// EXPLICITLY (never flips the `LAYOUT_MODE` module constant), per the
// review's note that a test must exercise both modes through the
// parameter.
describe("search-index v1 is gated on layout mode (follow-up #5)", () => {
  function seedOnePaper(): void {
    writePapers("iclr-2026", [
      {
        title: "Mode Paper",
        authors: ["A"],
        tags: ["X"],
        type: "Poster",
        arxiv_url: "https://arxiv.org/abs/2404.00001",
      },
    ]);
  }

  it("writeSearchIndexes(docs, 'legacy') writes v1 (byte-identical to the default)", () => {
    seedOnePaper();
    const result = writeSearchIndexes(docs, "legacy");
    expect(result.outV1).toBe(join(docs, INDEX_FILENAME));
    expect(fs.existsSync(join(docs, INDEX_FILENAME))).toBe(true);
    expect(fs.existsSync(join(docs, INDEX_V2_FILENAME))).toBe(true);
  });

  it("writeSearchIndexes(docs, 'p5') never writes search-index.json, but still writes v2 + blocks", () => {
    seedOnePaper();
    const result = writeSearchIndexes(docs, "p5");
    expect(result.outV1).toBeUndefined();
    expect(fs.existsSync(join(docs, INDEX_FILENAME))).toBe(false);
    expect(fs.existsSync(join(docs, INDEX_V2_FILENAME))).toBe(true);
    expect(result.idBlocks.length).toBeGreaterThan(0);
  });

  it("checkSearchIndexes(docs, 'p5') passes with no search-index.json on disk at all", () => {
    seedOnePaper();
    writeSearchIndexes(docs, "p5");
    expect(fs.existsSync(join(docs, INDEX_FILENAME))).toBe(false);
    expect(() => checkSearchIndexes(docs, "p5")).not.toThrow();
  });

  it("checkSearchIndexes(docs, 'legacy') still rejects a stale v1 file", () => {
    seedOnePaper();
    writeSearchIndexes(docs, "legacy");
    writeFileSync(join(docs, INDEX_FILENAME), '[["tampered","x"]]', "utf-8");
    expect(() => checkSearchIndexes(docs, "legacy")).toThrow(/stale/);
  });

  it("checkSearchIndexes(docs, 'p5') ignores a stale/tampered v1 file left over on disk", () => {
    seedOnePaper();
    writeSearchIndexes(docs, "legacy"); // writes a v1 file
    writeFileSync(join(docs, INDEX_FILENAME), '[["tampered","x"]]', "utf-8");
    // Under p5 mode v1 is out of scope entirely -- a stale leftover must
    // not fail the check (v2 + blocks are still fresh from the write above).
    expect(() => checkSearchIndexes(docs, "p5")).not.toThrow();
  });
});

// CAT-31: `checkSearchIndexes` (the `--check` body of `build_search_index.py`'s
// `main()`) had no test and no CLI calling it at all — a regression there
// would go undetected by the whole suite. Ported from Python's
// `test_check_detects_stale_index` family.
describe("checkSearchIndexes (CAT-31)", () => {
  function seedValidIndexes(): void {
    writePapers("iclr-2026", [
      {
        title: "Check Paper",
        authors: ["A"],
        tags: ["X"],
        type: "Poster",
        arxiv_url: "https://arxiv.org/abs/2404.00001",
      },
    ]);
    writeSearchIndexes(docs);
  }

  it("passes against a freshly written, untampered index", () => {
    seedValidIndexes();
    expect(() => checkSearchIndexes(docs)).not.toThrow();
  });

  it("rejects a tampered search-index-v2.json without rewriting it", () => {
    seedValidIndexes();
    const v2Path = join(docs, INDEX_V2_FILENAME);
    writeFileSync(v2Path, '[["tampered"]]', "utf-8");
    const v1Before = readFileSync(join(docs, INDEX_FILENAME), "utf-8");

    expect(() => checkSearchIndexes(docs)).toThrow(/stale/);
    expect(readFileSync(v2Path, "utf-8")).toBe('[["tampered"]]');
    expect(readFileSync(join(docs, INDEX_FILENAME), "utf-8")).toBe(v1Before);
  });

  it("rejects an extra paper-ID block file, leaving the tree unchanged", () => {
    seedValidIndexes();
    const blockRoot = join(docs, PAPER_ID_BLOCK_DIRNAME);
    const extraPath = join(blockRoot, "9999.json");
    const extraPayload =
      '{"schema_version":"search-paper-ids-v1","block":9999,"start":0,"paper_ids":[]}\n';
    writeFileSync(extraPath, extraPayload, "utf-8");
    const v2Before = readFileSync(join(docs, INDEX_V2_FILENAME), "utf-8");

    expect(() => checkSearchIndexes(docs)).toThrow(/stale/);
    expect(fs.existsSync(extraPath)).toBe(true);
    expect(readFileSync(extraPath, "utf-8")).toBe(extraPayload);
    expect(readFileSync(join(docs, INDEX_V2_FILENAME), "utf-8")).toBe(v2Before);
  });

  it("rejects a deleted paper-ID block file, leaving other files unchanged", () => {
    seedValidIndexes();
    const blockRoot = join(docs, PAPER_ID_BLOCK_DIRNAME);
    const blockPath = join(blockRoot, "0000.json");
    const v2Before = readFileSync(join(docs, INDEX_V2_FILENAME), "utf-8");
    rmSync(blockPath);

    expect(() => checkSearchIndexes(docs)).toThrow(/stale/);
    expect(fs.existsSync(blockPath)).toBe(false);
    expect(readFileSync(join(docs, INDEX_V2_FILENAME), "utf-8")).toBe(v2Before);
  });
});
