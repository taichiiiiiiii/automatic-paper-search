/**
 * End-to-end proof that `collect/cli.ts` is actually wired for real runs
 * (#26/#29 of docs/migration/p4-followups.md): drives the REAL `main()`
 * entry point with the REAL `createRunnerDeps()` construction (real
 * header/timeout/provider-selection code), with ONLY `fetch`/
 * `arxivFetchText`/the clock swapped for test doubles via the documented
 * `createRunnerDeps` override seam — no real network call is ever made.
 *
 * Covers, through the real entry (not a parallel fake):
 *  - `.env` next to `--config` is loaded and its secrets reach the real
 *    fetch adapter as headers/query params (S2 `x-api-key`, OpenAlex
 *    `mailto`).
 *  - Per-source timeouts match the Python `request_with_retry` defaults
 *    S2/OpenAlex use (10s).
 *  - The #26 encoder decision: `embedding.enabled: true` records
 *    `stage3:…unavailable` and the run still exports.
 *  - The #26 SMTP decision: `output.email.enabled: true` (with SMTP
 *    configured via `.env`) records `export:email:SMTP not available in
 *    the TS runtime` and `--fail-on-errors` reports it; CSV still ships.
 *  - The #26 real LLM provider factory, exercised through the
 *    `expand-keywords` subcommand (the one CLI path that calls
 *    `provider.chat(...)` directly): an `ollama` provider reaches the
 *    fake `fetchImpl`'s `/api/chat` endpoint and the expansion is parsed
 *    and written back to config.yaml.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { type CliDeps, main } from "../../src/collect/cli.js";
import type { Config } from "../../src/collect/config/types.js";
import { createLogger } from "../../src/collect/logger.js";
import { PipelineRunner } from "../../src/collect/runner.js";
import { createRunnerDeps } from "../../src/collect/runtime/createRunnerDeps.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-e2e-"));
});

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

/** No real network: a fake `fetch` dispatched by hostname+path, recording
 * every call's URL/headers/timeout for assertions. */
function makeFakeFetch() {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number },
  ) => {
    calls.push({ url, headers: init.headers ?? {}, timeoutMs: init.timeoutMs });
    const u = new URL(url);
    if (u.hostname === "api.semanticscholar.org" && u.pathname === "/graph/v1/paper/search") {
      return {
        status: 200,
        json: async () => ({
          data: [
            {
              paperId: "p1",
              title: "Diffusion Models Survey",
              abstract: "A survey of diffusion models.",
              authors: [{ name: "A. Author", authorId: "a1" }],
              year: 2026,
              publicationDate: "2026-04-10",
              externalIds: {},
              openAccessPdf: {},
              venue: null,
              url: "https://www.semanticscholar.org/paper/p1",
            },
          ],
        }),
      };
    }
    if (u.hostname === "api.openalex.org" && u.pathname === "/works") {
      return { status: 200, json: async () => ({ results: [] }) };
    }
    if (u.hostname === "fake-ollama.test" && u.pathname === "/api/chat") {
      return {
        status: 200,
        json: async () => ({
          message: { content: JSON.stringify(["rag survey", "diffusion model"]) },
        }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

function writeConfigAndEnv(
  options: { emailEnabled?: boolean; embeddingEnabled?: boolean; llmYaml?: string } = {},
): string {
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    "search:\n" +
      '  keywords: ["diffusion model"]\n' +
      "  days_back: 7\n" +
      "sources:\n" +
      "  s2:\n" +
      "    enabled: true\n" +
      "    delay_seconds: 0\n" +
      "  openalex:\n" +
      "    enabled: true\n" +
      "    delay_seconds: 0\n" +
      "signals:\n" +
      "  venue:\n" +
      "    enabled: true\n" +
      "weights:\n" +
      "  venue: 3.0\n" +
      "  keyword: 0.5\n" +
      (options.embeddingEnabled ? "embedding:\n  enabled: true\n  backend: minilm\n" : "") +
      (options.llmYaml ?? "") +
      "output:\n" +
      `  csv:\n    enabled: true\n    dir: ${dir}\n` +
      "  json:\n    enabled: false\n" +
      (options.emailEnabled ? "  email:\n    enabled: true\n" : "") +
      "incremental:\n" +
      `  enabled: true\n  seen_ids_file: ${join(dir, "seen_ids.json")}\n` +
      "logging:\n  level: ERROR\n",
  );
  writeFileSync(
    join(dir, ".env"),
    "PAPERPILOT_S2_API_KEY=test-s2-key\n" +
      "PAPERPILOT_OPENALEX_EMAIL=test@example.com\n" +
      (options.emailEnabled
        ? "PAPERPILOT_SMTP_SERVER=smtp.example.com\nPAPERPILOT_EMAIL_TO=me@example.com\n"
        : ""),
  );
  return configPath;
}

function noopLogger() {
  return createLogger("cli-e2e-test", { level: "ERROR" });
}

it("real run: .env secrets reach the real fetch adapter (S2 x-api-key, OpenAlex mailto), correct per-source timeouts, embedding-unavailable Stage 3 decision, SMTP-unavailable Stage export decision", async () => {
  const configPath = writeConfigAndEnv({ embeddingEnabled: true, emailEnabled: true });

  const { fetchImpl, calls } = makeFakeFetch();
  const stdout: string[] = [];
  const deps: CliDeps = {
    createRunner: (config: Config) =>
      new PipelineRunner(
        config,
        createRunnerDeps({
          fetchImpl,
          arxivFetchText: async () => ({ status: 200, text: async () => "" }),
          clock: () => new Date(2026, 3, 10, 12, 0, 0),
          sleep: async () => {},
          logger: noopLogger(),
        }),
      ),
    logger: noopLogger(),
    stdout: (line) => stdout.push(line),
  };

  const rc = await main(["--config", configPath, "--fail-on-errors"], deps);

  // S2: x-api-key from .env, 10s timeout (request_with_retry's default,
  // matching Python's `request_with_retry(..., timeout=10.0)`).
  const s2Call = calls.find((c) => c.url.includes("api.semanticscholar.org"));
  expect(s2Call?.headers["x-api-key"]).toBe("test-s2-key");
  expect(s2Call?.timeoutMs).toBe(10_000);

  // OpenAlex: mailto query param from .env, 10s timeout.
  const openalexCall = calls.find((c) => c.url.includes("api.openalex.org"));
  expect(openalexCall?.url).toContain("mailto=test%40example.com");
  expect(openalexCall?.timeoutMs).toBe(10_000);

  // #26 decision: `embedding.enabled: true` with no real encoder wired is
  // NOT fatal — the run still completes and exports (Fail-Safe). The
  // resulting `stage3:…unavailable` entry itself is `result.errors`-only
  // (not surfaced on stdout, and excluded from `--fail-on-errors` by
  // design — collect LOW), already covered directly against
  // `PipelineRunner` in `runner.test.ts`'s "records a stage3: error…"
  // test; this only proves it doesn't break the CLI run end-to-end.
  const csvWritten = stdout.some((l) => l.includes(".csv"));
  expect(csvWritten).toBe(true);

  // #26 decision: output.email.enabled but SMTP is not implemented ->
  // export:email: recorded, and --fail-on-errors reports the degraded run
  // (export: is one of failureExitCode's checked prefixes).
  expect(rc).toBe(1);
}, 10_000);

it("real run: expand-keywords reaches a real LLM provider (ollama) through the real fetchImpl, no network", async () => {
  const configPath = writeConfigAndEnv({
    llmYaml: "llm:\n  enabled: true\n  provider: ollama\n  host: http://fake-ollama.test\n",
  });
  const { fetchImpl } = makeFakeFetch();
  const stdout: string[] = [];
  const deps: CliDeps = {
    createRunner: (config: Config) =>
      new PipelineRunner(
        config,
        createRunnerDeps({
          fetchImpl,
          arxivFetchText: async () => ({ status: 200, text: async () => "" }),
          sleep: async () => {},
          logger: noopLogger(),
        }),
      ),
    logger: noopLogger(),
    stdout: (line) => stdout.push(line),
  };

  const rc = await main(["--config", configPath, "expand-keywords", "--write"], deps);

  expect(rc).toBe(0);
  expect(stdout.some((l) => l.includes("expanded"))).toBe(true);
  expect(stdout.some((l) => l.includes("rag survey"))).toBe(true);

  const written = parseYaml(readFileSync(configPath, "utf-8")) as {
    search: { keywords: string[] };
  };
  expect(written.search.keywords).toContain("rag survey");
  expect(written.search.keywords).toContain("diffusion model");
}, 10_000);
