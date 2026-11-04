// R2-69: after S2_BREAKER_GIVE_UPS consecutive give-ups (every attempt
// 429), S2 requests fail at once for S2_BREAKER_COOLDOWN_MS instead of
// paying >= 2 min of backoff each; the pair becomes `fetch-failed`, which
// R2-68 hands to arXiv HTML. probeBreaker() lets one deliberate retry
// through (the expansion's R2-52 retry).
import { describe, expect, it } from "vitest";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import {
  S2_BREAKER_COOLDOWN_MS,
  S2_BREAKER_GIVE_UPS,
  S2CitationSource,
} from "../../../src/lineage/theme/s2Citations.js";

const resp = (status: number, body: unknown): HttpResponseLike =>
  ({ status, json: async () => body }) as HttpResponseLike;

const paper = (i: number): ThemePaper => ({
  paperId: `openalex:W${i}`,
  title: `Paper ${i}`,
  year: 2024,
  venue: "",
  citationCount: 1,
  abstract: "",
  authors: [],
  externalIds: { ArXiv: `2401.0000${i}` },
});
const CITED = paper(0);

function harness(statusFor: () => number) {
  let now = 0;
  let requests = 0;
  let slept = 0;
  const src = new S2CitationSource(null, {
    fetchImpl: async () => {
      requests += 1;
      const s = statusFor();
      return s === 200 ? resp(200, { data: [] }) : resp(s, null);
    },
    sleep: async (ms: number) => {
      slept += ms;
      now += ms;
    },
    monotonicNow: () => now,
  });
  return {
    src,
    advance: (ms: number) => {
      now += ms;
    },
    get requests() {
      return requests;
    },
    get slept() {
      return slept;
    },
  };
}

describe("S2 citation breaker (R2-69)", () => {
  it("opens after consecutive give-ups and then refuses without sleeping", async () => {
    const h = harness(() => 429);
    for (let i = 1; i <= S2_BREAKER_GIVE_UPS; i++) await h.src.lookup(paper(i), CITED);
    expect(h.src.breaker.trips).toBe(1);
    const before = { requests: h.requests, slept: h.slept };
    const look = await h.src.lookup(paper(9), CITED);
    expect(look).toMatchObject({ kind: "no_s2_data", reason: "fetch-failed" });
    expect(h.requests).toBe(before.requests);
    expect(h.slept).toBe(before.slept);
    expect(h.src.breaker.refused).toBeGreaterThan(0);
    expect(h.src.summary()).toContain("breaker trips=1");
  });

  it("probes once after the cool-down; success closes it", async () => {
    let status = 429;
    const h = harness(() => status);
    for (let i = 1; i <= S2_BREAKER_GIVE_UPS; i++) await h.src.lookup(paper(i), CITED);
    h.advance(S2_BREAKER_COOLDOWN_MS + 1);
    status = 200;
    const before = h.requests;
    await h.src.lookup(paper(20), CITED);
    expect(h.requests).toBeGreaterThan(before);
    expect(h.src.breaker.trips).toBe(1);
  });

  it("a give-up during the half-open probe re-opens it at once", async () => {
    const h = harness(() => 429);
    for (let i = 1; i <= S2_BREAKER_GIVE_UPS; i++) await h.src.lookup(paper(i), CITED);
    h.advance(S2_BREAKER_COOLDOWN_MS + 1);
    await h.src.lookup(paper(30), CITED);
    expect(h.src.breaker.trips).toBe(2);
  });

  it("probeBreaker lets a deliberate retry through while cooling down", async () => {
    const h = harness(() => 429);
    for (let i = 1; i <= S2_BREAKER_GIVE_UPS; i++) await h.src.lookup(paper(i), CITED);
    const before = h.requests;
    h.src.probeBreaker();
    await h.src.lookup(paper(40), CITED);
    expect(h.requests).toBeGreaterThan(before);
  });

  it("a 404 or a success between give-ups resets the count", async () => {
    let n = 0;
    const h = harness(() => {
      n += 1;
      return n % 7 === 0 ? 404 : 429; // every 7th request answers 404
    });
    for (let i = 1; i <= 6; i++) await h.src.lookup(paper(i), CITED);
    expect(h.src.breaker.trips).toBe(0);
  });
});
