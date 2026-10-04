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
