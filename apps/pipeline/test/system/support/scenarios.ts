/** Shared scenario constants for the system tests (no tests in here). */

import { createSandbox, type Sandbox } from "./sandbox.js";

/** Production regen parameters (regen-themes.yml) minus the embedding gate,
 * which downloads a model; the term gate is its documented fallback and is
 * what `fixtures/theme-http` was recorded with. */
export const THEME_ARGS = [
  "--theme",
  "Flash Attention",
  "--depth",
  "1",
  "--seeds",
  "5",
  "--width",
  "8",
  "--since-year",
  "2018",
  "--primary-source",
  "openalex",
  "--no-topic-embedding",
  // R2-37: the published flash-attention theme is audited, and a rebuild
  // invalidates its audit (the quality table would hide it until
  // re-audited); the publish guard refuses that unless the operator says so
  // (regen-themes.yml `allow_reaudit=true`). regenGuard.system.test.ts
  // covers the refusal itself.
  "--allow-reaudit",
];
export const THEME_DIR = "data/published/themes/flash-attention";

export const CONF = "iclr-2025";
export const CONF_AS_OF = "2026-10-11T10:50:14Z";

/** A minimal published tree with no catalog yet. */
export function emptyPublishedTree(): Record<string, unknown> {
  return {
    "data/published/conferences.json": [],
    "data/published/themes/themes-manifest.json": [],
    "data/published/lineage-quality-v1.json": {
      schema_version: "lineage-quality-v1",
      as_of: CONF_AS_OF,
      audit_version: "audit-v1",
      collections: [],
    },
  };
}

export const FEEDS_DIR = THEME_DIR;
export const FEEDS_ARGS = [
  "--now",
  "2026-10-12T00:00:00Z",
  "--days",
  "200",
  "--max-pages",
  "2",
  "--min-cites",
  "1",
  "--no-topic-embedding",
];

/** The published flash-attention theme (+ manifest), optionally with extra data. */
export function feedsSandbox(extra: string[] = []): Sandbox {
  return createSandbox({
    copyData: [FEEDS_DIR, ...extra],
    files: {
      "data/published/themes/themes-manifest.json": [
        { slug: "flash-attention", theme: "Flash Attention" },
      ],
    },
  });
}
