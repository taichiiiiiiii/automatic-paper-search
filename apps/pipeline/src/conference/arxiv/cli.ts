#!/usr/bin/env node
/**
 * CLI entry point for {@link runCollectConferenceMain} — p5-plan.md §2
 * A2: "arXiv conference collector: only `runCollectConferenceMain`
 * exists, with no `isMain` entry." Flags: `--conference --venue --query
 * --max --output-root` (default `layout.inputs`).
 *
 * Unlike the sibling openreview/cvf/acl collectors' own real-network
 * entry points (`conference/openreview/cli.ts`, `conference/cvf/cli.ts`,
 * `conference/acl/cli.ts`), which take `PAPERPILOT_OUTPUT_ROOT` from the
 * environment with NO default, p5-plan.md §2 A2 asks specifically for a
 * `--output-root` CLI flag defaulting to `layout.inputs` here — so this
 * file parses its OWN superset `ARG_SPEC` (covering `--output-root` too)
 * rather than forwarding raw argv straight into
 * `runCollectConferenceMain`, which only knows about the business flags
 * (`collect.ts`'s own `ARG_SPEC` has no `--output-root` at all — it takes
 * `outputRoot` only via `CollectConferenceMainDeps`). `toCollectArgv`
 * re-serializes the parsed business fields back into the argv shape
 * `collect.ts` expects.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import type { ArxivTextResponse } from "../shared/index.js";
import { fetchTextWithTimeout } from "../shared/networkTimeout.js";
import { runCollectConferenceMain } from "./collect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/conference/arxiv -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

/** Defensive timeout for the arXiv Atom fetch — same fixed value the
 * acl/cvf collectors' own real-network entry points use (M6 of the P4
 * review: `ArxivFetchDeps` carries no `timeoutMs` of its own). */
const ARXIV_FETCH_TIMEOUT_MS = 30_000;

export interface ArxivCliArgs {
  conference: string;
  venue: string;
  query: string;
  max: number;
  clearOral: boolean;
  outputRoot: string;
}

const ARG_SPEC = {
  conference: { type: "string", required: true } as const,
  venue: { type: "string", required: true } as const,
  query: { type: "string", required: true } as const,
  max: { type: "int", default: 800 } as const,
  "clear-oral": { type: "boolean" } as const,
  "output-root": { type: "string" } as const,
};

export function defaultOutputRoot(repoRoot: string = DEFAULT_REPO_ROOT): string {
  return layoutFor(repoRoot).inputs;
}

/** Mirrors `collect_conference.py`'s argparse flags, plus this CLI's own
 * `--output-root` (module doc). */
export function parseArxivCliArgs(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): ArxivCliArgs {
  const parsed = parseFlags(argv, ARG_SPEC);
  return {
    conference: parsed.conference as string,
    venue: parsed.venue as string,
    query: parsed.query as string,
    max: parsed.max as number,
    clearOral: Boolean(parsed["clear-oral"]),
    outputRoot: (parsed["output-root"] as string | undefined) ?? defaultOutputRoot(repoRoot),
  };
}

/** Re-serializes `args`' business fields into the argv shape
 * `runCollectConferenceMain`'s own (unexported) `ARG_SPEC` expects.
 * `--output-root` is never forwarded — `collect.ts` takes it only via
 * `CollectConferenceMainDeps.outputRoot` (module doc). */
function toCollectArgv(args: ArxivCliArgs): string[] {
  const out = [
    "--conference",
    args.conference,
    "--venue",
    args.venue,
    "--query",
    args.query,
    "--max",
    String(args.max),
  ];
  if (args.clearOral) out.push("--clear-oral");
  return out;
}

/**
 * Runs the collector for already-parsed `args`. `fetchText` defaults to
 * a real, timeout-enforcing `fetch` (production use); tests inject a
 * fake so no network call is ever made outside this one production
 * default.
 */
export async function runArxivCli(
  args: ArxivCliArgs,
  fetchText: (url: string) => Promise<ArxivTextResponse> = fetchTextWithTimeout(
    ARXIV_FETCH_TIMEOUT_MS,
  ),
): Promise<number> {
  return runCollectConferenceMain(toCollectArgv(args), {
    arxiv: { fetchText },
    outputRoot: args.outputRoot,
  });
}

export const HELP_TEXT = `usage: collect_conference --conference SLUG --venue VENUE --query QUERY [--max N] [--clear-oral] [--output-root DIR]`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    console.log(HELP_TEXT);
    process.exitCode = 0;
  } else {
    let parsed: ArxivCliArgs | undefined;
    try {
      parsed = parseArxivCliArgs(argv);
    } catch (e) {
      if (e instanceof CliUsageError) {
        process.stderr.write(`collect_conference: error: ${e.message}\n`);
        process.exitCode = 2;
      } else {
        throw e;
      }
    }
    if (parsed !== undefined) {
      runArxivCli(parsed).then(
        (code) => {
          process.exitCode = code;
        },
        (err) => {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 3;
        },
      );
    }
  }
}
