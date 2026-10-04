/**
 * Shared classification cache — TS port of
 * `paperpilot/scripts/_lineage_classify.py`'s cache machinery
 * (`_CachedClassifyProvider`, `_load_classification_cache`,
 * `_wrap_provider_with_cache`, `_default_persist_classifications`) plus
 * `build_lineage.py::persist_classifications` (the merge-under-lock writer
 * every production caller injects).
 *
 * `classifications.json` is shared by build_lineage / build_deep_lineage /
 * build_theme_lineage (CLAUDE.md §14), key `f"{a.paperId}->{b.paperId}"`.
 */

import * as fs from "node:fs";
import { dirname } from "node:path";
import { pyJsonDumps } from "@paperpilot/core/pycompat";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../collect/llm/provider.js";
import type { Paper } from "../../collect/model/paper.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { providerModelTag, relationClassificationFromDict } from "../llm/base.js";
import { withClassificationLock } from "./lock.js";

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export type ClassificationCache = Record<string, unknown>;

/**
 * Fallback persistence used when {@link CachedClassifyProvider} is
 * constructed without an explicit `persistFn`. Simple atomic-write
 * equivalent (no merge, no lock) — matches
 * `_lineage_classify._default_persist_classifications`. Production callers
 * inject {@link persistClassifications} instead, which merges concurrent
 * writers' entries (CLAUDE.md §14).
 */
export function defaultPersistClassifications(
  classifications: ClassificationCache,
  cachePath: string,
): void {
  atomicWriteText(cachePath, pyJsonDumps(classifications, { ensureAscii: false, indent: 2 }));
}

/**
 * TS port of `build_lineage.py::persist_classifications`. Merges any
 * concurrent writer's entries into our in-memory snapshot (our entries win
 * on key collision — they're the freshest just computed), then atomically
 * overwrites the cache file, the whole read-merge-write done under the
 * exclusive lock so no writer's contribution is ever lost (closes #402).
 *
 * MUTATES `classifications` in place (adds any disk-only keys via
 * `setdefault` semantics) — `_CachedClassifyProvider` relies on this so its
 * in-memory cache accumulates disk-only entries across calls within one run,
 * exactly like the Python original.
 */
export async function persistClassifications(
  classifications: ClassificationCache,
  cachePath: string,
): Promise<void> {
  fs.mkdirSync(dirname(cachePath), { recursive: true });
  await withClassificationLock(cachePath, () => {
    if (fs.existsSync(cachePath)) {
      let diskObj: unknown = null;
      try {
        diskObj = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      } catch {
        diskObj = null;
      }
      if (isPlainObject(diskObj)) {
        for (const [k, v] of Object.entries(diskObj)) {
          if (!(k in classifications)) classifications[k] = v; // setdefault
        }
      }
    }
    atomicWriteText(cachePath, pyJsonDumps(classifications, { ensureAscii: false, indent: 2 }));
  });
}

/**
 * Load the shared classifications cache from disk; return `{}` on missing
 * or malformed file. TS port of `_load_classification_cache`.
 */
export function loadClassificationCache(cachePath: string): ClassificationCache {
  if (!fs.existsSync(cachePath)) return {};
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  } catch {
    return {};
  }
  return isPlainObject(data) ? data : {};
}

export interface CachedClassifyProviderOptions {
  cachePath: string | null;
  persistFn?: (classifications: ClassificationCache, cachePath: string) => void | Promise<void>;
  logger?: { warn: (msg: string) => void };
}

/**
 * Decorate an LLM provider so `classifyRelation()` hits a shared
 * persistent cache keyed by `f"{a.paperId}->{b.paperId}"` first. TS port of
 * `_lineage_classify._CachedClassifyProvider`.
 *
 * Behaviour matches `build_lineage.py`'s `_classify_cached`:
 *   - Hit: deserialize through `relationClassificationFromDict` (which also
 *     rejects #131 template echoes — those fall back to the heuristic via
 *     the caller's merge step).
 *   - Miss with a successful inner call: store + persist atomically.
 *   - Miss with the inner call returning `null`: do NOT poison the cache —
 *     the next attempt retries the LLM.
 *   - Missing paperIds on either side: skip the cache entirely.
 *
 * ADAPTATION (documented): Python's class never overrides `complete_json`,
 * so calling it on the wrapper always raises `NotImplementedError` even when
 * the wrapped inner provider supports it — an apparent oversight (no
 * production call site exercises `complete_json` through this wrapper, and
 * no test pins the throw). This port delegates both `chat()` (which has no
 * Python analogue on `AbstractLLMProvider` at all — a TS-interface-only
 * requirement) and `completeJson()` straight to the inner provider, which is
 * strictly more useful and is called out here rather than silently chosen.
 */
export class CachedClassifyProvider implements LLMProvider {
  readonly name: string;
  enabled: boolean;
  batchSize: number;
  readonly model?: string;
  private readonly inner: LLMProvider;
  private readonly cache: ClassificationCache;
  private readonly cachePath: string | null;
  private readonly persistFn: (
    classifications: ClassificationCache,
    cachePath: string,
  ) => void | Promise<void>;
  private readonly logger?: { warn: (msg: string) => void };

  constructor(
    inner: LLMProvider,
    cache: ClassificationCache,
    options: CachedClassifyProviderOptions,
  ) {
    this.name = `${inner.name}+cache`;
    this.enabled = Boolean(inner.enabled);
    this.batchSize = inner.batchSize;
    this.model = inner.model;
    this.inner = inner;
    this.cache = cache;
    this.cachePath = options.cachePath;
    this.persistFn = options.persistFn ?? defaultPersistClassifications;
    this.logger = options.logger;
  }

  async evaluateBatch(
    papers: readonly Paper[],
    profile: string,
  ): Promise<(PaperEvaluation | null)[]> {
    return this.inner.evaluateBatch(papers, profile);
  }

  async chat(system: string, user: string): Promise<string | null> {
    return this.inner.chat(system, user);
  }

  async completeJson(system: string, user: string): Promise<string | null> {
    return this.inner.completeJson(system, user);
  }

  async classifyRelation(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    const aId = isPlainObject(a) ? a.paperId : undefined;
    const bId = isPlainObject(b) ? b.paperId : undefined;
    if (!(typeof aId === "string" && aId && typeof bId === "string" && bId)) {
      // Defensive: defer to inner provider but do NOT cache.
      return this.inner.classifyRelation(a, b);
    }
    const key = `${aId}->${bId}`;
    const cached = this.cache[key];
    // Python's `dict.get(key)` returns `None` for BOTH a missing key and a
    // key explicitly stored as `null` — there is no third state. A plain
    // `cached !== undefined` check would treat an explicit `null` entry as
    // a "hit" (JS distinguishes absent-key `undefined` from stored-`null`,
    // Python does not), permanently caching a failed classification without
    // ever retrying the inner provider — exactly the poisoning LIN-41
    // exists to prevent.
    if (cached !== undefined && cached !== null) {
      return relationClassificationFromDict(cached);
    }
    const rc = await this.inner.classifyRelation(a, b);
    if (rc !== null) {
      this.cache[key] = {
        relation: rc.relation,
        confidence: rc.confidence,
        rationale: rc.rationale,
        // #310: record the producing LLM (the INNER provider, not the
        // +cache wrapper) so a mixed-provider cache stays auditable.
        model: providerModelTag(this.inner),
      };
      // Persist only when the parent directory exists. Tests that don't
      // care about on-disk state point the path at a nonexistent dir —
      // silently skipping persist keeps the in-memory cache intact.
      if (this.cachePath !== null && fs.existsSync(dirname(this.cachePath))) {
        try {
          await this.persistFn(this.cache, this.cachePath);
        } catch (e) {
          this.logger?.warn(
            `classifications cache persist failed (${(e as Error).message}) — in-memory state still consistent`,
          );
        }
      }
    }
    return rc;
  }
}

/**
 * Wrap `inner` with the shared classification cache so rebuilds reuse
 * classified (parent, child) pairs at zero LLM cost. Returns
 * `{ provider, cache }` so the caller can log the entry count. TS port of
 * `_wrap_provider_with_cache`.
 */
export function wrapProviderWithCache(
  inner: LLMProvider,
  options: {
    cachePath: string;
    persistFn: (classifications: ClassificationCache, cachePath: string) => void | Promise<void>;
    logger?: { warn: (msg: string) => void };
  },
): { provider: CachedClassifyProvider; cache: ClassificationCache } {
  const cache = loadClassificationCache(options.cachePath);
  return {
    provider: new CachedClassifyProvider(inner, cache, {
      cachePath: options.cachePath,
      persistFn: options.persistFn,
      logger: options.logger,
    }),
    cache,
  };
}
