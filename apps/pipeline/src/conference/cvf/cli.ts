#!/usr/bin/env node
/**
 * Real-network entry point for `runCvfMain` — tests exercise `main.ts`
 * directly with injected deps.
 */
import { CliUsageError } from "../shared/cliArgs.js";
import { runCvfMain } from "./main.js";

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
      cvf: { fetchImpl: (url, init) => fetch(url, init) },
      arxiv: { fetchText: (url) => fetch(url) },
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
