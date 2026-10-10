#!/usr/bin/env node
/**
 * CLI over `regenPending.ts` for the regen workflows (design 41 D3, R2-6).
 *
 *   regenPendingCli.ts record --pending <file> --results-dir <dir> --at <ISO>
 *       [--summary <markdown-file>]
 *     Folds every `*.json` theme-CLI result in <dir> into <file> (always
 *     writes it, so the candidate can package it) and appends a markdown
 *     section listing degraded / pending themes to <summary> (the job
 *     summary).
 *
 *   regenPendingCli.ts list --pending <file> [--max-attempts <n>]
 *     Prints the comma-separated themes the scheduled retry should
 *     regenerate (empty line when none).
 */

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliUsageError, parseArgs } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  loadPending,
  QUOTA_REASON,
  type RunResultLike,
  recordResults,
  retryThemes,
  savePending,
} from "./regenPending.js";

const AT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

/** Read every `*.json` theme-CLI result in `dir` (sorted by file name). */
export function readResults(dir: string): RunResultLike[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const out: RunResultLike[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, n), "utf-8")) as Record<string, unknown>;
      if (typeof r.theme === "string" && typeof r.status === "string") {
        out.push({
          theme: r.theme,
          status: r.status,
          daily_limit_hit: r.daily_limit_hit === true,
          message: typeof r.message === "string" ? r.message : "",
        });
      }
    } catch {
      // a half-written result is ignored; the run's exit code still counts it
    }
  }
  return out;
}

/** Markdown for the job summary. */
export function summaryMarkdown(
  results: readonly RunResultLike[],
  pending: readonly string[],
): string {
  const degraded = results.filter((r) => r.status === "degraded_classification");
  const lines = ["### Degraded classification (artifact not written, previous build retained)"];
  if (degraded.length === 0) lines.push("- none");
  for (const r of degraded) {
    lines.push(
      `- ${r.theme}: ${r.daily_limit_hit ? "LLM daily limit hit — queued for automatic retry" : "not quota-related — needs a look"}`,
    );
  }
  lines.push("", `Pending automatic retry (${QUOTA_REASON}): ${pending.join(", ") || "none"}`, "");
  return `${lines.join("\n")}\n`;
}

export function runRegenPendingCli(argv: readonly string[]): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "record") {
      const a = parseArgs(rest, {
        pending: { type: "string", required: true },
        "results-dir": { type: "string", required: true },
        at: { type: "string", required: true },
        summary: { type: "string" },
      });
      const at = a.at as string;
      if (!AT_RE.test(at))
        throw new CliUsageError("--at must be a UTC timestamp like 2026-10-10T00:00:00Z");
      const results = readResults(a["results-dir"] as string);
      const next = recordResults(loadPending(a.pending as string), results, at);
      savePending(a.pending as string, next);
      const pending = retryThemes(next);
      if (typeof a.summary === "string" && a.summary) {
        appendFileSync(a.summary, summaryMarkdown(results, pending));
      }
      process.stdout.write(
        `regen-pending: ${next.themes.length} theme(s) recorded, ${pending.length} to retry\n`,
      );
      return 0;
    }
    if (cmd === "list") {
      const a = parseArgs(rest, {
        pending: { type: "string", required: true },
        "max-attempts": { type: "int", default: DEFAULT_MAX_RETRY_ATTEMPTS },
      });
      process.stdout.write(
        `${retryThemes(loadPending(a.pending as string), a["max-attempts"] as number).join(",")}\n`,
      );
      return 0;
    }
    throw new CliUsageError("usage: regenPendingCli.ts <record|list> ...");
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = runRegenPendingCli(process.argv.slice(2));
}
