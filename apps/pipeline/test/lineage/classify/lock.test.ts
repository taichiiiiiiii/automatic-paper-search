/**
 * `lineage/classify/lock.ts` — the cross-process lockfile scheme
 * `persistClassifications` / `compact` / `purgeTemplateClassificationsMain`
 * all share (CLAUDE.md §14). Review M5: stale-lock break must not delete a
 * fresh lock (TOCTOU between the staleness read and the break), and
 * release must not delete a lock it no longer owns.
 */
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireClassificationLock,
  releaseClassificationLock,
} from "../../../src/lineage/classify/lock.js";

// `fs.statSync` can't be `vi.spyOn`'d directly in ESM (the module
// namespace object isn't configurable) — mock the module and keep the
// real implementation as the default, so only the one TOCTOU test below
// (which installs a `mockImplementationOnce`) actually changes behaviour.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lock-"));
}

const STALE_LOCK_MS = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("acquireClassificationLock / releaseClassificationLock", () => {
  it("round-trips: acquire writes a token, release removes the file", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "c.json.lock");
    const token = await acquireClassificationLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe(token);
    releaseClassificationLock(lockPath, token);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("release does nothing when the on-disk token no longer matches ours (ownership check)", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "c.json.lock");
    const token = await acquireClassificationLock(lockPath);
    // Simulate another caller having broken our (apparently stale) lock
    // and replaced it with its own fresh one while we were still "holding"
    // it (e.g. we were unusually slow inside the critical section).
    writeFileSync(lockPath, "someone-elses-token");
    releaseClassificationLock(lockPath, token);
    // MUST NOT have deleted the other caller's lock.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("someone-elses-token");
  });

  it("breaking a genuinely stale lock succeeds and lets a new acquirer through", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "c.json.lock");
    writeFileSync(lockPath, "crashed-owner");
    const old = Date.now() - (STALE_LOCK_MS + 5_000);
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    const token = await acquireClassificationLock(lockPath);
    expect(readFileSync(lockPath, "utf-8")).toBe(token);
    releaseClassificationLock(lockPath, token);
  });

  it("does NOT delete a fresh lock that replaced a stale one between the staleness read and the break (TOCTOU)", async () => {
    const dir = tmpDir();
    const lockPath = join(dir, "c.json.lock");
    writeFileSync(lockPath, "crashed-owner");
    const old = Date.now() - (STALE_LOCK_MS + 5_000);
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    // After the staleness check's `statSync` reads the OLD mtime, but
    // before the code acts on it, simulate a concurrent legitimate holder:
    // the crashed-owner's lock is actually gone and a brand new, fresh
    // lock has taken its place at the exact same path.
    const statMock = fs.statSync as unknown as Mock;
    const realStatSync = (await vi.importActual<typeof import("node:fs")>("node:fs")).statSync;
    statMock.mockImplementationOnce((p: fs.PathLike, ...rest: unknown[]) => {
      const result = realStatSync(p, ...(rest as []));
      writeFileSync(lockPath, "fresh-concurrent-owner");
      const fresh = Date.now();
      fs.utimesSync(lockPath, fresh / 1000, fresh / 1000);
      return result; // caller still sees the OLD (stale) stat it already read
    });

    const acquirePromise = acquireClassificationLock(lockPath);

    // The acquirer must give up on stealing this path (it's not actually
    // stale anymore) and either time out or keep polling — it must not
    // silently succeed by having clobbered the fresh lock. Race it against
    // a short delay: if `acquirePromise` resolves within that window, that
    // itself proves the fresh lock was NOT respected (acquisition should
    // still be blocked by the fresh, un-stale lock).
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
    // The fresh lock must still be exactly as the "concurrent holder" left
    // it — not stolen, not deleted.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("fresh-concurrent-owner");

    // Clean up: release the fresh lock so the still-pending acquirer (if
    // any) can proceed and the test doesn't leak a dangling promise/timer.
    releaseClassificationLock(lockPath, "fresh-concurrent-owner");
    await acquirePromise.catch(() => {});
  });

  it("acquisition that times out rejects and leaves the held lock file unchanged", async () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    const lockPath = join(dir, "c.json.lock");
    writeFileSync(lockPath, "live-holder");
    // Recent mtime: never judged stale, so the acquirer can only time out.

    const acquirePromise = acquireClassificationLock(lockPath);
    const assertion = expect(acquirePromise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("live-holder");
  });
});
