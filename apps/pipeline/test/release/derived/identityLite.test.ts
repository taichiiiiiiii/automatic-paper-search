/**
 * TS port of `paperpilot/tests/test_identity_projector.py` — Identity Lite
 * catalog projection and conflict-gate tests (CAT-32..35).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  buildIdentityLite,
  loadConferenceNames,
  projectCatalogs,
} from "../../../src/release/derived/identityLite.js";

let docs: string;

beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "paperpilot-identity-lite-"));
});
afterEach(() => {
  rmSync(docs, { recursive: true, force: true });
});

function writeCatalog(slug: string, rows: unknown[]): void {
  const target = join(docs, slug);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "papers.json"), JSON.stringify(rows), "utf-8");
}

it("project_catalogs enriches without changing existing fields", () => {
  const original = {
    title: "A",
    authors: ["Alice"],
    tags: ["LLM"],
    type: "Poster",
    arxiv_url: "https://openreview.net/forum?id=AbC_123",
    abstract: "preview",
    arxiv_id: "2404.00001",
  };
  writeCatalog("iclr-2026", [original]);

  const result = projectCatalogs(docs, ["iclr-2026"], "2026-08-30T00:00:00Z");
  expect(result.coverage.valid).toBe(true);
  const enriched = result.catalogs["iclr-2026"]?.[0] as Record<string, unknown>;
  const subset: Record<string, unknown> = {};
  for (const key of Object.keys(original)) subset[key] = enriched[key];
  expect(subset).toEqual(original);
  expect(enriched.source).toBe("openreview");
  expect(enriched.source_id).toBe("AbC_123");
  expect((enriched.paper_id as string).length).toBe(40);
  expect(result.aliases).toContainEqual(["arxiv", "2404.00001", enriched.paper_id]);
  expect(result.aliases).toContainEqual(["openreview", "AbC_123", enriched.paper_id]);
  expect(result.coverage.resolved_rows).toBe(1);
});

it("project_catalogs reports alias conflict", () => {
  writeCatalog("iclr-2026", [
    { title: "A", arxiv_url: "https://openreview.net/forum?id=one", arxiv_id: "2404.00001" },
    { title: "B", arxiv_url: "https://openreview.net/forum?id=two", arxiv_id: "2404.00001" },
  ]);
  const result = projectCatalogs(docs, ["iclr-2026"], "2026-08-30T00:00:00Z");
  expect(result.coverage.valid).toBe(false);
  expect(result.coverage.alias_conflicts).toBe(1);
});

it("project_catalogs records parse failure without fallback", () => {
  writeCatalog("bad-2026", [{ title: "Looks usable", arxiv_url: "bad" }]);
  const result = projectCatalogs(docs, ["bad-2026"], "2026-08-30T00:00:00Z");
  expect(result.coverage.valid).toBe(false);
  expect(result.coverage.resolved_rows).toBe(0);
  expect(result.coverage.failures[0]?.title).toBe("Looks usable");
});

it("identity writer refuses partial publish on invalid projection", () => {
  writeCatalog("bad-2026", [{ title: "Bad", arxiv_url: "bad" }]);
  const aliasPath = join(docs, "identity-aliases-v1.json");
  writeFileSync(aliasPath, `[["arxiv","old","${"a".repeat(40)}"]]`);

  expect(() =>
    buildIdentityLite({
      docsRoot: docs,
      conferenceNames: ["bad-2026"],
      asOf: "2026-08-30T00:00:00Z",
      coveragePath: join(mkdtempSync(join(tmpdir(), "paperpilot-coverage-")), "coverage.json"),
    }),
  ).toThrow(/coverage/);
  expect(JSON.parse(readFileSync(aliasPath, "utf-8"))).toEqual([["arxiv", "old", "a".repeat(40)]]);
});

// ---- CAT-35: load_conference_names ----

it("loadConferenceNames rejects a non-array", () => {
  writeFileSync(join(docs, "conferences.json"), JSON.stringify({ not: "an array" }), "utf-8");
  expect(() => loadConferenceNames(docs)).toThrow(/array/);
});

it("loadConferenceNames rejects empty/missing names", () => {
  writeFileSync(join(docs, "conferences.json"), JSON.stringify([{ name: "" }]), "utf-8");
  expect(() => loadConferenceNames(docs)).toThrow(/non-empty name/);
});

it("loadConferenceNames rejects duplicate names", () => {
  writeFileSync(
    join(docs, "conferences.json"),
    JSON.stringify([{ name: "a" }, { name: "a" }]),
    "utf-8",
  );
  expect(() => loadConferenceNames(docs)).toThrow(/unique/);
});

it("loadConferenceNames returns names in document order", () => {
  writeFileSync(
    join(docs, "conferences.json"),
    JSON.stringify([{ name: "b" }, { name: "a" }]),
    "utf-8",
  );
  expect(loadConferenceNames(docs)).toEqual(["b", "a"]);
});

// ---- CAT-36: as_of validation ----

it("rejects an as_of without a timezone", () => {
  writeCatalog("iclr-2026", [{ title: "A", arxiv_url: "https://arxiv.org/abs/2601.00001" }]);
  expect(() => projectCatalogs(docs, ["iclr-2026"], "2026-08-30T00:00:00")).toThrow(/timezone/);
});

it("accepts a +00:00 offset as well as Z", () => {
  writeCatalog("iclr-2026", [{ title: "A", arxiv_url: "https://arxiv.org/abs/2601.00001" }]);
  const result = projectCatalogs(docs, ["iclr-2026"], "2026-08-30T00:00:00+00:00");
  expect(result.coverage.as_of).toBe("2026-08-30T00:00:00+00:00");
});

// ---- CAT-33: report-only ----

it("reportOnly writes the coverage report but skips the gate and public writes", () => {
  writeCatalog("bad-2026", [{ title: "Bad", arxiv_url: "bad" }]);
  const coverageDir = mkdtempSync(join(tmpdir(), "paperpilot-coverage-"));
  const coveragePath = join(coverageDir, "coverage.json");
  const aliasPath = join(docs, "identity-aliases-v1.json");

  const projection = buildIdentityLite({
    docsRoot: docs,
    conferenceNames: ["bad-2026"],
    asOf: "2026-08-30T00:00:00Z",
    coveragePath,
    reportOnly: true,
  });

  expect(projection.coverage.valid).toBe(false);
  expect(JSON.parse(readFileSync(coveragePath, "utf-8")).valid).toBe(false);
  expect(() => readFileSync(aliasPath, "utf-8")).toThrow();
});

// ---- CAT-34: --check ----

it("check throws when the coverage report is stale and writes nothing", () => {
  writeCatalog("iclr-2026", [{ title: "A", arxiv_url: "https://arxiv.org/abs/2601.00001" }]);
  const coverageDir = mkdtempSync(join(tmpdir(), "paperpilot-coverage-"));
  const coveragePath = join(coverageDir, "coverage.json");
  writeFileSync(coveragePath, "{}", "utf-8");

  expect(() =>
    buildIdentityLite({
      docsRoot: docs,
      conferenceNames: ["iclr-2026"],
      asOf: "2026-08-30T00:00:00Z",
      coveragePath,
      check: true,
    }),
  ).toThrow(/stale/);
});

it("check passes once the projection has been written, and still writes nothing new", () => {
  writeCatalog("iclr-2026", [{ title: "A", arxiv_url: "https://arxiv.org/abs/2601.00001" }]);
  const coverageDir = mkdtempSync(join(tmpdir(), "paperpilot-coverage-"));
  const coveragePath = join(coverageDir, "coverage.json");

  buildIdentityLite({
    docsRoot: docs,
    conferenceNames: ["iclr-2026"],
    asOf: "2026-08-30T00:00:00Z",
    coveragePath,
  });

  expect(() =>
    buildIdentityLite({
      docsRoot: docs,
      conferenceNames: ["iclr-2026"],
      asOf: "2026-08-30T00:00:00Z",
      coveragePath,
      check: true,
    }),
  ).not.toThrow();
});
