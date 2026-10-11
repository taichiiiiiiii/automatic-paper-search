#!/usr/bin/env node
/**
 * Real-network entry point for `runSiteMain` (tests exercise `main.ts` with
 * injected fetchers). Examples:
 *
 *   PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/site/cli.ts \
 *     --conference iclr-2025 --venue ICLR --kind proceedings --site iclr --year 2025
 *   PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx apps/pipeline/src/conference/site/cli.ts \
 *     --conference eccv-2026 --venue ECCV --kind ecva --year 2026
 */
import { isMain } from "../../shared/cli/isMain.js";
import { CliUsageError } from "../shared/cliArgs.js";
import { runSiteMain } from "./main.js";

// The NeurIPS Downloads export takes ~2 minutes to build server-side.
const FETCH_TIMEOUT_MS = 300_000;
export const USER_AGENT = "PaperPilot/1.0 (+https://paperpilot.pages.dev; catalog builder)";

async function main(): Promise<void> {
  const outputRoot = process.env.PAPERPILOT_OUTPUT_ROOT;
  if (!outputRoot) {
    console.error("PAPERPILOT_OUTPUT_ROOT must be set (no default — see writeOutputs doc).");
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await runSiteMain(process.argv.slice(2), {
      outputRoot,
      fetch: (url, init) =>
        fetch(url, {
          method: init?.method ?? "GET",
          headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
          body: init?.body,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
    });
  } catch (e) {
    if (e instanceof CliUsageError) {
      console.error(e.message);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) {
  main();
}
