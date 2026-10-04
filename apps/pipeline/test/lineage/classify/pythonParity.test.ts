/**
 * Byte-for-byte output parity against real CPython, non-dry-run.
 *
 * Each `fixtures/<case>/expected/*.json` file is the ACTUAL byte output of
 * the real Python script (`compact_classifications.py`,
 * `purge_template_classifications.py`, `build_lineage.persist_classifications`)
 * run on the sibling `fixtures/<case>/input/*` via
 * `uv run --extra dev python`, captured once in the session scratchpad and
 * committed here per the P4d brief ("commit the generated expected fixtures
 * under your test/ dir — not regenerated in CI"). These tests replay the
 * SAME inputs through the TS port and assert the written file is
 * byte-identical (not just structurally equal) to Python's output —
 * catching key-order, indentation, and `sort_keys` differences a deep-equal
 * check would miss.
 */
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { persistClassifications } from "../../../src/lineage/classify/cache.js";
import { compact } from "../../../src/lineage/classify/compact.js";
import { purgeTemplateClassificationsMain } from "../../../src/lineage/classify/purge.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "py-parity-"));
}

describe("compact — byte-for-byte parity vs CPython", () => {
  it("matches the real compact_classifications.py output for the same cache + docs tree", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    cpSync(join(fixturesDir, "compact", "input", "classifications.json"), cachePath);
    const docsDir = join(dir, "docs");
    cpSync(join(fixturesDir, "compact", "input", "docs"), docsDir, { recursive: true });

    const rc = await compact({ cachePath, docsDir });
    expect(rc).toBe(0);

    const actual = readFileSync(cachePath, "utf-8");
    const expected = readFileSync(
      join(fixturesDir, "compact", "expected", "classifications.json"),
      "utf-8",
    );
    expect(actual).toBe(expected);
  });
});

describe("purge — byte-for-byte parity vs CPython", () => {
  it("matches the real purge_template_classifications.py output for the same cache", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    cpSync(join(fixturesDir, "purge", "input", "classifications.json"), cachePath);

    const rc = await purgeTemplateClassificationsMain({ cachePath });
    expect(rc).toBe(0);

    const actual = readFileSync(cachePath, "utf-8");
    const expected = readFileSync(
      join(fixturesDir, "purge", "expected", "classifications.json"),
      "utf-8",
    );
    expect(actual).toBe(expected);
  });
});

describe("persistClassifications — byte-for-byte parity vs CPython's build_lineage.persist_classifications", () => {
  it("matches Python's setdefault-from-disk merge for the same two-writer scenario", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    cpSync(join(fixturesDir, "persist", "input", "disk.json"), cachePath);

    const classifications: Record<string, unknown> = {
      "new->one": {
        relation: "successor",
        confidence: 0.75,
        rationale: "freshly computed in-memory entry",
      },
    };
    await persistClassifications(classifications, cachePath);

    const actual = readFileSync(cachePath, "utf-8");
    const expected = readFileSync(
      join(fixturesDir, "persist", "expected", "classifications.json"),
      "utf-8",
    );
    expect(actual).toBe(expected);
  });
});
