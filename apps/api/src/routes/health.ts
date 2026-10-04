// GET /api/health — new per §4.2-7. Read-only status: never does upstream
// work, never returns a secret (the PAT is reduced to a boolean), and may
// replace the dormant /api/themes/status once a real D1 progress API
// exists (§5). No origin gate: an operator (or an uptime check without an
// Origin header) must be able to read this without being allowlisted.

import { KV_KEY_NAMESPACE_TAG } from "../config.js";
import { isAccepting } from "../lib/kv-flags.js";
import type { Env } from "../types.js";

export interface HealthBody {
  accepting: boolean;
  dispatch_mode: string;
  pat_configured: boolean;
  kv_namespace_tag: string | null;
}

// Read directly off the binding (not a `vars` default) — see
// src/config.ts's KV_KEY_NAMESPACE_TAG for why: a Worker bound to the
// wrong KV namespace must show that as a wrong/missing tag, which a
// deploy-time var could never catch.
async function readNamespaceTag(kv: Env["CONFIG_KV"]): Promise<string | null> {
  try {
    return await kv.get(KV_KEY_NAMESPACE_TAG);
  } catch {
    return null;
  }
}

export function createHealthHandler(): (request: Request, env: Env) => Promise<Response> {
  return async function handleHealth(_request: Request, env: Env): Promise<Response> {
    const accepting = await isAccepting(env.CONFIG_KV);
    const kvNamespaceTag = await readNamespaceTag(env.CONFIG_KV);
    const body: HealthBody = {
      accepting,
      dispatch_mode:
        env.DISPATCH_MODE === "dry-run" || env.DISPATCH_MODE === "live"
          ? env.DISPATCH_MODE
          : "unconfigured",
      pat_configured: Boolean(env.GH_DISPATCH_PAT?.trim()),
      kv_namespace_tag: kvNamespaceTag,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  };
}
