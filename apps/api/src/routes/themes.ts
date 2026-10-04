// POST /api/themes orchestration — TS port of worker/themes-post.js,
// extended with the §4.2-6/7/§4.5 gates new to this phase. See the top of
// worker/themes-post.js for the original order rationale (M-1/L-6/H-1/L-1/
// L-7 markers kept in comments below where the logic is unchanged).
//
// Order (CHANGED from worker/themes-post.js — the two KV-backed safety
// switches now run first, before even the content-type/body gates, because
// §4.2-7 requires both to fail closed "before any work"; everything after
// that keeps the original relative order):
//
//   origin allowlist (KV) → accept-stop flag (KV) → content-type (415) →
//   body size (413/400) → JSON parse (400) → input validation (400) →
//   manifest dedup (503/exists) → dispatch-mode sanity (503, no charge) →
//   cf-connecting-ip (400) → quota (429/503) → request-id (500) →
//   dispatch (502) → response (200 queued | dry_run)
//
// NOTE: manifest dedup runs before the dispatch-mode check (unlike the
// order first drafted for this port) so a request for an already-existing
// theme still gets a true "exists" answer even when DISPATCH_MODE/PAT are
// misconfigured — the legacy Worker's "exists" path never depended on the
// PAT either. Everything that actually spends quota or calls GitHub still
// sits behind the dispatch-mode check, so "no charge on misconfiguration"
// still holds.

import { MAX_BODY_BYTES, REFUND_ON_DISPATCH_FAILURE } from "../config.js";
import { contentTypeAllowed, readBoundedBody } from "../lib/bounded-body.js";
import type { DispatchResult } from "../lib/dispatch.js";
import { dispatchWorkflow } from "../lib/dispatch.js";
import { checkDispatchMode } from "../lib/dispatch-mode.js";
import { isAccepting, resolveOrigin } from "../lib/kv-flags.js";
import { alreadyGenerated } from "../lib/manifest.js";
import type { ConsumeResult, QuotaBackend } from "../lib/quota.js";
import { createRequestId } from "../lib/request-id.js";
import { json, themeStatusUnavailable } from "../lib/response.js";
import { themeSlug } from "../lib/slug.js";
import { validatePostInput } from "../lib/validate-input.js";
import type { Env } from "../types.js";

export { MAX_BODY_BYTES };

export interface ThemesPostDeps {
  fetch: typeof fetch;
  quota: (env: Env) => QuotaBackend;
  now?: () => number;
  randomUUID?: () => string;
  log?: (message: string) => void;
  refundOnDispatchFailure?: boolean;
}

export type ThemesPostHandler = (request: Request, env: Env) => Promise<Response>;

export function createThemesPostHandler(deps: ThemesPostDeps): ThemesPostHandler {
  if (typeof deps.fetch !== "function") {
    // API-23: never silently fall back to a global — require injection.
    throw new TypeError("themes POST handler requires an injected fetch");
  }
  if (typeof deps.quota !== "function") {
    throw new TypeError("themes POST handler requires an injected quota backend factory");
  }
  const fetchImpl = deps.fetch;
  const log = deps.log ?? ((m: string) => console.error(m));
  const refundOnFailure = deps.refundOnDispatchFailure ?? REFUND_ON_DISPATCH_FAILURE;

  // API-13/16: a refund is a best-effort cleanup, never a reason to turn a
  // well-formed 502 into an uncaught 500. If the backend's refund call
  // itself throws (e.g. the same DO hiccup that might cause other
  // failures), swallow it and keep the original 502 JSON response.
  async function safeRefund(env: Env, ip: string): Promise<void> {
    if (!refundOnFailure) return;
    try {
      await deps.quota(env).refund(ip);
    } catch (error) {
      log(`quota refund failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return async function handlePost(request: Request, env: Env): Promise<Response> {
    // §4.2-6: origin allowlist, exact match, read fresh from KV. A
    // mismatch/missing allowlist/unreadable KV all 403 with no ACAO to
    // echo (there is nothing we trust to echo) and before any other work.
    const originResolution = await resolveOrigin(request, env.CONFIG_KV);
    if (!originResolution.ok) {
      return json(
        { ok: false, status: "error", message: "request origin is not allowed" },
        { status: 403 },
      );
    }
    const origin = originResolution.origin;

    // §4.2-7: accept-stop switch, fail closed. No quota charge either way.
    if (!(await isAccepting(env.CONFIG_KV))) {
      return json(
        {
          ok: false,
          status: "paused",
          message: "theme submissions are temporarily paused; please check back later",
        },
        { status: 503, origin },
      );
    }

    // M-1: content-type gate.
    if (!contentTypeAllowed(request)) {
      return json(
        { ok: false, status: "error", message: "content-type must be application/json" },
        { status: 415, origin },
      );
    }

    // L-6: size gate, still before JSON parsing.
    const bodyResult = await readBoundedBody(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      if (bodyResult.status === 413) {
        return json(
          { ok: false, status: "error", message: "request body exceeds the 1KB limit" },
          { status: 413, origin },
        );
      }
      return json(
        { ok: false, status: "invalid", message: "JSON body required" },
        { status: 400, origin },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyResult.text);
    } catch {
      return json(
        { ok: false, status: "invalid", message: "JSON body required" },
        { status: 400, origin },
      );
    }

    const validation = validatePostInput(payload, themeSlug);
    if (!validation.ok) {
      return json(validation.body, { status: validation.status, origin });
    }
    const raw = validation.raw;
    const slug = validation.slug;

    // H-1: manifest-failure fail-closed contract — unchanged from
    // worker/themes-post.js's alreadyGenerated(). Deliberately runs BEFORE
    // the dispatch-mode sanity check below: a theme that already exists is
    // a true, harmless answer regardless of whether DISPATCH_MODE/PAT are
    // misconfigured — the legacy Worker never needed a PAT to say "exists"
    // either, and §4.5's "don't fake 受付済み" concern is about *queued*,
    // not about this read-only dedup answer.
    const manifest = await alreadyGenerated(slug, env, fetchImpl);
    if (!manifest.ok) {
      return json(
        {
          ok: false,
          status: "error",
          message: "could not verify existing themes; please retry shortly",
        },
        { status: 503, origin },
      );
    }
    if (manifest.exists) {
      return json({ ok: true, status: "exists", slug }, { origin });
    }

    // §4.5: dispatch-mode sanity — before any quota charge or dispatch
    // subrequest (one manifest read has already happened above, but that
    // read carries no quota cost and is itself the "exists" exemption),
    // so a misconfigured DISPATCH_MODE / missing PAT / dry-run-against-
    // production never charges the caller's quota.
    const modeCheck = checkDispatchMode(env, origin);
    if (!modeCheck.ok) {
      log(`dispatch mode check failed: ${modeCheck.message}`);
      return json(
        {
          ok: false,
          status: "error",
          message: "could not start the generation job; please retry shortly",
        },
        { status: 503, origin },
      );
    }
    const mode = modeCheck.mode;

    // cf-connecting-ip set by Cloudflare's edge, unspoofable by the client.
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip) {
      log("cf-connecting-ip header missing; rejecting");
      return json(
        { ok: false, status: "error", message: "request must originate from the public edge" },
        { status: 400, origin },
      );
    }

    // §5: exact quota via Durable Object, replacing the KV best-effort
    // counters. A backend throw (DO unreachable) fails closed exactly like
    // the old KV-throw path: 503 JSON with CORS headers, no dispatch.
    let consumeResult: ConsumeResult;
    try {
      consumeResult = await deps.quota(env).consume(ip);
    } catch (error) {
      log(`quota check failed: ${error instanceof Error ? error.message : String(error)}`);
      return json(
        {
          ok: false,
          status: "error",
          message: "could not check the rate limit; please retry shortly",
        },
        { status: 503, origin },
      );
    }
    if (!consumeResult.allowed) {
      const message =
        consumeResult.limitedBy === "ip"
          ? "more than 5 new themes/hour from this IP"
          : "daily generation cap (100) reached; please try again tomorrow";
      return json({ ok: false, status: "rate_limited", message }, { status: 429, origin });
    }

    let requestId: string;
    try {
      requestId = createRequestId(deps.randomUUID);
    } catch (error) {
      log(
        `request ID generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return json(
        {
          ok: false,
          status: "error",
          message: "could not start the generation job; please retry shortly",
        },
        { status: 500, origin },
      );
    }

    // L-1: dispatchWorkflow can throw in addition to resolving non-ok;
    // both must produce the same generic 502 and never leak the GitHub
    // error body (API-17).
    let dispatch: DispatchResult;
    try {
      dispatch = await dispatchWorkflow(raw, requestId, env, fetchImpl, mode, log);
    } catch (error) {
      log(`workflow dispatch threw: ${error instanceof Error ? error.message : String(error)}`);
      await safeRefund(env, ip);
      return json(
        {
          ok: false,
          status: "error",
          message: "could not start the generation job; please retry shortly",
        },
        { status: 502, origin },
      );
    }
    if (!dispatch.ok) {
      await safeRefund(env, ip);
      return json(
        {
          ok: false,
          status: "error",
          message: "could not start the generation job; please retry shortly",
        },
        { status: 502, origin },
      );
    }

    return json(
      {
        ok: true,
        status: dispatch.dryRun ? "dry_run" : "queued",
        slug,
        request_id: requestId,
      },
      { origin },
    );
  };
}

// API-19: status stays dormant — KV/DO counters cannot back a PAT-
// authenticated GitHub run query safely, so this route still never does
// upstream work. Origin is best-effort (never 403s this route — the
// browser must keep polling the public manifest regardless of CORS
// configuration drift).
export function createThemeStatusHandler(): (request: Request, env: Env) => Promise<Response> {
  return async function handleStatusGet(request: Request, env: Env): Promise<Response> {
    let origin: string | undefined;
    try {
      const resolution = await resolveOrigin(request, env.CONFIG_KV);
      if (resolution.ok) origin = resolution.origin;
    } catch {
      origin = undefined;
    }
    return themeStatusUnavailable(origin);
  };
}
