/**
 * OpenAlex API key + daily-budget gate (R2-19).
 *
 * Since 2026-02 OpenAlex meters every request against a daily USD budget
 * (https://developers.openalex.org/api-reference/authentication):
 * keyless $0.10/day (1,000 credits, shared by every GitHub Actions run
 * on the same egress IPs), $1/day with a free key. A search costs 10
 * credits, a list/filter page 1 credit, a single-entity lookup 0. The
 * budget resets at 00:00 UTC, so a "daily budget" 429 never recovers by
 * waiting; the `mailto` polite pool is gone.
 *
 * {@link OpenAlexGate.wrap} wraps a `FetchLike` so that every request to
 * `api.openalex.org` (and nothing else):
 *  - carries the key as `Authorization: Bearer <key>` (documented as
 *    equivalent to `?api_key=`; a header keeps the key out of URLs, which
 *    end up in logs, caches and error messages). The key is never logged.
 *  - is budget-checked: the `X-RateLimit-*` headers of every response are
 *    parsed; once the remaining budget cannot pay for a search (10
 *    credits), searches are refused, and once it cannot pay for a list
 *    page (1 credit), or OpenAlex answers a 429 that names the daily
 *    budget, list/search calls are refused for the rest of the run
 *    (circuit breaker). A refused call throws
 *    {@link OpenAlexBudgetExhaustedError}, which `requestWithRetry`
 *    turns into `null` at once (no retry sleeps), so every caller's
 *    existing failure path — the Semantic Scholar seed-search and
 *    expansion fallbacks (R2-14) — takes over.
 *  - is memoised for the run: an identical GET that already answered 200
 *    is served from memory (successful answers only — a failure is never
 *    remembered, LIN-20).
 *
 * {@link OpenAlexGate.summary} is the one CI log line:
 * `openalex budget: remaining=…, calls=…, searches=…, 429=…, key=yes/no`.
 */

import type { FetchInit, FetchLike, HeadersLike, HttpResponseLike } from "./requestWithRetry.js";

export const OPENALEX_API_HOST = "api.openalex.org";
/** Env names read for the key, in priority order. */
export const OPENALEX_API_KEY_ENV_NAMES = [
  "PAPERPILOT_OPENALEX_API_KEY",
  "OPENALEX_API_KEY",
] as const;

/** Credits per request class (1 credit = $0.0001). */
export const OPENALEX_CREDIT_COST = { free: 0, singleton: 0, list: 1, search: 10 } as const;
export const OPENALEX_USD_PER_CREDIT = 0.0001;
/** OpenAlex allows at most this many values in one `a|b|c` OR filter. */
export const OPENALEX_MAX_OR_VALUES = 100;
/** A 429 whose `Retry-After` exceeds this is a daily-budget refusal. */
const BUDGET_RETRY_AFTER_MS = 120_000;
const BUDGET_BODY_RE = /budget|credit|daily|insufficient|quota|exhausted/i;
const MEMO_MAX_ENTRIES = 5000;

export type OpenAlexRequestKind = keyof typeof OPENALEX_CREDIT_COST;
export type OpenAlexBreakerState = "closed" | "searches-blocked" | "open";

/** First non-blank key among {@link OPENALEX_API_KEY_ENV_NAMES}, else `null`. */
export function resolveOpenAlexApiKey(
  env: Readonly<Record<string, string | null | undefined>>,
): string | null {
  for (const name of OPENALEX_API_KEY_ENV_NAMES) {
    const v = env[name];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function isOpenAlexUrl(url: string): boolean {
  try {
    return new URL(url).hostname === OPENALEX_API_HOST;
  } catch {
    return false;
  }
}

const SINGLETON_PATH_RE =
  /^\/(works|authors|sources|institutions|topics|concepts|publishers|funders|keywords)\/[^/]+$/;

/** Price class of an OpenAlex URL (see module doc). */
export function classifyOpenAlexRequest(url: string): OpenAlexRequestKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "list";
  }
  if (u.pathname === "/rate-limit") return "free";
  const isSearch =
    [...u.searchParams.keys()].some((k) => k === "search" || k.startsWith("search.")) ||
    /(^|[,.])[a-z_]*\.?search[a-z_]*:/i.test(u.searchParams.get("filter") ?? "");
  if (isSearch) return "search";
  if (SINGLETON_PATH_RE.test(u.pathname)) return "singleton";
  return "list";
}

export interface OpenAlexBudgetSnapshot {
  /** `X-RateLimit-Remaining` (credits). */
  remainingCredits: number | null;
  /** `X-RateLimit-Remaining-USD`. */
  remainingUsd: number | null;
  /** `X-RateLimit-Prepaid-Remaining-USD` (spent after the daily budget). */
  prepaidRemainingUsd: number | null;
  /** `X-RateLimit-Onetime-Remaining` (credits). */
  onetimeRemainingCredits: number | null;
  /** `X-RateLimit-Limit` (credits). */
  limitCredits: number | null;
  /** `X-RateLimit-Credits-Used` (cost of this request). */
  creditsUsed: number | null;
  /** `X-RateLimit-Credits-Required` (sent with a refusal). */
  creditsRequired: number | null;
  /** `X-RateLimit-Reset` (seconds to 00:00 UTC). */
  resetSeconds: number | null;
}

function num(h: HeadersLike, name: string): number | null {
  const raw = h.get(name);
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/** Parse the `X-RateLimit-*` budget headers; `null` when none is present. */
export function parseOpenAlexBudgetHeaders(
  headers: HeadersLike | null | undefined,
): OpenAlexBudgetSnapshot | null {
  if (!headers || typeof headers.get !== "function") return null;
  const snap: OpenAlexBudgetSnapshot = {
    remainingCredits: num(headers, "x-ratelimit-remaining"),
    remainingUsd: num(headers, "x-ratelimit-remaining-usd"),
    prepaidRemainingUsd: num(headers, "x-ratelimit-prepaid-remaining-usd"),
    onetimeRemainingCredits: num(headers, "x-ratelimit-onetime-remaining"),
    limitCredits: num(headers, "x-ratelimit-limit"),
    creditsUsed: num(headers, "x-ratelimit-credits-used"),
    creditsRequired: num(headers, "x-ratelimit-credits-required"),
    resetSeconds: num(headers, "x-ratelimit-reset"),
  };
  return snap.remainingCredits === null && snap.remainingUsd === null ? null : snap;
}

/** Everything still spendable today, in credits: daily remainder plus
 * one-time and prepaid balances. `null` when the headers say nothing. */
export function effectiveRemainingCredits(snap: OpenAlexBudgetSnapshot | null): number | null {
  if (snap === null) return null;
  const daily =
    snap.remainingCredits ??
    (snap.remainingUsd === null ? null : Math.floor(snap.remainingUsd / OPENALEX_USD_PER_CREDIT));
  if (daily === null) return null;
  const prepaid =
    snap.prepaidRemainingUsd === null
      ? 0
      : Math.floor(snap.prepaidRemainingUsd / OPENALEX_USD_PER_CREDIT);
  return Math.max(0, daily) + Math.max(0, snap.onetimeRemainingCredits ?? 0) + Math.max(0, prepaid);
}

/** Thrown by the gate instead of sending a request the budget cannot pay
 * for. `requestWithRetry` maps it to `null` without retrying. */
export class OpenAlexBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAlexBudgetExhaustedError";
  }
}

export interface OpenAlexGateOptions {
  apiKey?: string | null;
  logger?: { warn: (msg: string) => void };
  /** Memoise successful GETs for the run (default true). */
  memo?: boolean;
}

export interface OpenAlexGateStats {
  calls: number;
  searches: number;
  lists: number;
  singletons: number;
  status429: number;
  blocked: number;
  memoHits: number;
}

function retryAfterMs(h: HeadersLike | undefined): number | null {
  const raw = h?.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at - Date.now();
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body) ?? "";
  } catch {
    return "";
  }
}

export class OpenAlexGate {
  readonly hasKey: boolean;
  private readonly apiKey: string | null;
  private readonly logger: { warn: (msg: string) => void };
  private readonly memoEnabled: boolean;
  private readonly memo = new Map<string, { headers?: HeadersLike; body: unknown }>();
  private state: OpenAlexBreakerState = "closed";
  /** Set when even a free single-entity lookup got a budget refusal. */
  private singletonsBlocked = false;
  private reason: string | null = null;
  private lastSnapshot: OpenAlexBudgetSnapshot | null = null;
  readonly stats: OpenAlexGateStats = {
    calls: 0,
    searches: 0,
    lists: 0,
    singletons: 0,
    status429: 0,
    blocked: 0,
    memoHits: 0,
  };

  constructor(options: OpenAlexGateOptions = {}) {
    const key = options.apiKey?.trim() ?? "";
    this.apiKey = key ? key : null;
    this.hasKey = this.apiKey !== null;
    this.logger = options.logger ?? { warn: () => {} };
    this.memoEnabled = options.memo ?? true;
  }

  get breaker(): OpenAlexBreakerState {
    return this.state;
  }

  /** Remaining credits from the latest response headers, or `null`. */
  get remainingCredits(): number | null {
    return effectiveRemainingCredits(this.lastSnapshot);
  }

  /** True once any OpenAlex request was attempted or refused. */
  get used(): boolean {
    return this.stats.calls + this.stats.blocked + this.stats.memoHits > 0;
  }

  /** Would a request of this class be sent right now? */
  allows(kind: OpenAlexRequestKind): boolean {
    if (kind === "free") return true;
    if (kind === "singleton") return !this.singletonsBlocked;
    if (kind === "list") return this.state !== "open";
    return this.state === "closed";
  }

  private trip(next: Exclude<OpenAlexBreakerState, "closed">, reason: string): void {
    const rank = { closed: 0, "searches-blocked": 1, open: 2 } as const;
    if (rank[next] <= rank[this.state]) return;
    this.state = next;
    this.reason = reason;
    this.logger.warn(
      next === "open"
        ? `openalex budget: ${reason}; no more OpenAlex list/search calls this run (Semantic Scholar fallbacks take over; budget resets 00:00 UTC)`
        : `openalex budget: ${reason}; no more OpenAlex searches this run (Semantic Scholar search fallback takes over)`,
    );
  }

  /** Feed one response's headers into the breaker. */
  observe(headers: HeadersLike | null | undefined): void {
    const snap = parseOpenAlexBudgetHeaders(headers);
    if (snap === null) return;
    this.lastSnapshot = snap;
    const remaining = effectiveRemainingCredits(snap);
    if (remaining === null) return;
    if (remaining < OPENALEX_CREDIT_COST.list) {
      this.trip("open", `daily budget exhausted (remaining=${remaining})`);
    } else if (remaining < OPENALEX_CREDIT_COST.search) {
      this.trip("searches-blocked", `daily budget too low for a search (remaining=${remaining})`);
    }
  }

  /** Wrap `fetchImpl`; non-OpenAlex URLs pass through untouched. */
  wrap(fetchImpl: FetchLike): FetchLike {
    return async (url: string, init: FetchInit): Promise<HttpResponseLike> => {
      if (!isOpenAlexUrl(url)) return fetchImpl(url, init);
      const kind = classifyOpenAlexRequest(url);
      if (!this.allows(kind)) {
        this.stats.blocked += 1;
        throw new OpenAlexBudgetExhaustedError(
          `openalex ${kind} call skipped: ${this.reason ?? "daily budget exhausted"}`,
        );
      }
      const isGet = (init.method ?? "GET").toUpperCase() === "GET";
      const memoKey = isGet && this.memoEnabled ? url : null;
      if (memoKey !== null) {
        const hit = this.memo.get(memoKey);
        if (hit !== undefined) {
          this.stats.memoHits += 1;
          return { status: 200, headers: hit.headers, json: async () => structuredClone(hit.body) };
        }
      }
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      if (
        this.apiKey !== null &&
        !Object.keys(headers).some((h) => h.toLowerCase() === "authorization")
      ) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }
      this.stats.calls += 1;
      if (kind === "search") this.stats.searches += 1;
      else if (kind === "list") this.stats.lists += 1;
      else if (kind === "singleton") this.stats.singletons += 1;
      const resp = await fetchImpl(url, { ...init, headers });
      this.observe(resp.headers);

      if (resp.status === 429) {
        this.stats.status429 += 1;
        let body: unknown;
        let bodyOk = true;
        try {
          body = await resp.json();
        } catch {
          bodyOk = false;
        }
        const snap = parseOpenAlexBudgetHeaders(resp.headers);
        const remaining = effectiveRemainingCredits(snap);
        const cost = Math.max(OPENALEX_CREDIT_COST[kind], snap?.creditsRequired ?? 0, 1);
        const hint = retryAfterMs(resp.headers);
        const budget =
          (remaining !== null && remaining < cost) ||
          (bodyOk && BUDGET_BODY_RE.test(bodyText(body))) ||
          (hint !== null && hint > BUDGET_RETRY_AFTER_MS);
        if (budget) {
          if (kind === "singleton") this.singletonsBlocked = true;
          this.trip(
            kind === "search" && remaining !== null && remaining >= OPENALEX_CREDIT_COST.list
              ? "searches-blocked"
              : "open",
            `429 daily budget refusal (remaining=${remaining ?? "unknown"})`,
          );
          throw new OpenAlexBudgetExhaustedError(
            `openalex ${kind} call refused: daily budget exhausted`,
          );
        }
        // A per-second throttle: let requestWithRetry back off as usual.
        return {
          status: resp.status,
          headers: resp.headers,
          json: async () => {
            if (!bodyOk) throw new SyntaxError("unreadable 429 body");
            return body;
          },
        };
      }

      if (memoKey === null || resp.status !== 200) return resp;
      return {
        status: resp.status,
        headers: resp.headers,
        json: async () => {
          const data = await resp.json();
          if (this.memo.size < MEMO_MAX_ENTRIES) {
            this.memo.set(memoKey, { headers: resp.headers, body: structuredClone(data) });
          }
          return data;
        },
      };
    };
  }

  /** `openalex budget: remaining=…, calls=…, searches=…, 429=…, key=yes/no` (never the key). */
  summary(): string {
    const rem = this.remainingCredits;
    const usd = this.lastSnapshot?.remainingUsd;
    const remaining =
      rem === null ? "unknown" : `${rem}${typeof usd === "number" ? ` ($${usd})` : ""}`;
    const s = this.stats;
    return (
      `openalex budget: remaining=${remaining}, calls=${s.calls}, searches=${s.searches}, ` +
      `lists=${s.lists}, singletons=${s.singletons}, 429=${s.status429}, blocked=${s.blocked}, ` +
      `cache_hits=${s.memoHits}, key=${this.hasKey ? "yes" : "no"}, breaker=${this.state}`
    );
  }
}

/**
 * CLI wiring: build a gate from `env` (key from
 * `PAPERPILOT_OPENALEX_API_KEY` / `OPENALEX_API_KEY`), wrap `fetchImpl`,
 * and print {@link OpenAlexGate.summary} once on process exit when the
 * run touched OpenAlex.
 */
export function installOpenAlexGate(
  fetchImpl: FetchLike,
  options: {
    apiKey?: string | null;
    env?: Readonly<Record<string, string | null | undefined>>;
    logger?: { warn: (msg: string) => void };
    write?: (line: string) => void;
    onExit?: (fn: () => void) => void;
  } = {},
): { fetchImpl: FetchLike; gate: OpenAlexGate } {
  const apiKey = options.apiKey ?? resolveOpenAlexApiKey(options.env ?? process.env);
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const logger = options.logger ?? { warn: write };
  const gate = new OpenAlexGate({ apiKey, logger });
  const onExit = options.onExit ?? ((fn: () => void) => process.once("exit", fn));
  onExit(() => {
    if (gate.used) write(gate.summary());
  });
  return { fetchImpl: gate.wrap(fetchImpl), gate };
}
