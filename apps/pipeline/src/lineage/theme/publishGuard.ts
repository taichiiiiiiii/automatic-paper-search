/**
 * R2-37: publication-tier guard for theme rebuilds.
 *
 * Incident 2026-10-12: `regen-themes.yml` rebuilt the published, unaudited
 * Low-Rank Adaptation theme (74 nodes / 327 edges, built by
 * `theme-on-demand.yml` with `--auto-expand`) at plain depth 1 and got 21
 * nodes / 39 edges with only 2 evidence-backed lineage relations. The build
 * was complete and evidence-classified, so every write-time gate let it
 * through, and the release replaced a visible theme with one the quality
 * table then marked `blocked` — the theme vanished from the site.
 *
 * This module evaluates a theme artifact with the SAME code the release
 * uses (`buildLineageQuality.collectionRow`, policy from
 * `lineage-quality-policy-v1.json`), so no gate number is duplicated here:
 *
 * - {@link evaluateTheme}: the tier a payload would get (a fresh build has no
 *   audit, so `unaudited` at best) plus the failed checks — the auto-expand
 *   trigger in `cli.ts` uses it ("would the depth-1 result be published?");
 * - {@link publishedTheme}: the tier/size of what is published now (with its
 *   golden fixture, so an audited theme reads `audited`);
 * - {@link regressionRefusal}: refuse to replace a published (audited /
 *   unaudited) theme with a build that would be `blocked`, or with one under
 *   {@link MIN_KEPT_NODE_SHARE} of its nodes unless `allowShrink`.
 *
 * The refusal happens before the write (`build.ts` `publishGuard`), so the
 * published files stay byte-identical; the CLI exits
 * {@link EXIT_REGRESSION_REFUSED}.
 */

import { readFileSync } from "node:fs";
import type { PublicationTier } from "../contract/v1.js";
import {
  type CollectionRow,
  collectionRow,
  type GoldenFixture,
  type QualityPolicy,
  strongRelationsFromPolicy,
  themeGateFromPolicy,
} from "../quality/buildLineageQuality.js";

/** Exit code of a rebuild refused by the non-regression guard. */
export const EXIT_REGRESSION_REFUSED = 6;
/** A rebuild keeping fewer than this share of the published nodes is a shrink. */
export const MIN_KEPT_NODE_SHARE = 0.5;

export class RegressionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegressionRefusedError";
  }
}

export interface ThemeVerdict {
  tier: PublicationTier;
  nodeCount: number;
  edgeCount: number;
  /** Every automatic check that did not pass (golden fixture excluded). */
  failed: string[];
  /** `golden_fixture` status: `unknown` = no audit entry for this theme,
   * `failed` with nothing else failing = an audit bound to other bytes. */
  golden: "passed" | "failed" | "unknown";
}

export interface PublishedTheme extends ThemeVerdict {
  /** `meta.depth` of the published build (null when absent). */
  depth: number | null;
  /** Number of `meta.seeds` of the published build. */
  seedCount: number;
}

export interface GuardContext {
  policy: QualityPolicy;
  /** Fixtures for the published tier (`lineage-audit-fixtures-v1.json`). */
  fixtures: readonly GoldenFixture[];
  /** Evaluation clock; read at each evaluation (a build's `generated_at`
   * must not look future-dated), floored to whole seconds like promote's
   * `as_of`. */
  now: () => Date;
}

/** Policy defaults when no policy file is configured (tests, library use). */
export function fallbackPolicy(minClassifiedRate: number): QualityPolicy {
  return {
    conference_max_age_days: 30,
    theme_max_age_days: 90,
    theme_min_evidence_classified_rate: minClassifiedRate,
  };
}

function readJson(path: string | null): unknown {
  if (path === null) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Load the guard context from the policy/fixture files (missing -> defaults). */
export function loadGuardContext(options: {
  policyPath: string | null;
  fixturesPath: string | null;
  minClassifiedRate: number;
  now?: () => Date;
}): GuardContext {
  const raw = readJson(options.policyPath);
  const policy =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? ({ ...fallbackPolicy(options.minClassifiedRate), ...raw } as QualityPolicy)
      : fallbackPolicy(options.minClassifiedRate);
  const fx = readJson(options.fixturesPath) as { collections?: unknown } | null;
  const fixtures = Array.isArray(fx?.collections)
    ? (fx.collections.filter((r) => r !== null && typeof r === "object") as GoldenFixture[])
    : [];
  return { policy, fixtures, now: options.now ?? (() => new Date()) };
}

function failedChecks(row: CollectionRow): string[] {
  const out: string[] = [];
  if (row.availability !== "ready") out.push(`availability ${row.availability}`);
  for (const c of row.audit.checks) {
    if (c.status === "passed" || c.name === "golden_fixture") continue;
    out.push(`${c.name} ${c.status} (observed ${c.observed}, expected ${c.expected})`);
  }
  return out;
}

function golden(r: CollectionRow): ThemeVerdict["golden"] {
  return r.audit.checks.find((c) => c.name === "golden_fixture")?.status ?? "unknown";
}

function fixtureFor(slug: string, ctx: GuardContext): GoldenFixture | null {
  return ctx.fixtures.find((f) => f.collection_id === `theme:${slug}`) ?? null;
}

function row(
  bytes: Buffer,
  slug: string,
  ctx: GuardContext,
  fixture: GoldenFixture | null,
): CollectionRow {
  return collectionRow({
    docsRoot: "",
    kind: "theme",
    slug,
    label: slug,
    relativePath: `themes/${slug}/lineage.json`,
    snapshotDate: null,
    generatedHint: null,
    fixture,
    asOfText: `${ctx.now().toISOString().slice(0, 19)}Z`,
    maxAgeDays: Number(ctx.policy.theme_max_age_days),
    catalogIds: null,
    strongRelations: strongRelationsFromPolicy(ctx.policy),
    themeGate: themeGateFromPolicy(ctx.policy),
    payload: bytes,
  });
}

/**
 * The tier `bytes` would get from the release's quality table. With
 * `withAudit` the theme's golden fixture is applied as the release applies
 * it — a fixture bound to other bytes FAILS `golden_fixture`, so a rebuilt
 * audited theme is `blocked` until re-audited. Without it (the auto-expand
 * trigger) only the build's own gate is judged: at best `unaudited`.
 */
export function evaluateTheme(
  bytes: Buffer,
  slug: string,
  ctx: GuardContext,
  options: { withAudit?: boolean } = {},
): ThemeVerdict {
  const r = row(bytes, slug, ctx, options.withAudit ? fixtureFor(slug, ctx) : null);
  return {
    tier: r.publication_tier,
    nodeCount: r.node_count,
    edgeCount: r.edge_count,
    failed: failedChecks(r),
    golden: golden(r),
  };
}

/** What is published for `slug` now; null when nothing (readable) is. */
export function publishedTheme(
  bytes: Buffer | null,
  slug: string,
  ctx: GuardContext,
): PublishedTheme | null {
  if (bytes === null) return null;
  const r = row(bytes, slug, ctx, fixtureFor(slug, ctx));
  let depth: number | null = null;
  let seedCount = 0;
  try {
    const meta = (JSON.parse(bytes.toString("utf-8")) as { meta?: Record<string, unknown> }).meta;
    if (typeof meta?.depth === "number") depth = meta.depth;
    if (Array.isArray(meta?.seeds)) seedCount = meta.seeds.length;
  } catch {
    // unreadable -> tier is already `blocked`
  }
  return {
    tier: r.publication_tier,
    nodeCount: r.node_count,
    edgeCount: r.edge_count,
    failed: failedChecks(r),
    golden: golden(r),
    depth,
    seedCount,
  };
}

/**
 * Why `candidate` must not replace `published` (null = it may). Only a
 * published (audited/unaudited) theme is protected: a blocked one is not on
 * the site, so any complete rebuild may replace it.
 */
export function regressionRefusal(
  published: PublishedTheme | null,
  candidate: ThemeVerdict,
  options: { allowShrink: boolean; allowReaudit?: boolean },
): string | null {
  if (published === null || published.tier === "blocked") return null;
  const was = `published ${published.tier} theme (${published.nodeCount} nodes / ${published.edgeCount} edges)`;
  const staleAuditOnly =
    candidate.tier === "blocked" && candidate.failed.length === 0 && candidate.golden === "failed";
  if (staleAuditOnly && !options.allowReaudit) {
    return (
      `refusing to replace the ${was}: the rebuild passes every automatic check, but its audit ` +
      "(lineage-audit-fixtures-v1.json) is bound to the published bytes, so the release would mark " +
      "the theme blocked (hidden) until it is re-audited. Pass --allow-reaudit " +
      "(regen-themes.yml: allow_reaudit=true) to replace it and re-audit the new build."
    );
  }
  if (candidate.tier === "blocked" && !staleAuditOnly) {
    return (
      `refusing to replace the ${was} with a build the publication gate would block ` +
      `(${candidate.nodeCount} nodes / ${candidate.edgeCount} edges; failed: ${candidate.failed.join("; ") || "unknown"}). ` +
      "The published files are kept; rebuild with the parameters the theme was created with " +
      "(--match-published / --auto-expand) or fix generation first."
    );
  }
  if (!options.allowShrink && candidate.nodeCount < published.nodeCount * MIN_KEPT_NODE_SHARE) {
    return (
      `refusing to replace the ${was} with a build of ${candidate.nodeCount} nodes / ${candidate.edgeCount} edges ` +
      `(< ${MIN_KEPT_NODE_SHARE * 100}% of the published nodes). The published files are kept; ` +
      "pass --allow-shrink (regen-themes.yml: allow_shrink=true) if the smaller graph is intended."
    );
  }
  return null;
}
