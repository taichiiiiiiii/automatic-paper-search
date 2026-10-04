/**
 * Port of the JSON-exporter cases of `paperpilot/tests/test_exporters.py`.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JSONExporter } from "../../../src/collect/exporters/json.js";
import { createPaper, type Paper } from "../../../src/collect/model/paper.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "json-exporter-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function samplePapers(): Paper[] {
  const today = "2026-04-10";
  return [
    createPaper({
      title: "T1",
      authors: ["A"],
      abstract: "abs",
      url: "http://x/1",
      publishedDate: today,
      source: "arxiv",
      arxivId: "2604.001",
      totalScore: 100.0,
    }),
    createPaper({
      title: "T2",
      authors: ["B", "C"],
      abstract: "abs2",
      url: "http://x/2",
      publishedDate: today,
      source: "s2",
      arxivId: "2604.002",
      totalScore: 50.0,
    }),
  ];
}

it("test_json_writes_list", async () => {
  const exp = new JSONExporter({ enabled: true, dir });
  const path = await exp.export(samplePapers());
  expect(path).not.toBeNull();
  const data = JSON.parse(readFileSync(path as string, "utf-8"));
  expect(data.length).toBe(2);
  expect(data[0].uid).toBe("arxiv:2604.001");
  expect(data[0].published_date).toBe("2026-04-10");
});

it("test_json_no_papers_returns_none", async () => {
  const exp = new JSONExporter({ enabled: true, dir });
  expect(await exp.export([])).toBeNull();
});

it("test_json_export_failure_leaves_the_existing_file_untouched", async () => {
  const exp = new JSONExporter({ enabled: true, dir });
  const path = (await exp.export(samplePapers())) as string;
  const originalBytes = readFileSync(path);

  const spy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
    throw new Error("serializing failed");
  });
  await expect(exp.export(samplePapers())).rejects.toThrow("serializing failed");
  spy.mockRestore();

  expect(readFileSync(path)).toEqual(originalBytes);
  expect(readdirSync(dir)).toEqual([path.split("/").pop()]);
});

it("test_json_export_survives_a_failed_rename", async () => {
  const fs = await import("node:fs");
  const exp = new JSONExporter({ enabled: true, dir });
  const path = (await exp.export(samplePapers())) as string;
  const originalBytes = readFileSync(path);

  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw new Error("rename failed");
  });
  await expect(exp.export(samplePapers())).rejects.toThrow("rename failed");

  expect(readFileSync(path)).toEqual(originalBytes);
  expect(readdirSync(dir)).toEqual([path.split("/").pop()]);
});

it("test_json_first_export_of_the_day_uses_the_plain_name", async () => {
  const now = new Date();
  const exp = new JSONExporter({ enabled: true, dir }, { now: () => now });
  const path = (await exp.export(samplePapers())) as string;
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  expect(path.split("/").pop()).toBe(`papers_${today}.json`);
});

it("test_json_second_same_day_export_with_disjoint_papers_keeps_both_files", async () => {
  const now = new Date();
  const exp = new JSONExporter({ enabled: true, dir }, { now: () => now });
  const titled = (title: string) => [
    createPaper({
      title,
      authors: ["A"],
      abstract: "abs",
      url: `http://x/${title}`,
      publishedDate: "2026-04-01",
      source: "arxiv",
      totalScore: 1,
    }),
  ];
  const first = (await exp.export(titled("H1"))) as string;
  const second = (await exp.export(titled("H2"))) as string;
  expect(first).not.toBe(second);
  expect(JSON.parse(readFileSync(first, "utf-8")).map((r: { title: string }) => r.title)).toEqual([
    "H1",
  ]);
  expect(JSON.parse(readFileSync(second, "utf-8")).map((r: { title: string }) => r.title)).toEqual([
    "H2",
  ]);
});

it("test_json_third_same_day_export_does_not_clobber_the_second", async () => {
  const fixedNow = new Date(2026, 0, 1, 12, 0, 0);
  const exp = new JSONExporter({ enabled: true, dir }, { now: () => fixedNow });
  const titled = (title: string) => [
    createPaper({
      title,
      authors: ["A"],
      abstract: "abs",
      url: `http://x/${title}`,
      publishedDate: "2026-04-01",
      source: "arxiv",
      totalScore: 1,
    }),
  ];
  const first = (await exp.export(titled("H1"))) as string;
  const second = (await exp.export(titled("H2"))) as string;
  const third = (await exp.export(titled("H3"))) as string;
  expect(new Set([first, second, third]).size).toBe(3);
  expect(first.split("/").pop()).toBe("papers_2026-01-01.json");
  expect(second.split("/").pop()).toBe("papers_2026-01-01-120000.json");
  expect(third.split("/").pop()).toBe("papers_2026-01-01-120000-2.json");
});
