#!/usr/bin/env node
/**
 * Real-network entry point for `runPmlrMain` (tests exercise `main.ts`
 * with injected fetchers). Usage:
 *
 *   PAPERPILOT_OUTPUT_ROOT=data/inputs pnpm exec tsx \
 *     apps/pipeline/src/conference/pmlr/cli.ts \
 *     --conference icml-2026 --venue ICML --volume 306
 */
import { isMain } from "../../shared/cli/isMain.js";
import { CliUsageError } from "../shared/cliArgs.js";
import { runPmlrMain } from "./main.js";

const FETCH_TIMEOUT_MS = 120_000;
export const USER_AGENT = "PaperPilot/1.0 (+https://paperpilot.pages.dev; catalog builder)";

async function main(): Promise<void> {
  const outputRoot = process.env.PAPERPILOT_OUTPUT_ROOT;
  if (!outputRoot) {
    console.error("PAPERPILOT_OUTPUT_ROOT must be set (no default — see writeOutputs doc).");
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await runPmlrMain(process.argv.slice(2), {
      outputRoot,
      fetchText: (url) =>
        fetch(url, {
          headers: { "User-Agent": USER_AGENT },
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
