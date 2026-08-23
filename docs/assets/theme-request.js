// On-demand theme submission + generation progress UI.
//
// Extracted from theme.js so the compact form on /lineage/ can share
// the same submission flow without loading the full chronological
// viewer. Lives as a standalone module so any host page that wants the
// form just adds <script src="../assets/theme-request.js"> and the
// matching HTML ids (theme-request / theme-request-input / etc.).
//
// Exposes window.PPThemeRequest with:
//   - bind(): attach form/progress listeners (idempotent, no-op if the
//     form HTML is absent). Called once at module load.
//   - submitTheme(): the submit handler (exposed so tests / callers
//     can drive it programmatically).
//
// Security notes inherited from theme.js:
//   - SLUG_RE is the same character class enforced server-side by
//     paperpilot/scripts/_common.theme_slug().
//   - SetRequestStatus uses innerHTML only with template-literal
//     strings authored here — inputs go through escapeHtml() first.
//   - Tooltip rationale uses textContent (NOT innerHTML).

(function (root) {
  "use strict";

  const PP = root.PP || {};
  if (typeof PP.escapeHtml !== "function") {
    throw new Error("theme-request.js requires utils.js (PP.escapeHtml) to be loaded first");
  }
  const escapeHtml = PP.escapeHtml;

  // API base read from <meta name="paperpilot-api-base">. Mirrors
  // theme.js's API_BASE so the form works on either host page.
  const API_BASE = (
    (typeof document !== "undefined" && typeof document.querySelector === "function"
      ? document.querySelector('meta[name="paperpilot-api-base"]')?.getAttribute("content")
      : "") || ""
  ).replace(/\/+$/, "");

  // Mirror of paperpilot/scripts/_common._SLUG_ALLOWED_RE / theme_slug().
  const SLUG_RE = /^[a-z0-9-]+$/;
  // Same pattern worker/slug.js (THEME_INPUT_PATTERN) enforces server-side.
  const THEME_REQUEST_PATTERN = /^[A-Za-z0-9 _-]{2,80}$/;

  // 5 s feels responsive while staying well under the GH API rate limit
  // even with several concurrent users — the status check fires once per
  // STATUS_CHECK_INTERVAL_POLLS ≈ 30 s.
  const POLL_INTERVAL_MS = 5_000;
  // 12 min hard cap. The theme-on-demand workflow has a 15 min
  // timeout-minutes; we surface "taking too long" before the workflow
  // would actually time out so the user knows something is wrong.
  const POLL_TIMEOUT_MS = 12 * 60 * 1_000;
  // Step list mirrored from the HTML data-step values — keep in sync.
  const PROGRESS_STEPS = ["dispatch", "queue", "generate", "commit", "ready"];
  // 4 failures × 5 s ≈ 20 s of trouble before the user sees a soft
  // "retrying" warning in the progress title.
  const POLL_FAILURE_THRESHOLD = 4;
  // 1 status check per 6 manifest polls ≈ once every 30 s.
  const STATUS_CHECK_INTERVAL_POLLS = 6;

  // Cached element refs — populated by bind() so multiple calls are
  // idempotent and the module works when the form HTML is absent.
  const els = {};

  // Module-level progress state so bound cancel/retry handlers can
  // flip `cancelled` without rebinding on every submit.
  let progressState = null;

  function _resolveEls() {
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
    els.reqForm = document.getElementById("theme-request");
    els.reqInput = document.getElementById("theme-request-input");
    els.reqSubmit = document.getElementById("theme-request-submit");
    els.reqStatus = document.getElementById("theme-request-status");
    els.progress = document.getElementById("theme-progress");
    els.progressTitle = document.getElementById("theme-progress-title");
    els.progressElapsed = document.getElementById("theme-progress-elapsed");
    els.progressBar = document.getElementById("theme-progress-bar");
    els.progressSteps = document.getElementById("theme-progress-steps");
    els.progressCancel = document.getElementById("theme-progress-cancel");
    els.progressFailure = document.getElementById("theme-progress-failure");
    els.progressFailureTitle = document.getElementById("theme-progress-failure-title");
    els.progressFailureMsg = document.getElementById("theme-progress-failure-msg");
    els.progressFailureRetry = document.getElementById("theme-progress-failure-retry");
    els.progressFailureDismiss = document.getElementById("theme-progress-failure-dismiss");
  }

  function setRequestStatus(kind, html) {
    // kind: "ok" | "err" | "pending" — drives CSS via data-kind.
    if (!els.reqStatus) return;
    els.reqStatus.dataset.kind = kind;
    // innerHTML only with template-literal strings authored here —
    // inputs are escaped via escapeHtml() before being spliced in.
    els.reqStatus.innerHTML = html;
    els.reqStatus.hidden = false;
  }

  function clearRequestStatus() {
    if (!els.reqStatus) return;
    els.reqStatus.hidden = true;
    els.reqStatus.innerHTML = "";
    els.reqStatus.dataset.kind = "";
  }

  function issueUrlFor(theme) {
    // Pre-filled Issue page used in degraded mode (no API_BASE configured).
    // Matches .github/ISSUE_TEMPLATE/theme-request.yml shape.
    const title = encodeURIComponent(`[theme request] ${theme}`);
    const body = encodeURIComponent(
      `## 希望テーマ\n${theme}\n\n## 理由 / 背景\n(任意)\n`,
    );
    return (
      `https://github.com/taichiiiiiiii/automatic-paper-search/issues/new` +
      `?labels=theme-request&title=${title}&body=${body}`
    );
  }

  // Translate a GitHub Actions run summary into the failure-UI fields.
  // Returns null while the run is still in flight or already succeeded.
  function failureFromRun(run) {
    if (!run || run.status !== "completed") return null;
    const conc = run.conclusion;
    if (conc === "success") return null;
    const url = typeof run.html_url === "string" ? run.html_url : "";
    if (conc === "failure") {
      return {
        title: "ワークフロー実行が失敗しました",
        message: "GitHub Actions の theme-on-demand ジョブが failure で完了しました。S2 のレート制限、Groq LLM の TPM 上限、または build_theme_lineage.py の内部エラーの可能性があります。ログから原因を特定してください。",
        runUrl: url,
      };
    }
    if (conc === "cancelled") {
      return {
        title: "ワークフローがキャンセルされました",
        message: "GitHub Actions のジョブが外部からキャンセルされました。再試行してください。",
        runUrl: url,
      };
    }
    if (conc === "timed_out") {
      return {
        title: "ワークフローがタイムアウトしました",
        message: "ジョブが GitHub Actions 側で時間切れになりました (workflow timeout-minutes 超過)。数分待ってから再試行してください。",
        runUrl: url,
      };
    }
    return null;
  }

  function progressPercentFor(step) {
    const idx = PROGRESS_STEPS.indexOf(step);
    if (idx < 0) return 0;
    return Math.min(100, (idx / (PROGRESS_STEPS.length - 1)) * 100);
  }

  function setProgressStep(step) {
    if (!els.progressSteps) return;
    const idx = PROGRESS_STEPS.indexOf(step);
    for (const li of els.progressSteps.querySelectorAll("li[data-step]")) {
      const liIdx = PROGRESS_STEPS.indexOf(li.dataset.step);
      li.classList.toggle("theme-progress__step--done", liIdx < idx);
      li.classList.toggle("theme-progress__step--current", liIdx === idx);
      li.classList.toggle("theme-progress__step--pending", liIdx > idx);
    }
    if (els.progressBar) {
      els.progressBar.style.width = `${progressPercentFor(step)}%`;
    }
  }

  function updateElapsed() {
    if (!progressState || !els.progressElapsed) return;
    const elapsed = Date.now() - progressState.startedAt;
    const m = Math.floor(elapsed / 60_000);
    const s = Math.floor((elapsed % 60_000) / 1_000);
    els.progressElapsed.textContent = `経過 ${m}:${String(s).padStart(2, "0")}`;
  }

  function maybeAdvance(step) {
    if (!progressState || progressState.cancelled) return;
    setProgressStep(step);
  }

  function setProgressNetworkWarning(on) {
    if (!els.progressTitle) return;
    const baseTitle = progressState?.themeLabel
      ? `「${progressState.themeLabel}」を生成中...`
      : "生成中...";
    els.progressTitle.textContent = on
      ? `${baseTitle} (マニフェスト取得に再試行中)`
      : baseTitle;
  }

  function showProgressFailure({ title, message, retrySlug, runUrl }) {
    if (!els.progress) return;
    if (progressState) {
      progressState.cancelled = true;
      if (progressState.timer) clearInterval(progressState.timer);
    }
    if (els.progressSteps) els.progressSteps.hidden = true;
    const cancelWrap = els.progressCancel?.parentElement;
    if (cancelWrap) cancelWrap.hidden = true;
    if (els.progressFailure) {
      if (els.progressFailureTitle && title) els.progressFailureTitle.textContent = title;
      if (els.progressFailureMsg && message) {
        // Build the optional link as a DOM node so runUrl can't inject
        // bad markup. rel=noopener + target=_blank so navigating away
        // doesn't kill the user's progress view.
        els.progressFailureMsg.textContent = message;
        if (runUrl) {
          const sep = document.createElement("span");
          sep.textContent = " ";
          const a = document.createElement("a");
          a.href = runUrl;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "GitHub Actions のログを開く →";
          a.className = "theme-progress__failure-link";
          els.progressFailureMsg.appendChild(sep);
          els.progressFailureMsg.appendChild(a);
        }
      }
      els.progressFailure.hidden = false;
      if (retrySlug && els.progressFailureRetry) {
        els.progressFailureRetry.dataset.retrySlug = retrySlug;
      }
    }
    if (els.reqSubmit) els.reqSubmit.disabled = false;
    if (els.reqInput) els.reqInput.disabled = false;
  }

  function cancelProgress() {
    if (progressState) {
      progressState.cancelled = true;
      if (progressState.timer) clearInterval(progressState.timer);
    }
    if (els.progress) els.progress.hidden = true;
    if (els.progressFailure) els.progressFailure.hidden = true;
    if (els.reqSubmit) els.reqSubmit.disabled = false;
    if (els.reqInput) els.reqInput.disabled = false;
  }

  // dataRoot() prefix so the same module works from /themes/ and
  // /lineage/ (manifest lives at /themes/themes-manifest.json in both
  // cases, but the page-relative path differs).
  function _dataRoot() {
    return (typeof PP.dataRoot === "function" ? PP.dataRoot() : "");
  }

  async function pollForCompletion(slug) {
    const startedAt = Date.now();
    let consecutiveFailures = 0;
    let pollIter = 0;
    const themeLabel = progressState?.themeLabel ?? "";
    while (progressState && !progressState.cancelled) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        showProgressFailure({
          title: "生成がタイムアウトしました (12 分経過)",
          message: "S2 / Groq LLM のレート制限、または GitHub Actions の内部エラーの可能性があります。数分後に再試行するか、既存テーマを確認してください。",
          retrySlug: slug,
        });
        return;
      }
      try {
        // cache: "no-store" is intentional — this loop fires every
        // POLL_INTERVAL_MS while the user waits, and CF Pages can serve
        // a stale manifest from the edge for ~30 s after the deploy.
        const r = await fetch(`${_dataRoot()}themes/themes-manifest.json`, { cache: "no-store" });
        if (r.ok) {
          consecutiveFailures = 0;
          const data = await r.json();
          if (Array.isArray(data) && data.some((e) => e?.slug === slug)) {
            setProgressStep("ready");
            // Brief pause so the user sees the green "完了" tick.
            setTimeout(() => {
              // Redirect back to the viewer with the new theme pinned.
              // On /lineage/ the URL param is ?theme= (same viewer);
              // the shell router picks it up.
              const loc = window.location;
              const target = new URL(loc.href);
              target.searchParams.set("theme", slug);
              window.location.href = target.toString();
            }, 800);
            return;
          }
        } else {
          consecutiveFailures++;
        }
      } catch {
        consecutiveFailures++;
      }
      if (consecutiveFailures === POLL_FAILURE_THRESHOLD) {
        setProgressNetworkWarning(true);
      } else if (consecutiveFailures === 0) {
        setProgressNetworkWarning(false);
      }
      pollIter++;
      if (pollIter % STATUS_CHECK_INTERVAL_POLLS === 0 && themeLabel && API_BASE) {
        try {
          const sr = await fetch(
            `${API_BASE}/api/themes/status?theme=${encodeURIComponent(themeLabel)}`,
            { credentials: "omit" },
          );
          if (sr.ok) {
            const sd = await sr.json();
            const fail = failureFromRun(sd?.run);
            if (fail) {
              showProgressFailure({
                title: fail.title,
                message: fail.message,
                retrySlug: slug,
                runUrl: fail.runUrl,
              });
              return;
            }
          }
        } catch {
          // Non-fatal — manifest poll + timeout still cover failure.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  function startProgress(slug, themeLabel) {
    if (els.progress) els.progress.hidden = false;
    if (els.progressTitle) els.progressTitle.textContent = `「${themeLabel}」を生成中...`;
    clearRequestStatus();
    setProgressStep("dispatch");
    progressState = {
      slug,
      themeLabel,
      startedAt: Date.now(),
      cancelled: false,
      timer: null,
    };
    if (els.progressFailure) els.progressFailure.hidden = true;
    if (els.progressSteps) els.progressSteps.hidden = false;
    const cancelWrap = els.progressCancel?.parentElement;
    if (cancelWrap) cancelWrap.hidden = false;
    setTimeout(() => maybeAdvance("queue"), 5_000);
    setTimeout(() => maybeAdvance("generate"), 30_000);
    setTimeout(() => maybeAdvance("commit"), 180_000);
    pollForCompletion(slug);
    progressState.timer = setInterval(updateElapsed, 1_000);
    updateElapsed();
  }

  async function submitTheme() {
    if (!els.reqForm || !els.reqInput) return;
    const raw = (els.reqInput.value || "").trim();
    if (!THEME_REQUEST_PATTERN.test(raw)) {
      setRequestStatus(
        "err",
        `⚠️ 2〜80 文字、英数字・スペース・ハイフン・アンダースコアのみ使用可能です。`,
      );
      return;
    }
    if (!API_BASE) {
      window.open(issueUrlFor(raw), "_blank", "noopener");
      setRequestStatus(
        "ok",
        `📝 GitHub Issue 作成画面を新規タブで開きました。送信してください。`,
      );
      return;
    }
    if (els.reqSubmit) els.reqSubmit.disabled = true;
    setRequestStatus("pending", "⏳ 送信中…");
    let resp;
    try {
      resp = await fetch(`${API_BASE}/api/themes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: raw }),
        credentials: "omit",
      });
    } catch (err) {
      if (els.reqSubmit) els.reqSubmit.disabled = false;
      const issueHref = escapeHtml(issueUrlFor(raw));
      setRequestStatus(
        "err",
        `❌ サーバに届きませんでした。<a href="${issueHref}" target="_blank" rel="noopener">GitHub Issue で送信 →</a>`,
      );
      return;
    }
    if (els.reqSubmit) els.reqSubmit.disabled = false;
    let data;
    try {
      data = await resp.json();
    } catch {
      setRequestStatus("err", `❌ サーバから不正な応答 (HTTP ${resp.status})`);
      return;
    }
    if (data?.ok && data.status === "exists" && data.slug) {
      setRequestStatus(
        "ok",
        `✅ そのテーマは既に生成済です。<a href="?theme=${encodeURIComponent(raw)}">表示する →</a>`,
      );
      return;
    }
    if (data?.ok && data.status === "queued") {
      const slug = typeof data.slug === "string" && SLUG_RE.test(data.slug) ? data.slug : null;
      if (slug) {
        startProgress(slug, raw);
        if (els.reqInput) els.reqInput.value = "";
        return;
      }
      setRequestStatus(
        "ok",
        `🚀 受付完了。生成は数分かかります。完了後にこのページを再読み込みしてください。`,
      );
      if (els.reqInput) els.reqInput.value = "";
      return;
    }
    const msg = (data && typeof data.message === "string" && data.message) ||
      `HTTP ${resp.status}`;
    setRequestStatus("err", `❌ ${escapeHtml(msg)}`);
  }

  function bind() {
    _resolveEls();
    if (!els.reqForm) return;
    els.reqForm.addEventListener("submit", (e) => {
      e.preventDefault();
      submitTheme().catch(() => {
        setRequestStatus("err", "❌ 予期しないエラーが発生しました。");
      });
    });
    if (els.reqInput) {
      els.reqInput.addEventListener("input", () => {
        clearRequestStatus();
      });
    }
    if (els.progressCancel) {
      els.progressCancel.addEventListener("click", cancelProgress);
    }
    if (els.progressFailureDismiss) {
      els.progressFailureDismiss.addEventListener("click", cancelProgress);
    }
    if (els.progressFailureRetry) {
      els.progressFailureRetry.addEventListener("click", () => {
        const retrySlug = els.progressFailureRetry.dataset.retrySlug || "";
        cancelProgress();
        if (retrySlug && els.reqInput) {
          els.reqInput.value = retrySlug
            .replace(/-/g, " ")
            .replace(/\b[a-z]/g, (c) => c.toUpperCase());
          els.reqInput.focus();
        }
      });
    }
  }

  // Auto-bind on load so existing /themes/index.html keeps working
  // without an explicit call site. /lineage/ loads the same script
  // and relies on the same auto-bind.
  bind();

  root.PPThemeRequest = {
    bind,
    submitTheme,
    cancelProgress,
    setRequestStatus,
    clearRequestStatus,
    issueUrlFor,
  };
})(window);
