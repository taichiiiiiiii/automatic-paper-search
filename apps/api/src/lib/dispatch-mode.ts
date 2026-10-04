// New per §4.5: explicit DISPATCH_MODE=dry-run|live binding, checked before
// any subrequest or quota charge so a misconfigured preview never silently
// no-ops a request the caller believes is "queued", and a misconfigured
// production deploy never dry-runs for real traffic.
//
// Order note (see src/routes/themes.ts): this check runs AFTER input
// validation (so a malformed body still gets its ordinary 400) but BEFORE
// the manifest fetch, cf-connecting-ip check, and quota — matching the
// "no charge, no subrequest" requirement for every one of these refusals.

import type { DispatchMode } from "../config.js";
import { PRODUCTION_GH_REF, PRODUCTION_ORIGINS } from "../config.js";

export interface DispatchModeEnv {
  DISPATCH_MODE?: string;
  GH_REF: string;
  GH_DISPATCH_PAT?: string;
}

export type DispatchModeCheck = { ok: true; mode: DispatchMode } | { ok: false; message: string };

/**
 * @param matchedOrigin the origin resolved by the allowlist check for this
 *   request (undefined only in contexts that never reach this check).
 */
export function checkDispatchMode(
  env: DispatchModeEnv,
  matchedOrigin: string | undefined,
): DispatchModeCheck {
  if (env.DISPATCH_MODE !== "dry-run" && env.DISPATCH_MODE !== "live") {
    return { ok: false, message: "dispatch mode is not configured" };
  }
  if (env.DISPATCH_MODE === "live") {
    if (!env.GH_DISPATCH_PAT || !env.GH_DISPATCH_PAT.trim()) {
      return { ok: false, message: "could not start the generation job; please retry shortly" };
    }
    return { ok: true, mode: "live" };
  }
  // dry-run: refuse when it looks like it's actually pointed at production
  // (misconfiguration guard — §4.5 "設定ミスで本番が空打ちになるのを防ぐ").
  if (env.GH_REF === PRODUCTION_GH_REF) {
    return { ok: false, message: "dry-run mode refuses to run against the production ref" };
  }
  if (matchedOrigin && PRODUCTION_ORIGINS.includes(matchedOrigin)) {
    return { ok: false, message: "dry-run mode refuses to run for the production origin" };
  }
  return { ok: true, mode: "dry-run" };
}
