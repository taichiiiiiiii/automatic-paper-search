// TS port of the body-reading half of worker/themes-post.js
// (readBoundedBody + its content-type/content-length gates). Split into its
// own module per docs/migration/safety-contracts.md's apps/api placement
// for API-03/04/05.

export const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*[^;]+)?\s*(?![\s\S])/i;
const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)(?![\s\S])/;

export function contentTypeAllowed(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType !== null && JSON_CONTENT_TYPE.test(contentType);
}

export type BoundedBodyResult = { ok: true; text: string } | { ok: false; status: 400 | 413 };

// L-6 (worker/themes-post.js): reject early on a declared content-length
// over the cap (no read at all), and otherwise read the body while
// enforcing the same cap against the actual bytes seen.
export async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<BoundedBodyResult> {
  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw !== null) {
    if (!CONTENT_LENGTH.test(declaredRaw)) {
      return { ok: false, status: 400 };
    }
    if (Number(declaredRaw) > maximumBytes) {
      return { ok: false, status: 413 };
    }
  }
  if (request.body === null) {
    return { ok: true, text: "" };
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return { ok: false, status: 400 };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        return { ok: false, status: 400 };
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The byte ceiling, not cancellation behavior, determines this response.
        }
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, status: 400 };
  }
}
