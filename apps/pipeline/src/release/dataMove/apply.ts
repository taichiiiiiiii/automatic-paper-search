/**
 * `cli.ts apply [--reverse]` (p5-plan.md §5.2/§5.3): performs the data-move
 * commit's mechanics against the live working tree — `git mv`/`git rm`
 * for every rule-table entry, the two config files' restricted-key edits,
 * the `.gitignore` patch, the `LAYOUT_MODE` literal flip, and the
 * `.github/workflows-p5` staging swap. Stages everything (`git add`/
 * `git mv`/`git rm`); never commits — the caller (the real cutover runbook
 * step, or a test) commits once, by hand, same as every other script in
 * this package.
 *
 * Validates the *entire* plan (and, for forward apply, the
 * `--confirm-delete` gate) before touching anything, so a refusal leaves
 * the working tree untouched.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GitAdapter, git } from "../git/gitAdapter.js";
import { applyConfigEdits, reverseConfigEdits } from "./configEdit.js";
import { applyGitignorePatch, reverseGitignorePatch } from "./gitignorePatch.js";
import { flipLayoutModeToLegacy, flipLayoutModeToP5 } from "./layoutFlip.js";
import { buildPlan, planIsClean } from "./plan.js";
import type { RuleEntry } from "./rules.js";
import { applyWorkflowSwap, reverseWorkflowSwap, type WorkflowSwapResult } from "./workflowSwap.js";

export class ApplyError extends Error {}

const GITIGNORE_REL = ".gitignore";
const LAYOUT_REL = "packages/core/src/layout/index.ts";

export interface ApplyOptions {
  readonly git: GitAdapter;
  readonly cwd: string;
  /** Must equal a gated delete entry's `requiresConfirmDelete` exactly, or `apply` refuses the whole operation. */
  readonly confirmDelete?: string;
}

export interface ApplyResult {
  readonly entries: readonly RuleEntry[];
  readonly workflowSwap: WorkflowSwapResult;
}

function listTrackedFiles(adapter: GitAdapter, cwd: string): string[] {
  const out = git(adapter, cwd, ["ls-files"]);
  return out.length === 0 ? [] : out.split("\n");
}

function readRepoFile(cwd: string, rel: string): string {
  return readFileSync(join(cwd, rel), "utf-8");
}
function writeRepoFile(cwd: string, rel: string, text: string): void {
  const full = join(cwd, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/**
 * `git mv` — unlike a plain `mv`, it does NOT create missing destination
 * directories itself (it fails with "No such file or directory" instead),
 * so this always `mkdirSync`s the destination's parent first.
 */
function gitMv(adapter: GitAdapter, cwd: string, src: string, dest: string): void {
  mkdirSync(dirname(join(cwd, dest)), { recursive: true });
  git(adapter, cwd, ["mv", src, dest]);
}

/** Forward. */
export function apply(options: ApplyOptions): ApplyResult {
  const { git: adapter, cwd } = options;
  const paths = listTrackedFiles(adapter, cwd);
  const plan = buildPlan({ paths });
  if (!planIsClean(plan)) {
    throw new ApplyError(
      `refusing to apply: the plan has ${plan.problems.length} problem(s):\n` +
        plan.problems.map((p) => `  - [${p.kind}] ${p.message}`).join("\n"),
    );
  }

  for (const entry of plan.entries) {
    if (entry.class === "delete" && entry.requiresConfirmDelete !== undefined) {
      if (options.confirmDelete !== entry.requiresConfirmDelete) {
        throw new ApplyError(
          `refusing to apply: deleting ${entry.path} requires ` +
            `--confirm-delete ${entry.requiresConfirmDelete}`,
        );
      }
    }
  }

  // 1. git mv / git rm (+ the two configs' restricted-key edits) for every entry.
  for (const entry of plan.entries) {
    if (entry.class === "move") {
      gitMv(adapter, cwd, entry.path, entry.dest);
    } else if (entry.class === "delete") {
      git(adapter, cwd, ["rm", "--", entry.path]);
    } else if (entry.class === "moveEdit") {
      const text = readRepoFile(cwd, entry.path);
      const edited = applyConfigEdits(text, entry.edits);
      gitMv(adapter, cwd, entry.path, entry.dest);
      writeRepoFile(cwd, entry.dest, edited);
      git(adapter, cwd, ["add", "--", entry.dest]);
    }
  }

  // 2. .gitignore.
  writeRepoFile(cwd, GITIGNORE_REL, applyGitignorePatch(readRepoFile(cwd, GITIGNORE_REL)));
  git(adapter, cwd, ["add", "--", GITIGNORE_REL]);

  // 3. LAYOUT_MODE flip.
  writeRepoFile(cwd, LAYOUT_REL, flipLayoutModeToP5(readRepoFile(cwd, LAYOUT_REL)));
  git(adapter, cwd, ["add", "--", LAYOUT_REL]);

  // 4. Workflow staging swap (skips gracefully if workflows-p5 is missing/empty).
  const workflowSwap = applyWorkflowSwap(adapter, cwd);

  return { entries: plan.entries, workflowSwap };
}

/**
 * Reverse: the exact inverse of {@link apply}. Requires `beforeRef`
 * (default `HEAD^`) to resolve to the pre-apply commit — true both for the
 * real cutover commit B (always built as one commit on top of the prior
 * develop tip) and for a round-trip test's `apply` -> commit -> `apply
 * --reverse` sequence. Used to restore the two `delete`-class files and
 * the three deleted workflow names, none of which are recoverable from
 * the current working tree alone.
 */
export function applyReverse(options: ApplyOptions, beforeRef = "HEAD^"): ApplyResult {
  const { git: adapter, cwd } = options;

  const beforePaths = git(adapter, cwd, ["ls-tree", "-r", "--name-only", beforeRef])
    .split("\n")
    .filter((l) => l.length > 0);
  const plan = buildPlan({ paths: beforePaths });
  if (!planIsClean(plan)) {
    throw new ApplyError(
      `refusing to reverse: ${beforeRef}'s tree does not reclassify cleanly:\n` +
        plan.problems.map((p) => `  - [${p.kind}] ${p.message}`).join("\n"),
    );
  }

  // 4'. Workflow staging swap, reversed.
  const workflowSwap = reverseWorkflowSwap(adapter, cwd, beforeRef);

  // 3'. LAYOUT_MODE flip, reversed.
  writeRepoFile(cwd, LAYOUT_REL, flipLayoutModeToLegacy(readRepoFile(cwd, LAYOUT_REL)));
  git(adapter, cwd, ["add", "--", LAYOUT_REL]);

  // 2'. .gitignore, reversed.
  writeRepoFile(cwd, GITIGNORE_REL, reverseGitignorePatch(readRepoFile(cwd, GITIGNORE_REL)));
  git(adapter, cwd, ["add", "--", GITIGNORE_REL]);

  // 1'. git mv / restore-from-beforeRef for every entry, reversed.
  for (const entry of plan.entries) {
    if (entry.class === "move") {
      gitMv(adapter, cwd, entry.dest, entry.path);
    } else if (entry.class === "delete") {
      const original = showBlobRaw(adapter, cwd, `${beforeRef}:${entry.path}`);
      writeRepoFile(cwd, entry.path, original);
      git(adapter, cwd, ["add", "--", entry.path]);
    } else if (entry.class === "moveEdit") {
      const text = readRepoFile(cwd, entry.dest);
      const reverted = reverseConfigEdits(text, entry.edits);
      gitMv(adapter, cwd, entry.dest, entry.path);
      writeRepoFile(cwd, entry.path, reverted);
      git(adapter, cwd, ["add", "--", entry.path]);
    }
  }

  return { entries: plan.entries, workflowSwap };
}

function showBlobRaw(adapter: GitAdapter, cwd: string, ref: string): string {
  const result = adapter.run(cwd, ["show", ref]);
  if (result.exitCode !== 0) {
    throw new ApplyError(`git show ${ref} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
