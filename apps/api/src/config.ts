// Fixed, non-secret facts about this Worker's own API contract (not deploy
// config — nothing here is edited from the CF dashboard). Mirrors
// worker/response.js's PAGES_ORIGIN, extended to the §4.2-6 "allow both old
// and new origin during the migration" list.
//
// NOTE: packages/core/src/site/config.ts landed concurrently (another agent,
// same P3 window) and exports PUBLIC_ORIGIN — but that is the *future*
// Cloudflare Pages origin (e.g. https://paperpilot.pages.dev), still a
// placeholder pending the user's Pages project. PRODUCTION_ORIGINS below is
// deliberately the *current* GitHub Pages origin: that's what is actually
// serving production traffic during P3 (the migration isn't cut over yet),
// so it's what a dry-run Worker must refuse to impersonate today.
//
// TODO(P5): once Cloudflare Pages is live, add packages/core/src/site's
// PUBLIC_ORIGIN to PRODUCTION_ORIGINS (and to the real KV origin_allowlist —
// an ops action, not a code change) so dry-run also self-refuses for the
// new production origin.

// Origins that count as "production" for the dry-run self-refusal rule
// (§4.5: "GH_REF=develop または本番 origin の時は dry-run を拒否する").
export const PRODUCTION_ORIGINS: readonly string[] = ["https://taichiiiiiiii.github.io"];

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
