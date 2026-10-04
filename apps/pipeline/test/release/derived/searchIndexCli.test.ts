/**
 * CLI-level tests for `runSearchIndexCli`/`runSearchIndexCliArgs` — mirrors
 * `paperpilot/scripts/build_search_index.py`'s `main()` (CAT-31). No prior
 * test or CLI exercised `checkSearchIndexes` at all before this file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INDEX_V2_FILENAME,
  PAPER_ID_BLOCK_DIRNAME,
} from "../../../src/release/derived/searchIndex.js";
import {
  parseSearchIndexCliArgs,
  runSearchIndexCli,
  runSearchIndexCliArgs,
} from "../../../src/release/derived/searchIndexCli.js";

let docs: string;
beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "paperpilot-search-index-cli-"));
  const conf = join(docs, "iclr-2026");
  mkdirSync(conf, { recursive: true });
  writeFileSync(
    join(conf, "papers.json"),
    JSON.stringify([
      {
        title: "CLI Paper",
        authors: ["A"],
        tags: ["X"],
        type: "Poster",
        arxiv_url: "https://arxiv.org/abs/2404.00001",
      },
    ]),
  );
});
afterEach(() => {
  rmSync(docs, { recursive: true, force: true });
});

describe("runSearchIndexCliArgs (CAT-31)", () => {
  it("a normal run (no --check) writes v1/v2/blocks and exits 0", () => {
    const result = runSearchIndexCliArgs({ docsRoot: docs, check: false });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(docs, INDEX_V2_FILENAME), "utf-8")).toContain("CLI Paper");
  });

  it("--check on an UP-TO-DATE index exits 0 without rewriting it", () => {
    runSearchIndexCliArgs({ docsRoot: docs, check: false }); // first write
    const v2Path = join(docs, INDEX_V2_FILENAME);
    const before = readFileSync(v2Path, "utf-8");

    const result = runSearchIndexCliArgs({ docsRoot: docs, check: true });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(v2Path, "utf-8")).toBe(before);
  });

  // CAT-31: `--check` against a STALE committed index (one that no longer
  // matches what a fresh build would produce) must exit non-zero WITHOUT
  // rewriting it. Nothing wired this into a CLI before this file.
  it("--check on a STALE v2 index exits non-zero and leaves the file byte-unchanged", () => {
    runSearchIndexCliArgs({ docsRoot: docs, check: false }); // first write
    const v2Path = join(docs, INDEX_V2_FILENAME);
    writeFileSync(v2Path, '[["tampered"]]', "utf-8");

    const result = runSearchIndexCliArgs({ docsRoot: docs, check: true });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/stale/);
    expect(readFileSync(v2Path, "utf-8")).toBe('[["tampered"]]');
  });

  it("--check on a stale paper-ID block set exits non-zero and leaves blocks unchanged", () => {
    runSearchIndexCliArgs({ docsRoot: docs, check: false }); // first write
    const blockRoot = join(docs, PAPER_ID_BLOCK_DIRNAME);
    const extraBlock = join(blockRoot, "9999.json");
    writeFileSync(
      extraBlock,
      '{"schema_version":"search-paper-ids-v1","block":9999,"start":0,"paper_ids":[]}\n',
      "utf-8",
    );

    const result = runSearchIndexCliArgs({ docsRoot: docs, check: true });
    expect(result.exitCode).toBe(1);
    expect(readFileSync(extraBlock, "utf-8")).toContain('"block":9999');
  });
});

describe("runSearchIndexCli argument strictness", () => {
  it("parses --docs-root and --check", () => {
    const args = parseSearchIndexCliArgs(["--docs-root", docs, "--check"]);
    expect(args.docsRoot).toBe(docs);
    expect(args.check).toBe(true);
  });

  it("defaults --check to false", () => {
    expect(parseSearchIndexCliArgs(["--docs-root", docs]).check).toBe(false);
  });

  it("exits 2 on an unrecognized/typo'd flag before touching the filesystem", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const rc = runSearchIndexCli(["--docs-roott", docs]);
      expect(rc).toBe(2);
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("runSearchIndexCli returns 1 for a stale --check without writing", () => {
    runSearchIndexCliArgs({ docsRoot: docs, check: false }); // first write
    const v2Path = join(docs, INDEX_V2_FILENAME);
    writeFileSync(v2Path, '[["tampered"]]', "utf-8");

    const rc = runSearchIndexCli(["--docs-root", docs, "--check"]);
    expect(rc).toBe(1);
    expect(readFileSync(v2Path, "utf-8")).toBe('[["tampered"]]');
  });
});
