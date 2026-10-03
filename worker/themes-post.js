// POST /api/themes orchestration, extracted from worker/index.ts (M-5b).
//
// Node 20 here has no TS-strip step, so worker/index.ts cannot be
// imported by tests (see worker/slug.js, worker/response.js,
// worker/entrypoint.js for the same pattern). This module holds the
// whole chain — origin/content-type/body-size gates, JSON parse, input
// validation, manifest dedup, per-IP limit, global cap, request-id
// creation, workflow dispatch, and the response envelope — as plain JS
// with `fetch` injected, so worker/themes-post.test.mjs can drive it
// directly. worker/index.ts now only wires createThemesPostHandler with
// the real global `fetch` and re-exports the result; it carries no
// request-handling logic of its own.
//
// Order (unchanged by the fixes below, see worker/README.md and
// CLAUDE.md §14): origin/content-type/body-size gates (before any KV
// read/write or subrequest) → JSON parse → input validation → manifest
// dedup → per-IP limit → global cap → request-id → dispatch → response.

import { themeSlug } from "./slug.js";
import {
  json,
  isRateLimited,
  isGloballyRateLimited,
  RATE_LIMIT_PER_HOUR,
  RATE_LIMIT_GLOBAL_PER_DAY,
  PAGES_ORIGIN,
} from "./response.js";
import { createRequestId, dispatchInputs } from "./request-id.js";
import { validatePostInput } from "./validate-input.js";

// L-6: hard ceiling on the POST body. 1KB comfortably covers the 80-char
// theme field plus JSON punctuation; anything bigger is either a bug in
// the caller or an attempt to make this Worker buffer an oversized body
// before validation gets a chance to reject it.
export const MAX_BODY_BYTES = 1024;

// M-1: content-type gate. Allows a trailing charset parameter (browsers
// and some HTTP clients append one) but nothing else.
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*[^;]+)?\s*(?![\s\S])/i;
const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)(?![\s\S])/;

function originAllowed(request) {
  return request.headers.get("origin") === PAGES_ORIGIN;
}

function contentTypeAllowed(request) {
  const contentType = request.headers.get("content-type");
  return contentType !== null && JSON_CONTENT_TYPE.test(contentType);
}

// L-6: reject early on a declared content-length over the cap (no read at
// all), and otherwise read the body while enforcing the same cap against
// the actual bytes seen — a client that lies about (or omits)
// content-length cannot force this Worker to buffer more than the limit.
async function readBoundedBody(request, maximumBytes) {
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
  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    return { ok: false, status: 400 };
  }
  const chunks = [];
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

// H-1: manifest-failure contract. A thrown fetch, a non-ok response, a
// JSON-parse error, or valid-but-non-array JSON must never be treated as
// "the theme already exists" — that tells the user their request was a
// duplicate when we simply couldn't verify the manifest, and skips the
// dispatch that would have generated a genuinely-new theme. Only a
// successfully parsed array is trusted, and only membership in it counts
// as "exists". Every other outcome reports `{ ok: false }` so the caller
// fails closed: 503, no KV charge, no dispatch.
async function alreadyGenerated(slug, env, fetchImpl) {
  // The viewer ships from GitHub Pages, so we read the manifest from
  // raw.githubusercontent.com (the Worker doesn't serve static assets).
  // GitHub's raw CDN has a ~5 min cache, so a freshly-published theme
  // stays "new" for roughly that window — same freshness behaviour as
  // CF Pages' old edge cache.
  const manifestUrl = `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${env.GH_REF}/docs/themes/themes-manifest.json`;
  let resp;
  try {
    // L-7: never silently follow a redirect away from the pinned ref/path.
    resp = await fetchImpl(manifestUrl, { redirect: "error" });
  } catch {
    return { ok: false };
  }
  if (!resp.ok) return { ok: false };
  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(data)) return { ok: false };
  return { ok: true, exists: data.some((e) => e?.slug === slug) };
}

async function dispatchWorkflow(theme, requestId, env, fetchImpl) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW_FILE}/dispatches`;
  const resp = await fetchImpl(url, {
    method: "POST",
    // L-7: same redirect guard on the dispatch call.
    redirect: "error",
    headers: {
      "authorization": `Bearer ${env.GH_DISPATCH_PAT}`,
      "accept": "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "paperpilot-theme-dispatcher",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_REF, inputs: dispatchInputs(theme, requestId) }),
  });
  // GitHub returns 204 on success.
  return { ok: resp.ok, status: resp.status, body: resp.ok ? "" : await resp.text() };
}

/**
 * Build the POST /api/themes handler with `fetch` injected. Production
 * wiring (worker/index.ts) passes the real global fetch; tests pass a
 * stub so the full chain — including every fail-closed path — runs
 * deterministically under node:test without a network.
 *
 * @param {{ fetch: typeof fetch }} deps
 * @returns {(request: Request, env: unknown) => Promise<Response>}
 */
export function createThemesPostHandler({ fetch: fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("themes POST handler requires an injected fetch");
  }

  return async function handlePost(request, env) {
    // M-1: origin + content-type gates run first — before any KV
    // read/write or subrequest — so a disallowed caller never reaches
    // the manifest fetch, the rate-limit buckets, or the GitHub dispatch.
    if (!originAllowed(request)) {
      return json({
        ok: false,
        status: "error",
        message: "request origin is not allowed",
      }, { status: 403 });
    }
    if (!contentTypeAllowed(request)) {
      return json({
        ok: false,
        status: "error",
        message: "content-type must be application/json",
      }, { status: 415 });
    }

    // L-6: size gate, still before JSON parsing.
    const bodyResult = await readBoundedBody(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      if (bodyResult.status === 413) {
        return json({
          ok: false,
          status: "error",
          message: "request body exceeds the 1KB limit",
        }, { status: 413 });
      }
      return json({ ok: false, status: "invalid", message: "JSON body required" }, { status: 400 });
    }

    let payload;
    try {
      payload = JSON.parse(bodyResult.text);
    } catch {
      return json({ ok: false, status: "invalid", message: "JSON body required" }, { status: 400 });
    }

    // Input validation lives in worker/validate-input.js so it can be
    // unit-tested without an HTTP round-trip. The pure helper bundles
    // body parse, theme pattern check, and slug derivation.
    const validation = validatePostInput(payload, themeSlug);
    if (!validation.ok) {
      return json(validation.body, { status: validation.status });
    }
    const raw = validation.raw;
    const slug = validation.slug;

    // H-1: existing theme → short-circuit, but only on a verified manifest
    // read. A manifest we couldn't verify fails closed with no RL charge,
    // no dispatch, and a message distinct from both "exists" and the
    // generic dispatch-failure error so the caller knows to just retry.
    const manifest = await alreadyGenerated(slug, env, fetchImpl);
    if (!manifest.ok) {
      return json({
        ok: false,
        status: "error",
        message: "could not verify existing themes; please retry shortly",
      }, { status: 503 });
    }
    if (manifest.exists) {
      return json({ ok: true, status: "exists", slug });
    }

    // Rate limits — applied AFTER the manifest dedup so benign "redirect
    // to existing" requests don't count against either bucket. Per-IP
    // first (catches honest abuse) then a global daily cap that protects
    // against IP rotation / residential proxy attacks.
    //
    // cf-connecting-ip is set by Cloudflare's edge and cannot be spoofed
    // by a client. If it's missing the request didn't come through the
    // edge (local dev, misconfigured proxy) — fail closed rather than
    // falling through to a shared "rl:unknown" bucket that any single
    // local-dev session would exhaust.
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip) {
      console.warn("cf-connecting-ip header missing; rejecting");
      return json({
        ok: false,
        status: "error",
        message: "request must originate from the public edge",
      }, { status: 400 });
    }

    // L-1: a KV put failure in either rate-limit check must fail closed
    // (JSON error with the usual CORS headers) rather than an uncaught
    // 500 — and, since it's before dispatch, with no workflow triggered.
    let limited;
    try {
      limited = await isRateLimited(ip, env.RATE_LIMIT_KV);
    } catch (error) {
      console.error(`rate limit check failed: ${error && error.message ? error.message : error}`);
      return json({
        ok: false,
        status: "error",
        message: "could not check the rate limit; please retry shortly",
      }, { status: 503 });
    }
    if (limited) {
      return json({
        ok: false,
        status: "rate_limited",
        message: `more than ${RATE_LIMIT_PER_HOUR} new themes/hour from this IP`,
      }, { status: 429 });
    }

    let globallyLimited;
    try {
      globallyLimited = await isGloballyRateLimited(env.RATE_LIMIT_KV);
    } catch (error) {
      console.error(`global rate limit check failed: ${error && error.message ? error.message : error}`);
      return json({
        ok: false,
        status: "error",
        message: "could not check the rate limit; please retry shortly",
      }, { status: 503 });
    }
    if (globallyLimited) {
      return json({
        ok: false,
        status: "rate_limited",
        message: `daily generation cap (${RATE_LIMIT_GLOBAL_PER_DAY}) reached; please try again tomorrow`,
      }, { status: 429 });
    }

    let requestId;
    try {
      requestId = createRequestId();
    } catch (error) {
      console.error(`request ID generation failed: ${(error && error.message) || error}`);
      return json({
        ok: false,
        status: "error",
        message: "could not start the generation job; please retry shortly",
      }, { status: 500 });
    }

    // L-1: dispatchWorkflow can throw (network error, aborted body read,
    // etc.) in addition to resolving with a non-ok response. Both must
    // produce the same generic JSON 502 — never an uncaught exception —
    // and neither leaks the GitHub error body, which can include
    // rate-limit headers / token hashes.
    let dispatch;
    try {
      dispatch = await dispatchWorkflow(raw, requestId, env, fetchImpl);
    } catch (error) {
      console.error(`workflow dispatch threw: ${error && error.message ? error.message : error}`);
      return json({
        ok: false,
        status: "error",
        message: "could not start the generation job; please retry shortly",
      }, { status: 502 });
    }
    if (!dispatch.ok) {
      console.error(`workflow dispatch failed: ${dispatch.status} ${dispatch.body}`);
      return json({
        ok: false,
        status: "error",
        message: "could not start the generation job; please retry shortly",
      }, { status: 502 });
    }

    return json({ ok: true, status: "queued", slug, request_id: requestId });
  };
}
