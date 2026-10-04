/**
 * TS port of `paperpilot/tests/test_build_search_index.py` (the portable
 * unit tests; the two tests that scrape the real committed `docs/` tree
 * and `docs/index.html` are covered by the parity run instead, not here).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORS,
  buildIndex,
  buildIndexV2,
  CONFERENCE,
  PAPER_ID_BLOCK_DIRNAME,
  PAPER_ID_BLOCK_SIZE,
  PAPER_REF,
  prunePaperIdBlocks,
  TAGS,
  TITLE,
  writeIndex,
  writeIndexV2,
  writePaperIdBlocks,
  YEAR,
} from "../../../src/release/derived/searchIndex.js";

let docs: string;

beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "paperpilot-search-index-"));
});
afterEach(() => {
  rmSync(docs, { recursive: true, force: true });
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

it("PAPER_ID_BLOCK_SIZE matches the Python constant", () => {
  expect(PAPER_ID_BLOCK_SIZE).toBe(256);
});
