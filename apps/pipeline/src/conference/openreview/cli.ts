#!/usr/bin/env node
/**
 * Real-network entry point for `runOpenreviewMain` — the only file in this
 * module that is allowed to touch the real network / wall clock (tests
 * exercise `main.ts` directly with injected deps).
 */
import { CliUsageError } from "../shared/cliArgs.js";
import { runOpenreviewMain } from "./main.js";

async function main(): Promise<void> {
  const outputRoot = process.env.PAPERPILOT_OUTPUT_ROOT;
  if (!outputRoot) {
    console.error("PAPERPILOT_OUTPUT_ROOT must be set (no default — see writeOutputs doc).");
    process.exitCode = 2;
    return;
  }
  try {
    const exitCode = await runOpenreviewMain(process.argv.slice(2), {
      outputRoot,
      request: { fetchImpl: (url, init) => fetch(url, init) },
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
