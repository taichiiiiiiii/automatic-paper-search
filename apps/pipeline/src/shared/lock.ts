/**
 * Cross-process mutual exclusion via a sibling `<path>.lock` file.
 *
 * Node's `node:fs` exposes no `flock` syscall, so this uses a lockfile +
 * `O_EXCL` scheme with an equivalent *outcome* (serialized read-merge-write
 * across concurrent callers), not the same *primitive* `fcntl.flock`
 * provides. Consolidated per docs/migration/p4-followups.md #13: this
 * algorithm used to be independently duplicated in two places —
 * `collect/state/seenIds.ts` (COL-22, `mergeSeenIds`'s lock) and
 * `lineage/classify/lock.ts` (CLAUDE.md §14, `classifications.json`'s
 * lock) — because each P4 task's edit scope excluded the other's
 * directory. The algorithm kept here is the STRONGER of the two: a
 * TOCTOU-safe stale-lock break (originally only in `lineage/classify/
 * lock.ts`), parameterized with the configurable tuning (originally only
 * in `collect/state/seenIds.ts`'s `LockTuning`). Both former call sites
 * now re-export thin wrappers around this module so neither's public API
 * changes.
 *
 * "holding the lock" = having created `<path>.lock` with the `wx` flag
 * (fails with EEXIST if it already exists), its content a per-attempt
 * OWNER TOKEN (`<pid>-<random>`, not just the pid — two acquisitions in
 * the same process, e.g. two tests in one Vitest worker, must not look
 * like the same owner). "releasing the lock" = deleting that file, but
 * ONLY after confirming the file still holds OUR token (see
 * {@link releaseLock}).
 *
 * A caller that finds the lock file already there polls until it can
 * create it, or until the lock is judged STALE (mtime older than
 * `staleLockMs` — a previous holder almost certainly crashed without
 * cleaning up). Breaking a stale lock is NOT a plain stat-then-unlink
 * (review M5): between the staleness read and the unlink, the
 * slow-but-alive holder we judged "probably crashed" can finish and
 * release normally, and a brand-new caller can legitimately acquire a
 * FRESH lock at the same path — a plain unlink would then delete that
 * fresh lock out from under its new, legitimate owner. Instead the break
 * is done via `rename` to a unique tombstone path (atomic — whatever is
 * at `lockPath` right now moves, whoever that belongs to), and the
 * tombstoned file's content + mtime are then checked against the
 * snapshot taken before the rename: a match means it really was the
 * same old, stale lock and the tombstone is discarded; a mismatch means
 * a fresh lock got clobbered, so it is renamed back into place and this
 * caller just retries the loop instead of proceeding.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname } from "node:path";

export interface LockTuning {
  staleLockMs?: number;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
}

const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 20;

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
 * Acquires the sibling `<path>.lock` at `lockPath`. Returns the owner
 * token written into the lock file; pass it to {@link releaseLock} so
 * release can verify it still owns the lock before deleting the file.
 */
export async function acquireLock(lockPath: string, tuning: LockTuning = {}): Promise<string> {
  const staleLockMs = tuning.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const lockTimeoutMs = tuning.lockTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS;
  const pollIntervalMs = tuning.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
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
      if (Date.now() - stat.mtimeMs > staleLockMs) {
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
    await sleep(pollIntervalMs);
  }
}

/**
 * Releases a lock this caller acquired, identified by the exact token
 * {@link acquireLock} returned. If the file at `lockPath` no longer holds
 * that token — broken as stale and re-acquired by someone else, or never
 * ours — this is a no-op: unlinking it would delete another holder's
 * active lock out from under it.
 */
export function releaseLock(lockPath: string, token: string): void {
  let current: string | null = null;
  try {
    current = fs.readFileSync(lockPath, "utf-8");
  } catch {
    return; // already gone
  }
  if (current !== token) return; // not ours (anymore) — do not touch it
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already released/replaced between our read and unlink above */
  }
}

/** Runs `fn` while holding the exclusive lock at `lockPath`. */
export async function withLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  tuning: LockTuning = {},
): Promise<T> {
  const token = await acquireLock(lockPath, tuning);
  try {
    return await fn();
  } finally {
    releaseLock(lockPath, token);
  }
}
