// Production wiring for apps/api. Mirrors worker/index.ts's role: this
// file carries no request-handling logic of its own — it only injects the
// real global `fetch` and the production Durable-Object-backed quota
// factory into createApp(), and re-exports the Durable Object class so
// wrangler can bind it (see wrangler.jsonc's `durable_objects` + the
// `new_sqlite_classes` migration). R1-6 adds the Cron Trigger entry
// (`scheduled`, wrangler.jsonc `triggers.crons`): the watchdog and the
// weekly conference-watch dispatch in src/watchdog/scheduled.ts.

import { createApp } from "./app.js";
import { productionQuotaBackend } from "./durable/quota-object.js";
import type { Env } from "./types.js";
import { runScheduled, type WatchdogKv } from "./watchdog/scheduled.js";

export { QuotaCounter } from "./durable/quota-object.js";

// Wrapped in an arrow function (not passed bare) for the same reason as
// worker/index.ts: a bare method reference would detach `this` from
// workerd's JSG-wrapped global fetch and can throw "Illegal invocation".
const globalFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);

const app = createApp({
  fetch: globalFetch,
  quota: (env: Env) => {
    if (!env.QUOTA) {
      throw new TypeError("QUOTA Durable Object binding is required in production");
    }
    return productionQuotaBackend(env.QUOTA);
  },
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // CONFIG_KV is a real KVNamespace in production (the Env type narrows
    // it to the read-only FlagsKv the request path needs).
    const kv = env.CONFIG_KV as unknown as WatchdogKv;
    ctx.waitUntil(
      runScheduled(env, controller.scheduledTime, { fetch: globalFetch, kv }).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
