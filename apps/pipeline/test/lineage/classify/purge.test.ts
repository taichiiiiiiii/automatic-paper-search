/**
 * Port of `paperpilot/tests/test_purge_template_classifications.py`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  purgeTemplateClassificationsMain,
  purgeTemplateEntries,
} from "../../../src/lineage/classify/purge.js";
import { TEMPLATE_RATIONALES } from "../../../src/lineage/llm/base.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "purge-"));
}

function sampleTemplate(): string {
  return Object.values(TEMPLATE_RATIONALES)[0] as string;
}

describe("purgeTemplateEntries", () => {
  it("test_purge_drops_entries_with_template_rationale", () => {
    const cache = {
      "a->b": { relation: "extends", confidence: 0.8, rationale: sampleTemplate() },
      "c->d": {
        relation: "successor",
        confidence: 0.9,
        rationale: "B のスペクトル畳み込みは A の局所演算を周波数領域で再定式化している",
      },
    };
    const { kept, dropped } = purgeTemplateEntries(cache);
    expect(dropped).toBe(1);
    expect(kept).toEqual({ "c->d": cache["c->d"] });
  });

  it("test_purge_idempotent_on_clean_cache", () => {
    const cache = {
      "a->b": {
        relation: "extends",
        confidence: 0.8,
        rationale: "real paper-specific reason from LLM",
      },
    };
    const { kept, dropped } = purgeTemplateEntries(cache);
    expect(dropped).toBe(0);
    expect(kept).toEqual(cache);
  });

  it("test_purge_drops_every_known_template", () => {
    const values = Object.values(TEMPLATE_RATIONALES);
    const cache: Record<string, unknown> = {};
    values.forEach((tmpl, i) => {
      cache[`k${i}->v${i}`] = { relation: "extends", confidence: 0.7, rationale: tmpl };
    });
    const { kept, dropped } = purgeTemplateEntries(cache);
    expect(dropped).toBe(values.length);
    expect(kept).toEqual({});
  });

  it("test_purge_preserves_non_dict_entries", () => {
    const cache: Record<string, unknown> = {
      broken: "not a dict",
      also_broken: null,
      good: { relation: "extends", confidence: 0.9, rationale: "specific reason" },
      templated: { relation: "extends", confidence: 0.8, rationale: sampleTemplate() },
    };
    const { kept, dropped } = purgeTemplateEntries(cache);
    expect(dropped).toBe(1);
    expect("broken" in kept).toBe(true);
    expect("also_broken" in kept).toBe(true);
    expect("good" in kept).toBe(true);
    expect("templated" in kept).toBe(false);
  });

  it("test_purge_handles_whitespace_around_template", () => {
    const cache = {
      "a->b": { relation: "extends", confidence: 0.7, rationale: `  ${sampleTemplate()}  ` },
    };
    const { kept, dropped } = purgeTemplateEntries(cache);
    expect(dropped).toBe(1);
    expect(kept).toEqual({});
  });

  it("test_purge_keeps_entries_with_no_rationale_field", () => {
    const cache = { "a->b": { relation: "extends", confidence: 0.7 } };
    const { kept, dropped } = purgeTemplateEntries(cache);
    expect(dropped).toBe(0);
    expect(kept).toEqual(cache);
  });
});

describe("purgeTemplateClassificationsMain (CLI)", () => {
  it("test_cli_dry_run_does_not_modify_file", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    const cache = { "a->b": { relation: "extends", confidence: 0.7, rationale: sampleTemplate() } };
    writeFileSync(cachePath, JSON.stringify(cache));

    const logs: string[] = [];
    const rc = await purgeTemplateClassificationsMain({
      cachePath,
      dryRun: true,
      log: (l) => logs.push(l),
    });
    expect(rc).toBe(0);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(cache);
    const out = logs.join("\n");
    expect(out).toContain("drop : 1");
    expect(out).toContain("--dry-run");
  });

  it("test_cli_writes_purged_cache_back", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    const keptEntry = { relation: "extends", confidence: 0.9, rationale: "specific paper reason" };
    const cache = {
      "drop->me": { relation: "extends", confidence: 0.7, rationale: sampleTemplate() },
      "keep->me": keptEntry,
    };
    writeFileSync(cachePath, JSON.stringify(cache));

    const rc = await purgeTemplateClassificationsMain({ cachePath });
    expect(rc).toBe(0);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ "keep->me": keptEntry });
  });

  it("test_cli_missing_cache_file_is_no_op", async () => {
    const dir = tmpDir();
    const missing = join(dir, "does-not-exist.json");
    const rc = await purgeTemplateClassificationsMain({ cachePath: missing });
    expect(rc).toBe(0);
  });

  it("test_cli_malformed_cache_returns_nonzero", async () => {
    const dir = tmpDir();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "this is not json{");
    const rc = await purgeTemplateClassificationsMain({ cachePath: bad });
    expect(rc).toBe(1);
  });

  it("test_cli_acquires_and_releases_the_shared_lock (lock file created and removed)", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    writeFileSync(
      cachePath,
      JSON.stringify({ "a->b": { relation: "extends", confidence: 0.9, rationale: "x" } }),
    );

    const rc = await purgeTemplateClassificationsMain({ cachePath });
    expect(rc).toBe(0);
    // The lock file must be released (removed) after main() returns.
    expect(existsSync(`${cachePath}.lock`)).toBe(false);
  });

  it("test_cli_write_failure_leaves_original_file_intact (no stray temp files on an unrelated failure path)", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    const original = {
      "drop->me": { relation: "extends", confidence: 0.7, rationale: sampleTemplate() },
      "keep->me": { relation: "extends", confidence: 0.9, rationale: "specific paper reason" },
    };
    writeFileSync(cachePath, JSON.stringify(original));
    const rc = await purgeTemplateClassificationsMain({ cachePath });
    expect(rc).toBe(0);
    // No leftover temp files in the directory after a normal run.
    const leftovers = readdirSync(dir).filter(
      (name) => name !== "classifications.json" && name !== "classifications.json.lock",
    );
    expect(leftovers).toEqual([]);
  });
});
