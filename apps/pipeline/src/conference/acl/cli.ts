#!/usr/bin/env node
/**
 * Real-network entry point for `runCollectAclMain` — tests exercise
 * `anthology.ts` directly with injected deps. TS port adds what
 * `openreview/cli.ts` / `cvf/cli.ts` don't yet have (the "ACL has no CLI
 * entry point" LOW of the P4 review): a guarded `main()` so merely
 * IMPORTING this module (e.g. from a future test, or a barrel) never
 * fires a real network request as a side effect.
 *
 * The guard is a LOCAL `isMain()` for this file only — the shared
 * `isMain()` helper (M2 of the P4 review: the naive
 * `import.meta.url === file://${argv[1]}` string comparison other
 * lineage CLIs use fails on a symlinked/space-containing/non-ASCII
 * invocation path) is a separate, later task. This one compares
 * `realpathSync` of BOTH sides instead of building a `file://` URL
 * string, which sidesteps that whole class of bug directly: a symlinked
 * invocation path and this file's own (possibly also symlinked) path
 * both resolve to the same real filesystem path either way.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliUsageError } from "../shared/cliArgs.js";
import { fetchTextWithTimeout } from "../shared/networkTimeout.js";
import { runCollectAclMain } from "./anthology.js";

/** Defensive timeout for the arXiv oral-overlay fetch (M6): its own `ArxivFetchDeps`
 * interface carries no `timeoutMs` (the real `arxiv` PyPI client this stands in for
 * issues no timeout at all), so this is a fixed, documented tightening, not a parity
 * requirement. */
const ARXIV_FETCH_TIMEOUT_MS = 30_000;
/** Matches `fetch_xml`'s Python default (`timeout: float = 30.0`). */
const XML_FETCH_TIMEOUT_MS = 30_000;

/**
 * `true` exactly when this module was invoked as the process's entry
 * script — `process.argv[1]` and this file resolve (after following any
 * symlinks) to the same real path. `false` (never throws) when
 * `argv[1]` is missing or either side cannot be resolved (e.g. this file
 * was only imported, not run), so importing this module is always
 * side-effect-free.
 */
export function isMain(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const invokedFile = realpathSync(invoked);
    return thisFile === invokedFile;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const outputRoot = process.env.PAPERPILOT_OUTPUT_ROOT;
  if (!outputRoot) {
    console.error("PAPERPILOT_OUTPUT_ROOT must be set (no default — see writeOutputs doc).");
    process.exitCode = 2;
    return;
  }
  try {
    const exitCode = await runCollectAclMain(process.argv.slice(2), {
      outputRoot,
      fetchXmlText: fetchTextWithTimeout(XML_FETCH_TIMEOUT_MS),
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

if (isMain()) {
  main();
}
