// Vercel Function: receives the on-site theme-submit form and turns
// each request into a GitHub Issue with the `theme-request` label.
// The label fires `.github/workflows/dispatch-on-theme-request.yml`,
// which workflow_dispatches `theme-on-demand.yml` to generate the
// lineage. The Function does NOT have actions:write — it only owns
// issues:write — so the worst-case abuse of leaking the PAT is a
// flood of `theme-request` Issues, not arbitrary workflow runs.
//
// Why a Function (and not direct GitHub API from browser): creating
// an Issue requires an authenticated PAT, and we can't ship that in
// JS without exposing it. The Function lives between the form and
// GitHub so the PAT stays on the server.
//
// Deploy: drop this file under `api/` in a Vercel project linked to
// the repo. Vercel auto-detects the file and routes `POST /api/themes`
// to it. Configure `GH_TOKEN` in the Vercel project settings; the
// owner/repo come from `process.env.GH_OWNER` / `GH_REPO` defaults
// hard-coded below since they're public and never change.

const GH_OWNER = process.env.GH_OWNER || "taichiiiiiiii";
const GH_REPO = process.env.GH_REPO || "automatic-paper-search";
const GH_REF = process.env.GH_REF || "develop";
const GH_TOKEN = process.env.GH_TOKEN;

// Mirror of paperpilot/scripts/_common._SLUG_ALLOWED_RE input shape
// + the worker's THEME_PATTERN. 2-80 chars, ASCII alphanum + space +
// underscore + hyphen only. Same set the slug derivation accepts so
// a successful submit always resolves to a valid Python slug.
const THEME_PATTERN = /^[A-Za-z0-9 _-]{2,80}$/;
const RATIONALE_MAX = 1000;

// 5 min minimum gap between duplicate-text submissions from the same
// IP. The Function is stateless so we can only check this in-memory
// per-instance — good enough to absorb the accidental double-click,
// not a real rate limiter. For sustained-abuse protection, attach a
// KV (Vercel KV / Upstash) and persist a counter; this MVP relies on
// the PAT scope cap (issues:write only) instead.
const RECENT = new Map();
const RECENT_TTL_MS = 5 * 60 * 1000;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...(init.headers || {}),
    },
  });
}

function slugify(theme) {
  // Mirror of paperpilot/scripts/_common.theme_slug(): lowercase, replace
  // any non-alphanum with "-", collapse runs, trim, 64-char cap.
  return theme
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function fetchExistingSlugs() {
  // raw.githubusercontent.com has a ~5 min CDN cache that mirrors the
  // freshness we want: a theme committed in the last few minutes will
  // appear here within roughly the same window. A non-200 means we
  // can't be sure — return null and the caller treats it as "unknown,
  // proceed but log".
  const url = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_REF}/docs/themes/themes-manifest.json`;
  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json();
    return new Set(
      Array.isArray(data) ? data.map((e) => e?.slug).filter(Boolean) : [],
    );
  } catch {
    return null;
  }
}

async function findOpenThemeIssue(theme) {
  // De-dupe against open issues so a refresh-and-resubmit doesn't
  // create a second Issue for the same theme. GitHub search API
  // returns only matching items so the result count is the dedup
  // signal.
  const q = encodeURIComponent(
    `repo:${GH_OWNER}/${GH_REPO} is:issue is:open label:theme-request "[theme request] ${theme}" in:title`,
  );
  const url = `https://api.github.com/search/issues?q=${q}`;
  const resp = await fetch(url, {
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "paperpilot-theme-submit/1.0",
    },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.items?.[0] || null;
}

async function createIssue(theme, rationale) {
  const title = `[theme request] ${theme}`;
  const bodyLines = [
    `## 希望テーマ`,
    theme,
    "",
    `## 理由 / 背景`,
    rationale || "(in-browser form submission)",
    "",
    `---`,
    `_Submitted via the on-site form (api/themes.js)._`,
  ];
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/issues`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "paperpilot-theme-submit/1.0",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title,
      body: bodyLines.join("\n"),
      labels: ["theme-request"],
    }),
  });
  if (!resp.ok) {
    return { ok: false, status: resp.status, body: await resp.text() };
  }
  const data = await resp.json();
  return {
    ok: true,
    status: 200,
    issue_number: data.number,
    issue_url: data.html_url,
  };
}

async function handlePost(request) {
  if (!GH_TOKEN) {
    return json(
      {
        ok: false,
        status: "error",
        message: "server misconfigured: GH_TOKEN missing",
      },
      { status: 500 },
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(
      { ok: false, status: "invalid", message: "invalid JSON body" },
      { status: 400 },
    );
  }

  const theme = String(payload?.theme || "").trim();
  const rationale = String(payload?.rationale || "").trim().slice(0, RATIONALE_MAX);
  if (!THEME_PATTERN.test(theme)) {
    return json(
      {
        ok: false,
        status: "invalid",
        message: "テーマは 2〜80 文字、英数字 + スペース + ハイフン + アンダースコアのみ使用可能です",
      },
      { status: 400 },
    );
  }

  // Double-click guard.
  const ip = request.headers.get("x-forwarded-for") || "unknown";
  const dedupKey = `${ip}|${theme.toLowerCase()}`;
  const now = Date.now();
  for (const [k, t] of RECENT.entries()) {
    if (now - t > RECENT_TTL_MS) RECENT.delete(k);
  }
  if (RECENT.has(dedupKey)) {
    return json(
      {
        ok: false,
        status: "rate_limited",
        message: "同じテーマが連続送信されました。5 分後に再試行してください",
      },
      { status: 429 },
    );
  }
  RECENT.set(dedupKey, now);

  const slug = slugify(theme);
  const existing = await fetchExistingSlugs();
  if (existing && existing.has(slug)) {
    return json({
      ok: true,
      status: "exists",
      slug,
      message: `テーマ "${theme}" は既に生成済です`,
    });
  }

  const open = await findOpenThemeIssue(theme);
  if (open) {
    return json({
      ok: true,
      status: "pending",
      slug,
      issue_number: open.number,
      issue_url: open.html_url,
      message: `テーマ "${theme}" は既にリクエスト済 (Issue #${open.number})`,
    });
  }

  const result = await createIssue(theme, rationale);
  if (!result.ok) {
    return json(
      {
        ok: false,
        status: "error",
        message: `GitHub Issue 作成失敗 (HTTP ${result.status})`,
      },
      { status: 502 },
    );
  }
  return json({
    ok: true,
    status: "queued",
    slug,
    issue_number: result.issue_number,
    issue_url: result.issue_url,
    message: `テーマ "${theme}" を Issue #${result.issue_number} として登録しました`,
  });
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "POST") {
    return json(
      { ok: false, status: "invalid", message: "method not allowed" },
      { status: 405 },
    );
  }
  return handlePost(request);
}

// Vercel Edge Runtime config. Edge is faster + cheaper for this
// workload (no Node-specific APIs are used). Default region keeps
// p99 close to the GitHub API region the function calls into.
export const config = { runtime: "edge" };

// Exported for the unit tests in api/themes.test.mjs — node:test can
// import { slugify, THEME_PATTERN } and pin the slug derivation that
// must match paperpilot/scripts/_common.theme_slug().
export { slugify, THEME_PATTERN };
