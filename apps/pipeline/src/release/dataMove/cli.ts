#!/usr/bin/env node

/**
 * CLI entry point for the data-move tool (p5-plan.md §5.2, changeset A9).
 *
 *   tsx cli.ts plan
 *   tsx cli.ts apply [--reverse] [--confirm-delete <path>]
 *   tsx cli.ts verify <before> <after>
 *   tsx cli.ts rehearse [--repo <path>] [--keep]
 *
 * Every subcommand resolves the repository root from `process.cwd()` (run
 * this from the repo/worktree root, exactly like the other `release/`
 * CLIs). `plan` and `verify` never mutate anything; `apply` stages changes
 * with `git add`/`git mv`/`git rm` but never commits.
 */

import { parseOrExit } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { createGitAdapter } from "../git/gitAdapter.js";
import { ApplyError, apply, applyReverse } from "./apply.js";
import { buildPlan, planIsClean } from "./plan.js";
import { runRehearsal } from "./rehearse.js";
import { verifyMove } from "./verify.js";

function die(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function listTrackedFiles(cwd: string): string[] {
  const adapter = createGitAdapter();
  const result = adapter.run(cwd, ["ls-files"]);
  if (result.exitCode !== 0) {
    die(`git ls-files failed: ${result.stderr || result.stdout}`);
  }
  const out = result.stdout.trim();
  return out.length === 0 ? [] : out.split("\n");
}

function runPlan(): void {
  const cwd = process.cwd();
  const plan = buildPlan({ paths: listTrackedFiles(cwd) });
  if (!planIsClean(plan)) {
    for (const problem of plan.problems) {
      console.error(`::error::[${problem.kind}] ${problem.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ entries: plan.entries }, null, 2));
}

function runApply(args: string[]): void {
  let reverse = false;
  let confirmDelete: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--reverse") {
      reverse = true;
    } else if (token === "--confirm-delete") {
      confirmDelete = args[++i];
      if (confirmDelete === undefined) die("--confirm-delete requires a value");
    } else {
      die(`unrecognized argument: ${token}`);
    }
  }

  const adapter = createGitAdapter();
  const cwd = process.cwd();
  try {
    const result = reverse
      ? applyReverse({ git: adapter, cwd, confirmDelete })
      : apply({ git: adapter, cwd, confirmDelete });
    if (result.workflowSwap.skipped) {
      console.log(`workflow swap skipped: ${result.workflowSwap.skipReason}`);
    } else {
      console.log(
        `workflow swap: moved ${result.workflowSwap.movedNames.length}, ` +
          `deleted ${result.workflowSwap.deletedNames.length}`,
      );
    }
    console.log(
      `staged ${result.entries.length} rule-table entries (${reverse ? "reverse" : "forward"})`,
    );
  } catch (error) {
    if (error instanceof ApplyError) {
      die(error.message);
    }
    throw error;
  }
}

function runVerify(args: string[]): void {
  if (args.length !== 2) {
    die("usage: verify <before> <after>");
  }
  const [before, after] = args as [string, string];
  const adapter = createGitAdapter();
  const cwd = process.cwd();
  const report = verifyMove({ git: adapter, cwd, before, after });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function runRehearse(args: string[]): void {
  const flags = parseOrExit(
    args,
    {
      repo: { type: "string", default: process.cwd() },
      keep: { type: "boolean" },
    },
    "cli.ts rehearse",
  );
  process.exitCode = runRehearsal({ repo: flags.repo as string, keep: flags.keep as boolean });
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "plan":
      runPlan();
      break;
    case "apply":
      runApply(rest);
      break;
    case "verify":
      runVerify(rest);
      break;
    case "rehearse":
      runRehearse(rest);
      break;
    default:
      die(
        "usage: cli.ts {plan|apply|verify|rehearse} ...\n" +
          "  plan\n" +
          "  apply [--reverse] [--confirm-delete <path>]\n" +
          "  verify <before> <after>\n" +
          "  rehearse [--repo <path>] [--keep]",
      );
  }
}

if (isMain(import.meta.url)) {
  main();
}
