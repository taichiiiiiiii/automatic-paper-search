/**
 * Validates `buildIndexV2`'s output against the committed
 * `schemas/search-index-v2.schema.json` via `@paperpilot/core/schemas`
 * (design doc §3; the task names this schema explicitly for
 * `search-index-v2.json`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArtifact } from "@paperpilot/core/schemas";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildIndexV2 } from "../../../src/release/derived/searchIndex.js";

let docs: string;
beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "paperpilot-search-index-schema-"));
});
afterEach(() => {
  rmSync(docs, { recursive: true, force: true });
});

it("buildIndexV2 output satisfies the search-index-v2 schema", () => {
  const dir = join(docs, "iclr-2026");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "papers.json"),
    JSON.stringify([
      {
        title: "Attention",
        authors: ["Alice", "Bob"],
        tags: ["LLM"],
        type: "Oral",
        arxiv_url: "https://openreview.net/forum?id=AbC_123",
      },
      {
        title: "No year field",
        authors: [],
        tags: [],
        type: "Poster",
        arxiv_url: "https://arxiv.org/abs/2601.00002",
        year: null,
      },
    ]),
    "utf-8",
  );

  const { entries } = buildIndexV2(docs);
  const result = validateArtifact("search-index-v2", entries);
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
});

it("rejects a malformed row shape (sanity-checks the schema is actually wired)", () => {
  const result = validateArtifact("search-index-v2", [["only one field"]]);
  expect(result.ok).toBe(false);
});
