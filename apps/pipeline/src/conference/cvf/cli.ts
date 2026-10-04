#!/usr/bin/env node
/**
 * Real-network entry point for `runCvfMain` — tests exercise `main.ts`
 * directly with injected deps.
 */
import { CliUsageError } from "../shared/cliArgs.js";
import { fetchImplWithTimeout, fetchTextWithTimeout } from "../shared/networkTimeout.js";
import { runCvfMain } from "./main.js";

/** Defensive timeout for the arXiv oral-overlay fetch (M6): its own `ArxivFetchDeps`
 * interface carries no `timeoutMs` (the real `arxiv` PyPI client this stands in for
 * issues no timeout at all), so this is a fixed, documented tightening, not a parity
 * requirement. */
const ARXIV_FETCH_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const outputRoot = process.env.PAPERPILOT_OUTPUT_ROOT;
  if (!outputRoot) {
    console.error("PAPERPILOT_OUTPUT_ROOT must be set (no default — see writeOutputs doc).");
    process.exitCode = 2;
    return;
  }
  try {
    const exitCode = await runCvfMain(process.argv.slice(2), {
      outputRoot,
      // M6: `init.timeoutMs` (`fetchListing`/`fetchOne`'s 30s default)
      // must actually abort the request — plain `fetch(url, init)`
      // silently ignores it.
      cvf: { fetchImpl: fetchImplWithTimeout() },
      arxiv: { fetchText: fetchTextWithTimeout(ARXIV_FETCH_TIMEOUT_MS) },
    });
    process.exitCode = exitCode;
  } catch (e) {
    if (e instanceof CliUsageError) {
      console.error(e.message);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}

main();
