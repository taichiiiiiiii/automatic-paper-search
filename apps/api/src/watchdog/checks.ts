// R1-6 / design 50 P1-1: production checks run by the Worker's Cron
// Trigger (replaces the Mac-only ~/.hermes/scripts/paperpilot_watchdog.sh).
//
// Every check is a plain async function over an injected `fetch`, returns
// a list of problems (empty = healthy), and never throws: a network error
// is itself reported as a problem. Each problem carries a stable `key`
// used for de-duplication (alert.ts) and a human-readable `message`
// (Japanese, like the old script, because it ends up in a GitHub issue
// the owner reads).

import { createHealthHandler } from "../routes/health.js";
import type { Env } from "../types.js";

export interface Problem {
  /** Stable identity of the problem (same problem on the next run = same key). */
  key: string;
  message: string;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Pages that must answer 200 (no redirect follow, like `curl` without `-L`). */
export const WATCHDOG_SITE_PATHS: readonly string[] = ["/", "/themes/", "/how-it-works/"];

/** Old GitHub Pages site: a redirect page that must keep answering 200. */
export const LEGACY_SITE_URL = "https://taichiiiiiiii.github.io/automatic-paper-search/";

/**
 * Workflows whose latest develop run must not have failed. `alert.yml` is
 * deliberately absent (a failing alert run must not trigger another alert).
 */
export const WATCHDOG_WORKFLOWS: readonly string[] = [
  "pages.yml",
  "tests.yml",
  "data-audit.yml",
  "regen-themes.yml",
  "theme-on-demand.yml",
  "regen-retry.yml",
  "conference-watch.yml",
];

/** Conclusions of a completed run that are not a problem. */
const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** Alert when the dispatch PAT expires in fewer than this many days. */
export const PAT_EXPIRY_WARN_DAYS = 14;
/** Second, louder alert (new dedupe key) inside this window. */
export const PAT_EXPIRY_URGENT_DAYS = 3;

/** R2-6: a theme stuck in regen-pending after this many attempts needs a human. */
export const REGEN_PENDING_MAX_ATTEMPTS = 5;

const TIMEOUT_MS = 15_000;
const USER_AGENT = "paperpilot-watchdog";

function signal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function githubHeaders(pat: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": USER_AGENT,
  };
  if (pat?.trim()) headers.authorization = `Bearer ${pat}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Site pages
// ---------------------------------------------------------------------------

export async function checkPages(
  fetchImpl: FetchLike,
  siteOrigin: string,
  paths: readonly string[] = WATCHDOG_SITE_PATHS,
): Promise<Problem[]> {
  const urls = [...paths.map((p) => `${siteOrigin}${p}`), LEGACY_SITE_URL];
  const results = await Promise.all(
    urls.map(async (url): Promise<Problem | null> => {
      try {
        const resp = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": USER_AGENT },
          signal: signal(),
        });
        // Drain the body so the connection is released.
        await resp.arrayBuffer().catch(() => undefined);
        if (resp.status === 200) return null;
        return { key: `page:${url}`, message: `${url} が ${resp.status}` };
      } catch (error) {
        return { key: `page:${url}`, message: `${url} に接続できない（${errText(error)}）` };
      }
    }),
  );
  return results.filter((p): p is Problem => p !== null);
}

// ---------------------------------------------------------------------------
// /api/health (in-process: a Worker cannot reliably fetch its own
// workers.dev URL, so the same handler is called directly — this checks
// the KV flags and the PAT binding, not public reachability)
// ---------------------------------------------------------------------------

export async function checkHealth(env: Env): Promise<Problem[]> {
  const problems: Problem[] = [];
  try {
    const resp = await createHealthHandler()(
      new Request("https://watchdog.internal/api/health"),
      env,
    );
    const body = (await resp.json()) as Record<string, unknown>;
    if (body.pat_configured !== true) {
      problems.push({ key: "health:pat", message: "Worker の GH_DISPATCH_PAT が設定されていない" });
    }
    if (body.accepting !== true) {
      problems.push({
        key: "health:accepting",
        message: "Worker の受付が止まっている（KV の accepting が true でない）",
      });
    }
    if (body.dispatch_mode !== "live") {
      problems.push({
        key: "health:dispatch_mode",
        message: `Worker の DISPATCH_MODE が live でない（${String(body.dispatch_mode)}）`,
      });
    }
  } catch (error) {
    problems.push({ key: "health:error", message: `/api/health が失敗（${errText(error)}）` });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Published themes (lineage-quality-v1.json)
// ---------------------------------------------------------------------------

interface QualityRow {
  kind?: unknown;
  availability?: unknown;
  publication_tier?: unknown;
}

/** Themes the site shows: kind=theme, ready, tier audited or unaudited. */
export function countPublishedThemes(quality: unknown): number {
  const rows = (quality as { collections?: unknown })?.collections;
  if (!Array.isArray(rows)) throw new Error("collections is not an array");
  return (rows as QualityRow[]).filter(
    (r) =>
      r.kind === "theme" &&
      r.availability === "ready" &&
      (r.publication_tier === "audited" || r.publication_tier === "unaudited"),
  ).length;
}

export interface ThemesCheck {
  problems: Problem[];
  /** Current count, or null when the file could not be read. */
  count: number | null;
}

export async function checkPublishedThemes(
  fetchImpl: FetchLike,
  siteOrigin: string,
  previousCount: number | null,
): Promise<ThemesCheck> {
  const url = `${siteOrigin}/lineage-quality-v1.json`;
  let count: number;
  try {
    const resp = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: signal(),
    });
    if (!resp.ok) {
      await resp.arrayBuffer().catch(() => undefined);
      return {
        problems: [{ key: "themes:fetch", message: `${url} が ${resp.status}` }],
        count: null,
      };
    }
    count = countPublishedThemes(await resp.json());
  } catch (error) {
    return {
      problems: [{ key: "themes:fetch", message: `${url} を読めない（${errText(error)}）` }],
      count: null,
    };
  }
  const problems: Problem[] = [];
  if (count < 1) {
    problems.push({ key: "themes:none", message: "公開中のテーマが 0 件になっている" });
  } else if (previousCount !== null && count < previousCount) {
    problems.push({
      key: `themes:drop:${previousCount}->${count}`,
      message: `公開中のテーマが ${previousCount} 件から ${count} 件に減った（意図した変更なら対応不要。次回からは ${count} 件を基準にする）`,
    });
  }
  return { problems, count };
}

// ---------------------------------------------------------------------------
// GitHub: latest develop runs + PAT expiry
// ---------------------------------------------------------------------------

/**
 * Parses GitHub's `github-authentication-token-expiration` header, e.g.
 * `2027-01-07 00:00:00 UTC` or `2027-01-07 09:00:00 +0900`. Returns null
 * when absent or unparseable.
 */
export function parseTokenExpiration(raw: string | null): Date | null {
  if (!raw) return null;
  const m = raw
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const [, date, time, zone] = m;
  let offset = "Z";
  if (zone && zone !== "UTC" && zone !== "Z") {
    offset = zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  }
  const d = new Date(`${date}T${time}${offset}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function patExpiryProblems(expiresAt: Date | null, now: Date): Problem[] {
  if (!expiresAt) return [];
  const days = (expiresAt.getTime() - now.getTime()) / 86_400_000;
  if (days >= PAT_EXPIRY_WARN_DAYS) return [];
  const date = expiresAt.toISOString().slice(0, 10);
  const bucket = days < PAT_EXPIRY_URGENT_DAYS ? "urgent" : "warn";
  const left = days <= 0 ? "すでに失効している" : `あと ${Math.max(0, Math.floor(days))} 日`;
  return [
    {
      key: `pat:expiry:${date}:${bucket}`,
      message: `Worker の GH_DISPATCH_PAT が ${date} に失効する（${left}）。新しい PAT を作り \`wrangler secret put GH_DISPATCH_PAT\` で入れ替える（runbook「運用: 秘密と期限」）`,
    },
  ];
}

interface WorkflowRun {
  id?: number;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  created_at?: string;
}

export interface GithubCheck {
  problems: Problem[];
  /** From the first authenticated response that carried the header. */
  patExpiresAt: Date | null;
}

export async function checkWorkflows(
  fetchImpl: FetchLike,
  env: Pick<Env, "GH_OWNER" | "GH_REPO" | "GH_REF" | "GH_DISPATCH_PAT">,
  workflows: readonly string[] = WATCHDOG_WORKFLOWS,
): Promise<GithubCheck> {
  const problems: Problem[] = [];
  let patExpiresAt: Date | null = null;
  let authProblem = false;
  for (const wf of workflows) {
    const url =
      `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${wf}/runs` +
      `?branch=${encodeURIComponent(env.GH_REF)}&per_page=1&exclude_pull_requests=true`;
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        headers: githubHeaders(env.GH_DISPATCH_PAT),
        redirect: "manual",
        signal: signal(),
      });
    } catch (error) {
      problems.push({
        key: `github:${wf}:error`,
        message: `GitHub API（${wf}）に接続できない（${errText(error)}）`,
      });
      continue;
    }
    patExpiresAt ??= parseTokenExpiration(
      resp.headers.get("github-authentication-token-expiration"),
    );
    if (resp.status === 401 || resp.status === 403) {
      await resp.arrayBuffer().catch(() => undefined);
      if (!authProblem) {
        authProblem = true;
        problems.push({
          key: `github:auth:${resp.status}`,
          message: `GitHub API が ${resp.status}（GH_DISPATCH_PAT が失効・権限不足の可能性。通知と予定実行も止まる）`,
        });
      }
      continue;
    }
    // 404: workflow not on the ref yet (e.g. a new file before merge) — not a problem.
    if (resp.status === 404) {
      await resp.arrayBuffer().catch(() => undefined);
      continue;
    }
    if (!resp.ok) {
      await resp.arrayBuffer().catch(() => undefined);
      problems.push({ key: `github:${wf}:http`, message: `GitHub API（${wf}）が ${resp.status}` });
      continue;
    }
    let run: WorkflowRun | undefined;
    try {
      const body = (await resp.json()) as { workflow_runs?: WorkflowRun[] };
      run = body.workflow_runs?.[0];
    } catch (error) {
      problems.push({
        key: `github:${wf}:parse`,
        message: `GitHub API（${wf}）の応答を読めない（${errText(error)}）`,
      });
      continue;
    }
    if (!run || run.status !== "completed") continue;
    const conclusion = run.conclusion ?? "unknown";
    if (OK_CONCLUSIONS.has(conclusion)) continue;
    problems.push({
      key: `workflow:${wf}:${run.id ?? "?"}`,
      message: `${wf} の最新の実行（${env.GH_REF}）が ${conclusion}: ${run.html_url ?? "?"}（${run.created_at ?? "?"}）`,
    });
  }
  return { problems, patExpiresAt };
}

// ---------------------------------------------------------------------------
// R2-6: themes stuck in regen-pending.json (absent file = nothing pending)
// ---------------------------------------------------------------------------

export async function checkRegenPending(
  fetchImpl: FetchLike,
  env: Pick<Env, "GH_OWNER" | "GH_REPO" | "GH_REF">,
): Promise<Problem[]> {
  const url = `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${env.GH_REF}/data/state/lineage-cache/regen-pending.json`;
  try {
    const resp = await fetchImpl(url, { headers: { "user-agent": USER_AGENT }, signal: signal() });
    if (resp.status === 404) {
      await resp.arrayBuffer().catch(() => undefined);
      return [];
    }
    if (!resp.ok) {
      await resp.arrayBuffer().catch(() => undefined);
      return [{ key: "regen-pending:http", message: `regen-pending.json の取得が ${resp.status}` }];
    }
    const body = (await resp.json()) as { themes?: Array<Record<string, unknown>> };
    const stuck = (body.themes ?? []).filter(
      (t) =>
        (typeof t.attempts === "number" && t.attempts >= REGEN_PENDING_MAX_ATTEMPTS) ||
        t.reason !== "llm_quota",
    );
    if (stuck.length === 0) return [];
    const names = stuck.map(
      (t) => `${String(t.theme)}（${String(t.reason)}, ${String(t.attempts)}回）`,
    );
    return [
      {
        key: `regen-pending:${stuck
          .map((t) => String(t.theme))
          .sort()
          .join(",")}`,
        message: `系譜の再生成が自動再試行で解消していないテーマ: ${names.join(", ")}`,
      },
    ];
  } catch (error) {
    return [
      { key: "regen-pending:error", message: `regen-pending.json を読めない（${errText(error)}）` },
    ];
  }
}
