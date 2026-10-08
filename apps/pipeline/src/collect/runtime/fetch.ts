/**
 * Real-network adapters for the collect CLI's real entry point (#26/#29 of
 * docs/migration/p4-followups.md — "collect の runner に実 LLM provider /
 * embedding encoder の生成を接続する" / "collect/cli.ts に実行入口が無く
 * …実ネットワーク接続…が未配線").
 *
 * `requestWithRetry`'s `FetchInit.timeoutMs` is documented as
 * "informational — a real fetchImpl may also use it for an AbortSignal"
 * (`collect/http/requestWithRetry.ts`). `createRealFetchImpl` is that real
 * fetchImpl: it wraps the global `fetch` and actually enforces the timeout
 * via `AbortSignal.timeout`, which — unlike a hand-rolled
 * `setTimeout`/`clearTimeout` pair cleared right after the response headers
 * arrive — stays armed for the whole call including the body read (a
 * server that sends headers promptly and then stalls the body stream would
 * otherwise hang forever). This is the exact pattern already used by
 * `apps/pipeline/src/conference/shared/networkTimeout.ts`'s
 * `fetchImplWithTimeout`/`fetchTextWithTimeout`; a local copy lives here
 * instead of importing that module because `conference/**` is being
 * consolidated by another agent concurrently with this task and has no
 * "except importing" exception (unlike `lineage/**`).
 *
 * Per-call timeouts are set by each caller (S2Source/OpenAlexSource/
 * SlackExporter default to `requestWithRetry`'s own 10_000ms default —
 * matching Python's `request_with_retry(..., timeout=10.0)` default;
 * CitationSignal/AuthorSignal pass 15_000ms — matching Python's
 * `timeout=15.0`; githubApi.ts's `searchRepoByTitle`/`fetchRepoStars` pass
 * 10_000ms — matching Python's `utils/github.py`'s `timeout=10`; the real
 * LLM providers pass `timeoutSeconds * 1000`, default 60_000ms — matching
 * each Python provider's `timeout_seconds` config default of 60 (Ollama's
 * Python default is 120s via its own YAML comment, but `OllamaProvider`'s
 * base class default is still 60s unless `llm.timeout_seconds` is set —
 * same on both sides)). This module does not set a default itself; it only
 * makes whatever `timeoutMs` the caller computed actually abort the
 * request.
 *
 * arXiv is the one exception: the real `arxiv` PyPI client Python's
 * `ArxivSource` wraps sets NO timeout at all on its underlying `requests`
 * call (see `conference/shared/networkTimeout.ts`'s `fetchTextWithTimeout`
 * doc comment for the identical gap already noted for the conference
 * collectors' oral-overlay arXiv fetch). `createRealArxivFetchText`'s
 * default below is a defensive ADDITION, not a parity requirement.
 */

import type { FetchLike } from "../http/requestWithRetry.js";
import type { ArxivFetchText } from "../sources/arxiv/arxiv.js";

/**
 * Identifies this client to arXiv/S2/OpenAlex/GitHub per their API
 * etiquette guidelines. Python's `requests`/`aiohttp` send their own
 * library default User-Agent instead (no explicit header is set anywhere
 * in `paperpilot/utils/http.py` or the source/signal modules) — this is an
 * intentional, documented addition on the TS side, not a parity
 * requirement: Node's global `fetch` (undici) sends no identifying
 * User-Agent of its own, so omitting one here would be LESS polite than
 * the Python side, not equally polite.
 */
export const DEFAULT_USER_AGENT =
  "PaperPilot-collector/1.0 (+https://github.com/taichiiiiiiii/automatic-paper-search)";

/** Not a parity requirement — see module doc. */
export const DEFAULT_ARXIV_FETCH_TIMEOUT_MS = 30_000;

/**
 * Real `FetchLike` for every JSON-returning endpoint `requestWithRetry`
 * calls (S2, OpenAlex, GitHub, Slack webhook, every LLM provider's chat
 * endpoint): sends a polite default `User-Agent` (callers that set their
 * own headers — `x-api-key`, `Authorization: Bearer …`, `Content-Type` —
 * win on key collision since they're spread last), and aborts the request
 * after `init.timeoutMs` via `AbortSignal.timeout`.
 */
export function createRealFetchImpl(fetchFn: typeof fetch = fetch): FetchLike {
  return async (url, init) => {
    const resp = await fetchFn(url, {
      method: init.method,
      headers: { "User-Agent": DEFAULT_USER_AGENT, ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    return { status: resp.status, json: () => resp.json() };
  };
}

/**
 * Real `ArxivFetchText` for `ArxivSource` — see module doc for why this
 * (unlike every other adapter here) picks its own default timeout rather
 * than receiving one from the caller: `ArxivSource`'s own `FetchParams`
 * carries no timeout at all (Python's wrapped `arxiv` client sets none).
 */
export function createRealArxivFetchText(
  timeoutMs: number = DEFAULT_ARXIV_FETCH_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch,
): ArxivFetchText {
  return async (url) => {
    const resp = await fetchFn(url, {
      headers: { "User-Agent": DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: resp.status, text: () => resp.text() };
  };
}
