#!/usr/bin/env node

/**
 * CLI entry point for the data-move tool (p5-plan.md §5.2, changeset A9).
 *
 *   tsx cli.ts plan
 *   tsx cli.ts apply [--confirm-delete <path>] [--allow-missing-workflows]
 *   tsx cli.ts apply --reverse --before <sha> [--allow-missing-workflows]
 *   tsx cli.ts carry-back --since <sha>
 *   tsx cli.ts verify <before> <after> [--allow-missing-workflows]
 *   tsx cli.ts rehearse [--repo <path>] [--keep]
 *
 * Every subcommand resolves the repository root from `process.cwd()` (run
 * this from the repo/worktree root, exactly like the other `release/`
 * CLIs). `plan` and `verify` never mutate anything; `apply`/`carry-back`
 * stage changes with `git add`/`git mv`/`git rm` but never commit.
 *
 * `apply --reverse` requires `--before <sha>` explicitly (p5-plan.md
 * §6.2 R-B, review finding M3) — there is no implicit default, and it
 * only ever works when `HEAD` is still exactly `<sha>`'s forward-`apply`
 * result (nothing committed on top). For the general R-B case where
 * ordinary post-cutover commits (`collect-weekly`, `theme-on-demand`, …)
 * have landed under `data/**` since the cutover commit B, use
 * `carry-back --since <B>` first (and a plain `git revert -m 1 <B>`
 * afterwards for the structural half) — see §6.2 R-B.
 */

import { parseOrExit } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { createGitAdapter } from "../git/gitAdapter.js";
import { ApplyError, apply, applyReverse } from "./apply.js";
import { CarryBackError, carryBack } from "./carryBack.js";
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
  let before: string | undefined;
  let allowMissingWorkflows = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--reverse") {
      reverse = true;
    } else if (token === "--confirm-delete") {
      confirmDelete = args[++i];
      if (confirmDelete === undefined) die("--confirm-delete requires a value");
    } else if (token === "--before") {
      before = args[++i];
      if (before === undefined) die("--before requires a value");
    } else if (token === "--allow-missing-workflows") {
      allowMissingWorkflows = true;
    } else {
      die(`unrecognized argument: ${token}`);
    }
  }
  if (reverse && before === undefined) {
    die(
      "apply --reverse requires --before <sha> (the pre-apply commit) — there is no implicit " +
        "default; see this file's header comment and p5-plan.md §6.2 R-B",
    );
  }

  const adapter = createGitAdapter();
  const cwd = process.cwd();
  try {
    const result = reverse
      ? applyReverse({ git: adapter, cwd, confirmDelete, allowMissingWorkflows }, before as string)
      : apply({ git: adapter, cwd, confirmDelete, allowMissingWorkflows });
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

function runCarryBack(args: string[]): void {
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--since") {
      since = args[++i];
      if (since === undefined) die("--since requires a value");
    } else {
      die(`unrecognized argument: ${token}`);
    }
  }
  if (since === undefined) {
    die("usage: carry-back --since <sha>");
  }

  const adapter = createGitAdapter();
  const cwd = process.cwd();
  try {
    const result = carryBack({ git: adapter, cwd, since: since as string });
    for (const entry of result.entries) {
      console.log(`${entry.status}\t${entry.p5Path} -> ${entry.legacyPath}`);
    }
    console.log(`carried back ${result.entries.length} path(s) since ${since}`);
  } catch (error) {
    if (error instanceof CarryBackError) {
      die(error.message);
    }
    throw error;
  }
}

function runVerify(args: string[]): void {
  let allowMissingWorkflows = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    if (token === "--allow-missing-workflows") {
      allowMissingWorkflows = true;
    } else {
      positional.push(token);
    }
  }
  if (positional.length !== 2) {
    die("usage: verify <before> <after> [--allow-missing-workflows]");
  }
  const [before, after] = positional as [string, string];
  const adapter = createGitAdapter();
  const cwd = process.cwd();
  const report = verifyMove({ git: adapter, cwd, before, after, allowMissingWorkflows });
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
    case "carry-back":
      runCarryBack(rest);
      break;
    case "verify":
      runVerify(rest);
      break;
    case "rehearse":
      runRehearse(rest);
      break;
    default:
      die(
        "usage: cli.ts {plan|apply|carry-back|verify|rehearse} ...\n" +
          "  plan\n" +
          "  apply [--confirm-delete <path>] [--allow-missing-workflows]\n" +
          "  apply --reverse --before <sha> [--allow-missing-workflows]\n" +
          "  carry-back --since <sha>\n" +
          "  verify <before> <after> [--allow-missing-workflows]\n" +
          "  rehearse [--repo <path>] [--keep]",
      );
  }
}

if (isMain(import.meta.url)) {
  main();
}
