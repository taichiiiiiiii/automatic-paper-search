/**
 * p5-plan.md §2 A0: `layoutFor`/`relLayout` in both modes, the named file
 * helpers, and the invariant that flipping `LAYOUT_MODE` is the only change
 * a caller needs to retarget every root at once (the "single switch" the
 * whole changeset exists to create).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditFixtures,
  classificationsCache,
  collectConfig,
  conferenceCopyDir,
  conferenceSources,
  denylist,
  foundationalAllowlist,
  identityCoverage,
  LAYOUT_MODE,
  type Layout,
  layoutFor,
  lineageCacheDir,
  paperRepos,
  qualityPolicy,
  relLayout,
  runHistory,
  seenIds,
  themeAliases,
  themeBlacklist,
} from "../../src/layout/index.js";

const REPO_ROOT = "/repo";

describe("LAYOUT_MODE", () => {
  // Pins the single switch's state in BOTH modes instead of skipping in
  // one of them (P5 tier-A review round 2, N1): pre-cutover it must be
  // exactly "legacy" (p5-plan.md §5.1: "Commit B changes exactly one
  // literal"); once commit B flips it (including during this task's own
  // p5-rehearsal, which applies that same flip to a scratch clone) it
  // must be exactly "p5". Branches on the mode-appropriate literal rather
  // than skipping either branch, and additionally pins the matching
  // `relLayout` root so a typo'd mode string (e.g. "P5"/"data") cannot
  // slip through either branch unnoticed.
  it("is exactly the mode-appropriate literal (legacy pre-B, p5 after)", () => {
    if (LAYOUT_MODE === "legacy") {
      expect(LAYOUT_MODE).toBe("legacy");
      expect(relLayout(LAYOUT_MODE).published).toBe("docs");
    } else {
      expect(LAYOUT_MODE).toBe("p5");
      expect(relLayout(LAYOUT_MODE).published).toBe("data/published");
    }
  });
});

describe("relLayout", () => {
  it("legacy roots match today's hard-coded paths", () => {
    expect(relLayout("legacy")).toEqual({
      published: "docs",
      state: "paperpilot/data",
      inputs: "paperpilot/output",
      config: "paperpilot/data",
      legacySite: "docs",
      workflowsDir: ".github/workflows-p5",
      headAssets: "docs/assets",
    });
  });

  it("p5 roots match the plan's data/ layout", () => {
    expect(relLayout("p5")).toEqual({
      published: "data/published",
      state: "data/state",
      inputs: "data/inputs",
      config: "data/config",
      legacySite: "legacy/gh-pages-site",
      workflowsDir: ".github/workflows",
      headAssets: "apps/web/static/assets",
    });
  });

  it("defaults to LAYOUT_MODE when no mode is given", () => {
    expect(relLayout()).toEqual(relLayout(LAYOUT_MODE));
  });
});

describe("layoutFor", () => {
  it("joins the legacy roots onto repoRoot with the platform separator", () => {
    expect(layoutFor(REPO_ROOT, "legacy")).toEqual({
      published: join(REPO_ROOT, "docs"),
      state: join(REPO_ROOT, "paperpilot", "data"),
      inputs: join(REPO_ROOT, "paperpilot", "output"),
      config: join(REPO_ROOT, "paperpilot", "data"),
      legacySite: join(REPO_ROOT, "docs"),
      workflowsDir: join(REPO_ROOT, ".github", "workflows-p5"),
      headAssets: join(REPO_ROOT, "docs", "assets"),
    });
  });

  it("joins the p5 roots onto repoRoot", () => {
    expect(layoutFor(REPO_ROOT, "p5")).toEqual({
      published: join(REPO_ROOT, "data", "published"),
      state: join(REPO_ROOT, "data", "state"),
      inputs: join(REPO_ROOT, "data", "inputs"),
      config: join(REPO_ROOT, "data", "config"),
      legacySite: join(REPO_ROOT, "legacy", "gh-pages-site"),
      workflowsDir: join(REPO_ROOT, ".github", "workflows"),
      headAssets: join(REPO_ROOT, "apps", "web", "static", "assets"),
    });
  });

  it("defaults to LAYOUT_MODE when no mode is given", () => {
    expect(layoutFor(REPO_ROOT)).toEqual(layoutFor(REPO_ROOT, LAYOUT_MODE));
  });

  it("legacy published and legacySite are the same directory (today's live docs/ site)", () => {
    const layout = layoutFor(REPO_ROOT, "legacy");
    expect(layout.published).toBe(layout.legacySite);
  });

  it("legacy state and config are the same directory (both paperpilot/data today)", () => {
    const layout = layoutFor(REPO_ROOT, "legacy");
    expect(layout.state).toBe(layout.config);
  });

  it("p5 separates every root into its own directory", () => {
    const layout = layoutFor(REPO_ROOT, "p5");
    const roots = [layout.published, layout.state, layout.inputs, layout.config, layout.legacySite];
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe("flipping LAYOUT_MODE is the only change a caller needs", () => {
  /**
   * A stand-in for a real call site: resolves every named helper plus
   * `collectConfig` purely from `layoutFor(repoRoot, mode)`/`mode` — no
   * other mode-conditional logic. If this function's *body* never has to
   * change to produce the plan's p5 paths (only the `mode` value passed
   * into it), the single-switch property holds.
   */
  function resolveEverything(repoRoot: string, mode: "legacy" | "p5") {
    const layout = layoutFor(repoRoot, mode);
    return {
      layout,
      seenIdsWeekly: seenIds(layout),
      seenIdsDaily: seenIds(layout, "daily"),
      runHistoryWeekly: runHistory(layout),
      runHistoryDaily: runHistory(layout, "daily"),
      lineageCacheDir: lineageCacheDir(layout),
      classificationsCache: classificationsCache(layout),
      denylist: denylist(layout),
      foundationalAllowlist: foundationalAllowlist(layout),
      themeAliases: themeAliases(layout),
      themeBlacklist: themeBlacklist(layout),
      paperRepos: paperRepos(layout),
      qualityPolicy: qualityPolicy(layout),
      auditFixtures: auditFixtures(layout),
      conferenceSources: conferenceSources(layout),
      identityCoverage: identityCoverage(layout),
      conferenceCopyDir: conferenceCopyDir(layout),
      collectConfigWeekly: collectConfig(repoRoot, "weekly", mode),
      collectConfigDailyWatch: collectConfig(repoRoot, "daily-watch", mode),
    };
  }

  it("legacy run matches today's hard-coded paths byte-for-byte", () => {
    const r = resolveEverything(REPO_ROOT, "legacy");
    expect(r.seenIdsWeekly).toBe(join(REPO_ROOT, "paperpilot", "data", "seen_ids.json"));
    expect(r.seenIdsDaily).toBe(join(REPO_ROOT, "paperpilot", "data", "seen_ids.daily.json"));
    expect(r.runHistoryWeekly).toBe(join(REPO_ROOT, "paperpilot", "data", "run_history.jsonl"));
    expect(r.runHistoryDaily).toBe(
      join(REPO_ROOT, "paperpilot", "data", "run_history.daily.jsonl"),
    );
    expect(r.lineageCacheDir).toBe(join(REPO_ROOT, "paperpilot", "data", "lineage-cache"));
    expect(r.classificationsCache).toBe(
      join(REPO_ROOT, "paperpilot", "data", "lineage-cache", "classifications.json"),
    );
    expect(r.denylist).toBe(join(REPO_ROOT, "paperpilot", "data", "lineage_denylist.json"));
    expect(r.foundationalAllowlist).toBe(
      join(REPO_ROOT, "paperpilot", "data", "lineage_foundational_allowlist.json"),
    );
    expect(r.themeAliases).toBe(join(REPO_ROOT, "paperpilot", "data", "theme_aliases.json"));
    expect(r.themeBlacklist).toBe(join(REPO_ROOT, "paperpilot", "data", "theme_blacklist.json"));
    expect(r.paperRepos).toBe(join(REPO_ROOT, "paperpilot", "data", "paper_repos.json"));
    expect(r.qualityPolicy).toBe(
      join(REPO_ROOT, "paperpilot", "data", "lineage-quality-policy-v1.json"),
    );
    expect(r.auditFixtures).toBe(
      join(REPO_ROOT, "paperpilot", "data", "lineage-audit-fixtures-v1.json"),
    );
    expect(r.conferenceSources).toBe(
      join(REPO_ROOT, "paperpilot", "data", "conference-sources-v1.yaml"),
    );
    expect(r.identityCoverage).toBe(
      join(REPO_ROOT, "paperpilot", "data", "identity-coverage-v1.json"),
    );
    expect(r.conferenceCopyDir).toBe(join(REPO_ROOT, "paperpilot", "data", "conference-copy"));
    expect(r.collectConfigWeekly).toBe(join(REPO_ROOT, "paperpilot", "config.yaml"));
    expect(r.collectConfigDailyWatch).toBe(
      join(REPO_ROOT, "paperpilot", "config.daily-watch.yaml"),
    );
  });

  it("p5 run matches the plan's data/ paths", () => {
    const r = resolveEverything(REPO_ROOT, "p5");
    expect(r.seenIdsWeekly).toBe(join(REPO_ROOT, "data", "state", "seen_ids.json"));
    expect(r.seenIdsDaily).toBe(join(REPO_ROOT, "data", "state", "seen_ids.daily.json"));
    expect(r.runHistoryWeekly).toBe(join(REPO_ROOT, "data", "state", "run_history.jsonl"));
    expect(r.runHistoryDaily).toBe(join(REPO_ROOT, "data", "state", "run_history.daily.jsonl"));
    expect(r.lineageCacheDir).toBe(join(REPO_ROOT, "data", "state", "lineage-cache"));
    expect(r.classificationsCache).toBe(
      join(REPO_ROOT, "data", "state", "lineage-cache", "classifications.json"),
    );
    expect(r.denylist).toBe(join(REPO_ROOT, "data", "config", "lineage_denylist.json"));
    expect(r.foundationalAllowlist).toBe(
      join(REPO_ROOT, "data", "config", "lineage_foundational_allowlist.json"),
    );
    expect(r.themeAliases).toBe(join(REPO_ROOT, "data", "config", "theme_aliases.json"));
    expect(r.themeBlacklist).toBe(join(REPO_ROOT, "data", "config", "theme_blacklist.json"));
    expect(r.paperRepos).toBe(join(REPO_ROOT, "data", "config", "paper_repos.json"));
    expect(r.qualityPolicy).toBe(
      join(REPO_ROOT, "data", "config", "lineage-quality-policy-v1.json"),
    );
    expect(r.auditFixtures).toBe(
      join(REPO_ROOT, "data", "config", "lineage-audit-fixtures-v1.json"),
    );
    expect(r.conferenceSources).toBe(
      join(REPO_ROOT, "data", "config", "conference-sources-v1.yaml"),
    );
    expect(r.identityCoverage).toBe(join(REPO_ROOT, "data", "state", "identity-coverage-v1.json"));
    expect(r.conferenceCopyDir).toBe(join(REPO_ROOT, "data", "config", "conference-copy"));
    expect(r.collectConfigWeekly).toBe(join(REPO_ROOT, "data", "config", "config.yaml"));
    expect(r.collectConfigDailyWatch).toBe(
      join(REPO_ROOT, "data", "config", "config.daily-watch.yaml"),
    );
  });

  it("every resolved file path differs between modes (no accidental sharing)", () => {
    const { layout: _legacyLayout, ...legacy } = resolveEverything(REPO_ROOT, "legacy");
    const { layout: _p5Layout, ...p5 } = resolveEverything(REPO_ROOT, "p5");
    for (const key of Object.keys(legacy) as (keyof typeof legacy)[]) {
      expect(legacy[key]).not.toBe(p5[key]);
    }
  });
});

describe("collectConfig", () => {
  it("legacy: config.yaml lives directly under paperpilot/, not paperpilot/data", () => {
    expect(collectConfig(REPO_ROOT, "weekly", "legacy")).toBe(
      join(REPO_ROOT, "paperpilot", "config.yaml"),
    );
  });

  it("legacy: config.daily-watch.yaml likewise", () => {
    expect(collectConfig(REPO_ROOT, "daily-watch", "legacy")).toBe(
      join(REPO_ROOT, "paperpilot", "config.daily-watch.yaml"),
    );
  });

  it("p5: both move under data/config", () => {
    expect(collectConfig(REPO_ROOT, "weekly", "p5")).toBe(
      join(REPO_ROOT, "data", "config", "config.yaml"),
    );
    expect(collectConfig(REPO_ROOT, "daily-watch", "p5")).toBe(
      join(REPO_ROOT, "data", "config", "config.daily-watch.yaml"),
    );
  });

  it("defaults to weekly and LAYOUT_MODE", () => {
    expect(collectConfig(REPO_ROOT)).toBe(collectConfig(REPO_ROOT, "weekly", LAYOUT_MODE));
  });
});

// Type-only check that Layout's shape is exactly the plan's seven fields
// (a change here is a deliberate, reviewed shape change). `headAssets` was
// added for p5-plan.md §4.1/A5 (the head-metadata assets copy-data.ts
// reads: docs/assets in legacy, apps/web/static/assets in p5).
const _shapeCheck: Layout = {
  published: "",
  state: "",
  inputs: "",
  config: "",
  legacySite: "",
  workflowsDir: "",
  headAssets: "",
};
void _shapeCheck;
