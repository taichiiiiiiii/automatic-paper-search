// New per §4.2-6/7: two request-time safety switches read from KV on every
// request (never deploy-time `vars`, which get overwritten/rolled back by
// a redeploy). Both fail closed: a missing flag, an unreadable namespace,
// or a namespace bound to the wrong KV id must behave as "stop", not
// "allow".

import { KV_KEY_ACCEPTING, KV_KEY_ORIGIN_ALLOWLIST } from "../config.js";

export interface FlagsKv {
  get(key: string): Promise<string | null>;
}

export type OriginResolution = { ok: true; origin: string } | { ok: false };

/**
 * §4.2-6: exact-match origin allowlist, multiple origins supported (the
 * migration period allows both the old and new public origin at once).
 * A missing allowlist, an unreadable KV, invalid JSON, a non-array value,
 * a missing Origin header, or no exact match are all `{ ok: false }` —
 * the caller responds 403 in every one of those cases; this module does
 * not distinguish them further (API-01's "before any work" contract: the
 * caller must not do anything else before checking this).
 */
export async function resolveOrigin(request: Request, kv: FlagsKv): Promise<OriginResolution> {
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) return { ok: false };
  let raw: string | null;
  try {
    raw = await kv.get(KV_KEY_ORIGIN_ALLOWLIST);
  } catch {
    return { ok: false };
  }
  if (raw === null) return { ok: false };
  let allowlist: unknown;
  try {
    allowlist = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(allowlist)) return { ok: false };
  const matched = allowlist.find((o) => typeof o === "string" && o === requestOrigin);
  if (typeof matched !== "string") return { ok: false };
  return { ok: true, origin: matched };
}

/**
 * §4.2-7: accept-stop switch. Only the exact string "true" means "accept
 * requests"; a missing flag, any other value, or a KV read error all mean
 * "paused" — fail closed, never charges quota, never dispatches.
 */
export async function isAccepting(kv: FlagsKv): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await kv.get(KV_KEY_ACCEPTING);
  } catch {
    return false;
  }
  return raw === "true";
}
