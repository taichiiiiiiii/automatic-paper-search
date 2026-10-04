/**
 * Small, local reproductions of Python runtime semantics that
 * `s2_source.py` / `openalex_source.py` rely on (truthiness, `dict.get`,
 * `str.strip()`, `int()`), so a malformed-item test case that "drops" in
 * Python (raises AttributeError/TypeError deep in field access) also
 * "drops" here, rather than silently producing a different, TS-idiomatic
 * result. See docs/design/39-typescript-cloudflare-migration.md §7.2 for why
 * this kind of language-difference shim belongs next to the port, not
 * inlined at every call site.
 *
 * This is deliberately NARROW: it covers only the operations the two
 * sources' `_to_paper`/`_search` actually perform, not a general Python
 * compatibility layer.
 */

/** Python truthiness: `None`/`undefined`, `""`, `0`, `NaN`, `false`, `[]`, `{}` are falsy. */
export function truthy(x: unknown): boolean {
  if (x === null || x === undefined || x === false) return false;
  if (typeof x === "string") return x.length > 0;
  if (typeof x === "number") return x !== 0 && !Number.isNaN(x);
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "object") return Object.keys(x as object).length > 0;
  return Boolean(x);
}

/** `x or fallback`, Python-semantics (falls through on any Python-falsy value). */
export function orElse<T>(x: T | null | undefined, fallback: T): T {
  return truthy(x) ? (x as T) : fallback;
}

/** `type(x).__name__` for the handful of JSON-shaped types we ever see. */
export function pyTypeName(x: unknown): string {
  if (x === null || x === undefined) return "NoneType";
  if (Array.isArray(x)) return "list";
  if (typeof x === "boolean") return "bool";
  if (typeof x === "number") return Number.isInteger(x) ? "int" : "float";
  if (typeof x === "string") return "str";
  if (typeof x === "object") return "dict";
  return typeof x;
}

/** Raised in place of Python's `AttributeError` for the specific attribute accesses this port needs. */
export class PyAttributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributeError";
  }
}

/**
 * Raised where the Python source raises a bare `RuntimeError(...)`. Named
 * to match — the ported safety-contract tests assert on the exact
 * `"RuntimeError: <message>"` text that ends up in `degradedKeywords`
 * (e.g. COL-10/11), since that string is itself part of the run record an
 * operator reads, not an implementation detail to paper over with a
 * TS-idiomatic error name.
 */
export class PyRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

/**
 * `dict.get(key)` — returns `undefined` (Python `None`) when the key is
 * absent, the stored value (even if falsy/null) when present, and raises
 * `PyAttributeError` when `obj` is not itself a plain-object "dict" (a list,
 * string, number, etc. has no `.get`), matching the `AttributeError` a
 * malformed upstream record triggers in the Python source.
 */
export function pyGet(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== "object" || Array.isArray(obj)) {
    throw new PyAttributeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return (obj as Record<string, unknown>)[key];
}

/**
 * `(x or "").strip()` — Python's idiom for "treat a missing/falsy field as
 * blank text". Raises `PyAttributeError` when `x` is truthy but not a
 * string (e.g. a stray integer in a title field), matching `.strip()` on a
 * non-string raising `AttributeError` in Python; that is what lets a single
 * malformed item get counted as `dropped` rather than silently coerced.
 */
export function pyStrip(x: unknown): string {
  if (!truthy(x)) return "";
  if (typeof x !== "string") {
    throw new PyAttributeError(`'${pyTypeName(x)}' object has no attribute 'strip'`);
  }
  return x.trim();
}

/**
 * `int(year)` guarded by the caller's `if year:` truthiness check and a
 * `try/except (TypeError, ValueError)`. Returns `null` exactly where Python
 * would fall into that except clause. Does not replicate Python's full
 * `int()` grammar (e.g. underscores in numeric literals) — only what the
 * sources' `_parse_pub_date` fixtures exercise.
 */
export function pyIntOrNull(x: unknown): number | null {
  if (typeof x === "number") {
    if (Number.isNaN(x) || !Number.isFinite(x)) return null;
    return Math.trunc(x);
  }
  if (typeof x === "boolean") return x ? 1 : 0; // bool is an int subclass in Python
  if (typeof x === "string") {
    const m = /^\s*[+-]?\d+\s*$/.exec(x);
    if (!m) return null;
    return Number.parseInt(x.trim(), 10);
  }
  return null; // list/dict/etc -> TypeError in Python
}

/**
 * `datetime.strptime(s, "%Y-%m-%d")` — accepts unpadded month/day
 * (`"2026-4-1"`), rejects an invalid calendar date (`"2026-02-30"`) or
 * anything not matching the pattern. Returns an ISO `YYYY-MM-DD` string
 * (zero-padded) on success, `null` on failure (mirrors the `except
 * ValueError: pass` fallthrough in both sources' `_parse_pub_date`).
 */
export function pyStrptimeYMD(s: string): string | null {
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** `date(year, 1, 1).isoformat()` for a year already resolved via `pyIntOrNull`. */
export function yearToIsoDate(year: number): string {
  return `${String(year).padStart(4, "0")}-01-01`;
}

/**
 * `date.today().isoformat()` (or any `datetime.isoformat()`'s date part) —
 * the LOCAL calendar date, not `Date.prototype.toISOString()`'s UTC date.
 * Python's `date.today()` always reads the local wall-clock date; using
 * `Date#toISOString().slice(0, 10)` instead (collect LOW: "today" UTC vs
 * local) shifts the computed date by a day near local midnight whenever
 * the local UTC offset makes the UTC and local calendar dates disagree.
 */
export function toLocalIsoDate(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO `YYYY-MM-DD` string comparison (lexicographic == chronological for zero-padded dates). */
export function isoDateLess(a: string, b: string): boolean {
  return a < b;
}

/** `f"{type(e).__name__}: {e}"` — the exact shape every degraded-keyword reason in the Python sources uses for a caught exception. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return `Error: ${String(e)}`;
}
