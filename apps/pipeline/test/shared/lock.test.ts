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
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLock, releaseLock, withLock } from "../../src/shared/lock.js";

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
