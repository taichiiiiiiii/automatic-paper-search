// R1-6 / design 50 P1-1 + P1-4: the Worker's `scheduled()` handler.
//
// One Cron Trigger (wrangler.jsonc `triggers.crons`, daily 00:30 UTC; the
// account allows only 5 cron triggers on the Free plan) does two jobs:
//
//   1. Watchdog: runs the checks in ./checks.ts. When the set of problems
//      changes, it dispatches `.github/workflows/alert.yml`, which opens
//      (or comments on) ONE open issue labelled `watchdog` with
//      GITHUB_TOKEN — GitHub then e-mails the owner. The same problem set
//      is not re-sent (dedupe state in KV), except a weekly reminder while
//      it persists; when everything is healthy again, a `resolved` dispatch
//      comments and closes the issue.
//   2. Weekly scheduler (P1-4): on Mondays it dispatches
//      `conference-watch.yml` (the R3 new-edition watcher). GitHub's own
//      `schedule:` runs hours late and stops after 60 idle days, so the
//      Worker is the clock.
//
// Never throws out of the handler: every failure becomes a problem or a
// log line (Workers Logs, `observability.enabled`).

import { PUBLIC_ORIGIN } from "@paperpilot/core/site";
import type { Env } from "../types.js";
import {
  checkHealth,
  checkPages,
  checkPublishedThemes,
  checkRegenPending,
  checkWorkflows,
  type FetchLike,
  githubHeaders,
  type Problem,
  patExpiryProblems,
} from "./checks.js";

export const ALERT_WORKFLOW_FILE = "alert.yml";
export const CONFERENCE_WATCH_WORKFLOW_FILE = "conference-watch.yml";
/** UTC weekday (0 = Sunday) on which conference-watch.yml is dispatched. */
export const CONFERENCE_WATCH_WEEKDAY = 1;
/** R4-3 per-theme new-paper feeds, dispatched on the same weekday. */
export const THEME_FEEDS_WORKFLOW_FILE = "theme-feeds.yml";
/** Window passed to theme-feeds.yml: a week of runs plus OpenAlex's indexing lag. */
export const THEME_FEEDS_DAYS = "45";
/** KV key (CONFIG_KV) holding {@link WatchdogState} as JSON. */
export const KV_KEY_WATCHDOG_STATE = "watchdog_state";
/** Re-send an unchanged, still-open problem set after this long. */
export const REMINDER_INTERVAL_MS = 7 * 86_400_000;
/** workflow_dispatch input values are capped well below GitHub's 65,535 limit. */
export const MAX_SUMMARY_CHARS = 6000;

export interface WatchdogKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface WatchdogState {
  /** Sorted problem keys of the last successfully dispatched alert ("" = none open). */
  alerted_fingerprint: string;
  alerted_at: string | null;
  /** Published-theme baseline for the drop check. */
  published_themes: number | null;
  last_run_at: string | null;
}

export const EMPTY_STATE: WatchdogState = {
  alerted_fingerprint: "",
  alerted_at: null,
  published_themes: null,
  last_run_at: null,
};

export function parseState(raw: string | null): WatchdogState {
  if (!raw) return { ...EMPTY_STATE };
  try {
    const v = JSON.parse(raw) as Partial<WatchdogState>;
    return {
      alerted_fingerprint: typeof v.alerted_fingerprint === "string" ? v.alerted_fingerprint : "",
      alerted_at: typeof v.alerted_at === "string" ? v.alerted_at : null,
      published_themes:
        typeof v.published_themes === "number" && Number.isFinite(v.published_themes)
          ? v.published_themes
          : null,
      last_run_at: typeof v.last_run_at === "string" ? v.last_run_at : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function fingerprint(problems: readonly Problem[]): string {
  return [...new Set(problems.map((p) => p.key))].sort().join("\n");
}

export type AlertDecision =
  | { action: "none" }
  | { action: "problem"; reason: "new" | "reminder" }
  | { action: "resolved" };

export function decideAlert(
  problems: readonly Problem[],
  state: WatchdogState,
  now: Date,
): AlertDecision {
  const fp = fingerprint(problems);
  if (problems.length === 0) {
    return state.alerted_fingerprint ? { action: "resolved" } : { action: "none" };
  }
  if (fp !== state.alerted_fingerprint) return { action: "problem", reason: "new" };
  const last = state.alerted_at ? Date.parse(state.alerted_at) : Number.NaN;
  if (Number.isNaN(last) || now.getTime() - last >= REMINDER_INTERVAL_MS) {
    return { action: "problem", reason: "reminder" };
  }
  return { action: "none" };
}

export function buildSummary(
  problems: readonly Problem[],
  previousFingerprint: string,
  decision: AlertDecision,
  now: Date,
): string {
  const at = now.toISOString();
  if (decision.action === "resolved") {
    return `${at} の見張りでは問題は見つかりませんでした（前回までの問題は解消）。`;
  }
  const before = new Set(previousFingerprint ? previousFingerprint.split("\n") : []);
  const lines = problems.map((p) => `- ${before.has(p.key) ? "" : "🆕 "}${p.message}`);
  const head =
    decision.action === "problem" && decision.reason === "reminder"
      ? `${at} の見張り: 次の問題が続いています（7 日ごとの再通知）。`
      : `${at} の見張りで問題が見つかりました。`;
  const text = `${head}\n\n${lines.join("\n")}`;
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
}

export async function dispatchWorkflowFile(
  fetchImpl: FetchLike,
  env: Pick<Env, "GH_OWNER" | "GH_REPO" | "GH_REF" | "GH_DISPATCH_PAT">,
  workflowFile: string,
  inputs: Record<string, string>,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (!env.GH_DISPATCH_PAT?.trim()) return { ok: false, detail: "GH_DISPATCH_PAT is not set" };
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${workflowFile}/dispatches`;
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: { ...githubHeaders(env.GH_DISPATCH_PAT), "content-type": "application/json" },
      body: JSON.stringify({ ref: env.GH_REF, inputs }),
    });
    if (resp.ok) return { ok: true };
    const body = (await resp.text().catch(() => "")).split(env.GH_DISPATCH_PAT).join("[redacted]");
    return { ok: false, detail: `${resp.status} ${body.slice(0, 300)}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface ScheduledDeps {
  fetch: FetchLike;
  kv: WatchdogKv;
  now?: () => Date;
  log?: (message: string) => void;
  siteOrigin?: string;
}

export interface ScheduledResult {
  problems: Problem[];
  decision: AlertDecision;
  alertDispatched: boolean;
  conferenceWatchDispatched: boolean;
  themeFeedsDispatched: boolean;
  state: WatchdogState;
}

export async function runScheduled(
  env: Env,
  scheduledTime: number,
  deps: ScheduledDeps,
): Promise<ScheduledResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ? deps.now() : new Date(scheduledTime);
  const site = deps.siteOrigin ?? PUBLIC_ORIGIN;

  let rawState: string | null = null;
  try {
    rawState = await deps.kv.get(KV_KEY_WATCHDOG_STATE);
  } catch (error) {
    log(`watchdog: KV read failed: ${String(error)}`);
  }
  const state = parseState(rawState);

  const [pages, health, themes, github, pending] = await Promise.all([
    checkPages(deps.fetch, site),
    checkHealth(env),
    checkPublishedThemes(deps.fetch, site, state.published_themes),
    checkWorkflows(deps.fetch, env),
    checkRegenPending(deps.fetch, env),
  ]);
  const problems: Problem[] = [
    ...health,
    ...pages,
    ...themes.problems,
    ...github.problems,
    ...patExpiryProblems(github.patExpiresAt, now),
    ...pending,
  ];

  // Only the production (live) Worker dispatches anything; a preview /
  // `wrangler dev --test-scheduled` run checks and logs only.
  const live = env.DISPATCH_MODE === "live";
  if (!live) log("watchdog: DISPATCH_MODE is not live — checks only, no dispatch");

  // P1-4: weekly R3 new-edition watcher (GitHub's schedule is unreliable).
  let conferenceWatchDispatched = false;
  if (live && new Date(scheduledTime).getUTCDay() === CONFERENCE_WATCH_WEEKDAY) {
    const r = await dispatchWorkflowFile(deps.fetch, env, CONFERENCE_WATCH_WORKFLOW_FILE, {});
    if (r.ok) {
      conferenceWatchDispatched = true;
    } else {
      problems.push({
        key: "dispatch:conference-watch",
        message: `conference-watch.yml を起動できなかった（${r.detail}）`,
      });
    }
  }

  // R4-3: weekly new-paper feeds (OpenAlex citing works; ~$0.01 a run).
  let themeFeedsDispatched = false;
  if (live && new Date(scheduledTime).getUTCDay() === CONFERENCE_WATCH_WEEKDAY) {
    const r = await dispatchWorkflowFile(deps.fetch, env, THEME_FEEDS_WORKFLOW_FILE, {
      days: THEME_FEEDS_DAYS,
    });
    if (r.ok) {
      themeFeedsDispatched = true;
    } else {
      problems.push({
        key: "dispatch:theme-feeds",
        message: `theme-feeds.yml を起動できなかった（${r.detail}）`,
      });
    }
  }

  const decision = decideAlert(problems, state, now);
  const next: WatchdogState = {
    ...state,
    published_themes:
      themes.count !== null && themes.count >= 1 ? themes.count : state.published_themes,
    last_run_at: now.toISOString(),
  };
  let alertDispatched = false;
  if (live && decision.action !== "none") {
    const summary = buildSummary(problems, state.alerted_fingerprint, decision, now);
    const r = await dispatchWorkflowFile(deps.fetch, env, ALERT_WORKFLOW_FILE, {
      status: decision.action,
      summary,
    });
    if (r.ok) {
      alertDispatched = true;
      next.alerted_fingerprint = decision.action === "resolved" ? "" : fingerprint(problems);
      next.alerted_at = decision.action === "resolved" ? null : now.toISOString();
    } else {
      // State is not advanced: the next run retries the same alert.
      log(`watchdog: alert dispatch failed: ${r.detail}`);
    }
  }

  log(
    `watchdog: ${problems.length} problem(s); decision=${decision.action}; ` +
      `alert=${alertDispatched}; conference-watch=${conferenceWatchDispatched}; ` +
      `theme-feeds=${themeFeedsDispatched}` +
      (problems.length ? `\n${problems.map((p) => `  - ${p.key}`).join("\n")}` : ""),
  );
  try {
    await deps.kv.put(KV_KEY_WATCHDOG_STATE, JSON.stringify(next));
  } catch (error) {
    log(`watchdog: KV write failed: ${String(error)}`);
  }
  return {
    problems,
    decision,
    alertDispatched,
    conferenceWatchDispatched,
    themeFeedsDispatched,
    state: next,
  };
}
