// Response envelope + KV rate limiting helpers extracted from
// worker/index.ts so index.ts stays focused on routing.
//
// Plain JS (mirroring slug.js) so the node:test runner can import
// directly without a TS-strip step; type info lives at the import site
// in index.ts. Pin: worker/response.test.mjs.

// Per-IP requests/hour cap. Sized so a single user's UI can replay form
// submissions a few times during debugging without being locked out.
// Also appears verbatim in the error message at worker/index.ts:L142;
// keep the two in sync.
export const RATE_LIMIT_PER_HOUR = 5;

// Global daily ceiling on dispatched workflows / jobs. Even with a
// perfect per-IP limiter, a /20 IPv6 block or a rotating proxy can
// bypass it; this cap protects against direct-cost denial-of-service
// against the LLM provider (Groq Stage 4 calls). Also referenced in
// worker/index.ts:L149 — keep in sync.
export const RATE_LIMIT_GLOBAL_PER_DAY = 100;

/**
 * Response envelope shape returned from the /api/themes endpoint.
 *
 * @typedef {Object} JsonResponse
 * @property {boolean} ok
 * @property {"exists" | "queued" | "rate_limited" | "invalid" | "error"} status
 * @property {string=} slug
 * @property {string=} request_id
 * @property {string=} message
 */

/**
 * @param {JsonResponse} body
 * @param {ResponseInit} [init]
 * @returns {Response}
 */
export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // GH-Pages-hosted viewer + workers.dev-hosted API = cross-origin.
      // The Worker is safe to expose to any origin: input is validated,
      // requests are KV-rate-limited per-IP + globally, no cookies are
      // read, no PII is returned. Anyone calling /api/themes still has
      // to clear the same per-IP and global caps. If you ever lock the
      // API to a specific origin, set ACAO to the actual GH-Pages URL
      // AND restore `Vary: Origin` together — they're a matched pair
      // (the Vary makes sense only when ACAO reflects the request
      // origin; with a static "*" it just fragments CDN cache).
      "access-control-allow-origin": "*",
    },
    ...init,
  });
}

export function themeStatusUnavailable() {
  return json(
    {
      ok: false,
      status: "error",
      message: "workflow status is temporarily unavailable; completion continues through the public manifest",
    },
    { status: 503 },
  );
}

// Today's UTC date as YYYY-MM-DD. Worker time is UTC by default.
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export async function isRateLimited(ip, kv) {
  const key = `rl:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= RATE_LIMIT_PER_HOUR) return true;
  // 1-hour TTL — KV expirationTtl resets the window when the next
  // request lands after the bucket expires, so a single client gets a
  // fresh quota each hour rather than a fixed UTC-aligned window.
  await kv.put(key, String(count + 1), { expirationTtl: 3600 });
  return false;
}

export async function isGloballyRateLimited(kv) {
  const key = `rl:global:${todayUTC()}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= RATE_LIMIT_GLOBAL_PER_DAY) return true;
  // 24h TTL on the global bucket. Even if KV reset on every write
  // slid the window slightly, the daily cap is loose enough that the
  // amortised throughput stays bounded.
  await kv.put(key, String(count + 1), { expirationTtl: 86400 });
  return false;
}
