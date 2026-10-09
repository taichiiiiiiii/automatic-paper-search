// Theme slug helpers for apps/api.
//
// Nothing is defined here: `themeSlug`, `THEME_INPUT_PATTERN` and
// `SLUG_RE` are re-exported from the single consolidated definition in
// `@paperpilot/core/slug` (packages/core/src/slug/{theme,patterns}.ts),
// per docs/migration/safety-contracts.md API-08 (one definition shared by
// apps/web, apps/api and apps/pipeline). That module is pure string/regex
// logic with no `node:*` imports, so it bundles cleanly into the Worker.
// The workflows' THEME_RE env is pinned against the core export by
// apps/pipeline/test/workflows/constants-and-regex.test.ts.

export { SLUG_RE, THEME_INPUT_PATTERN, themeSlug } from "@paperpilot/core/slug";
