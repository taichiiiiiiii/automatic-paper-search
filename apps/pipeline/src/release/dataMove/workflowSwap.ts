/**
 * The workflow staging swap (p5-plan.md §5.1 "git mv .github/workflows-p5/*
 * -> .github/workflows/ (overwrite); delete ts-ci.yml, publish.yml,
 * paper-slides-on-demand.yml"). Separate from the {@link "./rules.js"}
 * move table: these are the same *names* under both directories (an
 * overwrite-in-place from the diff's point of view, not a rename), so
 * `git mv -f` is used directly rather than going through the generic
 * plan/verify path.
 *
 * If `.github/workflows-p5` is missing or has no files (another P5 agent
 * owns creating it, per the shared brief, and may not have landed yet),
 * {@link applyWorkflowSwap} skips the whole swap — including the three
 * deletes — as one atomic unit: deleting the old workflows without the
 * replacements in place would leave the repository with no CI at all.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type GitAdapter, git, gitOk } from "../git/gitAdapter.js";

export class WorkflowSwapError extends Error {}

const WORKFLOWS_P5_REL = ".github/workflows-p5";
const WORKFLOWS_REL = ".github/workflows";
export const DELETED_WORKFLOW_NAMES = [
  "ts-ci.yml",
  "publish.yml",
  "paper-slides-on-demand.yml",
] as const;

export interface WorkflowSwapResult {
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly movedNames: readonly string[];
  readonly deletedNames: readonly string[];
}

/** Every regular file under `dir`, as paths relative to `dir` (POSIX, sorted). */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  function walk(relDir: string): void {
    const absDir = join(dir, relDir);
    for (const name of readdirSync(absDir)) {
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = join(absDir, name);
      if (statSync(abs).isDirectory()) {
        walk(rel);
      } else {
        out.push(rel);
      }
    }
  }
  walk("");
  return out.sort();
}

/** Raw (non-trimmed) blob content via `git show <ref>` — unlike {@link git}, which trims stdout. */
function readBlobRaw(adapter: GitAdapter, cwd: string, ref: string): string {
  const result = adapter.run(cwd, ["show", ref]);
  if (result.exitCode !== 0) {
    throw new WorkflowSwapError(`git show ${ref} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Lists the relative file paths under `.github/workflows-p5` (empty if missing/empty), sorted for determinism. */
export function listStagedWorkflowFiles(cwd: string): string[] {
  const dir = join(cwd, WORKFLOWS_P5_REL);
  if (!existsSync(dir)) return [];
  return listFilesRecursive(dir);
}

/**
 * Moves every file under `.github/workflows-p5` onto the same relative
 * path under `.github/workflows` (overwriting), then deletes
 * {@link DELETED_WORKFLOW_NAMES}. Skips entirely (returns
 * `{skipped: true}`) when `.github/workflows-p5` is missing or empty.
 */
export function applyWorkflowSwap(adapter: GitAdapter, cwd: string): WorkflowSwapResult {
  const names = listStagedWorkflowFiles(cwd);
  if (names.length === 0) {
    return {
      skipped: true,
      skipReason:
        `${WORKFLOWS_P5_REL} is missing or empty — skipping the workflow swap (and the ` +
        "three deletes) as one atomic unit until the agent staging it lands",
      movedNames: [],
      deletedNames: [],
    };
  }

  for (const name of names) {
    const destRel = `${WORKFLOWS_REL}/${name}`;
    mkdirSync(dirname(join(cwd, destRel)), { recursive: true });
    git(adapter, cwd, ["mv", "-f", `${WORKFLOWS_P5_REL}/${name}`, destRel]);
  }
  // `git mv` doesn't necessarily clean up a now-empty source directory on
  // disk (unlike `git rm`'s default) — this keeps the working tree tidy;
  // git itself never tracked `.github/workflows-p5` as a directory, so
  // this has no effect on what gets committed either way.
  removeEmptyDirsRecursively(join(cwd, WORKFLOWS_P5_REL));

  const deleted: string[] = [];
  for (const name of DELETED_WORKFLOW_NAMES) {
    const target = `${WORKFLOWS_REL}/${name}`;
    if (!gitOk(adapter, cwd, ["rm", "--", target])) {
      throw new WorkflowSwapError(
        `expected ${target} to exist and be removable, but \`git rm\` failed`,
      );
    }
    deleted.push(name);
  }
  return { skipped: false, movedNames: names, deletedNames: deleted };
}

/** Removes `dir` and any now-empty subdirectories, bottom-up. A no-op if `dir` is missing or non-empty. */
function removeEmptyDirsRecursively(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) removeEmptyDirsRecursively(full);
  }
  if (readdirSync(dir).length === 0) {
    rmdirSync(dir);
  }
}

/**
 * The exact inverse of {@link applyWorkflowSwap}, given `beforeRef` — a
 * commit that still has `.github/workflows-p5` populated (by convention,
 * `apply`'s single commit's parent). For each staged name: the file
 * currently at `.github/workflows/<name>` (today's working tree — this is
 * the content the forward swap put there) is written back to
 * `.github/workflows-p5/<name>`; `.github/workflows/<name>` is then
 * restored to whatever `beforeRef` had there (or removed, if `beforeRef`
 * didn't have it — e.g. a workflow that is new in p5). The three deleted
 * names are restored from `beforeRef` the same way.
 */
export function reverseWorkflowSwap(
  adapter: GitAdapter,
  cwd: string,
  beforeRef: string,
): WorkflowSwapResult {
  const stagedBefore = git(adapter, cwd, [
    "ls-tree",
    "-r",
    "--name-only",
    beforeRef,
    "--",
    WORKFLOWS_P5_REL,
  ])
    .split("\n")
    .filter((l) => l.length > 0)
    .map((p) => p.slice(`${WORKFLOWS_P5_REL}/`.length))
    .sort();

  if (stagedBefore.length === 0) {
    return {
      skipped: true,
      skipReason: `${beforeRef} had no files under ${WORKFLOWS_P5_REL} — nothing to reverse`,
      movedNames: [],
      deletedNames: [],
    };
  }

  for (const name of stagedBefore) {
    const currentPath = join(cwd, WORKFLOWS_REL, name);
    const currentContent = readFileSync(currentPath);
    const stagedPath = join(cwd, WORKFLOWS_P5_REL, name);
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, currentContent);
    git(adapter, cwd, ["add", "--", `${WORKFLOWS_P5_REL}/${name}`]);

    const existedBeforeRef = `${beforeRef}:${WORKFLOWS_REL}/${name}`;
    if (gitOk(adapter, cwd, ["cat-file", "-e", existedBeforeRef])) {
      const original = readBlobRaw(adapter, cwd, existedBeforeRef);
      writeFileSync(currentPath, original);
      git(adapter, cwd, ["add", "--", `${WORKFLOWS_REL}/${name}`]);
    } else {
      git(adapter, cwd, ["rm", "--", `${WORKFLOWS_REL}/${name}`]);
    }
  }

  const restored: string[] = [];
  for (const name of DELETED_WORKFLOW_NAMES) {
    const ref = `${beforeRef}:${WORKFLOWS_REL}/${name}`;
    if (!gitOk(adapter, cwd, ["cat-file", "-e", ref])) {
      throw new WorkflowSwapError(`expected ${ref} to exist to restore the deleted workflow`);
    }
    const original = readBlobRaw(adapter, cwd, ref);
    writeFileSync(join(cwd, WORKFLOWS_REL, name), original);
    git(adapter, cwd, ["add", "--", `${WORKFLOWS_REL}/${name}`]);
    restored.push(name);
  }

  return { skipped: false, movedNames: stagedBefore, deletedNames: restored };
}
