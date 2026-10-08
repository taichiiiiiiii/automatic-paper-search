/**
 * Child-process harness for the MEDIUM-1 (P4 review round 2) regression
 * test in `../lock.test.ts`.
 *
 * `acquireLock`'s stale-lock branch used to treat ANY `readFileSync`/
 * `statSync` failure — not just ENOENT — as "the lock file vanished" and
 * `continue` straight back to the top of its `for (;;)` loop WITHOUT
 * checking the deadline or ever `await`-ing `sleep`. Since nothing in
 * that path yields to the event loop, a non-ENOENT failure that recurs
 * every iteration (e.g. a permanently unreadable, but still STALE, lock
 * file) became a synchronous busy-spin that blocks the event loop
 * forever — `lockTimeoutMs` is never honored because `Date.now() >
 * deadline` is never reached.
 *
 * Run out-of-process (spawned by the test with a kill timer) so that a
 * regression hangs only this child, not the whole Vitest worker.
 */
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock } from "../../../src/shared/lock.js";

const [lockPath, lockTimeoutMsRaw] = process.argv.slice(2);
if (!lockPath || !lockTimeoutMsRaw) {
  throw new Error("usage: acquireLockStaleBranchChild.ts <lockPath> <lockTimeoutMs>");
}

mkdirSync(dirname(lockPath), { recursive: true });
writeFileSync(lockPath, "stale-owner");
// Old enough to be judged stale against the tiny `staleLockMs` below.
const old = Date.now() - 10_000;
utimesSync(lockPath, old / 1000, old / 1000);
// No read permission -> readFileSync(lockPath) throws EACCES, not ENOENT.
chmodSync(lockPath, 0o000);

acquireLock(lockPath, {
  staleLockMs: 10,
  lockTimeoutMs: Number(lockTimeoutMsRaw),
  lockPollIntervalMs: 10,
})
  .then((token) => {
    console.log(`ACQUIRED:${token}`);
    process.exit(0);
  })
  .catch((e: unknown) => {
    console.log(`REJECTED:${(e as Error).message}`);
    process.exit(1);
  });
