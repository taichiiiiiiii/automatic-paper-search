/**
 * Recursive, symlink-rejecting directory walk shared by the promoter
 * (PUB-06) and the candidate packager (PUB-18) — TS port of the walk
 * behaviour in `promote-generated.sh`'s inline Python
 * (`os.walk(root, followlinks=False)` + a `path.is_symlink()` check on
 * every entry) and `package-generated-candidate.sh`'s `find -type l`.
 */

import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export class CandidateSymlinkError extends Error {}

export interface WalkCandidateFilesResult {
  /** Whether at least one regular file was found anywhere in the tree. */
  foundFile: boolean;
}

/**
 * Walk every entry under `root` (directories first, then into them,
 * mirroring `os.walk`), calling `onEntry(relativePosixParts, isDirectory)`
 * for each. Throws {@link CandidateSymlinkError} on the first symlink
 * found (checked before recursing, so a symlinked directory is reported
 * and never descended into — matching `followlinks=False`).
 */
export function walkCandidateFiles(
  root: string,
  onEntry: (relPosixParts: string[], isDirectory: boolean) => void,
): WalkCandidateFilesResult {
  let foundFile = false;

  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const relParts = relative(root, full).split(sep);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new CandidateSymlinkError(`candidate symlink is forbidden: ${relParts.join("/")}`);
      }
      if (stat.isDirectory()) {
        onEntry(relParts, true);
        walk(full);
      } else {
        foundFile = true;
        onEntry(relParts, false);
      }
    }
  }

  walk(root);
  return { foundFile };
}
