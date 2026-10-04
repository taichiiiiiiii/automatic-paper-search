/**
 * Port of `paperpilot/tests/test_rate_limiter.py`.
 *
 * N/A (no TS port): `test_wait_is_thread_safe_under_concurrent_callers` — Node's
 * collection pipeline has no multi-threaded concurrent callers sharing one
 * RateLimiter instance (see rateLimiter.ts's doc comment); this port's Sources
 * only ever call `wait()` sequentially from a single async task.
 */
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../../src/collect/http/rateLimiter.js";

describe("RateLimiter", () => {
  it("is a no-op with zero delay", async () => {
    const slept: number[] = [];
    const lim = new RateLimiter(0, { sleep: async (s) => void slept.push(s) });
    await lim.wait();
    await lim.wait();
    expect(slept).toEqual([]);
  });

  it("sleeps when the interval since the last call is too short", async () => {
    let now = 1000.0;
    const slept: number[] = [];
    const lim = new RateLimiter(1.0, {
      now: () => now,
      sleep: async (s) => {
        slept.push(s);
        now += s;
      },
    });
    await lim.wait(); // first call: no prior timestamp, no sleep
    expect(slept).toEqual([]);
    now += 300; // advance 0.3s (in ms units: 300ms)
    await lim.wait();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeCloseTo(700, 0); // ~0.7s remaining, in ms
  });
});
