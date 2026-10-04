/**
 * Compute per-theme data-quality statistics for the family-tree viewer
 * — TS port of `paperpilot/scripts/compute_theme_quality.py` (LIN-53).
 *
 * Walks `docs/themes/<slug>/lineage.json` and produces a single rollup
 * (`docs/themes/_quality.json`) containing per-theme metrics plus a
 * summary block. Reuses `edgeMetrics` (ported in `lineage/quality/
 * auditLineageQuality.ts`) and `isOnTopic` (`./auditThemeSeeds.ts`) so
 * the numbers reported here match what the audit gates would say.
 */

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codepointCompare, pyFloat, pyIsoformat, pyJsonDumps } from "@paperpilot/core";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { edgeMetrics } from "../quality/auditLineageQuality.js";
import { type AuditablePaper, isOnTopic } from "./auditThemeSeeds.js";

/** Threshold for "high template ratio" in the summary rollup — matches
 * `audit_lineage_quality`'s WARN gate so the two reports stay
 * qualitatively consistent. */
const HIGH_TEMPLATE_RATIO = 0.3;

export interface ThemeQuality {
  theme: string;
  node_count: number;
  focus_count: number;
  off_topic_focus: number;
  edge_count: number;
  template_count: number;
  template_ratio: number;
  popularity_sinks: number;
  year_reversals: number;
}

export interface ThemeQualityRollup {
  generated_at: string;
  themes: Record<string, ThemeQuality>;
  summary: {
    theme_count: number;
    total_nodes: number;
    total_edges: number;
    total_off_topic_focus: number;
    themes_with_template_rationale_high: number;
    themes_with_off_topic_seeds: number;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compute the quality block for a single theme dir, or `null` when
 * the dir lacks a readable `lineage.json`. */
export function themeQuality(themeDir: string): ThemeQuality | null {
  const lj = join(themeDir, "lineage.json");
  let raw: string;
  try {
    raw = readFileSync(lj, "utf-8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;
  const meta = isPlainObject(data.meta) ? data.meta : {};
  const theme = typeof meta.theme === "string" ? meta.theme : "";
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const focus = (nodes as AuditablePaper[]).filter((n) => isPlainObject(n) && Boolean(n.is_focus));
  const offTopic = theme ? focus.filter((n) => !isOnTopic(theme, n)) : [];

  const em = edgeMetrics(data);
  return {
    theme,
    node_count: nodes.length,
    focus_count: focus.length,
    off_topic_focus: offTopic.length,
    edge_count: em.edge_count,
    template_count: em.template_count,
    template_ratio: em.template_ratio,
    popularity_sinks: em.popularity_sinks,
    year_reversals: em.year_reversals,
  };
}

export interface ComputeQualityOptions {
  themesDir: string;
  /** Injectable so tests can pin the timestamp. */
  now?: Date;
}

/** Build the full quality rollup. */
export function computeQuality(options: ComputeQualityOptions): ThemeQualityRollup {
  const now = options.now ?? new Date();
  const themes: Record<string, ThemeQuality> = {};

  let names: string[] = [];
  try {
    names = readdirSync(options.themesDir).sort(codepointCompare);
  } catch {
    names = [];
  }
  for (const name of names) {
    const themeDir = join(options.themesDir, name);
    try {
      if (!statSync(themeDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const q = themeQuality(themeDir);
    if (q !== null) themes[name] = q;
  }

  const values = Object.values(themes);
  const highTemplate = values.filter((q) => q.template_ratio > HIGH_TEMPLATE_RATIO).length;
  const offTopicThemes = values.filter((q) => q.off_topic_focus > 0).length;
  const totalOffTopic = values.reduce((sum, q) => sum + q.off_topic_focus, 0);

  return {
    // Python's `datetime.isoformat()` on a UTC-aware datetime prints
    // "+00:00", not "Z" — `Date.toISOString()` always prints "Z", so
    // `pyIsoformat` is used for byte-identical output.
    generated_at: pyIsoformat(now),
    themes,
    summary: {
      theme_count: values.length,
      total_nodes: values.reduce((sum, q) => sum + q.node_count, 0),
      total_edges: values.reduce((sum, q) => sum + q.edge_count, 0),
      total_off_topic_focus: totalOffTopic,
      themes_with_template_rationale_high: highTemplate,
      themes_with_off_topic_seeds: offTopicThemes,
    },
  };
}

/** Compute the rollup and atomically write it to
 * `themesDir/_quality.json`; returns the written path. */
export function writeThemeQuality(options: ComputeQualityOptions): string {
  mkdirSync(options.themesDir, { recursive: true });
  const rollup = computeQuality(options);
  const out = join(options.themesDir, "_quality.json");
  // `template_ratio` is `float(...)` in Python, so an integer-valued
  // ratio (0.0 or 1.0, both common — see the "clean"/"all-template"
  // theme cases) must still serialize with a decimal point.
  // `pyJsonDumps` only does that for values wrapped in `pyFloat`; the
  // returned `rollup` itself keeps plain `number`s for ergonomic
  // reading/testing, so the wrap happens only in this wire copy.
  const wire = {
    ...rollup,
    themes: Object.fromEntries(
      Object.entries(rollup.themes).map(([slug, q]) => [
        slug,
        { ...q, template_ratio: pyFloat(q.template_ratio) },
      ]),
    ),
  };
  atomicWriteText(out, `${pyJsonDumps(wire, { ensureAscii: false, indent: 2 })}\n`);
  return out;
}
