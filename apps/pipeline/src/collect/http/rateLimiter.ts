/**
 * Trivial sleep-based rate limiter for polite API usage — TS port of
 * `paperpilot/utils/rate_limiter.py::RateLimiter`.
 *
 * Node's collection pipeline is single-threaded (no GIL-adjacent thread
 * pool fetching pages concurrently the way `collect_cvf.py`'s
 * `ThreadPoolExecutor` does in Python), so the original's `threading.Lock`
 * has no TS equivalent need — `wait()` is an async method and callers that
 * want concurrent-safe throttling should `await` it sequentially (which is
 * what every Source in this port does: one keyword fetch at a time). This
 * is a documented, intentional simplification, not a parity gap in the
 * synchronous single-caller case the ported tests exercise.
 */
export class RateLimiter {
  private readonly delayMs: number;
  private lastCall = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    delaySeconds: number,
    deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.delayMs = Math.max(0, delaySeconds) * 1000;
    this.now = deps.now ?? (() => performance.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async wait(): Promise<void> {
    if (this.delayMs <= 0) return;
    const elapsed = this.now() - this.lastCall;
    const remaining = this.delayMs - elapsed;
    if (remaining > 0) {
      await this.sleep(remaining);
    }
    this.lastCall = this.now();
  }
}
