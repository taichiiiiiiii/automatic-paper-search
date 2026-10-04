// Production wiring for apps/api. Mirrors worker/index.ts's role: this
// file carries no request-handling logic of its own — it only injects the
// real global `fetch` and the production Durable-Object-backed quota
// factory into createApp(), and re-exports the Durable Object class so
// wrangler can bind it (see wrangler.jsonc's `durable_objects` + the
// `new_sqlite_classes` migration).

import { createApp } from "./app.js";
import { productionQuotaBackend } from "./durable/quota-object.js";
import type { Env } from "./types.js";

export { QuotaCounter } from "./durable/quota-object.js";

const app = createApp({
  // Wrapped in an arrow function (not passed bare) for the same reason as
  // worker/index.ts: a bare method reference would detach `this` from
  // workerd's JSG-wrapped global fetch and can throw "Illegal invocation".
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  quota: (env: Env) => {
    if (!env.QUOTA) {
      throw new TypeError("QUOTA Durable Object binding is required in production");
    }
    return productionQuotaBackend(env.QUOTA);
  },
});

export default app;
