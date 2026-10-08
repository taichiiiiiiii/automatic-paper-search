// Hono wiring for apps/api. TS port of worker/entrypoint.js's route table,
// scoped to the theme routes only — the paper-slide adapter-projection
// machinery (`projectWorkerConfig` / `ownAdapterMethod` / factory opt-in)
// is explicitly out of scope for this phase (paper-slides §12 判断待ち 1,
// not ported here). What IS ported from entrypoint.js: exact-path routing,
// the theme CORS preflight contract, and "unknown path/method -> 404,
// plain 'Not Found' body, no CORS headers on 404" (API-21).
//
// Handler logic itself stays framework-agnostic plain functions
// `(request, env) => Promise<Response>` (see src/routes/*.ts) — Hono only
// does route dispatch, so every handler is still directly unit-testable
// exactly as worker/themes-post.test.mjs did against worker/themes-post.js.

import { Hono } from "hono";
import { themePreflight } from "./lib/preflight.js";
import type { QuotaBackend } from "./lib/quota.js";
import { createHealthHandler } from "./routes/health.js";
import { createThemeStatusHandler, createThemesPostHandler } from "./routes/themes.js";
import type { Env } from "./types.js";

export interface AppDeps {
  fetch: typeof fetch;
  quota: (env: Env) => QuotaBackend;
  now?: () => number;
  randomUUID?: () => string;
  log?: (message: string) => void;
  refundOnDispatchFailure?: boolean;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();

  const handlePost = createThemesPostHandler(deps);
  const handleStatus = createThemeStatusHandler();
  const handleHealth = createHealthHandler();

  app.post("/api/themes", (c) => handlePost(c.req.raw, c.env));
  app.get("/api/themes/status", (c) => handleStatus(c.req.raw, c.env));
  app.get("/api/health", (c) => handleHealth(c.req.raw, c.env));
  // API-21/entrypoint.js: Paper Slide namespace near-misses must never
  // inherit the generic theme CORS preflight (there is no adapter wired in
  // this phase at all, so every /api/paper-slides* path is a plain 404,
  // including OPTIONS — ported from worker/entrypoint.test.mjs's "Paper
  // Slide namespace near-misses never inherit generic theme CORS").
  app.options("/api/*", (c) => {
    if (c.req.path.startsWith("/api/paper-slides")) {
      return new Response("Not Found", { status: 404 });
    }
    return themePreflight(c.req.raw, c.env.CONFIG_KV);
  });

  // API-21: unknown path/method -> 404 with the exact plain-text body and
  // no CORS headers that worker/entrypoint.js's notFound() returned.
  app.notFound(() => new Response("Not Found", { status: 404 }));

  return app;
}
