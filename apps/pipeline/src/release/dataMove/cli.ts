#!/usr/bin/env node

/**
 * CLI entry point for the data-move tool (p5-plan.md §5.2, changeset A9).
 *
 *   tsx cli.ts plan
 *   tsx cli.ts apply [--confirm-delete <path>] [--allow-missing-workflows]
 *   tsx cli.ts apply --reverse --before <sha> [--allow-missing-workflows]
 *   tsx cli.ts carry-back --since <sha> --manifest <path>
 *   tsx cli.ts finish-revert --manifest <path>
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
 * `carry-back --since <B> --manifest <file>` first, then
 * `git revert --no-commit -m 1 <B>` for the structural half, then
 * `finish-revert --manifest <file>` to resolve that revert's conflicts and
 * orphans from the manifest — see §6.2 R-B.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseOrExit } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { createGitAdapter } from "../git/gitAdapter.js";
import { ApplyError, apply, applyReverse } from "./apply.js";
import {
  CarryBackError,
  type CarryBackManifest,
  carryBack,
  FinishRevertError,
  finishRevert,
  parseManifest,
} from "./carryBack.js";
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
  let manifestPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--since") {
      since = args[++i];
      if (since === undefined) die("--since requires a value");
    } else if (token === "--manifest") {
      manifestPath = args[++i];
      if (manifestPath === undefined) die("--manifest requires a value");
    } else {
      die(`unrecognized argument: ${token}`);
    }
  }
  if (since === undefined) {
    die("usage: carry-back --since <sha> --manifest <path>");
  }
  // Review round 3, L3: finish-revert cannot run without the manifest, so
  // it is required, and an empty value (for example an unset
  // "$RUNNER_TEMP/…" expanding oddly, or "") is refused up front.
  if (manifestPath === undefined || manifestPath.trim() === "") {
    die(
      "carry-back requires --manifest <path> (a writable file outside the repository, for " +
        "example /tmp/carry-back.json); finish-revert reads it",
    );
  }

  const adapter = createGitAdapter();
  const cwd = process.cwd();
  try {
    const result = carryBack({
      git: adapter,
      cwd,
      since: since as string,
      // p5-plan.md §6.2 R-B step 4: the deterministic handoff to
      // `finish-revert --manifest <file>`. Written before anything is
      // staged, so an unwritable path leaves the index untouched. Write it
      // outside the repository so no commit can pick it up.
      writeManifest: (manifest) =>
        writeFileSync(manifestPath as string, `${JSON.stringify(manifest, null, 2)}\n`),
    });
    for (const entry of result.entries) {
      console.log(`${entry.status}\t${entry.p5Path} -> ${entry.legacyPath}`);
    }
    console.log(`carried back ${result.entries.length} path(s) since ${since}`);
    console.log(`manifest written: ${manifestPath}`);
    if (!result.staged) {
      // Review round 3, M2: a delete-only carry-back stages nothing.
      console.log(
        "nothing is staged (every carried-back path was a deletion B had already made); the " +
          "carry-back commit must still exist: git commit --allow-empty",
      );
    }
  } catch (error) {
    if (error instanceof CarryBackError) {
      die(error.message);
    }
    throw error;
  }
}

function runFinishRevert(args: string[]): void {
  let manifestPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--manifest") {
      manifestPath = args[++i];
      if (manifestPath === undefined) die("--manifest requires a value");
    } else {
      die(`unrecognized argument: ${token}`);
    }
  }
  if (manifestPath === undefined) {
    die("usage: finish-revert --manifest <path>");
  }

  const adapter = createGitAdapter();
  const cwd = process.cwd();
  try {
    let text: string;
    try {
      text = readFileSync(manifestPath, "utf-8");
    } catch (error) {
      die(`failed to read manifest ${manifestPath}: ${String(error)}`);
    }
    const manifest: CarryBackManifest = parseManifest(text);
    const result = finishRevert({ git: adapter, cwd, manifest });
    for (const p of result.removed) console.log(`removed: ${p}`);
    for (const p of result.restored) console.log(`set to expected content: ${p}`);
    console.log(
      "finish-revert: index matches pre-B tree + carried-back changes; commit once to finish",
    );
  } catch (error) {
    if (error instanceof FinishRevertError) {
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
    case "finish-revert":
      runFinishRevert(rest);
      break;
    case "verify":
      runVerify(rest);
      break;
    case "rehearse":
      runRehearse(rest);
      break;
    default:
      die(
        "usage: cli.ts {plan|apply|carry-back|finish-revert|verify|rehearse} ...\n" +
          "  plan\n" +
          "  apply [--confirm-delete <path>] [--allow-missing-workflows]\n" +
          "  apply --reverse --before <sha> [--allow-missing-workflows]\n" +
          "  carry-back --since <sha> --manifest <path>\n" +
          "  finish-revert --manifest <path>\n" +
          "  verify <before> <after> [--allow-missing-workflows]\n" +
          "  rehearse [--repo <path>] [--keep]",
      );
  }
}

if (isMain(import.meta.url)) {
  main();
}
