/**
 * Bounded-read helper for small, security-sensitive JSON fetches (the
 * pilot-lineage index today). Ported from docs/assets/app.js
 * `readPilotLineageIndex` (SCR-20): the response must not have been
 * redirected, must resolve to the exact URL requested, must declare (if
 * at all) a Content-Length within the byte cap, and the body itself is
 * read under the same cap while streaming (a response that lies about
 * its length, or never closes, cannot exhaust memory or hang the page).
 * Malformed UTF-8 or non-JSON content fails closed (returns null) --
 * never thrown, so a caller's `.catch` only has to handle network
 * failures, not "the server answered with garbage".
 */

export interface BoundedReadOptions {
  maxBytes: number;
  /** The exact absolute URL the response must resolve to (after
   * following same-origin internals, before any redirect -- redirect is
   * rejected outright, see below). Omit to skip this check. */
  expectedUrl?: string;
}

/** The minimal reader shape this module actually uses -- not the DOM
 * lib's full `ReadableStreamDefaultReader` (which also requires
 * `releaseLock`/`closed`), so a hand-built test fixture can implement
 * just `read`/`cancel` without a real stream. */
export interface BoundedBodyReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
}

/** A Fetch `Response`-shaped object; declared narrowly so this module
 * never needs the DOM lib's full `Response` type (keeps it usable from
 * a Vitest/node environment with a hand-built fixture). */
export interface BoundedResponseLike {
  ok: boolean;
  redirected?: boolean;
  url?: string;
  headers?: { get?: (name: string) => string | null };
  body?: { getReader?: () => BoundedBodyReader } | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

async function readBoundedBytes(
  response: BoundedResponseLike,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && declared !== "") {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return null;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (!response.arrayBuffer) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads and JSON-parses a bounded, non-redirected, exact-URL response.
 * Returns `null` (never throws) on any violation of those contracts, or
 * on invalid UTF-8/JSON.
 */
export async function readBoundedJson(
  response: BoundedResponseLike,
  options: BoundedReadOptions,
): Promise<unknown | null> {
  if (!response.ok || response.redirected === true) return null;
  if (options.expectedUrl !== undefined && response.url && response.url !== options.expectedUrl) {
    return null;
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBytes(response, options.maxBytes);
  } catch {
    return null;
  }
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}
