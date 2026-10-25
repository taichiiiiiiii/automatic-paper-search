/**
 * CLI entry point for `buildThemeLineage` — TS port of
 * `paperpilot/scripts/build_theme_lineage.py`'s `_build_arg_parser`,
 * `SPARSE_NODES`/`SPARSE_EDGES`, `_expand_params`, `main`.
 *
 * Safety contracts: LIN-18 (auto-expand retry keeps the first result on
 * a worse/failed retry), LIN-19 (exit 2 for bad input / unreadable
 * just-written file, exit 3 for zero edges — decided here from the same
 * condition the builder's write-order gate already enforced BEFORE any
 * write, per `ZeroEdgeBuildError`'s doc comment).
 *
 * R2-6 (design 41 D3): exit 5 ({@link EXIT_DEGRADED_CLASSIFICATION}) when
 * fewer than `--min-classified-rate` (default:
 * `theme_min_evidence_classified_rate` in `lineage-quality-policy-v1.json`,
 * else 0.8) of the edges carry an evidence-backed relation (LLM, S2
 * intents, citation context, …; only year/citation guesses are
 * unclassified) — nothing is written and a `::error::` line names the
 * rate, the evidence mix, every LLM provider's usage and whether a daily
 * quota was hit. `--result-json <path>` records the outcome of every run for the
 * regen workflow's pending-retry state (`regenPending.ts`).
 *
 * R2-37: exit 6 (`EXIT_REGRESSION_REFUSED`, `publishGuard.ts`) when the
 * build would replace a published (audited/unaudited) theme with one the
 * release's quality table would mark `blocked`, or with under half of its
 * nodes (`--allow-shrink` accepts that; `--allow-reaudit` accepts an
 * audited theme going blocked until re-audited). Nothing is written.
 * `--auto-expand` (on-demand) rebuilds larger when the first pass is sparse
 * OR would not pass the publication gate; `--match-published` (regen)
 * rebuilds at the published build's parameters and expands only on a gate
 * failure.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditFixtures,
  classificationsCache,
  LAYOUT_MODE,
  type LayoutMode,
  layoutFor,
  lineageCacheDir,
  qualityPolicy,
} from "@paperpilot/core/layout";
import { loadEnv } from "../../collect/config/env.js";
import { installOpenAlexGate } from "../../collect/http/openalexGate.js";
import type { FetchInit, HttpResponseLike } from "../../collect/http/requestWithRetry.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { IncompleteBuildError } from "../fetch-state/completeness.js";
import { LINEAGE_LLM_ENV, type LineageLlmMode, resolveLineageLlm } from "../shared/lineageLlm.js";
import { buildProvider } from "../shared/providerFactory.js";
import { ARXIV_HTML_FILENAME, DEFAULT_MAX_FETCHES, type FetchTextLike } from "./arxivHtmlSource.js";
import { type BuildThemeLineageDeps, buildThemeLineage, ZeroEdgeBuildError } from "./build.js";
import {
  DEFAULT_MIN_CLASSIFIED_RATE,
  DegradedClassificationError,
  EXIT_DEGRADED_CLASSIFICATION,
} from "./classificationGate.js";
import { CROSSREF_DEFAULT_MAX_REQUESTS, CROSSREF_FILENAME } from "./crossrefReferences.js";
import { DBLP_DEFAULT_MAX_QUERIES, DBLP_FILENAME } from "./dblpVenues.js";
import {
  EXIT_REGRESSION_REFUSED,
  evaluateTheme,
  loadGuardContext,
  publishedTheme,
  RegressionRefusedError,
  regressionRefusal,
} from "./publishGuard.js";
import { S2_COUNT_FILENAME } from "./s2CitationCounts.js";
import { S2_REFERENCES_FILENAME } from "./s2Citations.js";
import { DEFAULT_DESCENDANT_CANDIDATES } from "./s2Expansion.js";
import { sanitizeTheme, themeLineagePath, themeSlug } from "./slug.js";
import { CachedTopicEmbedder, createTransformersEmbedder } from "./topicEmbedding.js";
import { DEFAULT_TOPIC_SCOPE_OPTIONS } from "./topicScope.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** R2-20: `PAPERPILOT_CONTEXT_BATCH_SIZE` (pairs per context-LLM request, 1-20); unset/invalid -> build default. */
export function contextBatchSizeFromEnv(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : undefined;
}
// apps/pipeline/src/lineage/theme -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface ThemeCliArgs {
  theme: string;
  depth: number;
  seedsCount: number;
  width: number;
  sinceYear: number | null;
  output: string | null;
  useOpenalexFallback: boolean;
  llmStrict: "off" | "ambiguous" | "all";
  primarySource: "s2" | "openalex";
  allowIncomplete: boolean;
  autoExpand: boolean;
  deferSparseExpansion: boolean;
  /** R2-2b: BFS admission gate on/off (`--no-topic-gate`). */
  topicGate: boolean;
  /** R2-2b: on-topic links needed to admit a candidate without a theme
   * match (`--topic-min-support`; default 0 = support admission off,
   * R2-11). */
  topicMinSupport: number;
  /** R2-11: embedding topic gate on/off (`--no-topic-embedding`). */
  topicEmbedding: boolean;
  /** R2-6: `--min-classified-rate` (0..1); `null` = take the policy/default. */
  minClassifiedRate: number | null;
  /** R2-6: `--result-json` path for the machine-readable outcome. */
  resultJson: string | null;
  /** R2-24: `--lineage-llm on|off`; `null` = `PAPERPILOT_LINEAGE_LLM`, else off. */
  lineageLlm: "on" | "off" | null;
  /** R2-37: `--match-published` — rebuild with the published build's
   * parameters (auto-expanded when its `meta.depth` is above `--depth`) and
   * retry expanded when the result would be blocked. regen-themes.yml. */
  matchPublished: boolean;
  /** R2-37: `--allow-shrink` — accept a rebuild under half the published nodes. */
  allowShrink: boolean;
  /** R2-37: `--allow-reaudit` — accept that a rebuilt audited theme is
   * blocked (hidden) until its new bytes are re-audited. */
  allowReaudit: boolean;
}

export class CliArgError extends Error {}

const THEME_CLI_SPEC = {
  theme: { type: "string" as const, required: true },
  depth: { type: "int" as const, default: 2 },
  seeds: { type: "int" as const, default: 8 },
  width: { type: "int" as const, default: 8 },
  "since-year": { type: "int" as const },
  output: { type: "string" as const },
  "no-openalex-fallback": { type: "boolean" as const },
  "llm-strict": {
    type: "string" as const,
    choices: ["off", "ambiguous", "all"] as const,
    default: "off",
  },
  "primary-source": {
    type: "string" as const,
    choices: ["s2", "openalex"] as const,
    default: "s2",
  },
  "allow-incomplete": { type: "boolean" as const },
  "auto-expand": { type: "boolean" as const },
  // R2-50: skip the in-run sparse trigger (the workflow's upgrade job rebuilds
  // a sparse result expanded AFTER the quick one is published).
  "defer-sparse-expansion": { type: "boolean" as const },
  "no-topic-gate": { type: "boolean" as const },
  "no-topic-embedding": { type: "boolean" as const },
  "topic-min-support": { type: "int" as const, default: DEFAULT_TOPIC_SCOPE_OPTIONS.minSupport },
  "min-classified-rate": { type: "float" as const },
  "result-json": { type: "string" as const },
  "lineage-llm": { type: "string" as const, choices: ["on", "off"] as const },
  "match-published": { type: "boolean" as const },
  "allow-shrink": { type: "boolean" as const },
  "allow-reaudit": { type: "boolean" as const },
};

/**
 * Parse CLI argv into `ThemeCliArgs` — M3 of the P4 review: mirrors
 * `_build_arg_parser`'s flag set through the shared strict parser
 * (unique-prefix abbreviation, `--flag=value`, `--depth x` exiting
 * instead of becoming `NaN`) instead of a hand-rolled `switch`.
 * `--theme` is required. `CliArgError` (this file's own public error
 * type, pinned by existing tests) now wraps the shared parser's
 * {@link CliUsageError}.
 */
export function parseArgs(argv: readonly string[]): ThemeCliArgs {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseFlags(argv, THEME_CLI_SPEC);
  } catch (e) {
    if (e instanceof CliUsageError) throw new CliArgError(e.message);
    throw e;
  }
  return {
    theme: parsed.theme as string,
    depth: parsed.depth as number,
    seedsCount: parsed.seeds as number,
    width: parsed.width as number,
    sinceYear: (parsed["since-year"] as number | undefined) ?? null,
    output: (parsed.output as string | undefined) ?? null,
    useOpenalexFallback: !(parsed["no-openalex-fallback"] as boolean),
    llmStrict: parsed["llm-strict"] as "off" | "ambiguous" | "all",
    primarySource: parsed["primary-source"] as "s2" | "openalex",
    allowIncomplete: parsed["allow-incomplete"] as boolean,
    autoExpand: parsed["auto-expand"] as boolean,
    deferSparseExpansion: parsed["defer-sparse-expansion"] === true,
    topicGate: !(parsed["no-topic-gate"] as boolean),
    topicMinSupport: parsed["topic-min-support"] as number,
    topicEmbedding: !(parsed["no-topic-embedding"] as boolean),
    minClassifiedRate: (parsed["min-classified-rate"] as number | undefined) ?? null,
    resultJson: (parsed["result-json"] as string | undefined) ?? null,
    lineageLlm: (parsed["lineage-llm"] as "on" | "off" | undefined) ?? null,
    matchPublished: parsed["match-published"] as boolean,
    allowShrink: parsed["allow-shrink"] as boolean,
    allowReaudit: parsed["allow-reaudit"] as boolean,
  };
}

/**
 * R2-24 (design 41): theme generation uses no LLM unless asked
 * (`--lineage-llm on` or `PAPERPILOT_LINEAGE_LLM=on`): relations come
 * from Semantic Scholar citation contexts/intents, OpenAlex/S2 reference
 * lists, title versions and the allowlist.
 */
export const THEME_LINEAGE_LLM_DEFAULT: LineageLlmMode = "off";

/** Policy key holding the default `--min-classified-rate`. */
export const POLICY_MIN_CLASSIFIED_RATE_KEY = "theme_min_evidence_classified_rate";

/**
 * The classification-rate threshold: the flag, else the policy file's
 * {@link POLICY_MIN_CLASSIFIED_RATE_KEY}, else 0.8. A missing/unreadable policy
 * falls back to the default; a present but out-of-range value is an error
 * (a typo must not silently disable the gate).
 */
export function resolveMinClassifiedRate(flag: number | null, policyPath: string | null): number {
  const check = (v: number, where: string): number => {
    if (!(Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw new CliArgError(`${where} must be a number in [0, 1], got ${v}`);
    }
    return v;
  };
  if (flag !== null) return check(flag, "--min-classified-rate");
  if (policyPath !== null) {
    let policy: unknown;
    try {
      policy = JSON.parse(readFileSync(policyPath, "utf-8"));
    } catch {
      policy = null;
    }
    if (policy !== null && typeof policy === "object" && POLICY_MIN_CLASSIFIED_RATE_KEY in policy) {
      const raw = (policy as Record<string, unknown>)[POLICY_MIN_CLASSIFIED_RATE_KEY];
      return check(typeof raw === "number" ? raw : Number.NaN, `${POLICY_MIN_CLASSIFIED_RATE_KEY}`);
    }
  }
  return DEFAULT_MIN_CLASSIFIED_RATE;
}

/** Machine-readable outcome of one CLI run (`--result-json`). */
export interface ThemeRunResult {
  schema_version: "theme-run-result-v1";
  theme: string;
  exit_code: number;
  status:
    | "ok"
    | "degraded_classification"
    | "zero_edges"
    | "incomplete"
    | "regression_refused"
    | "error";
  /** Degraded runs only: did any LLM provider report its daily quota exhausted? */
  daily_limit_hit: boolean;
  /** R2-24: whether the run could use an LLM (`off` runs never hit an LLM quota). */
  lineage_llm: "on" | "off";
  classified_rate: number | null;
  classified_edges: number | null;
  total_edges: number | null;
  threshold: number | null;
  message: string;
}

function writeResult(path: string | null, result: ThemeRunResult): void {
  if (path === null) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  } catch (e) {
    process.stderr.write(`warning: cannot write --result-json ${path}: ${(e as Error).message}\n`);
  }
}

/** `--auto-expand` thresholds: fewer than `SPARSE_NODES` nodes OR fewer
 * than `SPARSE_EDGES` edges triggers the retry. */
export const SPARSE_NODES = 15;
export const SPARSE_EDGES = 5;

/** Compute the larger BFS parameters used on the auto-expand retry.
 * Each axis bumps independently: depth never exceeds 3, seeds at least
 * doubles but caps at 12, width adds +4 with a 12 cap. */
export function expandParams(
  depth: number,
  seedsCount: number,
  width: number,
): [number, number, number] {
  return [
    Math.min(3, depth + 1),
    Math.min(12, Math.max(10, seedsCount * 2)),
    Math.min(12, width + 4),
  ];
}

/**
 * Where `.env` lives, as a function of the layout mode — p5-plan.md §2
 * A2 follow-up #19 ("load .env from layout.config"), L10 of the P5
 * tier-A review. Mirrors `layoutFor`'s own `collectConfig()` quirk for
 * `config.yaml` (`packages/core/src/layout/index.ts`): under
 * `"legacy"` it lives one level ABOVE `layout.config`
 * (`paperpilot/.env`, parallel to `paperpilot/data` — byte-identical to
 * this CLI's old hard-coded `join(repoRoot, "paperpilot", ".env")`, so
 * tier A stays inert), and only moves INSIDE `layout.config` under
 * `"p5"` (`data/config/.env`, alongside `config.yaml`). Kept as a local
 * helper (not a new `layoutFor` export) per this task's edit-scope
 * limits; duplicated from `lineage/conference/buildLineageCli.ts`'s own
 * `envFilePath` for the same "each CLI's wiring stays independently
 * readable" reason that module's own doc comment gives.
 */
export function envFilePath(repoRoot: string, mode: LayoutMode = LAYOUT_MODE): string {
  if (mode === "legacy") {
    return join(repoRoot, "paperpilot", ".env");
  }
  return join(layoutFor(repoRoot, mode).config, ".env");
}

/** R2-28 env switches: `on` enables, unset / `off` disables; anything
 * else disables with a warning (these sources only ADD evidence). */
export const ARXIV_HTML_ENV = "PAPERPILOT_ARXIV_HTML";
export const ARXIV_HTML_MAX_ENV = "PAPERPILOT_ARXIV_HTML_MAX_FETCHES";
export const CROSSREF_ENV = "PAPERPILOT_CROSSREF_REFERENCES";
export const CROSSREF_MAX_ENV = "PAPERPILOT_CROSSREF_MAX_REQUESTS";
export const DBLP_ENV = "PAPERPILOT_DBLP_VENUES";
export const DBLP_MAX_ENV = "PAPERPILOT_DBLP_MAX_QUERIES";
/** R2-35: ranked descendant search (S2 bulk search + reference check). */
export const S2_DESCENDANT_SEARCH_ENV = "PAPERPILOT_S2_DESCENDANT_SEARCH";
export const S2_DESCENDANT_CANDIDATES_ENV = "PAPERPILOT_S2_DESCENDANT_CANDIDATES";

function switchOn(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  warn: (msg: string) => void,
): boolean {
  const v = (env[name] ?? "").trim().toLowerCase();
  if (v === "" || v === "off") return false;
  if (v === "on") return true;
  warn(`warning: ${name}=${JSON.stringify(env[name])} is not on/off; treated as off`);
  return false;
}

function positiveInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const n = Number.parseInt(env[name] ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Plain-text GET with the timeout covering the body read (arXiv HTML). */
export const fetchTextImpl: FetchTextLike = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  // A caller that never reads the body (404, 403, 5xx) never clears the
  // timer; unref so it cannot keep the process alive for timeoutMs.
  timer.unref?.();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: init.method,
      headers: init.headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  return {
    status: resp.status,
    headers: resp.headers,
    text: async () => {
      try {
        return await resp.text();
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

/**
 * R2-28: the opt-in evidence sources of {@link BuildThemeLineageDeps}
 * (arXiv HTML contexts, Crossref reference lists, DBLP venues) from the
 * environment. All default to off; each is bounded per run.
 */
const S2_EXPANSION_RETRY_ENV = "PAPERPILOT_S2_EXPANSION_RETRY";
/** 45 s then 90 s per unanswered expansion, 8 min of waiting per build. */
export const S2_EXPANSION_RETRY = {
  delaysMs: [45_000, 90_000],
  budgetMs: 8 * 60_000,
} as const;

export function optInEvidenceDeps(
  env: Readonly<Record<string, string | undefined>>,
  cacheDir: string,
  contact: string | null,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): Pick<
  BuildThemeLineageDeps,
  "arxivHtml" | "crossref" | "dblpVenues" | "s2DescendantSearch" | "s2ExpansionRetry"
> {
  return {
    // R2-52: on by default (the keyless S2 429 storms are what fail an
    // expansion); `PAPERPILOT_S2_EXPANSION_RETRY=off` disables it.
    s2ExpansionRetry:
      env[S2_EXPANSION_RETRY_ENV]?.trim().toLowerCase() === "off" ? null : S2_EXPANSION_RETRY,
    s2DescendantSearch: switchOn(env, S2_DESCENDANT_SEARCH_ENV, warn)
      ? {
          candidates: positiveInt(env, S2_DESCENDANT_CANDIDATES_ENV, DEFAULT_DESCENDANT_CANDIDATES),
        }
      : null,
    arxivHtml: switchOn(env, ARXIV_HTML_ENV, warn)
      ? {
          cachePath: join(cacheDir, ARXIV_HTML_FILENAME),
          fetchText: fetchTextImpl,
          maxFetches: positiveInt(env, ARXIV_HTML_MAX_ENV, DEFAULT_MAX_FETCHES),
          contact,
        }
      : null,
    crossref: switchOn(env, CROSSREF_ENV, warn)
      ? {
          cachePath: join(cacheDir, CROSSREF_FILENAME),
          mailto: contact,
          maxRequests: positiveInt(env, CROSSREF_MAX_ENV, CROSSREF_DEFAULT_MAX_REQUESTS),
        }
      : null,
    dblpVenues: switchOn(env, DBLP_ENV, warn)
      ? {
          cachePath: join(cacheDir, DBLP_FILENAME),
          maxQueries: positiveInt(env, DBLP_MAX_ENV, DBLP_DEFAULT_MAX_QUERIES),
          contact,
        }
      : null,
  };
}

/** Exported for tests (the M6 fetch-timeout-covers-body-read fix lives in
 * the `fetchImpl` this builds); production callers rely on the
 * `runThemeCli` default. */
export function defaultDeps(repoRoot: string = DEFAULT_REPO_ROOT): BuildThemeLineageDeps {
  const layout = layoutFor(repoRoot);
  const docsRoot = layout.published;
  const env = loadEnv(envFilePath(repoRoot));
  const rawFetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike> = async (
    url,
    init,
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    // A caller that never reads the body (404, 403, 5xx) never clears the
    // timer; unref so it cannot keep the process alive for timeoutMs.
    timer.unref?.();
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    // M6 (review, LOW): `json()` is lazy — the caller reads the body
    // AFTER this function returns. Clearing the abort timer here (right
    // after the response HEADERS arrive, in a `finally` around only the
    // `fetch()` call above) would leave the body read with no timeout at
    // all: a server that sends headers promptly and then stalls the body
    // stream could hang the build forever. The timer must stay armed —
    // and the same `AbortController` still cover — the body read too, so
    // it's cleared from INSIDE the `json()` thunk once that read settles,
    // not before the caller even gets a chance to call it.
    return {
      status: resp.status,
      // Exposed so 429 handling can honour Retry-After / x-ratelimit-reset-*.
      headers: resp.headers,
      json: async () => {
        try {
          return await resp.json();
        } finally {
          clearTimeout(timer);
        }
      },
    };
  };
  // R2-19: OpenAlex key + daily-budget breaker; one summary line on exit.
  const { fetchImpl } = installOpenAlexGate(rawFetchImpl, { apiKey: env.openalexApiKey });
  return {
    fetchImpl,
    cacheDir: lineageCacheDir(layout),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    email: env.openalexEmail,
    docsRoot,
    identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
    githubCachePath: join(lineageCacheDir(layout), "github_stars.json"),
    githubToken: env.githubToken,
    classificationCachePath: classificationsCache(layout),
    githubApiDeps: { fetchImpl },
    // R2-36: publish max(OpenAlex, Semantic Scholar) citation counts.
    // PAPERPILOT_S2_CITATION_COUNTS=off keeps OpenAlex counts only.
    s2CitationCounts:
      (process.env.PAPERPILOT_S2_CITATION_COUNTS ?? "").toLowerCase() === "off"
        ? null
        : { cachePath: join(lineageCacheDir(layout), S2_COUNT_FILENAME) },
    // R2-10 (design 41 D6): Semantic Scholar citation contexts first.
    // PAPERPILOT_S2_RELATIONS=off restores the pre-R2-10 path.
    s2Citations:
      (process.env.PAPERPILOT_S2_RELATIONS ?? "").toLowerCase() === "off"
        ? null
        : {
            cachePath: join(lineageCacheDir(layout), S2_REFERENCES_FILENAME),
            apiKey: env.s2ApiKey,
          },
    // R2-28: arXiv HTML contexts / Crossref lists / DBLP venues (opt-in).
    ...optInEvidenceDeps(
      process.env,
      lineageCacheDir(layout),
      (process.env.PAPERPILOT_CONTACT_EMAIL ?? "").trim() || env.openalexEmail || null,
    ),
    // R2-11: vectors and model files live under the (git-ignored) lineage
    // cache; CI keeps both in the Actions cache (regen-themes.yml,
    // theme-on-demand.yml).
    topicEmbedder: new CachedTopicEmbedder(
      createTransformersEmbedder({
        modelCacheDir: join(lineageCacheDir(layout), "models"),
      }),
      join(lineageCacheDir(layout), "embeddings"),
    ),
    buildProvider: () =>
      buildProvider(
        {
          env,
          ambientEnv: process.env,
          fetchImpl,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          // Surface why an LLM call failed (status code) in the CI log;
          // without it every failure silently falls back to the heuristic.
          logger: { warn: (msg) => process.stderr.write(`${msg}\n`) },
        },
        // R2-6 (design 41 D2): Groq first, Gemini when Groq latches or
        // returns nothing for a pair — whichever keys are configured.
        // R2-20: the citation-context prompt asks the cheaper Groq context
        // model first (PAPERPILOT_GROQ_CONTEXT_MODEL, default gpt-oss-20b).
        { fallback: true, contextModelRouting: true },
      ),
    logger: {
      warn: (msg) => process.stderr.write(`${msg}\n`),
      info: (msg) => process.stderr.write(`${msg}\n`),
    },
  };
}

export interface RunThemeCliOptions {
  deps?: BuildThemeLineageDeps;
  /** Test-only override for `buildThemeLineage` itself (mirrors the
   * Python test suite's `monkeypatch.setattr(build_theme_lineage,
   * "build_theme_lineage", fake_build)` — lets auto-expand/retry tests
   * control exactly what each of the (up to two) build attempts
   * returns/throws without driving the full pipeline through fake
   * network fixtures). Defaults to the real `buildThemeLineage`. */
  buildFn?: typeof buildThemeLineage;
  /** Policy file holding the default `--min-classified-rate` and the
   * publication gate (R2-37 guard / auto-expand trigger); `null` = built-in
   * defaults. Defaults to the repo's `lineage-quality-policy-v1.json`. */
  policyPath?: string | null;
  /** R2-37: golden fixtures for the published theme's tier; `null` = none.
   * Defaults to the repo's `lineage-audit-fixtures-v1.json`. */
  fixturesPath?: string | null;
}

function readBytesOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Run the theme-lineage CLI; returns the process exit code. Never
 * throws — every failure path is mapped to a stderr message + exit
 * code, mirroring Python `main()`'s `try`/`except` ladder. */
export async function runThemeCli(
  argv: readonly string[],
  options: RunThemeCliOptions = {},
): Promise<number> {
  let args: ThemeCliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (args.topicMinSupport < 0) {
    process.stderr.write("error: --topic-min-support must be >= 0 (0 = support admission off)\n");
    return 2;
  }

  try {
    sanitizeTheme(args.theme);
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return 2;
  }

  let lineageLlm: "on" | "off";
  try {
    lineageLlm = resolveLineageLlm(args.lineageLlm, process.env, THEME_LINEAGE_LLM_DEFAULT);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 2;
  }
  if (lineageLlm === "off" && args.llmStrict !== "off") {
    process.stderr.write(
      `lineage-llm: off — --llm-strict ${args.llmStrict} ignored (API evidence only; set ${LINEAGE_LLM_ENV}=on or --lineage-llm on to use the LLM)\n`,
    );
  }

  const policyPath =
    options.policyPath === undefined
      ? qualityPolicy(layoutFor(DEFAULT_REPO_ROOT))
      : options.policyPath;
  let minClassifiedRate: number;
  try {
    minClassifiedRate = resolveMinClassifiedRate(args.minClassifiedRate, policyPath);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 2;
  }

  const result = (
    exitCode: number,
    status: ThemeRunResult["status"],
    message: string,
    degraded?: DegradedClassificationError,
  ): number => {
    writeResult(args.resultJson, {
      schema_version: "theme-run-result-v1",
      theme: args.theme,
      exit_code: exitCode,
      status,
      daily_limit_hit: degraded?.dailyLimitHit ?? false,
      lineage_llm: lineageLlm,
      classified_rate: degraded?.rate.ratio ?? null,
      classified_edges: degraded?.rate.classified ?? null,
      total_edges: degraded?.rate.total ?? null,
      threshold: degraded ? degraded.threshold : null,
      message: message.slice(0, 500),
    });
    return exitCode;
  };
  const degradedExit = (exc: DegradedClassificationError): number => {
    // stdout so the `::error::` annotation reaches the Actions log as a
    // workflow command; the detail lines follow it.
    process.stdout.write(`${exc.report()}\n`);
    return result(EXIT_DEGRADED_CLASSIFICATION, "degraded_classification", exc.message, exc);
  };

  const deps = options.deps ?? defaultDeps();
  const build = options.buildFn ?? buildThemeLineage;

  // R2-37: what is published for this theme now, and the guard that keeps
  // a rebuild from replacing it with a blocked or much smaller graph.
  const slug = themeSlug(sanitizeTheme(args.theme));
  let targetPath: string;
  try {
    targetPath = args.output ?? themeLineagePath(deps.docsRoot, slug);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 2;
  }
  const guardCtx = loadGuardContext({
    policyPath,
    fixturesPath:
      options.fixturesPath === undefined
        ? auditFixtures(layoutFor(DEFAULT_REPO_ROOT))
        : options.fixturesPath,
    minClassifiedRate,
    now: deps.wallClockNow,
  });
  const published = publishedTheme(readBytesOrNull(targetPath), slug, guardCtx);
  if (published !== null) {
    process.stderr.write(
      `publish guard: published ${slug} is ${published.tier} (${published.nodeCount} nodes / ${published.edgeCount} edges, depth ${published.depth ?? "?"}, ${published.seedCount} seeds)\n`,
    );
  }
  const publishGuard = (text: string): string | null =>
    regressionRefusal(
      published,
      evaluateTheme(Buffer.from(text, "utf-8"), slug, guardCtx, { withAudit: true }),
      { allowShrink: args.allowShrink, allowReaudit: args.allowReaudit },
    );
  const refusedExit = (exc: RegressionRefusedError): number => {
    process.stdout.write(`::error::theme ${JSON.stringify(args.theme)}: ${exc.message}\n`);
    return result(EXIT_REGRESSION_REFUSED, "regression_refused", exc.message);
  };
  /** Exit for the LAST attempt's failure (published file untouched). */
  const failureExit = (exc: unknown): number => {
    if (exc instanceof DegradedClassificationError) return degradedExit(exc);
    if (exc instanceof RegressionRefusedError) return refusedExit(exc);
    if (exc instanceof ZeroEdgeBuildError) {
      process.stderr.write(`0 edges produced; published artifact left untouched: ${exc.message}\n`);
      return result(3, "zero_edges", exc.message);
    }
    if (exc instanceof IncompleteBuildError) {
      process.stderr.write(
        `incomplete build; published artifact left untouched: ${(exc as Error).message}\n`,
      );
      return result(4, "incomplete", (exc as Error).message);
    }
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return result(2, "error", (exc as Error).message);
  };

  const attempt = (depth: number, seedsCount: number, width: number): Promise<string> =>
    build(
      {
        theme: args.theme,
        depth,
        seedsCount,
        width,
        sinceYear: args.sinceYear,
        output: args.output,
        useOpenalexFallback: args.useOpenalexFallback,
        llmStrict: args.llmStrict,
        primarySource: args.primarySource,
        allowIncomplete: args.allowIncomplete,
        // The CLI is the one caller that treats 0 edges as a failure.
        allowEdgeless: false,
        topicScope: { gate: args.topicGate, minSupport: args.topicMinSupport },
        topicEmbedding: args.topicEmbedding,
        minClassifiedRate,
        contextBatchSize: contextBatchSizeFromEnv(process.env.PAPERPILOT_CONTEXT_BATCH_SIZE),
        lineageLlm,
        publishGuard,
      },
      deps,
    );

  // R2-37 parameter parity: a theme published from an auto-expanded build
  // (meta.depth above the requested depth) is rebuilt at the expanded
  // parameters directly, as it was created.
  let [depth, seedsCount, width] = [args.depth, args.seedsCount, args.width];
  let expanded = false;
  if (
    args.matchPublished &&
    published !== null &&
    published.depth !== null &&
    published.depth > args.depth
  ) {
    [depth, seedsCount, width] = expandParams(args.depth, args.seedsCount, args.width);
    expanded = true;
    process.stderr.write(
      `match-published: published build has depth ${published.depth}; building with --depth ${depth} --seeds ${seedsCount} --width ${width}\n`,
    );
  }
  const mayExpand = (args.autoExpand || args.matchPublished) && !expanded;

  /** Why the written first pass should be rebuilt larger (null = keep it). */
  const expandReason = (bytes: Buffer): string | null => {
    const v = evaluateTheme(bytes, slug, guardCtx);
    if (
      args.autoExpand &&
      !args.deferSparseExpansion &&
      (v.nodeCount < SPARSE_NODES || v.edgeCount < SPARSE_EDGES)
    ) {
      return `first pass ${v.nodeCount} nodes / ${v.edgeCount} edges below (${SPARSE_NODES} / ${SPARSE_EDGES})`;
    }
    if (v.tier === "blocked") {
      return `first pass (${v.nodeCount} nodes / ${v.edgeCount} edges) would be blocked by the publication gate (${v.failed.join("; ")})`;
    }
    return null;
  };

  let outPath: string | null = null;
  let retryReason: string | null = null;
  try {
    outPath = await attempt(depth, seedsCount, width);
  } catch (exc) {
    if (exc instanceof DegradedClassificationError || !mayExpand) {
      // No auto-expand retry on a degraded build: a bigger graph needs
      // MORE classifications from the evidence source that just failed.
      return failureExit(exc);
    }
    if (exc instanceof ZeroEdgeBuildError) {
      retryReason = "first pass produced 0 edges";
    } else if (exc instanceof RegressionRefusedError) {
      retryReason = `first pass refused by the publish guard (${exc.message})`;
    } else {
      return failureExit(exc);
    }
  }

  // The first pass is on disk: rebuild larger when it is sparse or would
  // not be published.
  let initialBytes: Buffer | null = null;
  if (outPath !== null && mayExpand) {
    initialBytes = readBytesOrNull(outPath);
    retryReason = expandReason(initialBytes ?? Buffer.from("{}"));
  }

  if (retryReason !== null) {
    const [d2, s2, w2] = expandParams(args.depth, args.seedsCount, args.width);
    process.stderr.write(
      `auto-expand: ${retryReason}; retrying with --depth ${d2} --seeds ${s2} --width ${w2}\n`,
    );
    try {
      const retryPath = await attempt(d2, s2, w2);
      outPath = retryPath;
      // LIN-18: never trade a publishable first pass for a blocked retry.
      if (initialBytes !== null) {
        const before = evaluateTheme(initialBytes, slug, guardCtx);
        const after = evaluateTheme(
          readBytesOrNull(retryPath) ?? Buffer.from("{}"),
          slug,
          guardCtx,
        );
        if (after.tier === "blocked" && before.tier !== "blocked") {
          atomicWriteText(retryPath, initialBytes.toString("utf-8"));
          process.stderr.write(
            `auto-expand retry would be blocked (${after.failed.join("; ")}); keeping the initial lineage\n`,
          );
        }
      }
    } catch (exc) {
      if (outPath === null) return failureExit(exc);
      const why =
        exc instanceof DegradedClassificationError
          ? "was classification-degraded"
          : exc instanceof ZeroEdgeBuildError
            ? "produced 0 edges"
            : exc instanceof IncompleteBuildError
              ? "hit an incomplete fetch"
              : exc instanceof RegressionRefusedError
                ? "was refused by the publish guard"
                : "failed";
      process.stderr.write(
        `auto-expand retry ${why}; keeping the initial lineage: ${(exc as Error).message}\n`,
      );
    }
  }
  if (outPath === null) return result(2, "error", "no build written");

  let payload: { edges?: unknown[] };
  try {
    payload = JSON.parse(readFileSync(outPath, "utf-8"));
  } catch (exc) {
    process.stderr.write(
      `error: cannot re-read just-written ${outPath}: ${(exc as Error).message}\n`,
    );
    return result(2, "error", `cannot re-read just-written ${outPath}`);
  }
  if (!payload.edges || payload.edges.length === 0) {
    process.stderr.write(
      "warning: 0 edges produced; published artifact left untouched. Re-run after LLM quota resets (see issue #45).\n",
    );
    return result(3, "zero_edges", "0 edges produced");
  }
  return result(0, "ok", `wrote ${outPath}`);
}

if (isMain(import.meta.url)) {
  runThemeCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
