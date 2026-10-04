/**
 * Cross-process mutual exclusion for `classifications.json` — TS port of
 * the `fcntl.flock(<path>.lock)` pattern `build_lineage.persist_classifications`
 * / `compact_classifications.py` / `purge_template_classifications.py` all
 * share (CLAUDE.md §14).
 *
 * The lockfile scheme itself (owner-token + TOCTOU-safe stale-lock break
 * via rename-to-tombstone) is consolidated in `../../shared/lock.ts` per
 * docs/migration/p4-followups.md #13 — it used to be duplicated here
 * AND in `collect/state/seenIds.ts` (COL-22) because each P4 task's edit
 * scope excluded the other's directory; this module kept the stronger of
 * the two algorithms when they were merged (see that module's doc
 * comment). The names below are thin wrappers, scoped to
 * `classifications.json`'s specific lock-path convention
 * (`<cachePath>.lock`), so every existing caller/import here is
 * unaffected.
 *
 * KNOWN ADAPTATION (documented, not a parity gap to hide): Python's
 * `fcntl.flock` auto-releases when the holding process exits/crashes and
 * never leaves the `.lock` FILE itself behind (the lock is kernel state on
 * the fd, not the file's existence). This scheme's lock IS the file's
 * existence, so a `.lock` file written by a Python process that crashed
 * (or even one that exited normally without `flock`-unlocking in a way this
 * scheme would see) is read by this port as "someone's holding it" until it
 * ages past the stale-lock threshold — i.e. a mixed Python/TS deployment
 * can see a bounded (60s) extra wait on the TS side the Python side never
 * pays. Flagged as a p4-followups candidate; not fixed here (would require
 * the Python side to also delete the lock file, which is out of this
 * task's read-only-Python-code scope).
 */

import { acquireLock, releaseLock, withLock } from "../../shared/lock.js";

/**
 * Acquires the sibling `<path>.lock` next to `cachePath`. Returns the
 * owner token written into the lock file; pass it to
 * {@link releaseClassificationLock} so release can verify it still owns
 * the lock before deleting the file.
 */
export async function acquireClassificationLock(lockPath: string): Promise<string> {
  return acquireLock(lockPath);
}

/**
 * Releases the sibling `<path>.lock`, but only when its current content is
 * still `ownerToken` — i.e. only when WE still own it. If a stale-lock
 * break (by another caller, while we were unusually slow) already
 * replaced it with a different owner's fresh lock, deleting it
 * unconditionally would release a lock we never held, letting two callers
 * run inside the critical section at once. Silently does nothing when the
 * file is already gone or no longer ours.
 */
export function releaseClassificationLock(lockPath: string, ownerToken: string): void {
  releaseLock(lockPath, ownerToken);
}

/** Runs `fn` while holding the exclusive lock sibling to `cachePath` (`<cachePath>.lock`). */
export async function withClassificationLock<T>(
  cachePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withLock(`${cachePath}.lock`, fn);
}
