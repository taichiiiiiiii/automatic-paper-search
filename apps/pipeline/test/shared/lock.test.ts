/**
 * `shared/lock.ts` — the lockfile scheme consolidated here per
 * docs/migration/p4-followups.md #13 from `collect/state/seenIds.ts`
 * (COL-22) and `lineage/classify/lock.ts` (CLAUDE.md §14). Both of those
 * modules' own test suites (`test/collect/state/seenIds.test.ts`,
 * `test/lineage/classify/lock.test.ts`) still exercise this module
 * through their thin re-exporting wrappers unchanged; this file pins the
 * module's own public API directly, including the TOCTOU-safe stale-lock
 * break (review M5) that `collect/state/seenIds.ts`'s OWN pre-consolidation
 * algorithm did not have.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLock, releaseLock, withLock } from "../../src/shared/lock.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/test/shared -> repo root (4 levels up), matching
// test/collect/cli.spawn.test.ts's own REPO_ROOT derivation.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const STALE_BRANCH_CHILD = join(__dirname, "fixtures", "acquireLockStaleBranchChild.ts");

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shared-lock-"));
}

const STALE_LOCK_MS = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("acquireLock / releaseLock", () => {
  it("round-trips: acquire writes a token, release removes the file", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    const token = await acquireLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe(token);
    releaseLock(lockPath, token);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("release does nothing when the on-disk token no longer matches ours (ownership check)", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    const token = await acquireLock(lockPath);
    writeFileSync(lockPath, "someone-elses-token");
    releaseLock(lockPath, token);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("someone-elses-token");
  });

  // LOW (P4 review round 2): `staleLockMs` tuning was only ever exercised
  // at its default value — nothing asserted that passing a SHORTER (or
  // longer) `staleLockMs` actually changes the staleness threshold.
  it("a custom (shorter) staleLockMs breaks a lock the default threshold would still treat as live", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, "crashed-owner");
    const ageMs = 200; // older than a 50ms staleLockMs, nowhere near the 60s default
    const old = Date.now() - ageMs;
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    const token = await acquireLock(lockPath, { staleLockMs: 50, lockTimeoutMs: 2_000 });

    expect(readFileSync(lockPath, "utf-8")).toBe(token);
    releaseLock(lockPath, token);
  });

  it("a custom (shorter) staleLockMs: the SAME lock age times out under the (longer) default threshold", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, "live-holder");
    const ageMs = 200; // stale under staleLockMs:50 (previous test), but not under the 60s default
    const old = Date.now() - ageMs;
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    await expect(
      acquireLock(lockPath, { lockTimeoutMs: 80, lockPollIntervalMs: 10 }),
    ).rejects.toThrow(/timed out/);
  });

  // LOW (P4 review round 2): `acquireLock`'s `fs.mkdirSync(dirname(lockPath),
  // { recursive: true })` call was never exercised with a parent directory
  // that doesn't exist yet.
  it("creates the lock file's parent directory on demand (mkdirSync)", async () => {
    const dir = tmpDir();
    const nestedDir = join(dir, "does", "not", "exist", "yet");
    const lockPath = join(nestedDir, "x.lock");
    expect(fs.existsSync(nestedDir)).toBe(false);

    const token = await acquireLock(lockPath);

    expect(fs.existsSync(nestedDir)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe(token);
    releaseLock(lockPath, token);
  });

  it("breaking a genuinely stale lock succeeds and lets a new acquirer through", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, "crashed-owner");
    const old = Date.now() - (STALE_LOCK_MS + 5_000);
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    const token = await acquireLock(lockPath);
    expect(readFileSync(lockPath, "utf-8")).toBe(token);
    releaseLock(lockPath, token);
  });

  it("does NOT delete a fresh lock that replaced a stale one between the staleness read and the break (TOCTOU, M5)", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, "crashed-owner");
    const old = Date.now() - (STALE_LOCK_MS + 5_000);
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    const statMock = fs.statSync as unknown as Mock;
    const realStatSync = (await vi.importActual<typeof import("node:fs")>("node:fs")).statSync;
    statMock.mockImplementationOnce((p: fs.PathLike, ...rest: unknown[]) => {
      const result = realStatSync(p, ...(rest as []));
      writeFileSync(lockPath, "fresh-concurrent-owner");
      const fresh = Date.now();
      fs.utimesSync(lockPath, fresh / 1000, fresh / 1000);
      return result; // caller still sees the OLD (stale) stat it already read
    });

    const acquirePromise = acquireLock(lockPath);

    let acquired = false;
    acquirePromise.then(
      () => {
        acquired = true;
      },
      () => {
        acquired = true;
      },
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(acquired).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("fresh-concurrent-owner");

    releaseLock(lockPath, "fresh-concurrent-owner");
    await acquirePromise.catch(() => {});
  });

  // P4 review round 3 LOW: the mismatch branch above restores the
  // tombstone with `renameSync(tombstone, lockPath)`, which — unlike
  // `linkSync` — succeeds even when something ALREADY occupies
  // `lockPath`, silently overwriting it. This simulates a THIRD lock
  // appearing at `lockPath` in the window between the mismatch being
  // detected (forced here via a mocked `statSync` on the tombstone path)
  // and the restore attempt: with the fix (`linkSync`, EEXIST-safe) that
  // third lock must survive untouched; with the old `renameSync` this
  // test is RED (the stale tombstone's own "crashed-owner" content
  // silently clobbers it).
  it("restoring a mismatched tombstone never silently overwrites whatever a third party already created at lockPath in that window", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, "crashed-owner");
    const old = Date.now() - (STALE_LOCK_MS + 5_000);
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    const statMock = fs.statSync as unknown as Mock;
    const realStatSync = (await vi.importActual<typeof import("node:fs")>("node:fs")).statSync;
    let injected = false;
    statMock.mockImplementation((p: fs.PathLike, ...rest: unknown[]) => {
      const result = realStatSync(p, ...(rest as []));
      if (!injected && String(p).includes(".stale-")) {
        injected = true;
        // `p` here is the TOMBSTONE path `breakStaleLockIfStillStale`
        // just renamed the stale lock to — `lockPath` itself is
        // momentarily vacant. A third, independent caller grabs it right
        // now, and we force a content/mtime mismatch so the restore
        // branch (not the "still stale, discard" branch) runs next.
        writeFileSync(lockPath, "third-party-fresh-owner");
        return { ...result, mtimeMs: result.mtimeMs + 1 };
      }
      return result;
    });

    await expect(
      acquireLock(lockPath, { lockTimeoutMs: 300, lockPollIntervalMs: 10 }),
    ).rejects.toThrow(/timed out/);

    // The critical invariant: the third party's lock must be exactly what
    // it wrote, never clobbered by our restore of the stale tombstone.
    expect(readFileSync(lockPath, "utf-8")).toBe("third-party-fresh-owner");
    // And the tombstone itself must still be cleaned up either way.
    expect(fs.readdirSync(dir).some((f) => f.includes(".stale-"))).toBe(false);
  });

  it("acquisition that times out rejects and leaves the held lock file unchanged", async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    writeFileSync(lockPath, "live-holder");

    const acquirePromise = acquireLock(lockPath, { lockTimeoutMs: 80, lockPollIntervalMs: 10 });
    const assertion = expect(acquirePromise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("live-holder");
  });

  // M1 of the P4 review round 2: a stale lock file that fails to read
  // with something other than ENOENT (here: EACCES from a chmod-000
  // file) used to be treated as "vanished" and `continue`d straight back
  // to the top of the loop without ever checking the deadline or
  // `await`-ing `sleep` — a synchronous busy-spin that blocks the event
  // loop forever and ignores `lockTimeoutMs`. Run in a spawned child
  // process with a kill timer: an unfixed regression would otherwise hang
  // this test (and the whole Vitest worker) indefinitely rather than
  // simply failing an assertion.
  it("a stale lock file that fails to read with EACCES (not ENOENT) rejects promptly instead of busy-spinning forever", () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    let output: { code: number | null; stdout: string };
    try {
      const stdout = execFileSync(TSX, [STALE_BRANCH_CHILD, lockPath, "200"], {
        encoding: "utf-8",
        // The kill timer: a regression must not hang this test forever. Kept
        // well above tsx startup under load; the timing bound below is
        // measured inside the child, so a generous kill timer loosens nothing.
        timeout: 20_000,
      });
      output = { code: 0, stdout };
    } catch (e) {
      const err = e as { status: number | null; stdout?: string; signal?: string | null };
      if (err.signal) {
        throw new Error(
          `child was killed by its timeout (signal ${err.signal}) — acquireLock busy-spun past lockTimeoutMs instead of rejecting`,
        );
      }
      output = { code: err.status, stdout: String(err.stdout ?? "") };
    }
    expect(output.stdout).toContain("REJECTED");
    // acquireLock's own wall time (measured in the child, excluding process
    // startup): generous against the 200 ms lockTimeoutMs, but tight enough
    // that a busy-spin (which would run until killed) cannot pass it.
    const elapsed = /ELAPSED_MS:(\d+)/.exec(output.stdout);
    expect(elapsed).not.toBeNull();
    expect(Number(elapsed?.[1])).toBeLessThan(2_000);
  });
});

describe("withLock", () => {
  it("runs fn while holding the lock, then releases it even if fn throws", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    await expect(
      withLock(lockPath, () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("returns fn's resolved value", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "x.lock");
    const result = await withLock(lockPath, () => 42);
    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
