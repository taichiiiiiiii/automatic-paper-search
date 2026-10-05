// Rollback entry point for the OLD `worker/` Worker (pre-apps/api
// production). NOT used by any deploy path today — Workers Builds only
// reads whichever config file its dashboard "config file" setting names,
// and nothing in this repo points it at `wrangler.legacy-rollback.jsonc`
// (the config that bundles this file). This is operator-only rollback
// material for §6.2 Phase W's ↩ step.
//
// Why this file exists instead of just redeploying plain `worker/index.ts`:
// once any apps/api version has shipped with the `QUOTA` Durable Object
// binding and its `v1` (`new_sqlite_classes`) migration, Cloudflare's
// migration history for this Worker includes that class. A later deploy
// whose config has NO `durable_objects`/`migrations` block at all does not
// retroactively undo that history the way reverting source code would
// suggest — redeploying bare `worker/index.ts` with a config that dropped
// the binding is the failure mode §6.2 Phase W's ↩ step calls out
// (**verify** against current Cloudflare docs; recorded here as the
// reason this file keeps the class alive rather than omitting it).
// `wrangler.legacy-rollback.jsonc` keeps the exact same `QUOTA` binding +
// `v1`/`new_sqlite_classes` migration apps/api's production config uses,
// so a rollback deploy stays compatible with that migration history.
//
// `QuotaCounter` below is a STUB, not the real ledger
// (apps/api/src/durable/quota-object.ts's `QuotaCounter`). The old
// `worker/` request-handling code (re-exported as `default` below) never
// calls a Durable Object for quota — it still uses `RATE_LIMIT_KV`
// best-effort counting, same as it always has. This class exists purely
// to satisfy the migration binding; any request that did reach it (which
// production code never does) gets a fixed 503, never real quota state.

export { default } from "./index.js";

export class QuotaCounter {
  // Signature matches the Durable Object contract
  // (constructor(state, env) + async fetch(request)) so wrangler can bind
  // it the same way as the real class — see
  // apps/api/src/durable/quota-object.ts's `QuotaCounter` for the shape
  // being mirrored, deliberately without its logic.
  constructor(_state: unknown, _env: unknown) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ error: "quota tracking unavailable after rollback" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
}
