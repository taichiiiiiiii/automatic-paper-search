/**
 * Audit edge classification distribution by provenance bucket — TS port of
 * `paperpilot/scripts/audit_lineage_classification_breakdown.py` (LIN-38's
 * `_VALID_PROVENANCES` drift-guard counterpart). Read-only; exit code is
 * always 0 (not a CI gate).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codepointCompare, pyRound } from "@paperpilot/core";
import { TEMPLATE_RATIONALES } from "../llm/base.js";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimum rationale length below which a cache entry is treated as a stale malformed record. */
const MIN_WELLFORMED_RATIONALE_CHARS = 30;

/** Ordered stable closed set for provenance buckets — must mirror `_lineage_classify._VALID_PROVENANCES`. */
export const NEW_ENUMS: readonly string[] = [
  "context_pattern",
  "intent_map",
  "year_cite",
  "title_version",
  "foundational_allowlist",
  "llm",
];

/** Legacy rationale-string -> new enum normalization map. */
const LEGACY_TEMPLATE_TO_ENUM: ReadonlyMap<string, string> = new Map([
  [TEMPLATE_RATIONALES.extends_methodology!, "intent_map"],
  [TEMPLATE_RATIONALES.successor_result!, "intent_map"],
  [TEMPLATE_RATIONALES.baseline_only_background!, "intent_map"],
  [TEMPLATE_RATIONALES.contrasts_year_cite!, "year_cite"],
  [TEMPLATE_RATIONALES.supersedes_year_cite!, "year_cite"],
  [TEMPLATE_RATIONALES.ablation_year_cite!, "year_cite"],
]);

type CountersByKey = Map<string, Map<string, number>>;

function bump(counters: CountersByKey, bucket: string, key: string): void {
  let c = counters.get(bucket);
  if (!c) {
    c = new Map();
    counters.set(bucket, c);
  }
  c.set(key, (c.get(key) ?? 0) + 1);
}

function initCounters(): CountersByKey {
  const c: CountersByKey = new Map();
  for (const e of NEW_ENUMS) c.set(e, new Map());
  return c;
}

export interface ClassifyEdgeProvenanceOptions {
  /** Collects each not-yet-seen unknown provenance value, for a dedup'd one-line-per-value warning. */
  warnedProvenanceValues?: Set<string>;
  onUnknownProvenance?: (value: string) => void;
}

/** Classify one lineage edge into the 5(+)-enum provenance bucket. */
export function classifyEdgeProvenance(
  edge: Record<string, unknown>,
  options: ClassifyEdgeProvenanceOptions = {},
): string {
  const { warnedProvenanceValues, onUnknownProvenance } = options;
  const field = edge.provenance;
  if (typeof field === "string" && field) {
    if (
      !NEW_ENUMS.includes(field) &&
      warnedProvenanceValues &&
      !warnedProvenanceValues.has(field)
    ) {
      warnedProvenanceValues.add(field);
      onUnknownProvenance?.(field);
    }
    return field;
  }
  const rationale = typeof edge.rationale === "string" ? edge.rationale : "";
  if (rationale.includes("canonical research-lineage")) return "foundational_allowlist";
  const mapped = LEGACY_TEMPLATE_TO_ENUM.get(rationale);
  if (mapped !== undefined) return mapped;
  return "llm";
}

export interface PublishedThemesAudit {
  per_theme: Record<string, Record<string, Record<string, number>>>;
  per_provenance_rel: Record<string, Record<string, number>>;
}

/** Per-provenance relation counts across published `docs/themes/<slug>/lineage.json` files. */
export function auditPublishedThemes(
  themesDir: string,
  warn: (value: string) => void = () => {},
): PublishedThemesAudit {
  const perProvenanceRel = initCounters();
  const perTheme: Record<string, Record<string, Record<string, number>>> = {};
  const warnedProvenanceValues = new Set<string>();

  let themeDirs: string[] = [];
  try {
    themeDirs = readdirSync(themesDir)
      .filter((name) => statSync(join(themesDir, name)).isDirectory())
      .sort(codepointCompare);
  } catch {
    themeDirs = [];
  }

  for (const themeName of themeDirs) {
    const lineagePath = join(themesDir, themeName, "lineage.json");
    if (!existsSync(lineagePath)) continue;
    const data = JSON.parse(readFileSync(lineagePath, "utf8")) as Record<string, unknown>;
    const themeBreakdown = initCounters();
    const edges = Array.isArray(data.edges) ? data.edges : [];
    for (const edge of edges) {
      if (!isMapping(edge)) continue;
      const relation = typeof edge.rel === "string" ? edge.rel : "unknown";
      const provenance = classifyEdgeProvenance(edge, {
        warnedProvenanceValues,
        onUnknownProvenance: warn,
      });
      bump(themeBreakdown, provenance, relation);
      bump(perProvenanceRel, provenance, relation);
    }
    const nonEmpty: Record<string, Record<string, number>> = {};
    for (const [bucket, counts] of themeBreakdown) {
      if (counts.size > 0) nonEmpty[bucket] = Object.fromEntries(counts);
    }
    perTheme[themeName] = nonEmpty;
  }

  const canonicalThenFuture = [
    ...NEW_ENUMS,
    ...Array.from(perProvenanceRel.keys()).filter((p) => !NEW_ENUMS.includes(p)),
  ];
  const perProvenanceRelOut: Record<string, Record<string, number>> = {};
  for (const bucket of canonicalThenFuture) {
    perProvenanceRelOut[bucket] = Object.fromEntries(perProvenanceRel.get(bucket) ?? new Map());
  }
  return { per_theme: perTheme, per_provenance_rel: perProvenanceRelOut };
}

export type ClassificationsCacheAudit =
  | { available: false }
  | {
      available: true;
      total_entries: number;
      unrelated_dropped: number;
      wellformed_rel: Record<string, number>;
      short_rationale_rel: Record<string, number>;
      by_model: Record<string, number>;
    };

/** Distribution across the persistent LLM call cache (wider denominator than the published lineage). */
export function auditClassificationsCache(cachePath: string): ClassificationsCacheAudit {
  if (!existsSync(cachePath)) return { available: false };
  const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
  const wellformedRel = new Map<string, number>();
  const shortRel = new Map<string, number>();
  let unrelated = 0;
  const byModel = new Map<string, number>();

  for (const value of Object.values(cache)) {
    if (!isMapping(value)) continue;
    const model = typeof value.model === "string" && value.model ? value.model : "(legacy/none)";
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
    const relation = value.relation;
    const rationale = (typeof value.rationale === "string" ? value.rationale : "").trim();
    if (relation === "unrelated") {
      unrelated += 1;
      continue;
    }
    if (typeof relation !== "string" || !relation) continue;
    if (Array.from(rationale).length >= MIN_WELLFORMED_RATIONALE_CHARS) {
      wellformedRel.set(relation, (wellformedRel.get(relation) ?? 0) + 1);
    } else {
      shortRel.set(relation, (shortRel.get(relation) ?? 0) + 1);
    }
  }

  return {
    available: true,
    total_entries: Object.keys(cache).length,
    unrelated_dropped: unrelated,
    wellformed_rel: Object.fromEntries(wellformedRel),
    short_rationale_rel: Object.fromEntries(shortRel),
    by_model: Object.fromEntries(byModel),
  };
}

/**
 * Python `f"{v * 100 / total:.1f}%"` (`_percent_table`) — round-half-to-even
 * on the exact binary value, not `.toFixed(1)`'s half-up-ish behaviour
 * (p4-followups.md #18). `pyRound(..., 1)` resolves the tie exactly as
 * CPython would; the subsequent `.toFixed(1)` only re-displays that
 * already-rounded value (no further rounding decision left to make, so
 * it cannot diverge from Python there).
 */
function percentTable(counts: Record<string, number>): [string, string][] {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [k, `${v} (${pyRound((v * 100) / total, 1).toFixed(1)}%)`]);
}

export function printHuman(
  published: PublishedThemesAudit,
  cache: ClassificationsCacheAudit,
  write: (line: string) => void,
): void {
  write("=== Published lineage (docs/themes/*/lineage.json) ===");
  for (const provenance of NEW_ENUMS) {
    const relCounts = published.per_provenance_rel[provenance] ?? {};
    const total = Object.values(relCounts).reduce((a, b) => a + b, 0);
    write(`\n[${provenance}] n=${total}`);
    for (const [rel, descr] of percentTable(relCounts)) write(`  ${rel}: ${descr}`);
  }

  if (cache.available) {
    write("\n=== Persistent LLM cache (paperpilot/data/lineage-cache/classifications.json) ===");
    write(`total entries: ${cache.total_entries} (unrelated dropped: ${cache.unrelated_dropped})`);
    const wf = cache.wellformed_rel;
    write(
      `\n[wellformed >= ${MIN_WELLFORMED_RATIONALE_CHARS} chars] n=${Object.values(wf).reduce((a, b) => a + b, 0)}`,
    );
    for (const [rel, descr] of percentTable(wf)) write(`  ${rel}: ${descr}`);
    const sh = cache.short_rationale_rel;
    if (Object.keys(sh).length > 0) {
      write(
        `\n[short < ${MIN_WELLFORMED_RATIONALE_CHARS} chars (stale?)] n=${Object.values(sh).reduce((a, b) => a + b, 0)}`,
      );
      for (const [rel, descr] of percentTable(sh)) write(`  ${rel}: ${descr}`);
    }
    const bm = cache.by_model;
    if (Object.keys(bm).length > 0) {
      write(`\n[by model (#310)] n=${Object.values(bm).reduce((a, b) => a + b, 0)}`);
      for (const [model, descr] of percentTable(bm)) write(`  ${model}: ${descr}`);
    }
  } else {
    write("\n(classifications cache not present)");
  }

  write("\n=== Diagnosis ===");
  const llmPub = published.per_provenance_rel.llm ?? {};
  if (Object.keys(llmPub).length > 0) {
    const pubTotal = Object.values(llmPub).reduce((a, b) => a + b, 0);
    const pubMissing = ["supersedes", "ablation", "baseline_only", "successor"].filter(
      (r) => (llmPub[r] ?? 0) === 0,
    );
    if (pubMissing.length > 0) {
      write(`Published LLM-only subset (n=${pubTotal}): ${pubMissing.join(", ")} = 0 emits.`);
    }
  }
  if (cache.available) {
    const wf = cache.wellformed_rel;
    const cacheMissing = ["supersedes", "ablation"].filter((r) => (wf[r] ?? 0) === 0);
    if (cacheMissing.length > 0) {
      write(
        `Persistent LLM cache wellformed (n=${Object.values(wf).reduce((a, b) => a + b, 0)}): ` +
          `${cacheMissing.join(", ")} = 0 emits across all cached calls. Prompt is the bottleneck for these relations.`,
      );
    }
  }
}
