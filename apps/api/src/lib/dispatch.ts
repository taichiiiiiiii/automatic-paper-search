// TS port of the dispatch half of worker/themes-post.js (dispatchWorkflow),
// extended for §4.5's dry-run dispatcher: in "dry-run" mode, no outbound
// fetch is made at all — the would-be dispatch is recorded via the
// injected `log` sink instead — and the caller must report `status:
// "dry_run"`, never `"queued"`.
//
// API-17 / inventory weakness #7: the non-ok GitHub response body is
// logged for operators, but truncated to 500 chars and with the PAT
// substring stripped first (defence in depth — the PAT is never put in
// that body by GitHub, but a future proxy/error page echoing the request
// could).

import type { DispatchMode } from "../config.js";
import { dispatchInputs } from "./request-id.js";

export interface DispatchEnv {
  GH_OWNER: string;
  GH_REPO: string;
  GH_WORKFLOW_FILE: string;
  GH_REF: string;
  GH_DISPATCH_PAT?: string;
}

export type DispatchResult =
  | { ok: true; dryRun: boolean }
  | { ok: false; status: number; body: string };

const MAX_LOGGED_BODY = 500;

function redactAndTruncate(body: string, pat: string | undefined): string {
  const redacted = pat && pat.trim() ? body.split(pat).join("[redacted]") : body;
  return redacted.length > MAX_LOGGED_BODY ? `${redacted.slice(0, MAX_LOGGED_BODY)}…` : redacted;
}

export async function dispatchWorkflow(
  theme: string,
  requestId: string,
  env: DispatchEnv,
  fetchImpl: typeof fetch,
  mode: DispatchMode,
  log: (message: string) => void = (m) => console.error(m),
): Promise<DispatchResult> {
  const inputs = dispatchInputs(theme, requestId);

  if (mode === "dry-run") {
    // Record the would-be dispatch without making any outbound call.
    log(`dry-run dispatch recorded: ${JSON.stringify(inputs)}`);
    return { ok: true, dryRun: true };
  }

  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW_FILE}/dispatches`;
  let resp: Response;
  try {
    // L-7: same redirect guard as the manifest fetch — workerd rejects
    // "error", so "manual" is the fail-closed choice (a 3xx is !ok).
    resp = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${env.GH_DISPATCH_PAT}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "paperpilot-theme-dispatcher",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: env.GH_REF, inputs }),
    });
  } catch (error) {
    throw error; // caller maps any throw to a generic 502, same as before
  }
  if (resp.ok) {
    return { ok: true, dryRun: false };
  }
  const bodyText = await resp.text();
  log(
    `workflow dispatch failed: ${resp.status} ${redactAndTruncate(bodyText, env.GH_DISPATCH_PAT)}`,
  );
  return { ok: false, status: resp.status, body: bodyText };
}
