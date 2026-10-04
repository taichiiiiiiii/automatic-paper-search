/**
 * Cross-process mutual exclusion for `classifications.json` — TS port of
 * the `fcntl.flock(<path>.lock)` pattern `build_lineage.persist_classifications`
 * / `compact_classifications.py` / `purge_template_classifications.py` all
 * share (CLAUDE.md §14).
 *
 * Node's `node:fs` exposes no `flock` syscall, so — exactly like
 * `collect/state/seenIds.ts`'s COL-22 port (the brief's "shared lockfile
 * approach used for seen_ids in collect/state") — this uses a lockfile +
 * `O_EXCL` scheme with an equivalent *outcome* (serialized read-merge-write
 * across concurrent callers), not the same *primitive*. Duplicated here
 * rather than imported because `collect/state/seenIds.ts`'s
 * `acquireLock`/`releaseLock` are module-private and `collect/state/**` is
 * outside this task's edit scope.
 *
 * "holding the lock" = having created `<path>.lock` with the `wx` flag
 * (fails with EEXIST if it already exists). "releasing the lock" = deleting
 * that file. A caller that finds the lock file already there polls until it
 * can create it, or until the lock is judged STALE (mtime older than
 * {@link STALE_LOCK_MS} — a previous holder almost certainly crashed without
 * cleaning up).
 *
 * KNOWN ADAPTATION (documented, not a parity gap to hide): Python's
 * `fcntl.flock` auto-releases when the holding process exits/crashes and
 * never leaves the `.lock` FILE itself behind (the lock is kernel state on
 * the fd, not the file's existence). This scheme's lock IS the file's
 * existence, so a `.lock` file written by a Python process that crashed
 * (or even one that exited normally without `flock`-unlocking in a way this
 * scheme would see) is read by this port as "someone's holding it" until it
 * ages past {@link STALE_LOCK_MS} — i.e. a mixed Python/TS deployment can
 * see a bounded (60s) extra wait on the TS side the Python side never pays.
 * Flagged as a p4-followups candidate; not fixed here (would require the
 * Python side to also delete the lock file, which is out of this task's
 * read-only-Python-code scope).
 */

import * as fs from "node:fs";
import { dirname } from "node:path";

const STALE_LOCK_MS = 60_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquires the sibling `<path>.lock` next to `cachePath`. */
export async function acquireClassificationLock(lockPath: string): Promise<void> {
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* another caller may have already cleared it; retry the loop */
        }
        continue;
      }
    } catch {
      // Lock file vanished between our failed create and this stat; retry.
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for lock ${lockPath}`);
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

export function releaseClassificationLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already released */
  }
}

/** Runs `fn` while holding the exclusive lock sibling to `cachePath` (`<cachePath>.lock`). */
export async function withClassificationLock<T>(
  cachePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const lockPath = `${cachePath}.lock`;
  await acquireClassificationLock(lockPath);
  try {
    return await fn();
  } finally {
    releaseClassificationLock(lockPath);
  }
}
