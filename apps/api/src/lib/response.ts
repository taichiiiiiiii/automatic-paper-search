// TS port of worker/response.js's envelope helper, adapted for §4.2-6/7: the
// allowed origin is no longer a single compile-time constant but whatever
// the per-request KV allowlist lookup matched (src/middleware/origin.ts).
// `json()` takes that resolved origin (or undefined when none matched /
// the route doesn't gate on origin, e.g. /api/health) and only sets
// Access-Control-Allow-Origin when one is given — `Vary: Origin` is always
// set once any part of the response could vary by Origin, per §4.2-6
// ("照合は完全一致のみ...一致した origin を ACAO に返す").
//
// CHANGED from worker/response.js: there is no more fixed PAGES_ORIGIN
// export here (see src/config.ts's ORIGIN_ALLOWLIST_FALLBACK for the
// dev-fallback list) — every caller must resolve an origin first.

export type JsonStatus =
  | "exists"
  | "queued"
  | "dry_run"
  | "rate_limited"
  | "invalid"
  | "error"
  | "paused";

export interface JsonBody {
  ok: boolean;
  status: JsonStatus;
  slug?: string;
  request_id?: string;
  message?: string;
}

export interface JsonInit {
  status?: number;
  origin?: string;
}

export function json(body: JsonBody, init: JsonInit = {}): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    vary: "Origin",
  };
  if (init.origin) {
    headers["access-control-allow-origin"] = init.origin;
  }
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

// §4.2-7: the dormant status endpoint never does upstream work and must
// never leak secrets. Origin is best-effort here (the route itself never
// 403s — see src/routes/themes.ts's status handler) so this keeps the
// signature symmetrical with json().
export function themeStatusUnavailable(origin?: string): Response {
  return json(
    {
      ok: false,
      status: "error",
      message:
        "workflow status is temporarily unavailable; completion continues through the public manifest",
    },
    { status: 503, origin },
  );
}
