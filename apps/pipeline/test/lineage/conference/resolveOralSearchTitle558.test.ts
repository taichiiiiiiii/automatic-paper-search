/**
 * #558 item 5: `resolveOral` must use OpenAlex's `search.title` parameter,
 * not the deprecated `filter=title.search:<title>` form (which also splits a
 * title containing a comma into OR-ed filter values). The failure message
 * must still name what was queried.
 */
import { describe, expect, it } from "vitest";
import { classifyOpenAlexRequest } from "../../../src/collect/http/openalexGate.js";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import {
  fetchMeta,
  type OpenAlexDeps,
  resolveOral,
} from "../../../src/lineage/conference/buildConferenceLineage.js";
import { IncompleteFetchError } from "../../../src/lineage/fetch-state/completeness.js";

const SELECT =
  "id,title,publication_year,authorships,primary_location,locations,ids,doi,referenced_works,cited_by_count";

function recordingDeps(status = 200): { deps: OpenAlexDeps; urls: string[] } {
  const urls: string[] = [];
  const deps: OpenAlexDeps = {
    fetchImpl: async (url): Promise<HttpResponseLike> => {
      urls.push(url);
      return { status, json: async () => ({ results: [] }) };
    },
    sleep: async () => {},
  };
  return { deps, urls };
}

const ALIASES = new Set(["arxiv:2601.00001"]) as unknown as Parameters<typeof resolveOral>[1];

describe("resolveOral uses search.title (#558)", () => {
  for (const title of ["Oral Paper One", "Sparse, Fast, and Accurate: A Study"]) {
    it(`sends search.title and no title.search filter (${JSON.stringify(title)})`, async () => {
      const { deps, urls } = recordingDeps();
      await resolveOral(title, ALIASES, {}, deps);
      expect(urls).toHaveLength(1);
      const params = new URL(urls[0] as string).searchParams;
      expect(params.get("search.title")).toBe(title);
      expect(params.get("filter")).toBeNull();
      expect(urls[0]).not.toContain("title.search");
      expect(params.get("select")).toBe(SELECT);
      expect(params.get("per-page")).toBe("25");
      // Still priced as a search by the budget gate.
      expect(classifyOpenAlexRequest(urls[0] as string)).toBe("search");
    });
  }

  it("names the search.title value in the failure message", async () => {
    const { deps } = recordingDeps(503);
    const err = await resolveOral("Oral Paper One", ALIASES, {}, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteFetchError);
    const message = (err as Error).message;
    expect(message).toContain("search.title='Oral Paper One'");
    expect(message).not.toContain("undefined");
  });

  it("keeps filter=... in the failure message of filter queries (fetchMeta)", async () => {
    const { deps } = recordingDeps(503);
    const warnings: string[] = [];
    await fetchMeta(["W1"], {}, { ...deps, logger: { warn: (m: string) => warnings.push(m) } });
    const failed = warnings.filter((m) => m.includes("metadata page failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("filter='ids.openalex:W1'");
  });
});
