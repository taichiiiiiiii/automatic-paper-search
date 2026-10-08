/**
 * Ported pure logic from docs/assets/theme.js's theme-request /
 * generation-progress flow (SCR-32 through SCR-40, API-14/18/19). Every
 * function here is network-free and DOM-free so it can be unit tested
 * directly — see test/themes/request-progress.test.ts and
 * test/themes/submit-contract.test.ts (ports of
 * paperpilot/tests/viewer/test_theme_request_progress.mjs and
 * test_theme_submit_contract.mjs).
 *
 * The DOM-facing counterparts (submitTheme, showProgressFailure,
 * pollForCompletion, bindThemeRequest) live in
 * components/themes/ThemeRequestForm.tsx and
 * components/themes/ThemeProgress.tsx, built on top of these helpers.
 */
import { SLUG_RE } from "./themes-slug";

// ---- Request-id polling -------------------------------------------------

/** Step list mirrored from the HTML data-step values in the original
 * docs/themes/index.html — kept as a plain ordered array so
 * `progressPercentFor` stays a pure index lookup. */
export const PROGRESS_STEPS = ["dispatch", "queue", "generate", "commit", "ready"] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

/** Single source of truth for the progress panel's step labels, keyed
 * by `PROGRESS_STEPS` order. PR #229 (on the original docs/assets/
 * theme.js) once let the step list drift from its only other copy (an
 * HTML attribute list) for ~5 days unnoticed; keeping the labels here
 * instead of inline JSX literals removes that second copy entirely —
 * the step list has exactly one definition. */
export const PROGRESS_STEP_LABELS: Record<ProgressStep, string> = {
  dispatch: "📨 ジョブを送信",
  queue: "⏳ Actions キュー待ち",
  generate: "🔍 論文収集 + LLM 関係分類",
  commit: "📦 develop に commit",
  ready: "✅ 完了 → 自動で表示します",
};

// 5 s feels responsive while staying well under the GH API rate limit
// even with several concurrent users.
export const POLL_INTERVAL_MS = 5_000;
// 12 min hard cap: the theme-on-demand workflow times out at 15 min; we
// surface "taking too long" before that so the user isn't left staring
// at a manifest that will never update.
export const POLL_TIMEOUT_MS = 12 * 60 * 1_000;
// 4 failures x 5s ~= 20s of trouble before a soft "retrying" warning.
export const POLL_FAILURE_THRESHOLD = 4;
// 1 status check per 6 manifest polls ~= once every 30s.
export const STATUS_CHECK_INTERVAL_POLLS = 6;

export const REQUEST_ID_RE =
  /^theme-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;

/** Pure step -> percent mapping. Unknown step names fall back to 0 so a
 * typo in a step value can't crash the progress bar. */
export function progressPercentFor(step: string): number {
  const idx = PROGRESS_STEPS.indexOf(step as ProgressStep);
  if (idx < 0) return 0;
  return Math.min(100, (idx / (PROGRESS_STEPS.length - 1)) * 100);
}

/** Builds the status-poll URL, or `null` when polling must not happen:
 * no API base configured, or `requestId` doesn't match the server's
 * `theme-<uuidv4>` shape (incl. rejecting a line-terminated id). */
export function statusUrlForRequest(
  apiBase: string | null | undefined,
  requestId: string,
): string | null {
  if (typeof apiBase !== "string" || !apiBase || !REQUEST_ID_RE.test(requestId)) {
    return null;
  }
  return `${apiBase.replace(/\/$/, "")}/api/themes/status?request_id=${encodeURIComponent(requestId)}`;
}

export interface GithubActionsRun {
  status?: string;
  conclusion?: string;
  html_url?: string;
}

export interface RunFailure {
  title: string;
  message: string;
  runUrl: string;
}

/** Translates a GitHub Actions run summary into the failure-UI fields.
 * Returns `null` while the run is still in flight or already
 * succeeded (the manifest poll handles success, not this). */
export function failureFromRun(run: GithubActionsRun | null | undefined): RunFailure | null {
  if (run?.status !== "completed") return null;
  const conclusion = run.conclusion;
  if (conclusion === "success") return null; // shouldn't happen -- manifest poll catches success first
  const url = typeof run.html_url === "string" ? run.html_url : "";
  if (conclusion === "failure") {
    return {
      title: "ワークフロー実行が失敗しました",
      message:
        "GitHub Actions の theme-on-demand ジョブが failure で完了しました。S2 のレート制限、Groq LLM の TPM 上限、または build_theme_lineage.py の内部エラーの可能性があります。ログから原因を特定してください。",
      runUrl: url,
    };
  }
  if (conclusion === "cancelled") {
    return {
      title: "ワークフローがキャンセルされました",
      message: "GitHub Actions のジョブが外部からキャンセルされました。再試行してください。",
      runUrl: url,
    };
  }
  if (conclusion === "timed_out") {
    return {
      title: "ワークフローがタイムアウトしました",
      message:
        "ジョブが GitHub Actions 側で時間切れになりました (workflow timeout-minutes 超過)。数分待ってから再試行してください。",
      runUrl: url,
    };
  }
  return null;
}

/**
 * Gates the only href showProgressFailure() ever assigns:
 * `run.html_url` is attacker-shaped data in principle (sourced from the
 * Worker's proxy of the GitHub runs API), so this rejects any scheme
 * other than `https:` and any host other than exactly `github.com`
 * before the link reaches the DOM — `javascript:`, `http:`, and
 * lookalike hosts (`evil.test/github.com`, `github.com.evil.test`) all
 * degrade to no link rather than a clickable one.
 */
export function safeRunUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
  return url;
}

// ---- Theme submission ----------------------------------------------------

export const JAPANESE_CHAR_RE = /[぀-ヿ㐀-鿿]/;

/**
 * Maps a Worker failure status to localised UI text, for the cases
 * where the Worker's own message isn't already Japanese (SCR-34).
 * `invalid` and `rate_limited` responses are NOT routed through this
 * map (handled verbatim by the caller) -- those already carry a
 * Worker-authored message meant to be shown as-is.
 *
 * `paused` (§4.2-7 accept-stop switch, apps/api's
 * `src/lib/kv-flags.ts` / `src/routes/themes.ts`) gets the exact
 * Japanese copy the design doc specifies:
 * 「現在受付を一時停止しています」.
 */
export const WORKER_STATUS_MESSAGE_JA: Record<number, string> = {
  403: "このページ以外からの依頼は受け付けていません",
  413: "依頼の形式が正しくありません",
  415: "依頼の形式が正しくありません",
  502: "GitHub への依頼に失敗しました。時間をおいて再度お試しください",
  503: "既存テーマの確認に失敗しました。時間をおいて再度お試しください",
};

/** The §4.2-7 accept-stop switch's message, shown instead of the
 * generic 503 text when the server reports `status: "paused"`. */
export const PAUSED_MESSAGE_JA = "現在受付を一時停止しています";

export function localizedFailureMessage(status: number, workerMessage: string | null): string {
  if (typeof workerMessage === "string" && JAPANESE_CHAR_RE.test(workerMessage)) {
    return workerMessage;
  }
  return WORKER_STATUS_MESSAGE_JA[status] || workerMessage || `HTTP ${status}`;
}

/** Pre-filled GitHub Issue URL used both in degraded mode (no API_BASE
 * configured) and as the fallback CTA on 502/503/paused Worker
 * failures. Matches `.github/ISSUE_TEMPLATE/theme-request.yml`'s shape
 * so operators can manually dispatch theme-on-demand.yml. */
export function issueUrlFor(theme: string): string {
  const title = encodeURIComponent(`[theme request] ${theme}`);
  const body = encodeURIComponent(`## 希望テーマ\n${theme}\n\n## 理由 / 背景\n(任意)\n`);
  return (
    "https://github.com/taichiiiiiiii/automatic-paper-search/issues/new" +
    `?labels=theme-request&title=${title}&body=${body}`
  );
}

// ---- Theme-generation quality-poll outcome -------------------------------

/** The three outcomes `pollForCompletion()` can observe once a manifest
 * poll finds the slug:
 *   - "ready"   row exists and is eligible: safe to redirect.
 *   - "failed"  row exists but isn't eligible: stop polling, show failure.
 *   - "pending" quality file unreadable / no row yet: keep polling. */
export type QualityPollOutcome = "ready" | "failed" | "pending";

// ---- POST /api/themes response interpretation ----------------------------
//
// submitTheme()'s pure decision logic, split out from its DOM effects
// (SCR-32..40, extended for §4.2-7's "paused" and §4.5's "dry_run"
// statuses added by apps/api — see apps/api/src/lib/response.ts's
// `JsonStatus` and apps/api/src/routes/themes.ts). The component layer
// (ThemeRequestForm.tsx) calls this with the parsed HTTP status + JSON
// body and renders whatever it returns; this function itself never
// touches the DOM or network, so it's covered directly by
// test/themes/submit-contract.test.ts.

export type ThemeSubmitOutcome =
  | { kind: "exists"; slug: string | null }
  | { kind: "queued"; slug: string; requestId: string }
  // Worker accepted the request (ok:true, status:"queued") but didn't
  // return a slug/request_id we can safely poll on -- SCR-35: never
  // fabricate progress for data we can't validate.
  | { kind: "queued_unusable" }
  // §4.5: dry-run mode (preview origin/ref only) -- the workflow was
  // never actually dispatched, so there is nothing to poll for.
  | { kind: "dry_run"; slug: string | null }
  | { kind: "rate_limited"; message: string }
  | { kind: "invalid"; message: string }
  // §4.2-7 accept-stop switch.
  | { kind: "paused"; message: string }
  | { kind: "error"; message: string; showIssueLink: boolean };

interface ThemesPostBody {
  ok?: unknown;
  status?: unknown;
  slug?: unknown;
  request_id?: unknown;
  message?: unknown;
}

/** Interprets a parsed `POST /api/themes` JSON response. Pure: never
 * throws, never touches the DOM/network. `httpStatus` is the HTTP
 * status code; `body` is the already-`JSON.parse`d response body
 * (pass `null` if parsing failed before calling this -- the caller
 * handles that case itself, see SCR-35). */
export function interpretThemesPostResponse(httpStatus: number, body: unknown): ThemeSubmitOutcome {
  const data = (body ?? null) as ThemesPostBody | null;
  const workerMessage = data && typeof data.message === "string" ? data.message : null;

  if (data?.ok === true && data.status === "exists") {
    // The server's dedup slug, not the raw free-text input, drives the
    // follow-up link -- only when it's itself a valid slug (SCR-33).
    const slug = typeof data.slug === "string" && SLUG_RE.test(data.slug) ? data.slug : null;
    return { kind: "exists", slug };
  }
  if (data?.ok === true && data.status === "queued") {
    const slug = typeof data.slug === "string" && SLUG_RE.test(data.slug) ? data.slug : null;
    const requestId =
      typeof data.request_id === "string" && REQUEST_ID_RE.test(data.request_id)
        ? data.request_id
        : null;
    if (slug && requestId) return { kind: "queued", slug, requestId };
    return { kind: "queued_unusable" };
  }
  if (data?.ok === true && data.status === "dry_run") {
    const slug = typeof data.slug === "string" && SLUG_RE.test(data.slug) ? data.slug : null;
    return { kind: "dry_run", slug };
  }
  if (data?.status === "paused") {
    return { kind: "paused", message: PAUSED_MESSAGE_JA };
  }
  // "invalid" and "rate_limited" already carry a Worker-authored message
  // meant to be shown verbatim -- unchanged by the Japanese status map.
  if (data?.status === "invalid" || data?.status === "rate_limited") {
    const message = workerMessage || `HTTP ${httpStatus}`;
    return data.status === "invalid"
      ? { kind: "invalid", message }
      : { kind: "rate_limited", message };
  }
  // Every other failure (origin/content-type/body-size/manifest/dispatch
  // gates, all status "error") maps its HTTP status to localised text.
  const message = localizedFailureMessage(httpStatus, workerMessage);
  const showIssueLink = httpStatus === 502 || httpStatus === 503;
  return { kind: "error", message, showIssueLink };
}
