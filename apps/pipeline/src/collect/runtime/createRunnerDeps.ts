/**
 * Assembles a real {@link RunnerDeps} for the collect CLI's production
 * entry point (#26/#29 of docs/migration/p4-followups.md) — real network
 * fetch (`collect/runtime/fetch.ts`), the real LLM provider factory
 * (`collect/runtime/llmProvider.ts`), and the SMTP decision
 * (`collect/runtime/emailTransport.ts`). No real encoder (Stage 3) is
 * wired — see `runner.ts`'s `buildEncoder` doc comment; `embedding.enabled:
 * true` already degrades to a reported `stage3:` error without this
 * module's help, exactly as intended.
 *
 * Every field is overridable so `collect/cli.ts`'s real entry and a test
 * (no network, fake fetch/clock injected) can share this exact
 * construction — the point of the "CLI end-to-end with a fake fetch
 * injected via a test seam" requirement: the test exercises the REAL
 * header/timeout/provider-selection code, not a parallel fake.
 */

import type { RunnerDeps } from "../runner.js";
import { createUnavailableEmailTransport } from "./emailTransport.js";
import { createRealArxivFetchText, createRealFetchImpl } from "./fetch.js";
import { buildLlmProviderFromConfig } from "./llmProvider.js";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type CreateRunnerDepsOptions = Partial<RunnerDeps>;

/**
 * Builds a full `RunnerDeps` for a real `PipelineRunner`. Any field passed
 * in `overrides` wins outright (test seam); everything else gets a real
 * default.
 */
export function createRunnerDeps(overrides: CreateRunnerDepsOptions = {}): RunnerDeps {
  const fetchImpl = overrides.fetchImpl ?? createRealFetchImpl();
  const sleep = overrides.sleep ?? defaultSleep;
  const now = overrides.now;
  const logger = overrides.logger;

  return {
    arxivFetchText: overrides.arxivFetchText ?? createRealArxivFetchText(),
    fetchImpl,
    emailTransport: overrides.emailTransport ?? createUnavailableEmailTransport(),
    sleep,
    now,
    clock: overrides.clock,
    logger,
    githubCuratedMapPath: overrides.githubCuratedMapPath,
    llmProvider: overrides.llmProvider,
    llmProviderFactory:
      overrides.llmProviderFactory ??
      ((llmCfg, env) => buildLlmProviderFromConfig(llmCfg, env, { fetchImpl, sleep, now, logger })),
    encoder: overrides.encoder,
  };
}
