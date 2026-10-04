/**
 * Port of the `load_curated_map` cases of
 * `paperpilot/tests/test_utils_github.py`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadCuratedMap } from "../../../src/collect/signals/githubMap.js";

function withFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "curated-map-test-"));
  const p = join(dir, "paper_repos.json");
  writeFileSync(p, content);
  return p;
}

it("test_load_curated_map_filters_meta_key", () => {
  const p = withFile(
    JSON.stringify({ _meta: { purpose: "doc" }, "1706.03762": "tensorflow/tensor2tensor" }),
  );
  expect(loadCuratedMap(p)).toEqual({ "1706.03762": "tensorflow/tensor2tensor" });
});

it("test_load_curated_map_drops_invalid_slug", () => {
  const p = withFile(
    JSON.stringify({
      "1706.03762": "tensorflow/tensor2tensor",
      "0000.00001": "owner/repo with spaces",
      "0000.00002": "owner/$injection",
      "0000.00003": "owner/../../etc",
    }),
  );
  expect(loadCuratedMap(p)).toEqual({ "1706.03762": "tensorflow/tensor2tensor" });
});

it("test_load_curated_map_rejects_leading_dot_in_segment", () => {
  const p = withFile(
    JSON.stringify({
      good: "owner/repo",
      bad1: ".owner/repo",
      bad2: "owner/.repo",
      bad3: "owner/..",
    }),
  );
  expect(loadCuratedMap(p)).toEqual({ good: "owner/repo" });
});

it("test_load_curated_map_handles_corrupt_json", () => {
  const p = withFile("{ not valid json");
  expect(loadCuratedMap(p)).toEqual({});
});

it("warns (does not silently ignore) a corrupt paper_repos.json (collect LOW)", () => {
  // Python's `load_curated_map` logs a WARNING on an unreadable file
  // ("paper_repos.json unreadable (...); skipping curated layer") before
  // this port existed; the old TS version swallowed the same
  // JSON.parse failure with no logger call at all.
  const p = withFile("{ not valid json");
  const warnings: string[] = [];
  expect(loadCuratedMap(p, { warn: (m) => warnings.push(m) })).toEqual({});
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("paper_repos.json unreadable");
  expect(warnings[0]).toContain("skipping curated layer");
});

it("does not warn for a plain missing file (no regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "curated-map-test-"));
  const warnings: string[] = [];
  expect(loadCuratedMap(join(dir, "missing.json"), { warn: (m) => warnings.push(m) })).toEqual({});
  expect(warnings).toEqual([]);
});

it("test_load_curated_map_handles_missing_file", () => {
  const dir = mkdtempSync(join(tmpdir(), "curated-map-test-"));
  expect(loadCuratedMap(join(dir, "missing.json"))).toEqual({});
});

it("test_load_curated_map_default_path_resolves", () => {
  const out = loadCuratedMap();
  expect(typeof out).toBe("object");
  expect(out["1706.03762"]).toBeDefined();
  expect(out["1706.03762"]).toContain("/");
});
