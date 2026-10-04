/**
 * Prune orphaned entries from the shared classification cache — TS port of
 * `paperpilot/scripts/compact_classifications.py`.
 *
 * `classifications.json` grows monotonically; without compaction it
 * collects entries for papers that have since been dropped from every
 * viewer artefact. This removes entries where either paperId isn't present
 * in any current `docs/**\/lineage.json` or `docs/**\/deep-*.json`.
 *
 * Run (host entry point not wired here — see the test suite for direct
 * calls): the Python CLI is `uv run python -m paperpilot.scripts.compact_classifications`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pyJsonDumps } from "@paperpilot/core/pycompat";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { toJsonSafeClassifications, tolerantJsonParse } from "./cache.js";
import { withClassificationLock } from "./lock.js";

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Read endpoints from an opaque v2 value or a legacy `src->dst` key. The
 * two v2 producers do not agree on where the endpoints live:
 * `build_deep_lineage` stores `src`/`dst` at the top level, while
 * `build_theme_lineage` stores them only inside `cache_identity`. Both
 * shapes are accepted here.
 */
export function cacheEndpoints(key: string, value: unknown): [string, string] | null {
  if (key.startsWith("v2:")) {
    if (!isPlainObject(value)) return null;
    let src = value.src;
    let dst = value.dst;
    if (!(typeof src === "string" && typeof dst === "string")) {
      const identity = value.cache_identity;
      if (isPlainObject(identity)) {
        src = identity.src;
        dst = identity.dst;
      }
    }
    return typeof src === "string" && typeof dst === "string" ? [src, dst] : null;
  }
  const sepIndex = key.indexOf("->");
  if (sepIndex < 0) return null;
  const src = key.slice(0, sepIndex);
  const dst = key.slice(sepIndex + 2);
  return src && dst ? [src, dst] : null;
}
export { cacheEndpoints as _cache_endpoints };

/**
 * Walk every shipped `lineage.json` + `deep-*.json` under `docsDir` and
 * collect every `node.id` string — the union of "papers the viewer might
 * currently render". Returns `{ live, unreadable }`: an artifact that will
 * not parse contributes no ids, which would make every classification only
 * it references look orphaned, so the caller refuses to compact when
 * `unreadable` is non-empty rather than deleting on the strength of an
 * incomplete survey.
 */
export function collectLivePaperIds(docsDir: string): { live: Set<string>; unreadable: string[] } {
  const live = new Set<string>();
  const unreadable: string[] = [];

  function absorb(path: string): void {
    let data: unknown;
    try {
      data = tolerantJsonParse(readFileSync(path, "utf-8"));
    } catch {
      unreadable.push(path);
      return;
    }
    if (!isPlainObject(data)) {
      unreadable.push(path);
      return;
    }
    const nodes = data.nodes;
    // An ABSENT `nodes` key is not an empty graph — our builders always
    // write it, so a file without one is not an artifact this survey can
    // read. `nodes: []` is different: that artifact states it has no
    // papers.
    if (!Array.isArray(nodes)) {
      unreadable.push(path);
      return;
    }
    const firstBad = nodes.find((n) => !(isPlainObject(n) && typeof n.id === "string" && n.id));
    if (firstBad !== undefined) {
      unreadable.push(path);
      return;
    }
    for (const n of nodes) live.add((n as Record<string, unknown>).id as string);
  }

  function walk(
    dir: string,
    matcher: (name: string) => boolean,
    skip?: (name: string) => boolean,
  ): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, matcher, skip);
      } else if (entry.isFile() && matcher(entry.name) && !(skip?.(entry.name) ?? false)) {
        absorb(full);
      }
    }
  }

  walk(docsDir, (name) => name === "lineage.json");
  walk(
    docsDir,
    (name) => name.startsWith("deep-") && name.endsWith(".json"),
    (name) => name === "deep-manifest.json",
  );
  return { live, unreadable };
}
export { collectLivePaperIds as _collect_live_paper_ids };

export interface CompactOptions {
  cachePath: string;
  docsDir: string;
  dryRun?: boolean;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  /**
   * Test seam matching Python's `monkeypatch.setattr(cc, "_collect_live_paper_ids", ...)`
   * — lets a test inject a concurrent on-disk write between the initial
   * cache snapshot and the lock-protected final read, exactly reproducing
   * the race `test_compact_carries_over_entries_written_during_the_survey`
   * exercises. Defaults to the real {@link collectLivePaperIds}.
   */
  collectLivePaperIdsFn?: (docsDir: string) => { live: Set<string>; unreadable: string[] };
}

/**
 * TS port of `compact_classifications.compact`. Returns the process exit
 * code (0 success, 1 refused/error).
 */
export async function compact(options: CompactOptions): Promise<number> {
  const log = options.log ?? (() => {});
  const errorLog = options.errorLog ?? (() => {});
  const collectFn = options.collectLivePaperIdsFn ?? collectLivePaperIds;

  let cache: unknown;
  try {
    cache = tolerantJsonParse(readFileSync(options.cachePath, "utf-8"));
  } catch (e) {
    errorLog(`cache unreadable: ${(e as Error).message}`);
    return 1;
  }
  if (!isPlainObject(cache)) {
    errorLog("cache root is not a dict — refusing to touch");
    return 1;
  }

  // The docs survey runs OUTSIDE the lock: it is the slow part, and holding
  // the classification lock across it would stall every concurrent lineage
  // build. The write below re-reads under the lock.
  const { live, unreadable } = collectFn(options.docsDir);
  if (unreadable.length > 0) {
    errorLog(
      `refusing to compact: ${unreadable.length} lineage artifact(s) could not be read, so the ` +
        "live-id survey is incomplete and every classification they alone reference would look " +
        `orphaned:\n  ${unreadable.join("\n  ")}`,
    );
    return 1;
  }
  const before = Object.keys(cache).length;
  if (before === 0) {
    log("cache is empty, nothing to compact.");
    return 0;
  }

  const kept: Record<string, unknown> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(cache)) {
    const endpoints = cacheEndpoints(key, value);
    if (endpoints !== null && live.has(endpoints[0]) && live.has(endpoints[1])) {
      kept[key] = value;
    } else {
      dropped += 1;
    }
  }

  const pct = (dropped / before) * 100;
  log(
    `live paperIds: ${live.size}\n` +
      `cache entries: ${before}\n` +
      `  kept:        ${Object.keys(kept).length}\n` +
      `  dropped:     ${dropped} (${pct.toFixed(0)}%)`,
  );

  if (options.dryRun) {
    log("\n(dry-run; no file written)");
    return 0;
  }

  // Take the same lock `persistClassifications` uses, and re-read inside
  // it. An atomic rename stops a torn read but not a lost update: without
  // this, a classification written after our snapshot was taken would be
  // erased by our replace.
  let added = 0;
  const result = await withClassificationLock(options.cachePath, (): number | null => {
    let current: unknown;
    try {
      current = tolerantJsonParse(readFileSync(options.cachePath, "utf-8"));
    } catch (e) {
      errorLog(`cache became unreadable under lock: ${(e as Error).message}`);
      return 1;
    }
    if (!isPlainObject(current)) {
      errorLog("cache root is not a dict — refusing to touch");
      return 1;
    }
    // Only drop keys we actually surveyed. A key that appeared after the
    // survey is evidence-free, so it is carried over untouched rather than
    // judged orphaned.
    const final: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(current)) {
      if (!(k in cache) || k in kept) final[k] = v;
    }
    added = Object.keys(final).length - Object.keys(kept).length;
    // `confidence` is a Python float; wrap it so an exactly-1.0/0.0
    // cached value re-serializes as "1.0"/"0.0", not "1"/"0"
    // (p4-followups #24) — see cache.ts's toJsonSafeClassifications doc
    // comment for why this is re-asserted by field, not value-detected.
    atomicWriteText(
      options.cachePath,
      pyJsonDumps(toJsonSafeClassifications(final), {
        ensureAscii: false,
        indent: 2,
        sortKeys: true,
      }),
    );
    return null;
  });
  if (result !== null) return result;

  if (added) log(`carried over ${added} entry/entries written during the survey`);
  const newSize = statSync(options.cachePath).size;
  log(`wrote ${options.cachePath} (${Math.floor(newSize / 1024)} KB)`);
  return 0;
}
