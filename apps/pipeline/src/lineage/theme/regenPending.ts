/**
 * Pending-regeneration state for quota-degraded themes (design 41 D3,
 * R2-6: "上限切れが原因なら、後で自動的に作り直す").
 *
 * `regen-themes.yml` runs the theme CLI once per theme with
 * `--result-json`, then {@link recordResults} folds those outcomes into
 * `data/state/lineage-cache/regen-pending.json` (promoted with the
 * candidate, so it survives on develop even when every theme failed):
 *
 *  - `ok` → the theme leaves the pending list;
 *  - `degraded_classification` with an LLM daily limit hit → pending with
 *    reason `llm_quota` (attempts incremented) — retried automatically;
 *  - any other failure of a theme that is already pending → its reason is
 *    updated (and it stops being retried: the quota was not the cause);
 *  - other failures of non-pending themes are not recorded (the job
 *    summary and the failed run report them).
 *
 * `regen-retry.yml` (daily cron) reads {@link retryThemes} and dispatches
 * `regen-themes.yml` for them. A theme stops being retried after
 * `maxAttempts` quota-degraded attempts and stays listed for a human.
 */

import { readFileSync } from "node:fs";
import { atomicWriteText } from "../../collect/state/atomic.js";

export const REGEN_PENDING_SCHEMA = "regen-pending-v1";
export const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
export const QUOTA_REASON = "llm_quota";

export interface PendingTheme {
  theme: string;
  reason: string;
  attempts: number;
  first_failed_at: string;
  last_attempt_at: string;
  message: string;
}

export interface RegenPending {
  schema_version: typeof REGEN_PENDING_SCHEMA;
  themes: PendingTheme[];
}

/** The subset of the theme CLI's `--result-json` this module reads. */
export interface RunResultLike {
  theme: string;
  status: string;
  daily_limit_hit?: boolean;
  message?: string;
}

export function emptyPending(): RegenPending {
  return { schema_version: REGEN_PENDING_SCHEMA, themes: [] };
}

/** Read the state file; missing/unreadable/foreign files read as empty. */
export function loadPending(path: string): RegenPending {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return emptyPending();
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    (raw as { schema_version?: unknown }).schema_version !== REGEN_PENDING_SCHEMA ||
    !Array.isArray((raw as { themes?: unknown }).themes)
  ) {
    return emptyPending();
  }
  const themes: PendingTheme[] = [];
  for (const t of (raw as { themes: unknown[] }).themes) {
    if (t === null || typeof t !== "object") continue;
    const e = t as Record<string, unknown>;
    if (typeof e.theme !== "string" || typeof e.reason !== "string") continue;
    themes.push({
      theme: e.theme,
      reason: e.reason,
      attempts: typeof e.attempts === "number" && e.attempts >= 0 ? Math.trunc(e.attempts) : 0,
      first_failed_at: typeof e.first_failed_at === "string" ? e.first_failed_at : "",
      last_attempt_at: typeof e.last_attempt_at === "string" ? e.last_attempt_at : "",
      message: typeof e.message === "string" ? e.message : "",
    });
  }
  return { schema_version: REGEN_PENDING_SCHEMA, themes };
}

/** Deterministic serialization (sorted by theme), newline-terminated. */
export function serializePending(state: RegenPending): string {
  const themes = [...state.themes].sort((a, b) =>
    a.theme < b.theme ? -1 : a.theme > b.theme ? 1 : 0,
  );
  return `${JSON.stringify({ schema_version: REGEN_PENDING_SCHEMA, themes }, null, 2)}\n`;
}

export function savePending(path: string, state: RegenPending): void {
  atomicWriteText(path, serializePending(state));
}

/** Fold one run's results into the state (pure; see module doc). */
export function recordResults(
  state: RegenPending,
  results: readonly RunResultLike[],
  at: string,
): RegenPending {
  const byTheme = new Map(state.themes.map((t) => [t.theme, { ...t }]));
  for (const r of results) {
    const prev = byTheme.get(r.theme);
    if (r.status === "ok") {
      byTheme.delete(r.theme);
      continue;
    }
    const quota = r.status === "degraded_classification" && r.daily_limit_hit === true;
    const message = (r.message ?? "").slice(0, 300);
    if (quota) {
      byTheme.set(r.theme, {
        theme: r.theme,
        reason: QUOTA_REASON,
        attempts: (prev?.attempts ?? 0) + 1,
        first_failed_at: prev?.first_failed_at || at,
        last_attempt_at: at,
        message,
      });
    } else if (prev) {
      byTheme.set(r.theme, {
        ...prev,
        reason: r.status,
        attempts: prev.attempts + 1,
        last_attempt_at: at,
        message,
      });
    }
  }
  return { schema_version: REGEN_PENDING_SCHEMA, themes: [...byTheme.values()] };
}

/** Themes the scheduled retry should regenerate (quota reason, under the attempt cap). */
export function retryThemes(
  state: RegenPending,
  maxAttempts: number = DEFAULT_MAX_RETRY_ATTEMPTS,
): string[] {
  return state.themes
    .filter((t) => t.reason === QUOTA_REASON && t.attempts < maxAttempts)
    .map((t) => t.theme)
    .sort();
}
