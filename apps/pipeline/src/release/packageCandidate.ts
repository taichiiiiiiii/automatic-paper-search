/**
 * Copy only generated working-tree changes under explicit repository paths
 * — TS port of `.github/scripts/package-generated-candidate.sh`.
 *
 * Implements PUB-16..20 of `docs/migration/safety-contracts.md`.
 */

import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  isUnderIncludedPath,
  PathSafetyError,
  validateCandidateDirArg,
  validateIncludedPathArg,
} from "@paperpilot/core/paths";
import { type GitAdapter, git } from "./git/gitAdapter.js";

export class PackageCandidateError extends Error {}

export interface PackageCandidateOptions {
  /** Absolute path, outside the repository, to copy the candidate into. */
  candidateDir: string;
  includedPaths: string[];
  git: GitAdapter;
  /** The repository checkout to package changes from (equivalent to the shell script's cwd / `git rev-parse --show-toplevel`). */
  repoRoot: string;
  /**
   * `PAPERPILOT_PACKAGE_INCLUDE_UNCHANGED` (snapshot mode): copy the exact
   * included paths verbatim, even if unchanged, instead of diffing against
   * `HEAD`. Used by a narrowly-scoped generator that may reproduce
   * byte-identical output (PUB-20).
   */
  snapshotMode?: boolean;
}

export interface PackageCandidateResult {
  copied: number;
}

function copyChangedFile(repoRoot: string, candidateDir: string, relPath: string): void {
  const source = join(repoRoot, relPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(source);
  } catch {
    throw new PackageCandidateError(`generated deletion is not supported: ${relPath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new PackageCandidateError(`generated symlink is forbidden: ${relPath}`);
  }
  if (!stat.isFile()) {
    return;
  }
  const dest = join(candidateDir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
}

function listFilesUnderSnapshotPath(repoRoot: string, includedPath: string): string[] {
  const full = join(repoRoot, includedPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(full);
  } catch {
    throw new PackageCandidateError(`snapshot path does not exist: ${includedPath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new PackageCandidateError(`generated symlink is forbidden: ${includedPath}`);
  }
  if (stat.isFile()) {
    return [includedPath];
  }
  if (!stat.isDirectory()) {
    throw new PackageCandidateError(`snapshot path is not a file or directory: ${includedPath}`);
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const entryPath = join(dir, name);
      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) {
        throw new PackageCandidateError(`generated symlink is forbidden below: ${includedPath}`);
      }
      if (entryStat.isDirectory()) {
        walk(entryPath);
      } else {
        files.push(relative(repoRoot, entryPath));
      }
    }
  };
  walk(full);
  return files;
}

/**
 * Copy only the working-tree changes under `options.includedPaths` into
 * `options.candidateDir`. Throws {@link PackageCandidateError} /
 * {@link PathSafetyError} if the arguments are unsafe or if nothing
 * changed to package.
 */
export function packageCandidate(options: PackageCandidateOptions): PackageCandidateResult {
  if (options.includedPaths.length === 0) {
    throw new PackageCandidateError("usage: at least one included path is required");
  }
  validateCandidateDirArg(options.candidateDir, options.repoRoot);
  for (const included of options.includedPaths) {
    validateIncludedPathArg(included);
  }

  mkdirSync(options.candidateDir, { recursive: true });
  let copied = 0;

  if (options.snapshotMode) {
    // A narrowly scoped generator may legitimately reproduce byte-identical
    // output. Snapshot only its exact include path so the promoter can
    // return changed=false without broadening the candidate to shared
    // directories.
    for (const included of options.includedPaths) {
      for (const relPath of listFilesUnderSnapshotPath(options.repoRoot, included)) {
        copyChangedFile(options.repoRoot, options.candidateDir, relPath);
        copied += 1;
      }
    }
  } else {
    const changed = git(options.git, options.repoRoot, [
      "diff",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      "-z",
      "HEAD",
    ]);
    const untracked = git(options.git, options.repoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const candidatePaths = [...splitNulTerminated(changed), ...splitNulTerminated(untracked)];
    for (const relPath of candidatePaths) {
      if (!isUnderIncludedPath(relPath, options.includedPaths)) continue;
      copyChangedFile(options.repoRoot, options.candidateDir, relPath);
      copied += 1;
    }
  }

  if (copied === 0) {
    throw new PackageCandidateError("no generated candidate files changed");
  }
  return { copied };
}

function splitNulTerminated(text: string): string[] {
  return text.split("\0").filter((part) => part !== "");
}

export { PathSafetyError };
