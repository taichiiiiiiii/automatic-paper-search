/**
 * `addCrossNodeEdges` prefetches `openalex:` references with bounded
 * concurrency (speed-up for on-demand theme generation) while keeping the
 * Semantic Scholar path sequential (its 3.5 s pacing lives in `fetchRelated`)
 * and the emitted edge order identical to the fully sequential walk.
 * `fetchRelated` is mocked: no network, no sleeps.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";

const state = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  calls: [] as string[],
  refsById: {} as Record<string, string[]>,
  failing: new Set<string>(),
}));

vi.mock("../../../src/lineage/shared/fetchRelated.js", () => ({
  fetchRelated: vi.fn(async (id: string) => {
    state.calls.push(id);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    // Yield so overlapping calls are observable; later ids finish first.
    await new Promise((resolve) => setTimeout(resolve, id.endsWith("1") ? 20 : 1));
    state.inFlight -= 1;
    if (state.failing.has(id)) throw new Error(`boom ${id}`);
    return (state.refsById[id] ?? []).map((refId) => ({
      paperId: refId,
      title: refId,
      year: 2019,
      citationCount: 10,
      abstract: "a".repeat(80),
      externalIds: {},
      _is_influential: true,
      _intents: ["methodology"],
    }));
  }),
}));

// Imported after vi.mock so bfs.ts binds the mocked fetchRelated.
const { addCrossNodeEdges } = await import("../../../src/lineage/theme/bfs.js");

function node(id: string, year: number) {
  return {
    id,
    title: id,
    year,
    venue: "arXiv",
    venue_tier: "preprint",
    authors: [],
    kinds: [],
    citation_count: 10,
    github_stars: 0,
    tldr: "",
  };
}

const deps = { warnings: [] as string[] } as unknown as FetchRelatedDeps;
const warnings: string[] = [];
const depsWithLogger = {
  ...deps,
  logger: { warn: (m: string) => void warnings.push(m) },
} as unknown as FetchRelatedDeps;

beforeEach(() => {
  state.inFlight = 0;
  state.maxInFlight = 0;
  state.calls = [];
  state.refsById = {};
  state.failing = new Set();
  warnings.length = 0;
});

describe("addCrossNodeEdges prefetch", () => {
  it("overlaps openalex fetches up to the cap and keeps edge order", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `openalex:W${i + 1}`);
    const nodes = new Map(ids.map((id, i) => [id, node(id, 2020 + (i % 3))]));
    // Every node cites the node before it, so each yields exactly one edge.
    for (let i = 1; i < ids.length; i += 1) state.refsById[ids[i]!] = [ids[i - 1]!];

    const edges: { src: string; dst: string }[] = [];
    const added = await addCrossNodeEdges(
      nodes,
      edges as never,
      { provider: null, strictMode: "off" },
      depsWithLogger,
    );

    expect(added).toBe(9);
    expect(state.maxInFlight).toBeGreaterThan(1);
    expect(state.maxInFlight).toBeLessThanOrEqual(4);
    // Edges follow node order, not fetch-completion order.
    expect(edges.map((e) => `${e.src}>${e.dst}`)).toEqual(
      ids.slice(1).map((id, i) => `${ids[i]}>${id}`),
    );
  });

  it("never overlaps non-openalex (Semantic Scholar) fetches", async () => {
    const ids = ["s2a", "s2b", "s2c", "s2d"];
    const nodes = new Map(ids.map((id) => [id, node(id, 2020)]));
    await addCrossNodeEdges(
      nodes,
      [] as never,
      { provider: null, strictMode: "off" },
      depsWithLogger,
    );
    expect(state.maxInFlight).toBe(1);
    expect(state.calls).toEqual(ids);
  });

  it("replays a prefetch failure as a warning and keeps going", async () => {
    const ids = ["openalex:W1", "openalex:W2", "openalex:W3"];
    const nodes = new Map(ids.map((id) => [id, node(id, 2021)]));
    state.refsById["openalex:W3"] = ["openalex:W1"];
    state.failing.add("openalex:W2");

    const edges: { src: string; dst: string }[] = [];
    const added = await addCrossNodeEdges(
      nodes,
      edges as never,
      { provider: null, strictMode: "off" },
      depsWithLogger,
    );

    expect(added).toBe(1);
    expect(edges[0]).toMatchObject({ src: "openalex:W1", dst: "openalex:W3" });
    expect(warnings.some((w) => w.includes("openalex:W2") && w.includes("boom"))).toBe(true);
  });
});
