/**
 * GitHub Stars signal via curated map + GitHub Search — TS port of
 * `paperpilot/signals/github_signal.py` (COL-30 of
 * docs/migration/safety-contracts.md).
 *
 * Flow per paper (Stage 2):
 *   arxivId -> curated map ('owner/repo')
 *                ↓ miss
 *              title -> GitHub /search/repositories
 *                ↓ no high-similarity hit
 *              null  ← skip, signal stays at 0
 *
 *   repoFull -> GitHub /repos/{owner}/{repo} -> stargazers_count
 *            -> log-scaled to [0, 100]
 *
 * Budget: `maxLookups` caps the number of PAPERS attempted (ranked by
 * `venueScore + keywordScore` descending, so KeywordSignal and VenueSignal
 * must run first in the runner's signal order). Papers missing `arxivId`
 * are skipped without charging the budget.
 */

import type { Paper } from "../model/paper.js";
import type { GitHubApiDeps } from "./githubApi.js";
import { fetchRepoStars, GitHubUnavailableError, searchRepoByTitle } from "./githubApi.js";
import { loadCuratedMap } from "./githubMap.js";
import { BaseSignal } from "./signal.js";

const MAX_STARS = 10_000;
const LOG_DENOM = Math.log(MAX_STARS + 1);

/** Logarithmic normalization to [0, 100]. Stars > MAX_STARS cap at 100. */
export function starsToScore(stars: number): number {
  if (stars <= 0) return 0.0;
  const s = Math.min(stars, MAX_STARS);
  return (Math.log(s + 1) / LOG_DENOM) * 100.0;
}

export interface GitHubSignalConfig {
  enabled?: boolean;
  max_lookups?: number;
}

export interface GitHubSignalDeps extends GitHubApiDeps {
  githubToken?: string | null;
  /** Overrides the default `paperpilot/data/paper_repos.json` path. */
  curatedMapPath?: string;
}

export { MAX_STARS };

export class GitHubSignal extends BaseSignal {
  readonly name = "github";
  readonly maxLookups: number;
  private readonly githubToken: string | null;
  private readonly deps: GitHubSignalDeps;
  /** Mutable for tests (mirrors the Python tests' direct `sig._curated = {...}` writes). */
  curated: Record<string, string>;
  private unavailable = 0;
  private errored = 0;
  private lastReason = "";
  /**
   * Set once, at construction, when `paper_repos.json` exists but could
   * not be read (collect LOW: "corrupt paper_repos.json silently ignored
   * -> warn+record"). `loadCuratedMap` already WARNS via the logger
   * (matching Python's `load_curated_map`); this additionally RECORDS the
   * degradation on the per-run `runFailures` channel every run, the same
   * way every other persistent-until-restart GitHubSignal problem would
   * be visible in `degraded_signals`/run_history, not just the log.
   */
  private readonly curatedMapWarning: string | null = null;

  constructor(config: GitHubSignalConfig = {}, deps: GitHubSignalDeps) {
    super(config);
    this.maxLookups = config.max_lookups ?? 50;
    this.githubToken = deps.githubToken ?? null;
    this.deps = deps;
    let captured: string | null = null;
    this.curated = loadCuratedMap(deps.curatedMapPath, {
      warn: (msg) => {
        captured = msg;
        deps.logger?.warn(msg);
      },
    });
    this.curatedMapWarning = captured;
  }

  private resetRunCounters(): void {
    this.resetRunFailures();
    this.unavailable = 0;
    this.errored = 0;
    this.lastReason = "";
    if (this.curatedMapWarning) this.runFailures.push(this.curatedMapWarning);
  }

  async enrichBatch(papers: Paper[]): Promise<Paper[]> {
    this.resetRunCounters();
    const ordered = [...papers].sort(
      (a, b) => b.venueScore + b.keywordScore - (a.venueScore + a.keywordScore),
    );
    const queryable = ordered.filter((p) => p.arxivId).length;
    let budget = this.maxLookups;
    let lookups = 0;
    for (const p of ordered) {
      if (budget <= 0) break;
      if (!p.arxivId) continue;
      await this.enrichOneAsync(p);
      budget -= 1;
      lookups += 1;
    }
    this.reportRunFailures(Math.max(queryable - lookups, 0));
    return papers;
  }

  enrichOne(_paper: Paper): Paper {
    // Synchronous contract entry point; delegates to the async lookup and
    // waits for it. No call site in this port's pipeline invokes this
    // directly (the runner always calls enrichBatch) — kept for interface
    // compatibility and direct unit tests.
    throw new Error("GitHubSignal.enrichOne is async; call enrichOneAsync or enrichBatch");
  }

  async enrichOneAsync(paper: Paper): Promise<Paper> {
    if (!paper.arxivId) return paper;
    try {
      const result = await this.lookup(paper.arxivId, paper.title);
      if (result === null) return paper;
      const [ghUrl, stars, isOfficial] = result;
      if (ghUrl) {
        paper.githubUrl = ghUrl;
        paper.githubStars = stars;
        paper.githubScore = starsToScore(stars);
        paper.hasCode = true;
        paper.isOfficialRepo = isOfficial;
      }
      return paper;
    } catch (e) {
      this.deps.logger?.warn(`github lookup failed for ${paper.arxivId}: ${(e as Error).message}`);
      this.errored += 1;
      this.lastReason = `${(e as Error).name}: ${(e as Error).message}`;
      return paper;
    }
  }

  private reportRunFailures(budgetUnqueried: number): void {
    const total = this.unavailable + this.errored;
    if (total) {
      const parts: string[] = [];
      if (this.unavailable) parts.push(`${this.unavailable} lookup(s) unavailable`);
      if (this.errored) parts.push(`${this.errored} lookup(s) raised`);
      let summary = parts.join("; ");
      if (this.lastReason) summary += `; last reason: ${this.lastReason}`;
      this.runFailures.push(summary);
      this.deps.logger?.warn(
        `github: ${total} lookup(s) degraded this run, github_score left at 0 — ${summary}`,
      );
    }
    if (budgetUnqueried) {
      const summary = `budget exhausted after ${this.maxLookups} lookups, ${budgetUnqueried} papers unqueried`;
      this.runFailures.push(summary);
      this.deps.logger?.warn(`github: ${summary} — those papers keep github_score 0.0 untested`);
    }
  }

  private async lookup(
    arxivId: string,
    title: string | null,
  ): Promise<[url: string | null, stars: number, isOfficial: boolean] | null> {
    let repoFull: string | null = this.curated[arxivId] ?? null;
    const isOfficial = Boolean(repoFull);

    try {
      if (!repoFull) {
        repoFull = await searchRepoByTitle(
          title ?? "",
          { githubToken: this.githubToken },
          this.deps,
        );
      }
      if (!repoFull) return null;
      const stars = await fetchRepoStars(repoFull, { githubToken: this.githubToken }, this.deps);
      if (stars === null || stars <= 0) return null;
      return [`https://github.com/${repoFull}`, stars, isOfficial];
    } catch (e) {
      if (e instanceof GitHubUnavailableError) {
        this.unavailable += 1;
        this.lastReason = e.message;
        return null;
      }
      throw e;
    }
  }
}
