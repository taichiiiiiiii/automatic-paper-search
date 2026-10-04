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
 * outside this task's edit scope (p4-followups #13 notes the duplication
 * as a later consolidation candidate).
 *
 * "holding the lock" = having created `<path>.lock` with the `wx` flag
 * (fails with EEXIST if it already exists), its content a per-attempt
 * OWNER TOKEN (`<pid>-<random>`, not just the pid — two acquisitions in the
 * same process, e.g. two tests in one Vitest worker, must not look like the
 * same owner). "releasing the lock" = deleting that file, but ONLY after
 * confirming the file still holds OUR token (see {@link releaseClassificationLock}).
 *
 * A caller that finds the lock file already there polls until it can
 * create it, or until the lock is judged STALE (mtime older than
 * {@link STALE_LOCK_MS} — a previous holder almost certainly crashed
 * without cleaning up). Breaking a stale lock is NOT a plain
 * stat-then-unlink (review M5): between the staleness read and the
 * unlink, the slow-but-alive holder we judged "probably crashed" can
 * finish and release normally, and a brand-new caller can legitimately
 * acquire a FRESH lock at the same path — a plain unlink would then
 * delete that fresh lock out from under its new, legitimate owner.
 * Instead the break is done via `rename` to a unique tombstone path
 * (atomic — whatever is at `lockPath` right now moves, whoever that
 * belongs to), and the tombstoned file's content + mtime are then
 * checked against the snapshot taken before the rename: a match means
 * it really was the same old, stale lock and the tombstone is discarded;
 * a mismatch means a fresh lock got clobbered, so it is renamed back
 * into place and this caller just retries the loop instead of proceeding.
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

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname } from "node:path";

const STALE_LOCK_MS = 60_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newOwnerToken(): string {
  return `${process.pid}-${randomBytes(8).toString("hex")}`;
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Attempt to break a lock file judged stale, without a chance of deleting
 * one that turned out to be fresh by the time we act on it (see the module
 * doc comment). Returns once `lockPath` is clear for a fresh `wx` attempt
 * — either because the break succeeded, because someone else already
 * cleared it, or because what looked stale turned out to be fresh (in
 * which case nothing was removed and the caller just loops around to
 * re-check).
 */
function breakStaleLockIfStillStale(
  lockPath: string,
  observed: { mtimeMs: number; content: string },
): void {
  const tombstone = `${lockPath}.stale-${newOwnerToken()}`;
  try {
    fs.renameSync(lockPath, tombstone);
  } catch (e) {
    if (isEnoent(e)) return; // someone else already broke or released it
    throw e;
  }
  let stillStale = false;
  try {
    const stat = fs.statSync(tombstone);
    const content = fs.readFileSync(tombstone, "utf-8");
    stillStale = stat.mtimeMs === observed.mtimeMs && content === observed.content;
  } catch {
    // Vanished between our rename and this check — nothing left to restore.
    return;
  }
  if (stillStale) {
    try {
      fs.unlinkSync(tombstone);
    } catch {
      /* already gone */
    }
    return;
  }
  // We raced a fresh acquisition: what we moved aside is NOT the lock we
  // observed as stale (different content/mtime — a new, legitimate owner
  // grabbed this path in the window between our staleness read and the
  // rename above). Put it back rather than discard someone else's live
  // lock.
  try {
    fs.renameSync(tombstone, lockPath);
  } catch {
    // `lockPath` was recreated again (or something else is now there) —
    // drop our tombstone copy rather than clobber whatever is current.
    try {
      fs.unlinkSync(tombstone);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Acquires the sibling `<path>.lock` next to `cachePath`. Returns the
 * owner token written into the lock file; pass it to
 * {@link releaseClassificationLock} so release can verify it still owns
 * the lock before deleting the file.
 */
export async function acquireClassificationLock(lockPath: string): Promise<string> {
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    const token = newOwnerToken();
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        let content: string | null = null;
        try {
          content = fs.readFileSync(lockPath, "utf-8");
        } catch {
          content = null; // vanished already; nothing to break
        }
        if (content !== null) {
          breakStaleLockIfStillStale(lockPath, { mtimeMs: stat.mtimeMs, content });
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
  let current: string | null = null;
  try {
    current = fs.readFileSync(lockPath, "utf-8");
  } catch {
    return; // already gone
  }
  if (current !== ownerToken) return; // not ours (anymore) — do not touch it
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already released/replaced between our read and unlink above */
  }
}

/** Runs `fn` while holding the exclusive lock sibling to `cachePath` (`<cachePath>.lock`). */
export async function withClassificationLock<T>(
  cachePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const lockPath = `${cachePath}.lock`;
  const token = await acquireClassificationLock(lockPath);
  try {
    return await fn();
  } finally {
    releaseClassificationLock(lockPath, token);
  }
}
