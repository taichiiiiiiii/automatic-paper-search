/**
 * Evidence-classification-rate gate for theme lineages (design 41 D3,
 * R2-6). Provider-agnostic by design.
 *
 * Every failed LLM call used to fall back silently to a year/citation
 * guess: a theme built while the key was expired or the daily quota was
 * gone still "succeeded", as a graph of guessed `successor` edges. D3:
 * when less than 80% of a lineage's edges carry a relation backed by real
 * evidence, the build is a failure — nothing is written, the previous
 * version stays published, and the CLI exits with
 * {@link EXIT_DEGRADED_CLASSIFICATION} so CI shows it.
 *
 * What counts (by `provenance.classification.method` of the FINAL edges,
 * i.e. `meta.provenance_breakdown`):
 *
 *  - UNCLASSIFIED (a guess, no evidence about the kind of relation):
 *    `citation_heuristic` and `year_cite` — "B cites A" plus the two
 *    years / citation counts. This is what remains when no evidence
 *    source answered for a pair.
 *  - CLASSIFIED (real evidence, whatever produced it): `llm` (a fresh
 *    answer, a cache hit, or a fallback-provider answer), `intent_map`
 *    (Semantic Scholar's citation intents), `context_pattern` (the citing
 *    sentence itself), `title_version` (an explicit version successor in
 *    the titles) and `foundational_allowlist` (curated ancestors). Any
 *    other, future method also counts as classified: the closed method
 *    set is enforced by the artifact validator, and only the guess
 *    methods above are known to carry no evidence.
 *
 * The gate does not care which source produced the evidence, so it keeps
 * working unchanged if LLM classification is replaced by API evidence
 * (S2 intents / contexts / `isInfluential`). With no edge at all the rate
 * is `null` and the gate passes (0 edges is the CLI's own exit 3).
 */

import type { LabelledUsage } from "../llm/fallback.js";

/** Default minimum share of edges whose relation is evidence-backed. */
export const DEFAULT_MIN_CLASSIFIED_RATE = 0.8;

/** Theme CLI exit code: evidence-classified rate below the threshold. */
export const EXIT_DEGRADED_CLASSIFICATION = 5;

/** Provenance methods that are guesses, not evidence. */
export const UNCLASSIFIED_METHODS: ReadonlySet<string> = new Set([
  "citation_heuristic",
  "year_cite",
]);

export interface ClassifiedRate {
  /** Edges whose relation is evidence-backed. */
  classified: number;
  /** All edges. */
  total: number;
  /** Edges that are year/citation guesses. */
  guessed: number;
  /** Classified edges per evidence method (llm, intent_map, …). */
  byMethod: Record<string, number>;
  /** `classified / total`, or `null` with no edges. */
  ratio: number | null;
}

/** Classify `provenanceBreakdown` per the rules in the module doc. */
export function evidenceClassifiedRate(
  provenanceBreakdown: Readonly<Record<string, number>>,
): ClassifiedRate {
  let classified = 0;
  let guessed = 0;
  const byMethod: Record<string, number> = {};
  for (const [method, rawCount] of Object.entries(provenanceBreakdown)) {
    const count = Number(rawCount) || 0;
    if (UNCLASSIFIED_METHODS.has(method)) {
      guessed += count;
    } else {
      classified += count;
      byMethod[method] = (byMethod[method] ?? 0) + count;
    }
  }
  const total = classified + guessed;
  return { classified, total, guessed, byMethod, ratio: total === 0 ? null : classified / total };
}

/** True when any LLM provider in the chain reported its daily quota exhausted. */
export function dailyLimitHit(usage: readonly LabelledUsage[]): boolean {
  return usage.some((u) => u.stats?.dailyLimitHit === true);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** Raised by `buildThemeLineage` BEFORE the write when the gate fails. */
export class DegradedClassificationError extends Error {
  readonly rate: ClassifiedRate;
  readonly threshold: number;
  /** LLM provider usage (empty when no LLM was configured). */
  readonly usage: readonly LabelledUsage[];
  readonly theme: string;

  constructor(
    theme: string,
    rate: ClassifiedRate,
    threshold: number,
    usage: readonly LabelledUsage[],
  ) {
    super(
      `evidence-classified rate ${rate.ratio === null ? "n/a" : pct(rate.ratio)} ` +
        `(${rate.classified}/${rate.total} edges) is below ${pct(threshold)} for theme ${JSON.stringify(theme)}`,
    );
    this.name = "DegradedClassificationError";
    this.theme = theme;
    this.rate = rate;
    this.threshold = threshold;
    this.usage = usage;
  }

  get dailyLimitHit(): boolean {
    return dailyLimitHit(this.usage);
  }

  /**
   * The CI-facing report: one GitHub `::error::` annotation line (kept on
   * one line — annotations end at the newline) followed by each LLM
   * provider's own summary line.
   */
  report(): string {
    const methods =
      Object.entries(this.rate.byMethod)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([m, n]) => `${m}=${n}`)
        .join(", ") || "none";
    const providers =
      this.usage.length === 0
        ? "none"
        : this.usage
            .map((u) => {
              const st = u.stats;
              if (!st) return `${u.model} (no counters)`;
              const latch = st.latched ? `latched: ${st.latchReason}` : "not latched";
              return `${u.model} calls=${st.calls} ok=${st.ok} failed=${st.failed}, ${latch}`;
            })
            .join("; ");
    const lines = [
      `::error::degraded classification for theme ${JSON.stringify(this.theme)}: ` +
        `${this.rate.ratio === null ? "n/a" : pct(this.rate.ratio)} of edges ` +
        `(${this.rate.classified}/${this.rate.total}; evidence: ${methods}; ` +
        `year/citation guesses: ${this.rate.guessed}) are evidence-classified, ` +
        `below the ${pct(this.threshold)} threshold — artifact NOT written, previous build retained. ` +
        `LLM daily limit hit: ${this.dailyLimitHit ? "yes" : "no"}. LLM providers: ${providers}`,
    ];
    for (const u of this.usage) if (u.summary) lines.push(...u.summary.split("\n"));
    return lines.join("\n");
  }
}
