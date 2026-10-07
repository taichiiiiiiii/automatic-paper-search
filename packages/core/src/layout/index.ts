/**
 * The single data-layout switch — docs/migration/p5-plan.md §2 changeset
 * A0 (design doc §1, §7.3).
 *
 * Every TS reader of the published JSON (today `docs/`), the
 * collector/lineage run state (today `paperpilot/data/`), the per-conference
 * collector input CSV/JSON (today `paperpilot/output/`), and the config data
 * files that happen to share `paperpilot/data/` with the run state today
 * (denylist, allowlists, theme aliases/blacklist, quality policy, audit
 * fixtures, conference sources) must resolve the root through
 * {@link layoutFor} / {@link relLayout} rather than hard-coding a path
 * literal. That makes flipping {@link LAYOUT_MODE} from `"legacy"` to
 * `"p5"` — commit B of the plan, which also does the one-time `git mv` of
 * `docs/` / `paperpilot/data/` / `paperpilot/output/` into `data/published`
 * / `data/state` / `data/inputs` / `data/config` — the only code change
 * needed to retarget every call site at once.
 *
 * `LAYOUT_MODE` is `"legacy"` until that commit. Every behaviour under
 * `"legacy"` must stay byte-identical to the pre-A0 hard-coded paths: this
 * module only replaces *how* each path is computed, never the resulting
 * string, while `LAYOUT_MODE` says `"legacy"`.
 */

import { join } from "node:path";

export type LayoutMode = "legacy" | "p5";

/** The mode every caller uses by default until commit B flips it. */
export const LAYOUT_MODE: LayoutMode = "p5";

/**
 * The five root kinds plus the staged-workflows directory, as absolute
 * filesystem paths under one `repoRoot` (see {@link layoutFor}).
 */
export interface Layout {
  /** Public JSON the site serves. Legacy `docs`; p5 `data/published`. */
  published: string;
  /** Collector/lineage run state (seen_ids, run_history, lineage-cache). Legacy `paperpilot/data`; p5 `data/state`. */
  state: string;
  /** Per-conference collector input CSV/JSON. Legacy `paperpilot/output`; p5 `data/inputs`. */
  inputs: string;
  /** Config data files (denylist, allowlists, theme aliases/blacklist, paper repos, quality policy, audit fixtures, conference sources, per-slug conference copy). Legacy `paperpilot/data` (shared with `state`); p5 `data/config`. */
  config: string;
  /** The frozen legacy GitHub Pages site. Legacy `docs` (shared with `published`, since it's the live site); p5 `legacy/gh-pages-site` (until deleted in tier C). */
  legacySite: string;
  /** Where the Node workflow YAML live. Legacy staged `.github/workflows-p5`; p5 `.github/workflows`. */
  workflowsDir: string;
  /**
   * Where the head-metadata assets (favicon, OG image — see
   * `apps/web/scripts/copy-data.ts`'s `HEAD_ASSET_FILES`) live on disk.
   * Legacy `docs/assets` (part of the live site, `published`'s own
   * `assets/` subdirectory); p5 `apps/web/static/assets` (p5-plan.md §5.1:
   * the data move relocates just these three files there, since
   * `apps/web/public/` is wiped and regenerated on every build and so
   * cannot hold a tracked source file).
   */
  headAssets: string;
}

/** The same five roots plus `workflowsDir`, as repo-relative POSIX strings (never joined with a platform path separator) — for allowlists, `SHARED_PATHS`, and workflow `paths:` filters. See {@link relLayout}. */
export type RelLayout = Readonly<Layout>;

const REL_LAYOUTS: Readonly<Record<LayoutMode, RelLayout>> = {
  legacy: {
    published: "docs",
    state: "paperpilot/data",
    inputs: "paperpilot/output",
    config: "paperpilot/data",
    legacySite: "docs",
    workflowsDir: ".github/workflows-p5",
    headAssets: "docs/assets",
  },
  p5: {
    published: "data/published",
    state: "data/state",
    inputs: "data/inputs",
    config: "data/config",
    legacySite: "legacy/gh-pages-site",
    workflowsDir: ".github/workflows",
    headAssets: "apps/web/static/assets",
  },
};

/**
 * Repo-relative POSIX strings for `mode` (default {@link LAYOUT_MODE}).
 * Use this (never `layoutFor(...).x` turned back into a string) wherever a
 * git-relative path is needed — e.g. `promote.ts`'s `SHARED_PATHS`, a
 * workflow's `paths:` filter, or an allowlist entry — since joining with
 * `node:path`'s platform separator would be wrong there.
 */
export function relLayout(mode: LayoutMode = LAYOUT_MODE): RelLayout {
  return REL_LAYOUTS[mode];
}

function toAbsolute(repoRoot: string, relPosix: string): string {
  return join(repoRoot, ...relPosix.split("/"));
}

/** Absolute filesystem roots for `repoRoot`, in `mode` (default {@link LAYOUT_MODE}). */
export function layoutFor(repoRoot: string, mode: LayoutMode = LAYOUT_MODE): Layout {
  const rel = relLayout(mode);
  return {
    published: toAbsolute(repoRoot, rel.published),
    state: toAbsolute(repoRoot, rel.state),
    inputs: toAbsolute(repoRoot, rel.inputs),
    config: toAbsolute(repoRoot, rel.config),
    legacySite: toAbsolute(repoRoot, rel.legacySite),
    workflowsDir: toAbsolute(repoRoot, rel.workflowsDir),
    headAssets: toAbsolute(repoRoot, rel.headAssets),
  };
}

// ---------------------------------------------------------------------------
// Named file helpers (p5-plan.md §2 A0's named-helper list). Each is a pure
// function of an already-resolved `Layout`, relative to the root the file
// actually lives under.
// ---------------------------------------------------------------------------

export type CollectKind = "weekly" | "daily";

/** `seen_ids.json` (weekly) / `seen_ids.daily.json` (daily). */
export function seenIds(layout: Layout, kind: CollectKind = "weekly"): string {
  return join(layout.state, kind === "daily" ? "seen_ids.daily.json" : "seen_ids.json");
}

/** `run_history.jsonl` (weekly) / `run_history.daily.jsonl` (daily). */
export function runHistory(layout: Layout, kind: CollectKind = "weekly"): string {
  return join(layout.state, kind === "daily" ? "run_history.daily.jsonl" : "run_history.jsonl");
}

/** The S2-metadata + LLM-classification cache directory. */
export function lineageCacheDir(layout: Layout): string {
  return join(layout.state, "lineage-cache");
}

/** `lineage-cache/classifications.json`, shared across every lineage builder. */
export function classificationsCache(layout: Layout): string {
  return join(lineageCacheDir(layout), "classifications.json");
}

/** `lineage_denylist.json` (implementation-foundation denylist, LIN-29). */
export function denylist(layout: Layout): string {
  return join(layout.config, "lineage_denylist.json");
}

/** `lineage_foundational_allowlist.json` (#277 foundational-ancestor allowlist). */
export function foundationalAllowlist(layout: Layout): string {
  return join(layout.config, "lineage_foundational_allowlist.json");
}

/** `theme_aliases.json` (#274/#195 theme alias fallback). */
export function themeAliases(layout: Layout): string {
  return join(layout.config, "theme_aliases.json");
}

/** `theme_blacklist.json` (#209 per-theme keyword blacklist). */
export function themeBlacklist(layout: Layout): string {
  return join(layout.config, "theme_blacklist.json");
}

/** `paper_repos.json` (curated arXiv-id -> GitHub-repo map). */
export function paperRepos(layout: Layout): string {
  return join(layout.config, "paper_repos.json");
}

/** `lineage-quality-policy-v1.json`. */
export function qualityPolicy(layout: Layout): string {
  return join(layout.config, "lineage-quality-policy-v1.json");
}

/** `lineage-audit-fixtures-v1.json`. */
export function auditFixtures(layout: Layout): string {
  return join(layout.config, "lineage-audit-fixtures-v1.json");
}

/** `conference-sources-v1.yaml`. */
export function conferenceSources(layout: Layout): string {
  return join(layout.config, "conference-sources-v1.yaml");
}

/** `identity-coverage-v1.json` (release/derived identity-lite state). */
export function identityCoverage(layout: Layout): string {
  return join(layout.state, "identity-coverage-v1.json");
}

/**
 * `conference-copy/<slug>.json` directory (p5-plan.md §2 A2: one file per
 * slug, so two concurrent conference promotions don't collide on a shared
 * manifest). New under p5; inert under legacy (nothing reads/writes it yet).
 */
export function conferenceCopyDir(layout: Layout): string {
  return join(layout.config, "conference-copy");
}

export type CollectConfigKind = "weekly" | "daily-watch";

/**
 * `config.yaml` (weekly) / `config.daily-watch.yaml` (daily-watch) — the
 * collector's own YAML config.
 *
 * This is the one named helper that is NOT simply `join(layout.config,
 * <file>)`: under `"legacy"`, these two files live directly under
 * `paperpilot/` (one level above `paperpilot/data`, which is what
 * `layout.config` points at in that mode) until commit B's `move + edit`
 * (p5-plan.md §5.1) relocates them into `data/config/`. Takes `repoRoot`
 * (not a resolved `Layout`) so it can compute the legacy, `layout.config`
 * -independent location itself.
 */
export function collectConfig(
  repoRoot: string,
  kind: CollectConfigKind = "weekly",
  mode: LayoutMode = LAYOUT_MODE,
): string {
  const fileName = kind === "daily-watch" ? "config.daily-watch.yaml" : "config.yaml";
  if (mode === "legacy") {
    return join(repoRoot, "paperpilot", fileName);
  }
  return join(layoutFor(repoRoot, mode).config, fileName);
}
