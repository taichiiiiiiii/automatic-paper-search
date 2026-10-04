"use client";

/**
 * Theme-request form + generation-progress panel. Port of
 * docs/assets/theme.js's submitTheme() / bindThemeRequest() /
 * startProgress() / pollForCompletion() / showProgressFailure(), split
 * so the pure decision logic (lib/themes-request.ts's
 * `interpretThemesPostResponse`, `failureFromRun`, `safeRunUrl`, ...)
 * is unit-tested directly and this component only wires it to the DOM.
 *
 * Safety behaviours preserved from the original (docs/migration/
 * safety-contracts.md):
 *   - SCR-33: the follow-up link for an "exists" response is built from
 *     the SERVER's slug, never the raw free-text input.
 *   - SCR-34: 403/413/415/502/503 map to localised Japanese text that
 *     never leaks the Worker's raw English message; §4.2-7's "paused"
 *     gets the design doc's fixed copy. "invalid"/"rate_limited" are
 *     shown verbatim (React escapes them -- no innerHTML sink exists
 *     in this port, unlike the original which had to call escapeHtml
 *     itself).
 *   - SCR-35: a `queued` response without a usable slug/request_id
 *     never starts (fake) progress.
 *   - SCR-37/38: status polling only ever happens with a validated
 *     request_id, and only a completed failure/cancelled/timed_out run
 *     is ever shown as a failure.
 *   - SCR-39/40: redirect-on-ready re-checks the quality gate (never
 *     redirects into a page that will render nothing for an
 *     audit-failed theme) and the whole loop gives up after 12 minutes.
 *   - SCR-41/42 (run-link href): `safeRunUrl` gates the only external
 *     href this component ever renders from server-controlled data.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../../lib/config";
import {
  fetchThemeRunStatus,
  fetchThemesManifest,
  pollThemeQualityOutcome,
} from "../../lib/data-themes";
import {
  failureFromRun,
  interpretThemesPostResponse,
  issueUrlFor,
  POLL_FAILURE_THRESHOLD,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  PROGRESS_STEP_LABELS,
  PROGRESS_STEPS,
  type ProgressStep,
  progressPercentFor,
  STATUS_CHECK_INTERVAL_POLLS,
  safeRunUrl,
} from "../../lib/themes-request";
import { THEME_INPUT_PATTERN } from "../../lib/themes-slug";

interface ProgressFailure {
  title: string;
  message: string;
  runUrl?: string;
}

interface ProgressState {
  slug: string;
  themeLabel: string;
  requestId: string | null;
  step: ProgressStep;
  startedAt: number;
  networkWarning: boolean;
  failure: ProgressFailure | null;
}

type FormStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; node: React.ReactNode }
  | { kind: "err"; node: React.ReactNode };

/** `props.onReady` is called once a submitted theme's quality row turns
 * eligible -- the caller (ThemesClient) performs the actual navigation
 * (a full `location.href` assignment, matching the original's
 * reload-on-ready behaviour, so every bit of page state re-derives
 * from the new `?theme=`). */
export function ThemeRequestForm({ onReady }: { onReady: (slug: string) => void }) {
  const [rawInput, setRawInput] = useState("");
  const [status, setStatus] = useState<FormStatus>({ kind: "idle" });
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const cancelledRef = useRef(false);
  const progressRef = useRef<ProgressState | null>(null);
  const [, setElapsedTick] = useState(0);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // 1s elapsed-time ticker, running only while a progress panel is open.
  useEffect(() => {
    if (!progress || progress.failure) return;
    const id = setInterval(() => setElapsedTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [progress]);

  const setFailure = useCallback((failure: ProgressFailure) => {
    cancelledRef.current = true;
    setProgress((prev) => (prev ? { ...prev, failure } : prev));
  }, []);

  const advanceStep = useCallback((step: ProgressStep) => {
    if (cancelledRef.current) return;
    setProgress((prev) => (prev && !prev.failure ? { ...prev, step } : prev));
  }, []);

  const pollForCompletion = useCallback(
    async (slug: string) => {
      const startedAt = Date.now();
      let consecutiveFailures = 0;
      let pollIter = 0;
      while (!cancelledRef.current) {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setFailure({
            title: "生成がタイムアウトしました (12 分経過)",
            message:
              "S2 / Groq LLM のレート制限、または GitHub Actions の内部エラーの可能性があります。数分後に再試行するか、既存テーマを確認してください。",
          });
          return;
        }
        try {
          const manifestResult = await fetchThemesManifest({ cache: "no-store" });
          if (manifestResult.status === "ok") {
            consecutiveFailures = 0;
            if (manifestResult.data.some((e) => e.slug === slug)) {
              const outcome = await pollThemeQualityOutcome(slug);
              if (outcome === "ready") {
                advanceStep("ready");
                await new Promise((resolve) => setTimeout(resolve, 800));
                if (!cancelledRef.current) onReady(slug);
                return;
              }
              if (outcome === "failed") {
                setFailure({
                  title: "生成されましたが品質監査を通過しませんでした",
                  message:
                    "テーマの系譜データは生成されましたが、品質監査を通過しなかったため表示できません。別のテーマ名で試すか、しばらく時間をおいて再度お試しください。",
                });
                return;
              }
              // "pending" -- quality row not published yet; keep polling.
            }
          } else {
            consecutiveFailures++;
          }
        } catch {
          consecutiveFailures++;
        }
        setProgress((prev) =>
          prev ? { ...prev, networkWarning: consecutiveFailures >= POLL_FAILURE_THRESHOLD } : prev,
        );
        pollIter++;
        const requestId = progressRef.current?.requestId;
        if (pollIter % STATUS_CHECK_INTERVAL_POLLS === 0 && requestId) {
          const run = await fetchThemeRunStatus(API_BASE, requestId);
          const fail = failureFromRun(run);
          if (fail) {
            setFailure({ title: fail.title, message: fail.message, runUrl: fail.runUrl });
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
    [advanceStep, onReady, setFailure],
  );

  const startProgress = useCallback(
    (slug: string, themeLabel: string, requestId: string) => {
      cancelledRef.current = false;
      setStatus({ kind: "idle" });
      setProgress({
        slug,
        themeLabel,
        requestId,
        step: "dispatch",
        startedAt: Date.now(),
        networkWarning: false,
        failure: null,
      });
      setTimeout(() => advanceStep("queue"), 5_000);
      setTimeout(() => advanceStep("generate"), 30_000);
      setTimeout(() => advanceStep("commit"), 180_000);
      void pollForCompletion(slug);
    },
    [advanceStep, pollForCompletion],
  );

  const cancelProgress = useCallback(() => {
    cancelledRef.current = true;
    setProgress(null);
  }, []);

  const retryWithSlug = useCallback((slug: string) => {
    cancelledRef.current = true;
    setProgress(null);
    setRawInput(slug.replace(/-/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase()));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const raw = rawInput.trim();
    if (!THEME_INPUT_PATTERN.test(raw)) {
      setStatus({
        kind: "err",
        node: "⚠️ 2〜80 文字、英数字・スペース・ハイフン・アンダースコアのみ使用可能です。",
      });
      return;
    }
    if (!API_BASE) {
      window.open(issueUrlFor(raw), "_blank", "noopener");
      setStatus({
        kind: "ok",
        node: "📝 GitHub Issue 作成画面を新規タブで開きました。送信してください。",
      });
      return;
    }
    setStatus({ kind: "pending" });
    let resp: Response;
    try {
      resp = await fetch(`${API_BASE}/api/themes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: raw }),
        credentials: "omit",
      });
    } catch (err) {
      setStatus({
        kind: "err",
        node: (
          <>
            ❌ サーバに届きませんでした。{" "}
            <a href={issueUrlFor(raw)} target="_blank" rel="noopener">
              GitHub Issue で送信 →
            </a>
          </>
        ),
      });
      console.error("[theme-request] fetch failed:", err);
      return;
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      setStatus({ kind: "err", node: `❌ サーバから不正な応答 (HTTP ${resp.status})` });
      return;
    }
    const outcome = interpretThemesPostResponse(resp.status, body);
    switch (outcome.kind) {
      case "exists":
        setStatus({
          kind: "ok",
          node: outcome.slug ? (
            <>
              ✅ そのテーマは既に生成済です。{" "}
              <Link href={{ pathname: "/themes/", query: { theme: outcome.slug } }}>
                表示する →
              </Link>
            </>
          ) : (
            "✅ そのテーマは既に生成済です。テーマ一覧から確認してください。"
          ),
        });
        return;
      case "queued":
        startProgress(outcome.slug, raw, outcome.requestId);
        setRawInput("");
        return;
      case "queued_unusable":
        setStatus({
          kind: "ok",
          node: "🚀 受付完了。生成は数分かかります。完了後にこのページを再読み込みしてください。",
        });
        setRawInput("");
        return;
      case "dry_run":
        // §4.5: preview-only, the workflow was never actually
        // dispatched -- there is nothing to poll for, so this never
        // starts the progress panel (it would hang until the 12-minute
        // timeout since themes-manifest.json will never gain the slug).
        setStatus({
          kind: "ok",
          node: "✅ (プレビュー環境) dry-run 送信に成功しました。実際の生成は行われません。",
        });
        return;
      case "rate_limited":
        setStatus({ kind: "err", node: outcome.message });
        return;
      case "invalid":
        setStatus({ kind: "err", node: `❌ ${outcome.message}` });
        return;
      case "paused": {
        setStatus({
          kind: "err",
          node: (
            <>
              ❌ {outcome.message}{" "}
              <a href={issueUrlFor(raw)} target="_blank" rel="noopener">
                GitHub Issue で送信 →
              </a>
            </>
          ),
        });
        return;
      }
      case "error": {
        setStatus({
          kind: "err",
          node: outcome.showIssueLink ? (
            <>
              ❌ {outcome.message}{" "}
              <a href={issueUrlFor(raw)} target="_blank" rel="noopener">
                GitHub Issue で送信 →
              </a>
            </>
          ) : (
            `❌ ${outcome.message}`
          ),
        });
        return;
      }
    }
  }

  if (progress) {
    const elapsedMs = Date.now() - progress.startedAt;
    const minutes = Math.floor(elapsedMs / 60_000);
    const seconds = Math.floor((elapsedMs % 60_000) / 1_000);
    const safeUrl = safeRunUrl(progress.failure?.runUrl);
    return (
      <div
        className="theme-progress mt-4 rounded-md border border-rule bg-surface p-4"
        aria-live="polite"
      >
        <div className="flex items-center gap-2">
          <strong className="text-sm text-ink">
            {progress.failure
              ? progress.failure.title
              : `「${progress.themeLabel}」を生成中...${progress.networkWarning ? " (マニフェスト取得に再試行中)" : ""}`}
          </strong>
          {!progress.failure && (
            <span className="text-xs text-ink-subtle">
              経過 {minutes}:{String(seconds).padStart(2, "0")}
            </span>
          )}
        </div>
        {!progress.failure && (
          <>
            <progress
              className="mt-2 h-2 w-full"
              value={progressPercentFor(progress.step)}
              max={100}
              aria-label="生成の進捗"
            />
            <ul className="mt-3 flex flex-col gap-1 text-sm">
              {PROGRESS_STEPS.map((step) => {
                const idx = PROGRESS_STEPS.indexOf(step);
                const curIdx = PROGRESS_STEPS.indexOf(progress.step);
                return (
                  <li
                    key={step}
                    data-step={step}
                    className={
                      idx < curIdx
                        ? "text-ink-subtle"
                        : idx === curIdx
                          ? "font-medium text-ink"
                          : "text-ink-subtle/60"
                    }
                  >
                    {PROGRESS_STEP_LABELS[step]}
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              onClick={cancelProgress}
              className="mt-3 text-xs text-ink-muted underline hover:text-accent"
            >
              キャンセルして既存テーマを見る
            </button>
          </>
        )}
        {progress.failure && (
          <div role="alert" className="mt-2 flex flex-col gap-2 text-sm">
            <p className="text-ink-muted">
              {progress.failure.message}
              {safeUrl && (
                <>
                  {" "}
                  <a href={safeUrl} target="_blank" rel="noopener noreferrer">
                    GitHub Actions のログを開く →
                  </a>
                </>
              )}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => retryWithSlug(progress.slug)}
                className="rounded-md border border-rule px-3 py-1 text-xs hover:bg-surface-2"
              >
                再試行
              </button>
              <button
                type="button"
                onClick={cancelProgress}
                className="rounded-md border border-rule px-3 py-1 text-xs hover:bg-surface-2"
              >
                閉じて既存テーマを見る
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <form className="mt-4 flex flex-col gap-2" autoComplete="off" onSubmit={handleSubmit}>
      <label className="text-sm font-medium text-ink" htmlFor="theme-request-input">
        <span aria-hidden="true">✨</span> テーマを自分で生成:
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="theme-request-input"
          className="min-w-0 flex-1 rounded-md border border-rule px-3 py-2 text-sm"
          type="text"
          name="theme"
          minLength={2}
          maxLength={80}
          pattern="[A-Za-z0-9 _\-]+"
          placeholder="例: Vision Transformer / Graph Neural Network"
          aria-describedby="theme-request-hint"
          autoComplete="off"
          value={rawInput}
          onChange={(e) => {
            setRawInput(e.target.value);
            setStatus({ kind: "idle" });
          }}
        />
        <button
          type="submit"
          className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-ink-muted"
        >
          生成する
        </button>
      </div>
      <span id="theme-request-hint" className="text-xs text-ink-subtle">
        2〜80 文字 / 英数字・スペース・ハイフン / 生成完了まで数分
      </span>
      {status.kind === "pending" && (
        <p role="status" className="text-sm text-ink-subtle">
          ⏳ 送信中…
        </p>
      )}
      {status.kind === "ok" && (
        <p role="status" data-kind="ok" className="text-sm text-ink-muted">
          {status.node}
        </p>
      )}
      {status.kind === "err" && (
        <p role="status" data-kind="err" className="text-sm text-accent-strong">
          {status.node}
        </p>
      )}
    </form>
  );
}
