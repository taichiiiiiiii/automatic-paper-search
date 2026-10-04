/**
 * Vitest port of `paperpilot/tests/test_generate_themes_manifest.py`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  generateManifest,
  UnreadableArtifactError,
  writeManifest,
} from "../../../src/lineage/theme/generateThemesManifest.js";

function writeThemeJson(
  themesDir: string,
  slug: string,
  opts: {
    theme?: string;
    nodes?: Record<string, unknown>[];
    edges?: Record<string, unknown>[];
    generatedAt?: string;
  } = {},
): string {
  const {
    theme,
    nodes = [
      {
        id: "p1",
        title: "Stub paper",
        year: 2020,
        venue: "NeurIPS",
        venue_tier: "A+",
        authors: ["A"],
        kinds: [],
        citation_count: 100,
        github_stars: 0,
        tldr: "",
        is_focus: true,
      },
    ],
    edges = [],
    generatedAt = "2026-04-25T00:00:00+00:00",
  } = opts;
  const payload = {
    root: nodes.length > 0 ? nodes[0]!.id : null,
    nodes,
    edges,
    meta: {
      source: "build_theme_lineage.py",
      theme: theme ?? titleCase(slug),
      slug,
      keywords: [],
      seeds: [],
      depth: 1,
      since_year: null,
      generated_at: generatedAt,
    },
  };
  const targetDir = join(themesDir, slug);
  mkdirSync(targetDir, { recursive: true });
  const path = join(targetDir, "lineage.json");
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

let themesDir: string;
beforeEach(() => {
  themesDir = mkdtempSync(join(tmpdir(), "themes-manifest-"));
});

describe("generateManifest", () => {
  it("returns [] for an empty dir", () => {
    expect(generateManifest(themesDir)).toEqual([]);
  });

  it("builds a single-theme entry", () => {
    writeThemeJson(themesDir, "mixture-of-experts", {
      theme: "Mixture of Experts",
      nodes: [
        {
          id: "p1",
          title: "Original MoE",
          year: 2017,
          venue: "NeurIPS",
          venue_tier: "A+",
          authors: ["A"],
          kinds: [],
          citation_count: 1000,
          github_stars: 0,
          tldr: "",
          is_focus: true,
        },
      ],
    });
    const entries = generateManifest(themesDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      slug: "mixture-of-experts",
      theme: "Mixture of Experts",
      paper_count: 1,
      year_range: [2017, 2017],
    });
    expect(entries[0]!.generated_at.startsWith("2026-04-25")).toBe(true);
  });

  it("sorts multiple themes by slug", () => {
    writeThemeJson(themesDir, "rag", { theme: "RAG" });
    writeThemeJson(themesDir, "diffusion", { theme: "Diffusion Models" });
    writeThemeJson(themesDir, "mixture-of-experts", { theme: "Mixture of Experts" });
    const entries = generateManifest(themesDir);
    expect(entries.map((e) => e.slug)).toEqual(["diffusion", "mixture-of-experts", "rag"]);
  });

  it("spans the year_range across all nodes", () => {
    writeThemeJson(themesDir, "moe", {
      nodes: [
        { id: "a", title: "A", year: 1991, is_focus: true },
        { id: "b", title: "B", year: 2017, is_focus: false },
        { id: "c", title: "C", year: 2024, is_focus: false },
      ],
    });
    const [entry] = generateManifest(themesDir);
    expect(entry!.year_range).toEqual([1991, 2024]);
    expect(entry!.paper_count).toBe(3);
  });

  it("excludes nodes with a missing year without crashing", () => {
    writeThemeJson(themesDir, "moe", {
      nodes: [
        { id: "a", title: "A", year: null, is_focus: true },
        { id: "b", title: "B", year: 2017, is_focus: false },
      ],
    });
    const [entry] = generateManifest(themesDir);
    expect(entry!.year_range).toEqual([2017, 2017]);
  });

  it("gives year_range=null when no node has a year", () => {
    writeThemeJson(themesDir, "moe", {
      nodes: [{ id: "a", title: "A", year: null, is_focus: true }],
    });
    const [entry] = generateManifest(themesDir);
    expect(entry!.year_range).toBeNull();
  });

  it("falls back to the directory name when meta.slug is a path-traversal probe", () => {
    const target = join(themesDir, "moe");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "lineage.json"),
      JSON.stringify({
        root: "p1",
        nodes: [{ id: "p1", title: "x", is_focus: true }],
        edges: [],
        meta: {
          source: "build_theme_lineage.py",
          theme: "Hostile",
          slug: "../../escape",
          keywords: [],
          seeds: [],
          depth: 1,
          since_year: null,
          generated_at: "2026-04-25T00:00:00+00:00",
        },
      }),
    );
    const entries = generateManifest(themesDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slug).toBe("moe");
  });

  it("skips a theme with a rel outside the allowed enum (cache-poisoning guard)", () => {
    writeThemeJson(themesDir, "moe", {
      edges: [{ src: "p1", dst: "p2", rel: "MALICIOUS_RELATION", conf: 1.0, rationale: "x" }],
    });
    writeThemeJson(themesDir, "rag", { theme: "RAG" });
    const entries = generateManifest(themesDir);
    expect(entries.map((e) => e.slug)).toEqual(["rag"]);
  });

  it("accepts every allowed rel value", () => {
    const allowed = [
      "supersedes",
      "successor",
      "extends",
      "ablation",
      "baseline_only",
      "contrasts",
    ];
    writeThemeJson(themesDir, "moe", {
      edges: allowed.map((r) => ({ src: "p1", dst: "p2", rel: r, conf: 0.5, rationale: "x" })),
    });
    expect(generateManifest(themesDir)).toHaveLength(1);
  });

  it("ignores files outside the <slug>/lineage.json layout", () => {
    writeThemeJson(themesDir, "moe");
    writeFileSync(join(themesDir, "themes-manifest.json"), "[]");
    writeFileSync(join(themesDir, "stray-file.json"), "{}");
    mkdirSync(join(themesDir, "subdir"));
    writeFileSync(join(themesDir, "subdir", "not-a-lineage.json"), "{}");
    expect(generateManifest(themesDir).map((e) => e.slug)).toEqual(["moe"]);
  });

  it("refuses to silently omit an unreadable artifact", () => {
    mkdirSync(join(themesDir, "bad"), { recursive: true });
    writeFileSync(join(themesDir, "bad", "lineage.json"), "not valid json");
    writeThemeJson(themesDir, "ok", { theme: "OK" });
    expect(() => generateManifest(themesDir)).toThrow(UnreadableArtifactError);
  });

  it("still quietly skips a genuine content rejection", () => {
    const badDir = join(themesDir, "bad-relation");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "lineage.json"),
      JSON.stringify({ nodes: [], edges: [{ rel: "not-an-allowed-relation" }], meta: {} }),
    );
    writeThemeJson(themesDir, "ok", { theme: "OK" });
    expect(generateManifest(themesDir).map((e) => e.slug)).toEqual(["ok"]);
  });

  it.each([
    ["edges-non-list", { edges: "broken" }],
    ["edges-element", { edges: ["not-a-dict"] }],
    ["nodes-non-list", { nodes: "broken" }],
    ["nodes-empty", { nodes: [{}] }],
    ["nodes-empty-id", { nodes: [{ id: "" }] }],
  ])("keeps a structurally-broken theme (%s) out of the manifest", (_label, patch) => {
    const goodDir = join(themesDir, "good");
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(
      join(goodDir, "lineage.json"),
      JSON.stringify({
        meta: { theme: "Good", generated_at: "2026-01-01T00:00:00Z" },
        nodes: [{ id: "n1", year: 2024 }],
        edges: [],
      }),
    );
    const badDir = join(themesDir, "bad");
    mkdirSync(badDir, { recursive: true });
    const payload = {
      meta: { theme: "Bad", generated_at: "2026-01-01T00:00:00Z" },
      nodes: [{ id: "n1" }],
      edges: [],
      ...patch,
    };
    writeFileSync(join(badDir, "lineage.json"), JSON.stringify(payload));
    expect(generateManifest(themesDir).map((e) => e.slug)).toEqual(["good"]);
  });

  it.each([
    ["no-nodes-key", "nodes"],
    ["no-edges-key", "edges"],
  ])("excludes a theme missing either array (%s)", (_label, dropKey) => {
    const badDir = join(themesDir, "bad");
    mkdirSync(badDir, { recursive: true });
    const payload: Record<string, unknown> = {
      meta: { theme: "Bad", generated_at: "2026-01-01T00:00:00Z" },
      nodes: [{ id: "n1" }],
      edges: [],
    };
    delete payload[dropKey];
    writeFileSync(join(badDir, "lineage.json"), JSON.stringify(payload));
    expect(generateManifest(themesDir)).toEqual([]);
  });

  it("lists a theme with both arrays genuinely empty", () => {
    const emptyDir = join(themesDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(
      join(emptyDir, "lineage.json"),
      JSON.stringify({
        meta: { theme: "Empty", generated_at: "2026-01-01T00:00:00Z" },
        nodes: [],
        edges: [],
      }),
    );
    const entries = generateManifest(themesDir);
    expect(entries.map((e) => [e.slug, e.paper_count])).toEqual([["empty", 0]]);
  });

  it.each([
    ["no-rel", {}],
    ["null-rel", { rel: null }],
    ["bad-rel", { rel: "fabricated" }],
  ])("keeps a theme out when an edge has no allowed rel (%s)", (_label, edge) => {
    const badDir = join(themesDir, "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "lineage.json"),
      JSON.stringify({
        meta: { theme: "Bad", generated_at: "2026-01-01T00:00:00Z" },
        nodes: [{ id: "n1" }],
        edges: [edge],
      }),
    );
    expect(generateManifest(themesDir)).toEqual([]);
  });
});

describe("writeManifest", () => {
  it("creates the manifest file", () => {
    writeThemeJson(themesDir, "moe", { theme: "MoE" });
    const out = writeManifest(themesDir);
    expect(out).toBe(join(themesDir, "themes-manifest.json"));
    const data = JSON.parse(readFileSync(out, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].slug).toBe("moe");
  });

  it("overwrites an existing manifest", () => {
    writeFileSync(join(themesDir, "themes-manifest.json"), '[{"stale": true}]');
    writeThemeJson(themesDir, "moe", { theme: "MoE" });
    writeManifest(themesDir);
    const data = JSON.parse(readFileSync(join(themesDir, "themes-manifest.json"), "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].slug).toBe("moe");
  });

  it("produces an empty array for an empty themes dir", () => {
    writeManifest(themesDir);
    const data = JSON.parse(readFileSync(join(themesDir, "themes-manifest.json"), "utf-8"));
    expect(data).toEqual([]);
  });

  it("leaves the previous manifest in place when a later run hits an unreadable artifact", () => {
    writeThemeJson(themesDir, "ok", { theme: "OK" });
    const previous = writeManifest(themesDir);
    const before = readFileSync(previous, "utf-8");

    mkdirSync(join(themesDir, "bad"), { recursive: true });
    writeFileSync(join(themesDir, "bad", "lineage.json"), "not valid json");

    expect(() => writeManifest(themesDir)).toThrow(UnreadableArtifactError);
    expect(readFileSync(previous, "utf-8")).toBe(before);
  });
});
