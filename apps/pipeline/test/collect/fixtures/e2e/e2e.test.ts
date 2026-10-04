/**
 * End-to-end parity (docs/design/39-typescript-cloudflare-migration.md
 * §7.2): the TS `PipelineRunner` output must match the REAL Python
 * `PipelineRunner`'s for the identical canned arXiv feed, under a fixed
 * clock.
 *
 * The Python side is NOT re-run here (same convention as
 * `fixtures/parity/dump_python_papers.py`): `expected/happy/` was
 * generated once via
 *
 *   uv run --extra dev python apps/pipeline/test/collect/fixtures/e2e/run_python.py happy apps/pipeline/test/collect/fixtures/e2e/expected/happy
 *
 * and is committed. To regenerate after a behavior change, re-run that
 * script (and the `corrupt-seen-ids` / `all-sources-failed` scenarios
 * below) and review the diff — see `run_python.py`'s own doc comment.
 *
 * `rules.json` has NO ignore rules: `seen_ids.json`'s timestamp VALUES are
 * now compared exactly like everything else. This only works because the
 * clock is fixed to a whole-second instant (`ms === 0`) on both sides —
 * `state/seenIds.ts`'s `pyNaiveIsoformat` (the write path) then produces
 * the identical string Python's naive `datetime.now().isoformat()` does
 * (`"2026-04-10T12:00:00"`, no fractional part, no offset). A non-fixed
 * (real wall-clock) run would NOT compare byte-identical here — Node's
 * millisecond resolution can't reproduce Python's microsecond jitter —
 * but that is an inherent precision-limit difference with no behavioral
 * effect (seen_ids timestamps are metadata the purge comparison reads at
 * day granularity), not something this fixture needs to paper over.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { failureExitCode } from "../../../../src/collect/cli.js";
import type { Config } from "../../../../src/collect/config/types.js";
import { createLogger } from "../../../../src/collect/logger.js";
import { PipelineRunner, type RunnerDeps } from "../../../../src/collect/runner.js";
import { compareTrees } from "../../../../src/parity/compare-trees.js";
import { loadRules } from "../../../../src/parity/rules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_HAPPY = join(HERE, "expected", "happy");
const RULES_PATH = join(HERE, "rules.json");

// The SAME wall-clock instant `run_python.py`'s `FIXED_NOW`/`FIXED_TODAY`
// patch in (see that script's doc comment on why a whole-second instant and
// why only the instant, not the string rendering, needs to match).
const FIXED_CLOCK = new Date(2026, 3, 10, 12, 0, 0); // 2026-04-10T12:00:00 local

function buildConfig(outDir: string): Config {
  return {
    search: {
      keywords: ["diffusion model"],
      categories: ["cs.LG"],
      days_back: 7,
      max_results_per_keyword: 10,
      exclude_words: [],
    },
    sources: { arxiv: { enabled: true, delay_seconds: 0 } },
    signals: { venue: { enabled: true } },
    weights: { venue: 3.0, keyword: 0.5 },
    pipeline: { stage2_top_n: 10 },
    output: {
      csv: { enabled: true, dir: outDir, encoding: "utf-8-sig" },
      json: { enabled: true, dir: outDir },
    },
    incremental: {
      enabled: true,
      seen_ids_file: join(outDir, "seen_ids.json"),
      // Routed outside outDir — see run_python.py's doc comment (a `.jsonl`
      // file is compared byte-for-byte by the parity tool, and timestamps
      // render per-language even under a fixed clock).
      run_history_file: join(outDir, "..", "history", "run_history.jsonl"),
      max_age_days: 14,
    },
    env: {
      githubToken: null,
      s2ApiKey: null,
      openalexEmail: null,
      slackWebhookUrl: null,
      geminiApiKey: null,
      claudeApiKey: null,
      groqApiKey: null,
      groqModel: null,
      geminiModel: null,
      smtp: { server: null, port: 587, user: null, password: null, to: null, useTls: true },
    },
  };
}

function baseDeps(): Omit<RunnerDeps, "arxivFetchText"> {
  return {
    fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
    emailTransport: {
      connect: async () => ({
        starttls: async () => {},
        login: async () => {},
        sendMessage: async () => {},
        quit: async () => {},
      }),
    },
    clock: () => FIXED_CLOCK,
    logger: createLogger("e2e-ts", { level: "ERROR" }), // quiet; errors still surface via result.errors
  };
}

async function arxivFetchTextFor(
  atomPath: string,
): Promise<NonNullable<RunnerDeps["arxivFetchText"]>> {
  const body = readFileSync(atomPath, "utf-8");
  return async () => ({ status: 200, text: async () => body });
}

it("e2e happy path: TS PipelineRunner output matches the committed Python fixture", async () => {
  const actualDir = await mkdtemp(join(tmpdir(), "e2e-happy-ts-"));
  const config = buildConfig(actualDir);
  const deps: RunnerDeps = {
    ...baseDeps(),
    arxivFetchText: await arxivFetchTextFor(join(HERE, "arxiv_e2e.atom.xml")),
  };
  const runner = new PipelineRunner(config, deps);

  const result = await runner.run();
  const exitCode = failureExitCode(result, createLogger("e2e-ts", { level: "ERROR" }), () => {});

  const expectedManifest = JSON.parse(
    readFileSync(join(EXPECTED_HAPPY, "manifest.json"), "utf-8"),
  ) as {
    exitCode: number;
    outputCount: number;
    errors: string[];
  };
  expect(exitCode).toBe(expectedManifest.exitCode);
  expect(result.outputCount).toBe(expectedManifest.outputCount);
  expect(result.errors).toEqual(expectedManifest.errors);

  // Mirror Python's manifest.json into the actual tree so compareTrees sees
  // matching file sets (it is debris from the fixture generator, not part
  // of the pipeline's own output — see run_python.py's doc comment).
  await writeFile(
    join(actualDir, "manifest.json"),
    `${JSON.stringify({ exitCode, outputCount: result.outputCount, errors: result.errors }, null, 2)}\n`,
  );

  const rules = await loadRules(RULES_PATH);
  const report = await compareTrees({ expectedRoot: EXPECTED_HAPPY, actualRoot: actualDir, rules });
  if (!report.equal) {
    console.error(JSON.stringify(report, null, 2));
  }
  expect(report.missingFiles).toEqual([]);
  expect(report.extraFiles).toEqual([]);
  expect(report.fileResults.filter((f: { equal: boolean }) => !f.equal)).toEqual([]);
  expect(report.equal).toBe(true);

  // `compareTrees` above already diffed seen_ids.json's VALUES too (no
  // ignore rule — see module doc); this is a redundant, explicit
  // byte-identical check on the parsed maps for readability.
  const expectedSeen = JSON.parse(readFileSync(join(EXPECTED_HAPPY, "seen_ids.json"), "utf-8"));
  const actualSeen = JSON.parse(readFileSync(join(actualDir, "seen_ids.json"), "utf-8"));
  expect(actualSeen).toEqual(expectedSeen);
});

describe("e2e failure-path parity (adapted — see module doc)", () => {
  it("corrupt seen_ids.json: same exit code, CSV/JSON still written", async () => {
    const actualDir = await mkdtemp(join(tmpdir(), "e2e-corrupt-ts-"));
    await writeFile(
      join(actualDir, "seen_ids.json"),
      '{"arxiv:2604.00001": "2026-01-01T00:00:00",',
    );

    const config = buildConfig(actualDir);
    const deps: RunnerDeps = {
      ...baseDeps(),
      arxivFetchText: await arxivFetchTextFor(join(HERE, "arxiv_e2e.atom.xml")),
    };
    const runner = new PipelineRunner(config, deps);
    const result = await runner.run();
    const exitCode = failureExitCode(result, createLogger("e2e-ts", { level: "ERROR" }), () => {});

    const expectedManifest = JSON.parse(
      readFileSync(join(HERE, "expected", "corrupt_seen_ids", "manifest.json"), "utf-8"),
    ) as { exitCode: number; outputCount: number };
    expect(exitCode).toBe(expectedManifest.exitCode);
    expect(result.outputCount).toBe(expectedManifest.outputCount);
    expect(result.errors.some((e: string) => e.startsWith("state:seen_ids:"))).toBe(true);

    // "Unchanged-output behavior": the run still writes today's CSV/JSON
    // normally (the quarantine degrades the run, it does not corrupt or
    // skip today's export) — same contract OUT-01..06 already pin at the
    // exporter level, confirmed here through the full runner.
    const { readdirSync } = await import("node:fs");
    const names = readdirSync(actualDir);
    expect(names.some((n) => n.endsWith(".csv"))).toBe(true);
    expect(names.some((n) => n.endsWith(".json") && n !== "seen_ids.json")).toBe(true);
  });

  it("all sources failed: same exit code, no output files, pre-existing files untouched", async () => {
    const actualDir = await mkdtemp(join(tmpdir(), "e2e-allfailed-ts-"));
    const sentinelPath = join(actualDir, "papers_2020-01-01.csv");
    await writeFile(sentinelPath, "sentinel-from-a-previous-day\n");
    const sentinelBytesBefore = readFileSync(sentinelPath);

    const config = buildConfig(actualDir);
    const deps: RunnerDeps = {
      ...baseDeps(),
      arxivFetchText: async () => {
        throw new Error("arxiv client exploded");
      },
    };
    const runner = new PipelineRunner(config, deps);
    const result = await runner.run();
    const exitCode = failureExitCode(result, createLogger("e2e-ts", { level: "ERROR" }), () => {});

    const expectedManifest = JSON.parse(
      readFileSync(join(HERE, "expected", "all_sources_failed", "manifest.json"), "utf-8"),
    ) as { exitCode: number; outputCount: number };
    expect(exitCode).toBe(expectedManifest.exitCode);
    expect(result.outputCount).toBe(expectedManifest.outputCount);
    expect(result.sourcesStatus.arxiv?.ok).toBe(false);

    // Unchanged-output: a prior day's file must survive byte-for-byte.
    expect(readFileSync(sentinelPath)).toEqual(sentinelBytesBefore);
  });
});
