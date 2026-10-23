// In-flight dedup for POST /api/themes (request-flow integration test,
// 2026-10). Before this, two requests for the same NEW theme (a second tab,
// a reload during the 5-15 min generation, two visitors) each dispatched
// theme-on-demand.yml: the manifest only learns the slug once the first
// run has published, so the "exists" check cannot catch it. Every extra
// dispatch burns Actions minutes / API budget and races the promoter.
//
// The ledger records `inflight:<slug>` -> {request_id, expiresAt} for
// INFLIGHT_TTL_MS after a successful claim. A later request for the same
// slug inside that window gets the first request's id back (status
// "queued", `deduplicated: true`) so the browser follows the run already
// in progress, with no dispatch and no quota charge. A failed dispatch
// releases the claim so a retry can dispatch again. Lives in the same
// single QuotaCounter Durable Object as the quota buckets (one instance =
// exact, race-free claims), swept by the same alarm.

export const INFLIGHT_KEY_PREFIX = "inflight:";

// theme-on-demand.yml's generate job has timeout-minutes: 40 (R2-43: a
// popular field took ~17 min to build, ~32 min end to end); the promote and
// release jobs follow. 50 minutes covers a normal run plus queueing; after
// that a retry is allowed even if the run silently died.
export const INFLIGHT_TTL_MS = 50 * 60 * 1000;

export interface InflightStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

interface InflightEntry {
  request_id: string;
  expiresAt: number;
}

export type ClaimResult = { claimed: true } | { claimed: false; requestId: string };

export class InflightLedger {
  constructor(
    private readonly storage: InflightStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async live(slug: string): Promise<InflightEntry | null> {
    const entry = await this.storage.get<InflightEntry>(`${INFLIGHT_KEY_PREFIX}${slug}`);
    if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= this.now()) return null;
    return typeof entry.request_id === "string" ? entry : null;
  }

  /** The request id of a live in-flight run for `slug`, or null. */
  async peek(slug: string): Promise<string | null> {
    return (await this.live(slug))?.request_id ?? null;
  }

  /** Claims `slug` for `requestId` unless a live claim exists (then
   * returns that claim's id). Atomic inside the Durable Object. */
  async claim(slug: string, requestId: string): Promise<ClaimResult> {
    const existing = await this.live(slug);
    if (existing) return { claimed: false, requestId: existing.request_id };
    await this.storage.put(`${INFLIGHT_KEY_PREFIX}${slug}`, {
      request_id: requestId,
      expiresAt: this.now() + INFLIGHT_TTL_MS,
    });
    return { claimed: true };
  }

  /** Drops the claim, but only if it still belongs to `requestId`. */
  async release(slug: string, requestId: string): Promise<void> {
    const key = `${INFLIGHT_KEY_PREFIX}${slug}`;
    const entry = await this.storage.get<InflightEntry>(key);
    if (entry && entry.request_id === requestId) await this.storage.delete(key);
  }
}

/** What the route handler depends on (Durable Object stub in production,
 * an InflightLedger over a Map in tests). */
export interface InflightBackend {
  peek(slug: string): Promise<string | null>;
  claim(slug: string, requestId: string): Promise<ClaimResult>;
  release(slug: string, requestId: string): Promise<void>;
}
