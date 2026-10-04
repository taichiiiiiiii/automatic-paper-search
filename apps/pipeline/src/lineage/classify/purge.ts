/**
 * One-shot purge of template-poisoned entries from the classifications
 * cache — TS port of `paperpilot/scripts/purge_template_classifications.py`.
 *
 * The shared LLM classification cache accumulates `{pair: {relation,
 * confidence, rationale}}` across every theme build. Before the #131
 * template-echo reject existed, an LLM call that mirrored back a heuristic
 * template phrasing was cached as a successful classification — this
 * deletes every cached entry whose rationale is in the template reject
 * set, leaving non-template entries untouched.
 *
 * Note (run-when-no-build, mirrors the Python docstring): the lock only
 * serializes the read-merge-write OPERATIONS; it cannot retroactively purge
 * data a long-running `build_lineage`/`build_theme_lineage` process already
 * holds in memory — that process's next `persistClassifications` call would
 * write the purged entries right back. Run this purge when no lineage build
 * is running.
 */

import { existsSync, readFileSync } from "node:fs";
import { pyJsonDumps } from "@paperpilot/core/pycompat";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { TEMPLATE_RATIONALES } from "../llm/base.js";
import { withClassificationLock } from "./lock.js";

const TEMPLATE_RATIONALES_SET: ReadonlySet<string> = new Set(Object.values(TEMPLATE_RATIONALES));

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Return `{kept, dropped}`. Drops any entry whose `rationale` is
 * byte-for-byte one of the heuristic templates. Non-object or
 * rationale-less entries are kept verbatim.
 */
export function purgeTemplateEntries(cache: Record<string, unknown>): {
  kept: Record<string, unknown>;
  dropped: number;
} {
  const kept: Record<string, unknown> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(cache)) {
    if (!isPlainObject(value)) {
      kept[key] = value;
      continue;
    }
    const rationale = value.rationale;
    if (typeof rationale === "string" && TEMPLATE_RATIONALES_SET.has(rationale.trim())) {
      dropped += 1;
      continue;
    }
    kept[key] = value;
  }
  return { kept, dropped };
}

export interface PurgeCliOptions {
  cachePath: string;
  dryRun?: boolean;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

/** TS port of `purge_template_classifications.main()`. Returns the exit code. */
export async function purgeTemplateClassificationsMain(options: PurgeCliOptions): Promise<number> {
  const log = options.log ?? (() => {});
  const errorLog = options.errorLog ?? (() => {});

  if (!existsSync(options.cachePath)) {
    log(`cache file not found at ${options.cachePath} — nothing to purge.`);
    return 0;
  }

  return withClassificationLock(options.cachePath, () =>
    purgeLocked(options.cachePath, { dryRun: options.dryRun ?? false, log, errorLog }),
  );
}

/** Read-purge-write the cache while the caller holds its lock. Re-reads fresh rather than trusting any earlier read. */
function purgeLocked(
  cachePath: string,
  options: { dryRun: boolean; log: (line: string) => void; errorLog: (line: string) => void },
): number {
  let cache: unknown;
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf-8"));
  } catch (e) {
    options.errorLog(`ERROR reading ${cachePath}: ${(e as Error).message}`);
    return 1;
  }
  if (!isPlainObject(cache)) {
    options.errorLog(`ERROR: cache root is ${typeof cache}, expected dict`);
    return 1;
  }

  const { kept, dropped } = purgeTemplateEntries(cache);
  options.log(`cache entries  total: ${Object.keys(cache).length}`);
  options.log(`               kept : ${Object.keys(kept).length}`);
  options.log(`               drop : ${dropped}  (template-poisoned)`);

  if (options.dryRun) {
    options.log("--dry-run: file not modified.");
    return 0;
  }
  if (dropped === 0) {
    options.log("already clean — no write needed.");
    return 0;
  }

  // Pretty-print with stable key order so the diff in git is meaningful.
  atomicWriteText(
    cachePath,
    `${pyJsonDumps(kept, { ensureAscii: false, indent: 2, sortKeys: true })}\n`,
  );
  options.log(`wrote purged cache to ${cachePath}`);
  return 0;
}
