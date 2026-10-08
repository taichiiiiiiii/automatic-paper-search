#!/usr/bin/env node
/**
 * Theme-slug printer for `theme-on-demand.yml`'s "freeze" step
 * (p5-plan.md §2 A2: "No theme-slug printer for the workflow's 'freeze'
 * step" / §4.1: after the theme builder runs, this CLI gives
 * `primary_path=data/published/themes/$slug`, checked against
 * `^data/published/themes/[a-z0-9-]{1,64}$` and the file existing — all
 * on the workflow side, outside this module).
 *
 * Reads `$THEME_INPUT` from the ENVIRONMENT, never argv — p5-plan.md §2
 * A2's "free text (display, lede, theme) only from env, validated". The
 * workflow validates `THEME_INPUT` itself (`^[A-Za-z0-9 _-]{2,80}$`)
 * before this CLI ever runs; this CLI's own validation (via
 * `themeSlug()`, plus the `^[a-z0-9-]{1,64}$` shape check p5-plan.md §2
 * A2 asks for explicitly) is defense in depth, not the only gate.
 */
import { themeSlug } from "@paperpilot/core/slug";
import { isMain } from "../../shared/cli/isMain.js";

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Pure: derives the slug for `themeInput`, or `null` if it's
 * unset/empty, `themeSlug()` throws (e.g. an all-non-ASCII label with no
 * ASCII fallback), or the result is empty / outside
 * `^[a-z0-9-]{1,64}$` (p5-plan.md §2 A2's explicit shape check — in
 * practice `themeSlug()`'s own output always satisfies this regex, but
 * the check is kept as defense in depth per the plan's wording).
 */
export function resolveThemeSlug(themeInput: string | undefined): string | null {
  if (!themeInput?.trim()) return null;
  let slug: string;
  try {
    slug = themeSlug(themeInput);
  } catch {
    return null;
  }
  if (!slug || !SLUG_RE.test(slug)) return null;
  return slug;
}

export interface SlugCliResult {
  exitCode: number;
  message: string;
}

/** `env` is the plain ambient-environment shape — `THEME_INPUT` is read
 * straight from it, never from argv (module doc). */
export function runSlugCli(env: Readonly<Record<string, string | undefined>>): SlugCliResult {
  const slug = resolveThemeSlug(env.THEME_INPUT);
  if (slug === null) {
    return {
      exitCode: 1,
      message:
        "error: THEME_INPUT is unset/empty, or its derived slug is empty or invalid " +
        "(must match ^[a-z0-9-]{1,64}$)",
    };
  }
  return { exitCode: 0, message: slug };
}

export const HELP_TEXT = `usage: theme-slug
Reads the THEME_INPUT environment variable, prints its derived slug to
stdout, and exits 0. Exits 1 (nothing printed on stdout) if THEME_INPUT
is unset, empty, or its derived slug is empty or does not match
^[a-z0-9-]{1,64}$. Takes no CLI flags — THEME_INPUT is read only from
the environment.`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    console.log(HELP_TEXT);
    process.exitCode = 0;
  } else if (argv.length > 0) {
    // This CLI takes no flags at all — THEME_INPUT comes only from the
    // environment (module doc) — so ANY argv token is a usage error.
    process.stderr.write(`theme-slug: error: unrecognized arguments: ${argv.join(" ")}\n`);
    process.exitCode = 2;
  } else {
    const result = runSlugCli(process.env);
    if (result.exitCode === 0) {
      console.log(result.message);
    } else {
      process.stderr.write(`${result.message}\n`);
    }
    process.exitCode = result.exitCode;
  }
}
