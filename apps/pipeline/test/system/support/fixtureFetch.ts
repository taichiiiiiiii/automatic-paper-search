/**
 * System-test HTTP layer: a `node --import` preload that replaces
 * `globalThis.fetch` with a recorded-fixture fetch BEFORE any CLI module
 * loads. Every pipeline CLI talks to the outside world through the global
 * `fetch` (directly or via an injected `fetchImpl` that wraps it), so this
 * is the one seam that covers all of them without touching production code.
 *
 * Environment (all set by `runCli.ts`, never by production):
 *   PAPERPILOT_FIXTURE_DIRS   ":"-separated dirs, each with an `index.json`
 *                             (array of {@link FixtureEntry}); earlier dirs win.
 *   PAPERPILOT_FIXTURE_FAULTS JSON array of {@link FaultRule}; checked first.
 *   PAPERPILOT_FIXTURE_LOG    JSONL file; one line per request (outcome
 *                             fixture | fault | miss | record).
 *   PAPERPILOT_FIXTURE_RECORD "1" = a miss goes to the real network and is
 *                             saved into the FIRST fixture dir (one-off
 *                             recording only; tests never set it).
 *
 * A miss without RECORD rejects like a dead network (`TypeError: fetch
 * failed`) so an unrecorded call can never reach a real API from a test.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export interface FixtureEntry {
  method?: string;
  /** Exact URL match … */
  url?: string;
  /** … or a RegExp source tested against the full URL. */
  urlPattern?: string;
  /** Optional substring the request body must contain (POST/SPARQL). */
  bodyIncludes?: string;
  status: number;
  headers?: Record<string, string>;
  /** Inline body, or `bodyFile` relative to the fixture dir. */
  body?: string;
  bodyFile?: string;
  /** JSON body (serialised on the fly). */
  json?: unknown;
  /**
   * Batch endpoints (S2 `POST /paper/batch`): the response is the JSON
   * array `ids.map((id) => byId[id] ?? null)` for the request body's
   * `field` array, in request order — like the real API.
   */
  batch?: { field: string; byId: Record<string, unknown> };
}

export interface FaultRule {
  /** Substring of the URL (host or path) the rule applies to. */
  match: string;
  kind: "status" | "timeout" | "malformed" | "network";
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Apply only to the first N matching requests (default: all). */
  times?: number;
}

interface Loaded {
  dir: string;
  entries: FixtureEntry[];
}

const realFetch = globalThis.fetch;
const dirs = (process.env.PAPERPILOT_FIXTURE_DIRS ?? "").split(":").filter((d) => d !== "");
const logPath = process.env.PAPERPILOT_FIXTURE_LOG ?? "";
const record = process.env.PAPERPILOT_FIXTURE_RECORD === "1";
const faults: (FaultRule & { used: number })[] = (
  JSON.parse(process.env.PAPERPILOT_FIXTURE_FAULTS ?? "[]") as FaultRule[]
).map((f) => ({ ...f, used: 0 }));

function loadDir(dir: string): Loaded {
  const p = join(dir, "index.json");
  return {
    dir,
    entries: existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as FixtureEntry[]) : [],
  };
}
const loaded: Loaded[] = dirs.map(loadDir);

function log(rec: Record<string, unknown>): void {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(rec)}\n`);
}

function requestParts(
  input: string | URL | Request,
  init?: RequestInit,
): { url: string; method: string; body: string } {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const raw = init?.body;
  const body = typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : "";
  return { url, method, body };
}

function find(url: string, method: string, body: string): { dir: string; e: FixtureEntry } | null {
  for (const { dir, entries } of loaded) {
    for (const e of entries) {
      if ((e.method ?? "GET").toUpperCase() !== method) continue;
      if (e.url !== undefined && e.url !== url) continue;
      if (e.urlPattern !== undefined && !new RegExp(e.urlPattern).test(url)) continue;
      if (e.url === undefined && e.urlPattern === undefined) continue;
      if (e.bodyIncludes !== undefined && !body.includes(e.bodyIncludes)) continue;
      return { dir, e };
    }
  }
  return null;
}

function respond(dir: string, e: FixtureEntry, requestBody: string): Response {
  let body: string | null;
  if (e.batch !== undefined) {
    const { field, byId } = e.batch;
    const ids = (JSON.parse(requestBody || "{}") as Record<string, unknown>)[field];
    body = JSON.stringify(Array.isArray(ids) ? ids.map((id) => byId[String(id)] ?? null) : []);
  } else if (e.json !== undefined) body = JSON.stringify(e.json);
  else if (e.bodyFile?.endsWith(".gz"))
    body = gunzipSync(readFileSync(join(dir, e.bodyFile))).toString("utf8");
  else if (e.bodyFile !== undefined) body = readFileSync(join(dir, e.bodyFile), "utf8");
  else body = e.body ?? "";
  const nullBody = e.status === 204 || e.status === 304;
  return new Response(nullBody ? null : body, {
    status: e.status,
    headers: { "content-type": "application/json", ...(e.headers ?? {}) },
  });
}

/** Recording only: per-host politeness (arXiv asks for >= 3 s). */
const lastHit = new Map<string, number>();
async function pace(url: string): Promise<void> {
  const host = new URL(url).host;
  const gap = host.includes("arxiv.org") ? 3200 : host.includes("semanticscholar") ? 1200 : 300;
  const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

function abortError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

async function fixtureFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const { url, method, body } = requestParts(input, init);
  for (const f of faults) {
    if (!url.includes(f.match)) continue;
    if (f.times !== undefined && f.used >= f.times) continue;
    f.used += 1;
    log({ method, url, outcome: "fault", kind: f.kind, status: f.status ?? null });
    if (f.kind === "timeout") throw abortError();
    if (f.kind === "network") throw new TypeError("fetch failed (injected network fault)");
    if (f.kind === "malformed") {
      return new Response(f.body ?? '{"data": [ {"broken": ', {
        status: f.status ?? 200,
        headers: { "content-type": "application/json", ...(f.headers ?? {}) },
      });
    }
    return new Response(f.body ?? JSON.stringify({ message: `injected ${f.status}` }), {
      status: f.status ?? 500,
      headers: { "content-type": "application/json", ...(f.headers ?? {}) },
    });
  }
  const hit = find(url, method, body);
  if (hit !== null) {
    log({ method, url, outcome: "fixture", status: hit.e.status });
    return respond(hit.dir, hit.e, body);
  }
  if (record && loaded[0] !== undefined) {
    await pace(url);
    const resp = await realFetch(input, init);
    const text = await resp.text();
    const first = loaded[0];
    if (resp.status === 429 || resp.status >= 500) {
      // Transient: hand it to the client's retry logic, never freeze it.
      log({ method, url, outcome: "record", status: resp.status, saved: false });
      return new Response(text, { status: resp.status, headers: resp.headers });
    }
    const name = `${createHash("sha256").update(`${method} ${url} ${body}`).digest("hex").slice(0, 16)}.body`;
    mkdirSync(join(first.dir, "bodies"), { recursive: true });
    writeFileSync(join(first.dir, "bodies", name), text);
    const headers: Record<string, string> = {};
    const ct = resp.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    const entry: FixtureEntry = {
      method,
      url,
      ...(body ? { bodyIncludes: body } : {}),
      status: resp.status,
      headers,
      bodyFile: `bodies/${name}`,
    };
    first.entries.push(entry);
    writeFileSync(join(first.dir, "index.json"), `${JSON.stringify(first.entries, null, 1)}\n`);
    log({ method, url, outcome: "record", status: resp.status });
    return new Response(text, { status: resp.status, headers });
  }
  log({ method, url, outcome: "miss" });
  throw new TypeError(`fetch failed (no fixture for ${method} ${url})`);
}

globalThis.fetch = fixtureFetch as typeof fetch;

/**
 * PAPERPILOT_FIXTURE_FAST_TIMERS=1: politeness pacing, Retry-After waits and
 * retry back-off (any `setTimeout` from 200 ms up to 15 min) fire
 * immediately, so a replayed run never waits on delays that only exist to
 * be nice to a real API. Request-timeout timers (callbacks that abort an
 * `AbortController`) and short timers keep their real delay.
 */
if (process.env.PAPERPILOT_FIXTURE_FAST_TIMERS === "1") {
  const realSetTimeout = globalThis.setTimeout;
  const fast = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const isAbort = typeof fn === "function" && /\babort\(/.test(String(fn));
    const squash = !isAbort && typeof ms === "number" && ms >= 200 && ms <= 900_000;
    return realSetTimeout(fn, squash ? 0 : ms, ...rest);
  }) as unknown as typeof setTimeout;
  globalThis.setTimeout = fast;
}
