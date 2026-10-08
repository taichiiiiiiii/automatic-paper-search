#!/usr/bin/env node
/**
 * CLI entry point for {@link writeConferenceCopyFile} —
 * `conference-on-demand.yml`'s scaffold step (p5-plan.md §4.1: "`scaffold/cli.ts`
 * (env `DISPLAY`/`LEDE`)"). `--conference` comes from argv (validated
 * slug — {@link writeConferenceCopyFile} already runs
 * `validateConferenceSlug`, including the `RESERVED_CONFERENCE_SLUGS`
 * check). `--display`/`--lede` are deliberately NOT CLI flags at all —
 * free text only from the environment (`DISPLAY`/`LEDE`), per
 * p5-plan.md §2 A2's "free text (display, lede, theme) only from env,
 * validated".
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { conferenceCopyDir, layoutFor } from "@paperpilot/core/layout";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { writeConferenceCopyFile } from "./writeConferenceCopy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/conference/scaffold -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface ScaffoldCliArgs {
  conference: string;
}

export function parseScaffoldCliArgs(argv: readonly string[]): ScaffoldCliArgs {
  const parsed = parseFlags(argv, {
    conference: { type: "string", required: true },
  });
  return { conference: parsed.conference as string };
}

export interface ScaffoldCliResult {
  exitCode: number;
  message: string;
}

/**
 * Pure (given its already-parsed inputs): `env` is the plain
 * ambient-environment shape — `DISPLAY`/`LEDE` are read straight from
 * it, never from argv (module doc). A missing/blank `DISPLAY`/`LEDE` is
 * a configuration error (exit 1), not a CLI usage error (exit 2) — the
 * flag set itself (`--conference`) parsed fine; so does an invalid or
 * reserved `--conference` value, which {@link writeConferenceCopyFile}
 * rejects (also exit 1, same reasoning).
 */
export function runScaffoldCliArgs(
  args: ScaffoldCliArgs,
  env: Readonly<Record<string, string | undefined>>,
  copyDir: string,
): ScaffoldCliResult {
  const display = env.DISPLAY;
  const lede = env.LEDE;
  if (!display?.trim()) {
    return { exitCode: 1, message: "error: DISPLAY environment variable must be non-empty" };
  }
  if (!lede?.trim()) {
    return { exitCode: 1, message: "error: LEDE environment variable must be non-empty" };
  }
  try {
    const path = writeConferenceCopyFile(args.conference, { display, lede }, copyDir);
    return { exitCode: 0, message: `Wrote ${path}` };
  } catch (e) {
    return { exitCode: 1, message: `error: ${(e as Error).message}` };
  }
}

export const HELP_TEXT = `usage: scaffold --conference SLUG
Reads DISPLAY and LEDE from the environment (never argv) and writes
<layout.config>/conference-copy/<SLUG>.json.`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * argv + env -> process exit code. `copyDir` defaults to the real
 * layout-derived directory (production use); tests pass a temp dir
 * directly so no real repo path is ever touched outside production.
 */
export function runScaffoldCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  copyDir: string = conferenceCopyDir(layoutFor(DEFAULT_REPO_ROOT)),
): number {
  if (isHelpRequest(argv)) {
    console.log(HELP_TEXT);
    return 0;
  }
  let args: ScaffoldCliArgs;
  try {
    args = parseScaffoldCliArgs(argv);
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`scaffold: error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const result = runScaffoldCliArgs(args, env, copyDir);
  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

if (isMain(import.meta.url)) {
  process.exitCode = runScaffoldCli(process.argv.slice(2));
}
