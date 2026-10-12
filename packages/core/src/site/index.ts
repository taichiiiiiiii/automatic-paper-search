/**
 * Re-exported so `apps/web` (a pnpm workspace package that does not, and
 * per the TS-migration hard limits must not, declare its own `zod`
 * dependency) can parse fetched JSON with zod by importing it from
 * `@paperpilot/core` -- the same path it already uses for `BASE_PATH` /
 * `API_BASE` / etc. See apps/web/lib/data.ts.
 */
export { z } from "zod";
/**
 * zod/mini (same validation core, functional API): what apps/web's
 * client bundles use (apps/web/lib/data.ts). The classic `z` namespace is
 * not tree-shakable and put ~92 KB of zod into the first-load JS of every
 * page, ~70 KB of it unused (Lighthouse 2026-10-12).
 */
export * as zm from "zod/mini";
export * from "./config.js";
