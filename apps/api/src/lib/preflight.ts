// OPTIONS /api/* preflight. TS port of worker/entrypoint.js's
// themePreflight(), adapted for §4.2-6: the fixed PAGES_ORIGIN echo is
// replaced by the same per-request KV allowlist match the POST route uses,
// so preflight and the real request always agree on which origins are
// currently allowed.
//
// CHANGED from worker/entrypoint.js: a mismatched/unreadable-allowlist
// Origin now gets 403 (no CORS headers at all) instead of a 204 that
// always echoed the single fixed origin regardless of the caller's own
// Origin header — the old behaviour was only "safe" because exactly one
// origin ever existed; §4.2-6 explicitly allows multiple, so a real match
// check is required.

import type { FlagsKv } from "./kv-flags.js";
import { resolveOrigin } from "./kv-flags.js";

export async function themePreflight(request: Request, kv: FlagsKv): Promise<Response> {
  const resolution = await resolveOrigin(request, kv);
  if (!resolution.ok) {
    return new Response(null, { status: 403, headers: { vary: "Origin" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": resolution.origin,
      vary: "Origin",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}
