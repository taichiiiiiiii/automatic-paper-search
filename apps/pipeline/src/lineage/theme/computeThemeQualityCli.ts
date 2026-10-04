/**
 * CLI entry point for {@link writeThemeQuality} — TS port of
 * `paperpilot/scripts/compute_theme_quality.py`'s `main()`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../../shared/cli/isMain.js";
import { writeThemeQuality } from "./computeThemeQuality.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/theme -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

const HIGH_TEMPLATE_RATIO = 0.3;

export function runComputeThemeQualityCli(
  themesDir: string = join(DEFAULT_REPO_ROOT, "docs", "themes"),
): number {
  const out = writeThemeQuality({ themesDir });
  const rollup = JSON.parse(readFileSync(out, "utf-8")) as {
    summary: {
      theme_count: number;
      themes_with_template_rationale_high: number;
      themes_with_off_topic_seeds: number;
    };
  };
  const {
    theme_count: n,
    themes_with_template_rationale_high: high,
    themes_with_off_topic_seeds: off,
  } = rollup.summary;
  process.stdout.write(`wrote ${out} with ${n} themes\n`);
  process.stdout.write(
    `  themes with template_ratio > ${Math.round(HIGH_TEMPLATE_RATIO * 100)}%: ${high}\n`,
  );
  process.stdout.write(`  themes with off-topic seeds:                    ${off}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = runComputeThemeQualityCli();
}
