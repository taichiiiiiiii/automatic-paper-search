/**
 * PipelineRunner — orchestrates Stage 0..4 and exporters. TS port of
 * `paperpilot/pipeline/runner.py` (COL-17, COL-20, COL-22..26, COL-32 of
 * docs/migration/safety-contracts.md).
 */

import { dirname, join } from "node:path";
import type { Config } from "./config/types.js";
import { CSVExporter } from "./exporters/csv.js";
import { EmailExporter, type SmtpClientFactory } from "./exporters/email.js";
import type { Exporter } from "./exporters/exporter.js";
import { JSONExporter } from "./exporters/json.js";
import { SlackExporter } from "./exporters/slack.js";
import type { FetchLike } from "./http/requestWithRetry.js";
import type { LLMProvider } from "./llm/provider.js";
import type { Logger } from "./logger.js";
import { AuthorSignal } from "./signals/author.js";
import { CitationSignal } from "./signals/citation.js";
import { FollowSignal } from "./signals/follow.js";
import { GitHubSignal } from "./signals/github.js";
import { KeywordSignal } from "./signals/keyword.js";
import type { Signal } from "./signals/signal.js";
import { VenueSignal } from "./signals/venue.js";
import type { ArxivFetchText } from "./sources/arxiv/arxiv.js";
import { ArxivSource } from "./sources/arxiv/arxiv.js";
import { OpenAlexSource } from "./sources/openalex.js";
import { S2Source } from "./sources/s2.js";
import { collect, type SourceEntry, type SourceStatus } from "./stages/collect.js";
import type { AbstractEncoder } from "./stages/embedding.js";
import { embedAndRank } from "./stages/embedding.js";
import { llmRerank } from "./stages/llmRank.js";
import { metricScore } from "./stages/metricScore.js";
import { ruleFilter } from "./stages/ruleFilter.js";
import { appendRunHistory, runId as formatRunId } from "./state/runHistory.js";
import { loadSeenIds, mergeSeenIds, purgeSeenIds } from "./state/seenIds.js";

export interface PipelineResult {
  outputCount: number;
  outputFiles: string[];
  stageCounts: Record<string, number>;
  durationSeconds: number;
  sourcesStatus: Record<string, SourceStatus>;
  errors: string[];
  degradedSignals: string[];
  truncatedDeliveries: { exporter: string; delivered: number; given: number }[];
  truncatedWindows: Record<string, string[]>;
}

export interface RunnerDeps {
  /** Required when `config.sources.arxiv` is present. */
  arxivFetchText?: ArxivFetchText;
  /** Used by S2/OpenAlex sources, citation/author/github signals, and the Slack exporter. */
  fetchImpl: FetchLike;
  /** Required when `config.output.email.enabled` is true. */
  emailTransport?: SmtpClientFactory;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Wall clock, for dates/timestamps/export filenames — injected for determinism. */
  clock?: () => Date;
  logger?: Logger;
  /** Overrides the default `paperpilot/data/paper_repos.json` path for GitHubSignal. */
  githubCuratedMapPath?: string;
  /**
   * Test/integration seam: real LLM providers are P4d (not implemented in
   * this port). When `config.llm.enabled` is true, this override (if
   * given) is used as-is; otherwise Stage 4 stays disabled.
   */
  llmProvider?: LLMProvider | null;
  /** Same seam as `llmProvider`, for Stage 3 (real encoders are P4d). */
  encoder?: AbstractEncoder | null;
}

export class PipelineRunner {
  readonly sources: SourceEntry[];
  readonly signals: Signal[];
  readonly exporters: Exporter[];
  readonly llmProvider: LLMProvider | null;
  readonly encoder: AbstractEncoder | null;
  private readonly config: Config;
  private readonly deps: RunnerDeps;
  // Set only when Stage 4/3 was explicitly asked for (`llm.enabled`
  // / `embedding.enabled`) but no usable provider/encoder could be built —
  // as opposed to nobody asking for the stage at all. `run()` turns this
  // into a `stage3:`/`stage4:` entry in `errors` (collect LOW: "Stage3/4
  // skipped with only warning when no provider"), since a misconfiguration
  // that silently downgrades a requested stage to a no-op is itself a
  // degradation worth recording, not just a log line.
  private llmProviderUnavailableReason: string | null = null;
  private encoderUnavailableReason: string | null = null;

  constructor(config: Config, deps: RunnerDeps) {
    this.config = config;
    this.deps = deps;
    this.sources = this.buildSources();
    this.signals = this.buildSignals();
    this.exporters = this.buildExporters();
    this.llmProvider = this.buildLlmProvider();
    this.encoder = this.buildEncoder();
  }

  // ---- builders ----

  private buildSources(): SourceEntry[] {
    const srcsCfg = this.config.sources ?? {};
    const env = this.config.env;
    const entries: SourceEntry[] = [];
    if (srcsCfg.arxiv) {
      if (!this.deps.arxivFetchText) {
        throw new Error("RunnerDeps.arxivFetchText is required when sources.arxiv is configured");
      }
      entries.push({
        source: new ArxivSource(
          { enabled: srcsCfg.arxiv.enabled, delaySeconds: srcsCfg.arxiv.delay_seconds },
          { fetchText: this.deps.arxivFetchText, sleep: this.deps.sleep, now: this.deps.now },
        ),
        enabled: srcsCfg.arxiv.enabled ?? true,
      });
    }
    if (srcsCfg.s2) {
      entries.push({
        source: new S2Source(
          { enabled: srcsCfg.s2.enabled, delaySeconds: srcsCfg.s2.delay_seconds },
          {
            fetchImpl: this.deps.fetchImpl,
            apiKey: env.s2ApiKey,
            sleep: this.deps.sleep,
            now: this.deps.now,
            logger: this.deps.logger,
          },
        ),
        enabled: srcsCfg.s2.enabled ?? true,
      });
    }
    if (srcsCfg.openalex) {
      entries.push({
        source: new OpenAlexSource(
          { enabled: srcsCfg.openalex.enabled, delaySeconds: srcsCfg.openalex.delay_seconds },
          {
            fetchImpl: this.deps.fetchImpl,
            email: env.openalexEmail,
            sleep: this.deps.sleep,
            now: this.deps.now,
            logger: this.deps.logger,
          },
        ),
        enabled: srcsCfg.openalex.enabled ?? true,
      });
    }
    return entries;
  }

  /**
   * Order matters (mirrors Python's documented reasoning): KeywordSignal
   * before GitHubSignal (budget prioritization reads keywordScore);
   * CitationSignal before AuthorSignal (citation populates firstAuthorId).
   */
  private buildSignals(): Signal[] {
    const sigCfg = this.config.signals ?? {};
    const env = this.config.env;
    const signals: Signal[] = [];
    if (sigCfg.venue) signals.push(new VenueSignal(sigCfg.venue));

    const profileCfg = this.config.profile ?? {};
    const followAuthors = profileCfg.follow_authors ?? [];
    const followOrgs = profileCfg.follow_orgs ?? [];
    if (followAuthors.length > 0 || followOrgs.length > 0) {
      signals.push(new FollowSignal(sigCfg.follow ?? { enabled: true }, followAuthors, followOrgs));
    }

    const keywords = this.config.search?.keywords ?? [];
    signals.push(new KeywordSignal({ enabled: true }, keywords));

    if (sigCfg.citation) {
      signals.push(
        new CitationSignal(sigCfg.citation, {
          fetchImpl: this.deps.fetchImpl,
          apiKey: env.s2ApiKey,
          sleep: this.deps.sleep,
          now: this.deps.now,
          today: this.deps.clock,
          logger: this.deps.logger,
        }),
      );
    }
    if (sigCfg.author) {
      signals.push(
        new AuthorSignal(sigCfg.author, {
          fetchImpl: this.deps.fetchImpl,
          apiKey: env.s2ApiKey,
          sleep: this.deps.sleep,
          now: this.deps.now,
          logger: this.deps.logger,
        }),
      );
    }
    if (sigCfg.github) {
      signals.push(
        new GitHubSignal(sigCfg.github, {
          fetchImpl: this.deps.fetchImpl,
          githubToken: env.githubToken,
          sleep: this.deps.sleep,
          now: this.deps.now,
          logger: this.deps.logger,
          curatedMapPath: this.deps.githubCuratedMapPath,
        }),
      );
    }
    return signals;
  }

  private buildExporters(): Exporter[] {
    const outCfg = this.config.output ?? {};
    const env = this.config.env;
    const exporters: Exporter[] = [];
    if (outCfg.csv?.enabled) {
      exporters.push(new CSVExporter(outCfg.csv, { now: this.deps.clock }));
    }
    if (outCfg.json?.enabled) {
      exporters.push(new JSONExporter(outCfg.json, { now: this.deps.clock }));
    }
    if (outCfg.slack?.enabled) {
      exporters.push(
        new SlackExporter(outCfg.slack, {
          fetchImpl: this.deps.fetchImpl,
          webhookUrl: env.slackWebhookUrl,
          sleep: this.deps.sleep,
          now: this.deps.now,
          today: this.deps.clock,
          logger: this.deps.logger,
        }),
      );
    }
    if (outCfg.email?.enabled) {
      if (!this.deps.emailTransport) {
        throw new Error("RunnerDeps.emailTransport is required when output.email.enabled is true");
      }
      exporters.push(
        new EmailExporter(outCfg.email, {
          smtp: {
            server: env.smtp.server,
            port: env.smtp.port,
            user: env.smtp.user,
            password: env.smtp.password,
            to: env.smtp.to,
            use_tls: env.smtp.useTls,
          },
          transport: this.deps.emailTransport,
          today: this.deps.clock,
          logger: this.deps.logger,
        }),
      );
    }
    return exporters;
  }

  private buildLlmProvider(): LLMProvider | null {
    const llmCfg = this.config.llm;
    if (!llmCfg?.enabled) return null;
    if (this.deps.llmProvider) return this.deps.llmProvider;
    const reason = `unknown LLM provider '${String(llmCfg.provider ?? "")}'`;
    this.deps.logger?.warn(`runner: ${reason} — skipping Stage 4`);
    this.llmProviderUnavailableReason = reason;
    return null;
  }

  private buildEncoder(): AbstractEncoder | null {
    const embCfg = this.config.embedding;
    if (!embCfg?.enabled) return null;
    if (this.deps.encoder) return this.deps.encoder;
    const reason = `encoder backend '${embCfg.backend ?? "minilm"}' unavailable`;
    this.deps.logger?.warn(`runner: ${reason} — skipping Stage 3`);
    this.encoderUnavailableReason = reason;
    return null;
  }

  // ---- run ----

  async run(): Promise<PipelineResult> {
    const started = this.deps.clock ? this.deps.clock() : new Date();
    const searchCfg = this.config.search ?? {};
    const pipeCfg = this.config.pipeline ?? {};
    const incCfg = this.config.incremental ?? {};
    const errors: string[] = [];

    // Stage 0
    const collectResult = await collect(
      this.sources,
      {
        keywords: searchCfg.keywords ?? [],
        categories: searchCfg.categories ?? [],
        daysBack: searchCfg.days_back ?? 7,
        maxResultsPerKeyword: searchCfg.max_results_per_keyword ?? 30,
      },
      { now: this.deps.clock, logger: this.deps.logger },
    );
    let papers = collectResult.papers;
    const sourcesStatus = collectResult.status;
    for (const [name, st] of Object.entries(sourcesStatus)) {
      if (!st.ok) errors.push(`source:${name}:${st.error ?? "unknown"}`);
    }
    // A keyword whose fetch is known-incomplete is missing papers, so the
    // run is not complete even though the source answered with its other
    // keywords (ok=true). A source that failed outright already reported
    // every keyword through the error line above.
    for (const entry of this.sources) {
      const st = sourcesStatus[entry.source.name];
      if (!st?.ok) continue;
      const comp = collectResult.completeness[entry.source.name];
      for (const [kw, reason] of comp?.degradedKeywords ?? []) {
        errors.push(`source:${entry.source.name}: incomplete keyword '${kw}' (${reason})`);
      }
    }
    const truncatedWindows: Record<string, string[]> = {};
    for (const entry of this.sources) {
      const comp = collectResult.completeness[entry.source.name];
      if (comp && comp.truncatedKeywords.length > 0) {
        truncatedWindows[entry.source.name] = comp.truncatedKeywords;
      }
    }
    const s0 = papers.length;

    // Stage 1
    let seen: Record<string, string> = {};
    const incEnabled = incCfg.enabled ?? true;
    const seenIdsFile = incCfg.seen_ids_file ?? "./data/seen_ids.json";
    if (incEnabled) {
      const quarantined: string[] = [];
      seen = loadSeenIds(seenIdsFile, {
        quarantineNotes: quarantined,
        now: this.deps.clock,
        logger: this.deps.logger,
      });
      for (const note of quarantined) {
        errors.push(`state:seen_ids: ${note}; backlog may be re-delivered`);
      }
      seen = purgeSeenIds(seen, incCfg.max_age_days ?? 14, this.deps.clock);
    }
    papers = ruleFilter(papers, {
      excludeWords: searchCfg.exclude_words ?? [],
      categories: searchCfg.categories ?? [],
      sinceDate: collectResult.sinceDate,
      seenIds: incEnabled ? seen : null,
    });
    const s1 = papers.length;

    // Stage 2
    const degradedSignals: string[] = [];
    for (const sig of this.signals) if (sig.enabled) sig.resetRunFailures();
    papers = await metricScore(papers, {
      signals: this.signals,
      weights: this.config.weights ?? {},
      topN: pipeCfg.stage2_top_n ?? 30,
      requireFollowMatch: pipeCfg.require_follow_match ?? false,
      logger: this.deps.logger,
    });
    const s2 = papers.length;

    for (const sig of this.signals) {
      if (!sig.enabled || sig.runFailures.length === 0) continue;
      degradedSignals.push(sig.name);
      for (const failure of sig.runFailures) errors.push(`signal:${sig.name}: ${failure}`);
    }
    if (degradedSignals.length > 0) {
      this.deps.logger?.warn(
        `stage2: degraded signal(s) ${degradedSignals.join(", ")} — their scores are missing, not low`,
      );
    }

    const profile = this.buildProfile();

    // Stage 3 (optional)
    let s3 = s2;
    if (this.encoder !== null) {
      try {
        papers = await embedAndRank(papers, {
          encoder: this.encoder,
          profileText: profile,
          topN: pipeCfg.stage3_top_n ?? 30,
          weight: this.config.weights?.embedding ?? 2.5,
          logger: this.deps.logger,
        });
      } catch (e) {
        this.deps.logger?.warn(
          `stage3: embedding failed, falling through: ${(e as Error).message}`,
        );
        errors.push(`stage3:${(e as Error).message}`);
      }
      s3 = papers.length;
    } else if (this.encoderUnavailableReason) {
      // `embedding.enabled: true` but no usable encoder was built — a
      // configuration-level degradation, not merely "nobody asked for
      // Stage 3". Recorded alongside the already-logged WARNING so a
      // consumer of run_history can see it too (COL-18 already excludes
      // `stage3:`/`stage4:` from the `--fail-on-errors` exit-code gate, so
      // this does not change exit codes).
      errors.push(`stage3:${this.encoderUnavailableReason}`);
    }

    // Stage 4 (optional)
    const stage4TopN = pipeCfg.stage4_top_n ?? 10;
    if (this.llmProvider?.enabled) {
      try {
        papers = await llmRerank(papers, {
          provider: this.llmProvider,
          profile,
          topN: stage4TopN,
          logger: this.deps.logger,
        });
      } catch (e) {
        this.deps.logger?.warn(
          `stage4: LLM rerank failed, using Stage 2 score: ${(e as Error).message}`,
        );
        errors.push(`stage4:${(e as Error).message}`);
        papers = stage4TopN > 0 ? papers.slice(0, stage4TopN) : papers;
      }
    } else {
      if (this.llmProviderUnavailableReason) {
        errors.push(`stage4:${this.llmProviderUnavailableReason}`);
      }
      if (stage4TopN > 0) {
        papers = papers.slice(0, stage4TopN);
      }
    }
    const s4 = papers.length;

    // Export
    const outputFiles: string[] = [];
    const enabledExporters = this.exporters.filter((e) => e.enabled);
    let exportFailures = 0;
    let deliveries = 0;
    const truncatedDeliveries: { exporter: string; delivered: number; given: number }[] = [];
    for (const exp of enabledExporters) {
      let path: string | null;
      try {
        path = await exp.export(papers);
      } catch (e) {
        this.deps.logger?.warn(`exporter '${exp.name}' failed: ${(e as Error).message}`);
        errors.push(`export:${exp.name}:${(e as Error).message}`);
        exportFailures += 1;
        continue;
      }
      if (path) {
        outputFiles.push(path);
        deliveries += 1;
        const delivered = exp.lastDelivered;
        if (delivered !== null && delivered < papers.length) {
          this.deps.logger?.warn(
            `exporter '${exp.name}' delivered ${delivered} of ${papers.length} papers — the rest are marked seen without ever being shown`,
          );
          truncatedDeliveries.push({ exporter: exp.name, delivered, given: papers.length });
        }
      }
    }

    // Persist seen IDs (mark all stage-4 outputs) — only when the run did
    // not both fail to deliver and fail outright.
    const deliveryOutage = exportFailures > 0 && deliveries === 0;
    if (incEnabled) {
      if (deliveryOutage) {
        this.deps.logger?.warn(
          `${exportFailures} of ${enabledExporters.length} enabled exporter(s) failed and none delivered; ` +
            `skipping seen_ids update so these ${papers.length} paper(s) are retried next run`,
        );
      } else {
        const mergeQuarantined: string[] = [];
        seen = await mergeSeenIds(seenIdsFile, papers, {
          maxAgeDays: incCfg.max_age_days ?? 14,
          now: this.deps.clock,
          quarantineNotes: mergeQuarantined,
          logger: this.deps.logger,
        });
        // The file can turn unreadable between the early `loadSeenIds`
        // read above and this lock-protected re-read; without forwarding
        // these notes too, that later quarantine event would have zero
        // visibility (COL-20 expects every quarantine to surface as a
        // `state:seen_ids` error, not just the first one this run hits).
        for (const note of mergeQuarantined) {
          errors.push(`state:seen_ids: ${note}; backlog may be re-delivered`);
        }
      }
    }

    const finished = this.deps.clock ? this.deps.clock() : new Date();
    const durationSeconds = (finished.getTime() - started.getTime()) / 1000;
    const result: PipelineResult = {
      outputCount: papers.length,
      outputFiles,
      stageCounts: {
        stage0_collected: s0,
        stage1_filtered: s1,
        stage2_scored: s2,
        stage3_embedded: s3,
        stage4_ranked: s4,
      },
      durationSeconds,
      sourcesStatus,
      errors,
      degradedSignals,
      truncatedDeliveries,
      truncatedWindows,
    };
    this.appendHistory(result, started, finished, seenIdsFile);
    return result;
  }

  // ---- profile ----

  private buildProfile(): string {
    const profCfg = this.config.profile ?? {};
    const description = profCfg.description;
    if (typeof description === "string" && description.trim()) return description.trim();
    const keywords =
      profCfg.keywords && profCfg.keywords.length > 0
        ? profCfg.keywords
        : (this.config.search?.keywords ?? []);
    if (keywords.length > 0) return `関心キーワード: ${keywords.join(", ")}`;
    return "";
  }

  // ---- history ----

  private appendHistory(
    result: PipelineResult,
    started: Date,
    finished: Date,
    seenIdsFile: string,
  ): void {
    const incCfg = this.config.incremental ?? {};
    const explicit = incCfg.run_history_file;
    const historyPath = explicit ? explicit : join(dirname(seenIdsFile), "run_history.jsonl");
    appendRunHistory(historyPath, {
      runId: formatRunId(started),
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationSeconds: result.durationSeconds,
      stageCounts: result.stageCounts,
      sourcesStatus: result.sourcesStatus,
      errors: result.errors,
      outputFiles: result.outputFiles,
      degradedSignals: result.degradedSignals,
      truncatedDeliveries: result.truncatedDeliveries,
      truncatedWindows: result.truncatedWindows,
    });
  }
}
