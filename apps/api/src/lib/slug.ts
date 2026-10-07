// Theme slug helpers for apps/api.
//
// `themeSlug` is NOT defined here: it is re-exported from the single
// consolidated implementation in `@paperpilot/core/slug`
// (packages/core/src/slug/theme.ts), per docs/migration/safety-contracts.md
// API-08 (one definition shared by apps/web, apps/api and apps/pipeline).
// That module is pure string/regex logic with no `node:*` imports, so it
// bundles cleanly into the Worker.
//
// The two regexes below are apps/api's own request-input gates (the
// server-side half of the browser's validation in apps/web/lib/themes-slug.ts).
// They stay as literal `export const X = /.../;` declarations on purpose:
// apps/pipeline/test/workflows/constants-and-regex.test.ts text-extracts
// THEME_INPUT_PATTERN from this file to pin the workflows' THEME_RE env.

export { themeSlug } from "@paperpilot/core/slug";

export const THEME_INPUT_PATTERN = /^[A-Za-z0-9 _-]{2,80}$/;
export const SLUG_RE = /^[a-z0-9-]+$/;
