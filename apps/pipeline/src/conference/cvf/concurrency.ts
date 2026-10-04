/**
 * Small concurrency helpers for `collect.ts` — TS has no
 * `ThreadPoolExecutor`, so this reimplements the two properties
 * `collect_cvf.py`'s version depends on:
 *
 *   - `mapConcurrent`: up to `limit` fetches in flight at once, results
 *     returned in the SAME order as the input paths (mirrors
 *     `ThreadPoolExecutor.map`, which yields in submission order
 *     regardless of completion order) — `detailPaths`' de-duplication
 *     order is what the "two distinct detail pages... deduped by url"
 *     parity depends on.
 *   - `SerializedRateLimiter`: `apps/pipeline/src/collect/http/rateLimiter.ts`'s
 *     `wait()` reads-then-writes `lastCall` with no lock, so two
 *     concurrent callers can both observe a stale `lastCall` and both
 *     proceed immediately — exactly the aggregate-rate guarantee
 *     `collect_cvf.py`'s single shared `RateLimiter` + `threading.Lock`
 *     (implicit in CPython's GIL for this kind of read-modify-write) is
 *     there to provide. Wrapping `wait()` in a promise-chain mutex here
 *     restores that: only one call is "inside" `wait()` at a time.
 */

import type { RateLimiter } from "../../collect/http/rateLimiter.js";

export class SerializedRateLimiter {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly inner: RateLimiter) {}

  wait(): Promise<void> {
    const run = this.queue.then(() => this.inner.wait());
    // Swallow a rejection here so one failed wait() doesn't wedge the
    // queue for later callers; the caller of `wait()` still sees it via
    // the promise this method returns.
    this.queue = run.catch(() => {});
    return run;
  }
}

/** Up to `limit` concurrent `fn` calls; results come back in input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
