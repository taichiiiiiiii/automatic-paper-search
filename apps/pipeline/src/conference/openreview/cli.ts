#!/usr/bin/env node
/**
 * Real-network entry point for `runOpenreviewMain` — the only file in this
 * module that is allowed to touch the real network / wall clock (tests
 * exercise `main.ts` directly with injected deps). M2 of the P4 review:
 * this used to call `main()` unconditionally with no entry guard, so
 * merely importing it could fire a real network request as a side
 * effect.
 */
import { isMain } from "../../shared/cli/isMain.js";
import { CliUsageError } from "../shared/cliArgs.js";
import { fetchImplWithTimeout } from "../shared/networkTimeout.js";
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
      // M6: `init.timeoutMs` (`fetchNotes`'s 20s default) must actually
      // abort the request — plain `fetch(url, init)` silently ignores it.
      request: { fetchImpl: fetchImplWithTimeout() },
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

if (isMain(import.meta.url)) {
  main();
}
