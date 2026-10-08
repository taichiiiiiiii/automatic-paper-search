// Fixed, non-secret facts about this Worker's own API contract (not deploy
// config — nothing here is edited from the CF dashboard). Mirrors
// worker/response.js's PAGES_ORIGIN, extended to the §4.2-6 "allow both old
// and new origin during the migration" list.
//
// packages/core/src/site/config.ts's PUBLIC_ORIGIN is the *future*
// Cloudflare Pages origin (e.g. https://paperpilot.pages.dev as of this
// writing) — still a placeholder pending the user's Pages project (that
// file's own TODO, not resolved here; this file does not hard-code a copy
// of the value, so it tracks whatever packages/core currently exports
// without drifting). PRODUCTION_ORIGINS below (resolves this file's former
// TODO(P5)) includes both: the *current* GitHub Pages origin, which is what
// is actually serving production traffic today, and the *future* Pages
// origin, so a dry-run Worker already self-refuses for either one — ready
// ahead of §6.2 Phase W, inert until PUBLIC_ORIGIN stops being a
// placeholder and the KV origin_allowlist is updated to match (an ops
// action, not a code change).

import { PUBLIC_ORIGIN } from "@paperpilot/core/site";

// Origins that count as "production" for the dry-run self-refusal rule
// (§4.5: "GH_REF=develop または本番 origin の時は dry-run を拒否する").
export const PRODUCTION_ORIGINS: readonly string[] = [
  "https://taichiiiiiiii.github.io",
  PUBLIC_ORIGIN,
];

// The branch ref that denotes "this would dispatch against the real,
// production theme-on-demand workflow". Refusing dry-run when GH_REF equals
// this prevents a misconfigured preview Worker from silently no-op'ing what
// looks like a production request.
export const PRODUCTION_GH_REF = "develop";

// KV keys for the two request-time safety switches (§4.2-6, §4.2-7). Both
// are read fresh on every request; neither is deploy-time config. These
// names are new (no code in root worker/ reads them yet — 判断待ち 10 is
// unshipped) — the future `worker/` change that reads the same KV flags
// must use these exact key names.
export const KV_KEY_ORIGIN_ALLOWLIST = "origin_allowlist"; // JSON array of exact origin strings
export const KV_KEY_ACCEPTING = "accepting"; // exact string "true" to accept; anything else = paused

// Free-text label an operator sets in the SAME KV namespace the Worker is
// bound to (not a `vars` default) — so GET /api/health reflects what the
// binding actually resolves to, not what the deploy config merely claims.
// A Worker accidentally bound to the wrong KV namespace then reports a
// missing/wrong tag instead of a reassuring but false one, which is the
// whole point of §4.2-7's "namespace に誤って紐付いた場合" check.
export const KV_KEY_NAMESPACE_TAG = "namespace_tag";

// Per-IP / global quota caps (unchanged values from worker/response.js;
// now enforced exactly via a Durable Object instead of best-effort KV).
export const RATE_LIMIT_PER_HOUR = 5;
export const RATE_LIMIT_GLOBAL_PER_DAY = 100;

// §5 "枠の返却" (refund on dispatch failure) is a decision-pending item.
// Implemented behind this constant, with tests for both values, so flipping
// it later is a one-line change plus re-running the existing test matrix.
export const REFUND_ON_DISPATCH_FAILURE = false;

// Hard ceiling on the POST body (unchanged from worker/themes-post.js).
export const MAX_BODY_BYTES = 1024;

export type DispatchMode = "dry-run" | "live";
