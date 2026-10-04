/**
 * Strict JSON parsing, bounded-value checking, canonicalization and
 * hashing -- ported 1:1 from docs/assets/lineage-v2-core.js. These are
 * the primitives every v2 validator builds on, so a divergence here
 * would silently loosen (or tighten) every contract downstream.
 *
 * `strictJsonParse` exists because `JSON.parse` alone loses
 * information this contract depends on: duplicate object keys,
 * control characters inside strings, and -- critically -- whether a
 * number token was written as an integer or a float lexeme (e.g.
 * `1` vs `1.0`). `canonicalJson`/`canonicalSha` re-serialize parsed
 * values to compute the hashes `review_binding.evidence_sha256` and
 * `candidate_universe` comparisons depend on; if re-serialization could
 * silently normalize `1.0` to `1`, a byte-for-byte hash computed here
 * could diverge from the one the (Python) producer computed, which
 * would make a genuinely valid release fail verification -- or worse,
 * let a tampered one slip through the rare float/int field allow-list.
 * `parseBytes` is the only entry point that combines all of the above;
 * callers must go through it, never `JSON.parse` directly, for any
 * lineage-v2 payload.
 */

export function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

export function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function unitNumber(value: unknown, nullable = true): value is number | null {
  return (
    (nullable && value === null) ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
  );
}

export function uniqueTextArray(value: unknown, nonempty = false): value is string[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) return false;
  return value.every((item) => text(item)) && new Set(value).size === value.length;
}

function invalidSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++index >= value.length) return true;
      const low = value.charCodeAt(index);
      if (low < 0xdc00 || low > 0xdfff) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const MAX_JSON_DEPTH_LOCAL = 64;
const MAX_JSON_VALUES_LOCAL = 100_000;
const MAX_STRING_BYTES_LOCAL = 1024 * 1024;

/** Walks a parsed value depth-first (iteratively, so it cannot stack
 * overflow on a deep/huge payload), rejecting anything with lone UTF-16
 * surrogates, oversized strings, unsafe integers, non-finite numbers,
 * or that exceeds the overall depth/value-count bounds -- a payload
 * that already round-tripped through `JSON.parse`/`structuredClone`
 * can still carry any of these. */
export function boundedJson(value: unknown): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  const seen = new Set<unknown>();
  let count = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const [item, depth] = frame;
    if (++count > MAX_JSON_VALUES_LOCAL || depth > MAX_JSON_DEPTH_LOCAL) return false;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "string") {
      if (
        invalidSurrogate(item) ||
        new TextEncoder().encode(item).byteLength > MAX_STRING_BYTES_LOCAL
      ) {
        return false;
      }
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        return false;
      }
      continue;
    }
    if (!record(item) && !Array.isArray(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) stack.push([child, depth + 1]);
    } else {
      for (const key of Object.keys(item as Record<string, unknown>)) {
        if (invalidSurrogate(key)) return false;
        stack.push([(item as Record<string, unknown>)[key], depth + 1]);
      }
    }
  }
  return true;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic, sorted-key JSON serialization used for hashing
 * (`canonicalSha`) and for the `candidate_universe` structural-equality
 * checks in release.ts. Must stay byte-identical to the JS producer's
 * canonicalization. */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}

export function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const item = stack.pop();
    if ((record(item) || Array.isArray(item)) && !seen.has(item)) {
      seen.add(item);
      for (const child of Object.values(item as object)) stack.push(child);
      Object.freeze(item);
    }
  }
  return value;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Accepts only a non-shared ArrayBuffer/Uint8Array, snapshotting it
 * into a fresh Uint8Array -- so a caller cannot mutate or transfer the
 * buffer out from under us after we have started hashing/parsing it
 * (see release.ts `verifyPilotRelease`'s "snapshot before the first
 * await" comment, and the "racedArtifact" test). */
export function asBytes(value: unknown): Uint8Array | null {
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    (value instanceof SharedArrayBuffer ||
      (value as { buffer?: unknown } | null | undefined)?.buffer instanceof SharedArrayBuffer)
  ) {
    return null;
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return null;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function canonicalSha(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(`${canonicalJson(value)}\n`));
}

interface NumericToken {
  path: Array<string | number>;
  value: number;
  integerLexeme: boolean;
}

const FLOAT_FIELDS = new Set([
  "raw_score",
  "calibrated_probability",
  "agreement",
  "wilson_lower_bound",
  "supersedes_wilson_lower_bound",
  "macro_precision",
  "ece",
  "brier",
  "accepted_coverage",
  "unknown_abstained_recall",
]);

/**
 * A hand-rolled JSON parser (used instead of `JSON.parse`) that:
 *  - rejects duplicate object keys and control characters in strings,
 *  - enforces the same depth/value-count bounds as `boundedJson` while
 *    parsing (so a hostile payload cannot even be fully materialized),
 *  - returns objects with a null prototype (`Object.create(null)`),
 *    matching the JS source so `record()` accepts them, and
 *  - tracks whether each numeric token was written with a float lexeme
 *    (`.` or exponent) even though its value is integral, and rejects
 *    it unless the field is one of a known float-typed allow-list (or
 *    inside an arbitrary `clusters` entry).
 * Throws `SyntaxError` on any malformed input; callers must treat a
 * throw as "parse failed", not as a wider contract violation.
 */
export function strictJsonParse(source: string): unknown {
  let offset = 0;
  let valueCount = 0;
  const numericTokens: NumericToken[] = [];

  function whitespace(): void {
    while (offset < source.length && /[\t\n\r ]/.test(source[offset] as string)) offset++;
  }

  function stringValue(): string {
    const start = offset++;
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset++] as string;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return JSON.parse(source.slice(start, offset));
      else if (character.charCodeAt(0) < 0x20) throw new SyntaxError("control in string");
    }
    throw new SyntaxError("unterminated string");
  }

  function parseValue(path: Array<string | number>, depth: number): unknown {
    if (++valueCount > MAX_JSON_VALUES_LOCAL || depth > MAX_JSON_DEPTH_LOCAL) {
      throw new SyntaxError("JSON bounds exceeded");
    }
    whitespace();
    const character = source[offset];
    if (character === '"') return stringValue();
    if (character === "[") {
      offset++;
      const value: unknown[] = [];
      whitespace();
      if (source[offset] === "]") {
        offset++;
        return value;
      }
      while (true) {
        value.push(parseValue([...path, value.length], depth + 1));
        whitespace();
        if (source[offset] === "]") {
          offset++;
          return value;
        }
        if (source[offset++] !== ",") throw new SyntaxError("array separator required");
      }
    }
    if (character === "{") {
      offset++;
      const value: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      whitespace();
      if (source[offset] === "}") {
        offset++;
        return value;
      }
      while (true) {
        whitespace();
        if (source[offset] !== '"') throw new SyntaxError("object key required");
        const key = stringValue();
        if (keys.has(key)) throw new SyntaxError("duplicate object key");
        keys.add(key);
        whitespace();
        if (source[offset++] !== ":") throw new SyntaxError("object colon required");
        value[key] = parseValue([...path, key], depth + 1);
        whitespace();
        if (source[offset] === "}") {
          offset++;
          return value;
        }
        if (source[offset++] !== ",") throw new SyntaxError("object separator required");
      }
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
    if (!number) throw new SyntaxError("JSON value required");
    offset += number[0].length;
    const value = Number(number[0]);
    numericTokens.push({
      path,
      value,
      integerLexeme: !/[.eE]/.test(number[0]),
    });
    return value;
  }

  const value = parseValue([], 0);
  whitespace();
  if (offset !== source.length) throw new SyntaxError("trailing JSON content");
  for (const token of numericTokens) {
    if (!token.integerLexeme && Number.isInteger(token.value)) {
      const field = token.path[token.path.length - 1];
      const arbitraryClusterValue = token.path[0] === "clusters";
      if (!FLOAT_FIELDS.has(String(field)) && !arbitraryClusterValue) {
        throw new SyntaxError("integer field used a floating-point token");
      }
    }
  }
  return value;
}

export interface ParsedBytes {
  bytes: Uint8Array;
  parsed: unknown;
}

/** Validates `value` is plain (non-shared) byte data within `maximum`,
 * decodes it as strict UTF-8, strict-parses it as JSON, and runs
 * `boundedJson` on the result. Returns `null` on any failure -- never
 * throws. */
export async function parseBytes(value: unknown, maximum: number): Promise<ParsedBytes | null> {
  const bytes = asBytes(value);
  if (bytes === null || bytes.byteLength > maximum) return null;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = strictJsonParse(decoded);
    return boundedJson(parsed) ? { bytes, parsed } : null;
  } catch {
    return null;
  }
}
