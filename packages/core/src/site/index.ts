/**
 * Re-exported so `apps/web` (a pnpm workspace package that does not, and
 * per the TS-migration hard limits must not, declare its own `zod`
 * dependency) can parse fetched JSON with zod by importing it from
 * `@paperpilot/core` -- the same path it already uses for `BASE_PATH` /
 * `API_BASE` / etc. See apps/web/lib/data.ts.
 */
export { z } from "zod";
export * from "./config.js";
