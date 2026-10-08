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
import { pyFloat, pyJsonDumps } from "@paperpilot/core/pycompat";
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

/**
 * Shallow, non-mutating JSON-safe view of `classifications` for
 * `pyJsonDumps`: `confidence` is a Python `float` in the source
 * (`RelationClassification.confidence`), so an exactly-1.0/0.0 value must
 * serialize as `1.0`/`0.0`, not `1`/`0` (p4-followups.md #24). Wrapped
 * only here, right before serialization — NOT at the point each cache
 * entry is built (`CachedClassifyProvider.classifyRelation`, above) —
 * because `PyFloat` has no `valueOf`/numeric coercion, and the SAME
 * in-memory `classifications` object is read back for cache hits
 * (`relationClassificationFromDict(cached)`) and mutated by this module's
 * own disk-merge (`setdefault`) within the same process; only the bytes
 * actually written to disk need the float marker.
 */
export function toJsonSafeClassifications(
  classifications: ClassificationCache,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(classifications)) {
    if (isPlainObject(value) && typeof value.confidence === "number") {
      out[key] = { ...value, confidence: pyFloat(value.confidence) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type ClassificationCache = Record<string, unknown>;

// ---------------------------------------------------------------------------
// H1: a NaN/Infinity-tolerant JSON reader.
//
// `pyJsonDumps` (packages/core) writes bare `NaN`/`Infinity`/`-Infinity`
// tokens for non-finite numbers — exactly like Python's `json.dump`
// (`allow_nan=True`, the default, used by every writer in this cache's
// history, Python and TS alike). Python's `json.loads` accepts those bare
// tokens back in (mapping them to `float("nan")`/`inf`/`-inf`); `JSON.parse`
// does not — it throws a `SyntaxError`. Before this clamp existed (see
// `relationClassificationFromDict` in `llm/base.ts`), a confidence of
// `float("nan")` could reach the cache; reading such a file back with plain
// `JSON.parse` would always throw, and a broad catch there would read the
// whole file as "empty", silently losing every entry in it the next time
// something persists (`persistClassifications`' setdefault-merge can only
// carry over keys it could parse off disk).
// U+E000-range markers (Unicode Private Use Area) rather than NUL-delimited
// text: a raw control character (e.g. U+0000) inside a JSON string literal
// is itself invalid JSON ("Bad control character in string literal"),
// which made the very substitution meant to make the text parseable
// produce a STILL-unparseable string.
const NON_FINITE_SENTINEL = {
  nan: "PYISH_NAN",
  posInf: "PYISH_POS_INF",
  negInf: "PYISH_NEG_INF",
} as const;

/** Replace bare `NaN`/`Infinity`/`-Infinity` tokens with quoted sentinel
 * strings, but ONLY outside string literals (a rationale could legitimately
 * contain the substring "NaN"). Returns `null` if no such token was found
 * (so the caller knows the original `SyntaxError` was for an unrelated
 * reason and shouldn't be retried). */
function quoteNonFiniteTokensOutsideStrings(text: string): string | null {
  let out = "";
  let inString = false;
  let touched = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    const rest = text.slice(i, i + 9); // longest token is "-Infinity" (9 chars)
    const m = /^-?Infinity|^NaN/.exec(rest);
    if (m) {
      const token = m[0];
      const sentinel =
        token === "NaN"
          ? NON_FINITE_SENTINEL.nan
          : token.startsWith("-")
            ? NON_FINITE_SENTINEL.negInf
            : NON_FINITE_SENTINEL.posInf;
      out += `"${sentinel}"`;
      i += token.length;
      touched = true;
      continue;
    }
    out += ch;
    i++;
  }
  return touched ? out : null;
}

function reviveNonFiniteSentinels(v: unknown): unknown {
  if (v === NON_FINITE_SENTINEL.nan) return Number.NaN;
  if (v === NON_FINITE_SENTINEL.posInf) return Number.POSITIVE_INFINITY;
  if (v === NON_FINITE_SENTINEL.negInf) return Number.NEGATIVE_INFINITY;
  if (Array.isArray(v)) return v.map(reviveNonFiniteSentinels);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = reviveNonFiniteSentinels(val);
    return out;
  }
  return v;
}

/**
 * `JSON.parse`, but tolerant of bare `NaN`/`Infinity`/`-Infinity` tokens
 * the way Python's `json.loads` is. Throws the ORIGINAL `SyntaxError` when
 * the text isn't JSON for some other reason (including when the
 * NaN/Infinity-tolerant retry ALSO fails to parse — a genuinely malformed
 * file is still a parse error either way, not silently swallowed here).
 */
export function tolerantJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    const sanitized = quoteNonFiniteTokensOutsideStrings(text);
    if (sanitized === null) throw e;
    let parsed: unknown;
    try {
      parsed = JSON.parse(sanitized);
    } catch {
      throw e; // still broken for some other reason — report the ORIGINAL error
    }
    return reviveNonFiniteSentinels(parsed);
  }
}

function isFsErrnoError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
}

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
  atomicWriteText(
    cachePath,
    pyJsonDumps(toJsonSafeClassifications(classifications), { ensureAscii: false, indent: 2 }),
  );
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
      const raw = fs.readFileSync(cachePath, "utf-8");
      let diskObj: unknown = null;
      try {
        diskObj = tolerantJsonParse(raw);
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        // H1 (#review): Python's `persist_classifications` treats ANY
        // unparseable disk file as `None` (empty) and proceeds to
        // overwrite it with just the in-memory snapshot — which is safe
        // in Python because `json.loads` tolerates the bare
        // NaN/Infinity/-Infinity tokens `json.dump` itself writes, so in
        // practice "unparseable" there only ever meant "truly corrupt
        // (truncated, etc.)". `tolerantJsonParse` above already closes
        // that same gap for this port. An EMPTY (never-written / fully
        // truncated-to-nothing) file is still safe to treat as `{}` — a
        // file this port would otherwise discard. Anything else that
        // remains unparseable IS existing data we cannot safely merge;
        // silently overwriting it with only our in-memory keys would
        // erase every other entry, so this port refuses instead
        // (intentional divergence from Python, not a parity gap).
        if (raw.trim() !== "") {
          throw new Error(
            `refusing to overwrite unparseable, non-empty classification cache at ${cachePath}: ${(e as Error).message}`,
          );
        }
        diskObj = null;
      }
      if (isPlainObject(diskObj)) {
        for (const [k, v] of Object.entries(diskObj)) {
          if (!(k in classifications)) classifications[k] = v; // setdefault
        }
      }
    }
    atomicWriteText(
      cachePath,
      pyJsonDumps(toJsonSafeClassifications(classifications), { ensureAscii: false, indent: 2 }),
    );
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
    data = tolerantJsonParse(fs.readFileSync(cachePath, "utf-8"));
  } catch (e) {
    // Mirrors Python's `except (json.JSONDecodeError, OSError)`: malformed
    // JSON or an I/O error reading the file starts the cache empty rather
    // than crashing the build. Anything else (a genuine bug) propagates —
    // a bare `catch {}` previously swallowed everything indiscriminately.
    if (e instanceof SyntaxError || isFsErrnoError(e)) return {};
    throw e;
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
          // TS port of `except OSError` (Python's `_CachedClassifyProvider`
          // only ever sees disk I/O failures here — `fcntl.flock` has no
          // timeout). This port's lock DOES have one (`lock.ts`'s
          // LOCK_ACQUIRE_TIMEOUT_MS, a TS-only addition with no Python
          // analogue): a timeout means another writer has been holding the
          // lock for 30s+, a real concurrency problem, not a benign I/O
          // hiccup — swallowing it here (review LOW) would hide that the
          // in-memory cache accumulated an entry nothing downstream will
          // ever see persisted. Only fs-style errno errors are swallowed;
          // anything else (including a lock timeout `Error`, which has no
          // `.code`) propagates.
          if (!isFsErrnoError(e)) throw e;
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
