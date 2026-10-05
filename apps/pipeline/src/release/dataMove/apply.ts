/**
 * `cli.ts apply [--reverse]` (p5-plan.md §5.2/§5.3): performs the data-move
 * commit's mechanics against the live working tree — `git mv`/`git rm`
 * for every rule-table entry, the two config files' restricted-key edits,
 * the `.gitignore` patch, the `LAYOUT_MODE` literal flip, the
 * `.lighthouserc.json` rewrite (p5-plan.md §4.1), and the
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
import { applyLighthouseEdit, reverseLighthouseEdit } from "./lighthouseEdit.js";
import { buildPlan, planIsClean } from "./plan.js";
import type { RuleEntry } from "./rules.js";
import { verifyMove } from "./verify.js";
import {
  applyWorkflowSwap,
  listStagedWorkflowFiles,
  reverseWorkflowSwap,
  type WorkflowSwapResult,
} from "./workflowSwap.js";

export class ApplyError extends Error {}

const GITIGNORE_REL = ".gitignore";
const LAYOUT_REL = "packages/core/src/layout/index.ts";
const LIGHTHOUSERC_REL = ".lighthouserc.json";

export interface ApplyOptions {
  readonly git: GitAdapter;
  readonly cwd: string;
  /** Must equal a gated delete entry's `requiresConfirmDelete` exactly, or `apply` refuses the whole operation. */
  readonly confirmDelete?: string;
  /**
   * Forward `apply` only (p5-plan.md §5.1 L8): by default, a missing or
   * empty `.github/workflows-p5` makes `apply` refuse the *entire*
   * operation before touching anything — not silently skip the workflow
   * swap while still moving data, flipping the layout, and patching
   * `.gitignore`/`.lighthouserc.json`, which would commit a `LAYOUT_MODE:
   * "p5"` tree with no Node workflows at all (no CI, no releases). Pass
   * `true` only for a deliberate incremental rehearsal where another
   * agent's `.github/workflows-p5` has not landed yet.
   */
  readonly allowMissingWorkflows?: boolean;
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

  // L8: refuse — never silently skip — a missing/empty .github/workflows-p5,
  // checked up front (before any `git mv`/`git add`) so the refusal leaves
  // the tree untouched, same as the --confirm-delete gate above.
  if (listStagedWorkflowFiles(cwd).length === 0 && !options.allowMissingWorkflows) {
    throw new ApplyError(
      "refusing to apply: .github/workflows-p5 is missing or empty, so the workflow swap " +
        "(and its three deletes) would be skipped while data still moves and LAYOUT_MODE still " +
        "flips to p5 — pass --allow-missing-workflows to accept that on purpose",
    );
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

  // 3b. .lighthouserc.json rewrite (p5-plan.md §4.1).
  writeRepoFile(cwd, LIGHTHOUSERC_REL, applyLighthouseEdit(readRepoFile(cwd, LIGHTHOUSERC_REL)));
  git(adapter, cwd, ["add", "--", LIGHTHOUSERC_REL]);

  // 4. Workflow staging swap (skips gracefully if workflows-p5 is missing/empty).
  const workflowSwap = applyWorkflowSwap(adapter, cwd);

  return { entries: plan.entries, workflowSwap };
}

/**
 * Reverse: the exact inverse of {@link apply}. `beforeRef` is **required**
 * (p5-plan.md §5.2/§6.2 R-B, review finding M3) — there is no implicit
 * `HEAD^` default, because that silently assumes HEAD *is* the cutover
 * commit B with nothing committed on top of it, which stops being true the
 * moment any post-B commit lands (R-B can run up to a week after Merge B,
 * per §6.2's observation window). Callers who do have post-B `data/**`
 * changes to carry back first must use {@link "./carryBack.js"}'s
 * `carryBack` — a separate, standalone mode — *before* calling this
 * function, never by passing some other ref here and hoping this function
 * also absorbs the drift.
 *
 * Before touching anything, this asserts (via {@link verifyMove}) that
 * `HEAD`'s tree is *exactly* `beforeRef`'s forward-`apply` result — the
 * same byte-SHA/mode/no-extra-diff proof `verify` itself performs. If it
 * is not (a post-B commit changed something `verify(beforeRef, "HEAD")`
 * would flag, or `beforeRef`'s own tree doesn't reclassify cleanly, or a
 * prior `git revert` of the cutover commit already undid some of it —
 * review probe P5), this throws {@link ApplyError} and mutates nothing.
 * Without this check, the previous implementation would run the workflow
 * swap, the `.lighthouserc.json`/`LAYOUT_MODE`/`.gitignore` reversals, and
 * *then* start `git mv`-ing data back, only to crash partway through
 * (review probe P4) — leaving a half-reversed tree with no commit to
 * explain it, which is strictly worse than refusing up front.
 */
export function applyReverse(options: ApplyOptions, beforeRef: string): ApplyResult {
  const { git: adapter, cwd } = options;

  const verification = verifyMove({ git: adapter, cwd, before: beforeRef, after: "HEAD" });
  if (!verification.ok) {
    throw new ApplyError(
      `refusing to reverse: HEAD is not exactly ${beforeRef}'s forward-apply result, so ` +
        "reversing now would silently half-reverse or desync the tree " +
        `(run \`dataMove verify ${beforeRef} HEAD\` for the full report):\n` +
        verification.problems.map((p) => `  - ${p}`).join("\n"),
    );
  }

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

  // 3b'. .lighthouserc.json rewrite, reversed.
  writeRepoFile(cwd, LIGHTHOUSERC_REL, reverseLighthouseEdit(readRepoFile(cwd, LIGHTHOUSERC_REL)));
  git(adapter, cwd, ["add", "--", LIGHTHOUSERC_REL]);

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
