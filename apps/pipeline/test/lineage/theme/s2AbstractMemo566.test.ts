/**
 * #566: an abstract Semantic Scholar answered once in a run must also reach
 * the SECOND copy of the same paper. The BFS reads a seed's neighbours
 * twice (topic-gate pool, then the BFS proper); the second read re-parses
 * the fetch cache and returns new objects whose ids are already in `tried`,
 * so before the fix they were neither asked again nor given the text and
 * the paper was dropped by the "no abstract" filter (#560 investigation).
 *
 * No network: S2 `/paper/batch` and the S2 references endpoint are stubbed.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { type FetchRelatedDeps, fetchRelated } from "../../../src/lineage/shared/fetchRelated.js";
import {
  type AbstractFallbackPaper,
  hasGateText,
  MAX_FAILED_CHUNKS,
  type S2AbstractStats,
  supplementAbstracts,
} from "../../../src/lineage/theme/s2AbstractFallback.js";

type S2Item = { title: string; abstract: string | null } | null;

/** `/paper/batch` stub; `status` may be changed between calls. */
function stub(answers: Record<string, S2Item>) {
  const calls: string[][] = [];
  const state = { status: 200 };
  const fetchImpl = async (_url: string, init?: FetchInit): Promise<HttpResponseLike> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { ids: string[] };
    calls.push(body.ids);
    return {
      status: state.status,
      headers: new Headers(),
      json: async () => body.ids.map((i) => answers[i] ?? null),
      text: async () => "",
    } as unknown as HttpResponseLike;
  };
  return { fetchImpl: fetchImpl as never, calls, state };
}

const fresh = (): S2AbstractStats => ({
  asked: 0,
  filled: 0,
  titleMismatch: 0,
  notFound: 0,
  failedChunks: 0,
});

const COOP_TITLE = "Learning to Prompt for Vision-Language Models";
const COOP_ABS = "Large pre-trained vision-language models like CLIP ...";
const coop = (title = COOP_TITLE): AbstractFallbackPaper => ({
  paperId: "openalex:W3198377975",
  title,
  externalIds: { ArXiv: "2109.01134" },
});
const answers = { "ARXIV:2109.01134": { title: COOP_TITLE, abstract: COOP_ABS } };
const noSleep = { sleep: async () => {} };

describe("supplementAbstracts re-attaches remembered abstracts (#566)", () => {
  it("(a) a second, separate copy of the same list also gets the text; one POST", async () => {
    const s2 = stub(answers);
    const tried = new Set<string>();
    const stats = fresh();
    const first = coop();
    await supplementAbstracts([first], { fetchImpl: s2.fetchImpl, apiKey: "k" }, tried, stats);
    expect(hasGateText(first)).toBe(true);
    const second = coop();
    expect(second).not.toBe(first);
    await supplementAbstracts([second], { fetchImpl: s2.fetchImpl, apiKey: "k" }, tried, stats);
    expect(hasGateText(second)).toBe(true);
    expect(second._gate_abstract).toBe(COOP_ABS);
    expect(s2.calls).toHaveLength(1);
    // Stats stay facts about requests: the re-attach is not a new fill.
    expect(stats).toMatchObject({ asked: 1, filled: 1 });
  });

  it("(b) ids of a failed chunk are not remembered and are asked again next call", async () => {
    const s2 = stub(answers);
    s2.state.status = 500;
    const tried = new Set<string>();
    const stats = fresh();
    const first = coop();
    await supplementAbstracts(
      [first],
      { fetchImpl: s2.fetchImpl, apiKey: "k", ...noSleep },
      tried,
      stats,
    );
    expect(hasGateText(first)).toBe(false);
    const afterFail = s2.calls.length;
    s2.state.status = 200;
    const second = coop();
    await supplementAbstracts(
      [second],
      { fetchImpl: s2.fetchImpl, apiKey: "k", ...noSleep },
      tried,
      stats,
    );
    expect(s2.calls.length).toBe(afterFail + 1);
    expect(second._gate_abstract).toBe(COOP_ABS);
    expect(stats.failedChunks).toBe(1);
  });

  it("(c1) the remembered text goes to _gate_abstract only; abstract stays empty", async () => {
    const s2 = stub(answers);
    const tried = new Set<string>();
    await supplementAbstracts([coop()], { fetchImpl: s2.fetchImpl, apiKey: "k" }, tried, fresh());
    const missing = coop();
    const empty = { ...coop(), abstract: "" };
    await supplementAbstracts(
      [missing, empty],
      { fetchImpl: s2.fetchImpl, apiKey: "k" },
      tried,
      fresh(),
    );
    expect(missing._gate_abstract).toBe(COOP_ABS);
    expect(missing.abstract).toBeUndefined();
    expect(empty._gate_abstract).toBe(COOP_ABS);
    expect(empty.abstract).toBe("");
  });

  it("(d) a third and later copy is the same, and the POST count does not grow", async () => {
    const s2 = stub(answers);
    const tried = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const p = coop();
      await supplementAbstracts([p], { fetchImpl: s2.fetchImpl, apiKey: "k" }, tried, fresh());
      expect(p._gate_abstract).toBe(COOP_ABS);
    }
    expect(s2.calls).toHaveLength(1);
  });

  it("(e) a later copy whose title differs (after normalisation) is not given the text", async () => {
    const s2 = stub(answers);
    const tried = new Set<string>();
    const stats = fresh();
    await supplementAbstracts([coop()], { fetchImpl: s2.fetchImpl, apiKey: "k" }, tried, stats);
    const sameAfterNorm = coop("learning to prompt for vision language models!");
    const other = coop("Learning to Prompt for Continual Learning");
    await supplementAbstracts(
      [sameAfterNorm, other],
      { fetchImpl: s2.fetchImpl, apiKey: "k" },
      tried,
      stats,
    );
    expect(sameAfterNorm._gate_abstract).toBe(COOP_ABS);
    expect(other._gate_abstract).toBeUndefined();
    expect(hasGateText(other)).toBe(false);
    expect(s2.calls).toHaveLength(1);
  });

  it("(f) after MAX_FAILED_CHUNKS the remembered texts still attach, with no new POST", async () => {
    const s2 = stub(answers);
    const tried = new Set<string>();
    const stats = fresh();
    await supplementAbstracts(
      [coop()],
      { fetchImpl: s2.fetchImpl, apiKey: "k", ...noSleep },
      tried,
      stats,
    );
    s2.state.status = 500;
    for (let i = 0; i < MAX_FAILED_CHUNKS; i++) {
      await supplementAbstracts(
        [{ title: `X${i}`, externalIds: { ArXiv: `9.${i}` } }],
        { fetchImpl: s2.fetchImpl, apiKey: "k", ...noSleep },
        tried,
        stats,
      );
    }
    expect(stats.failedChunks).toBe(MAX_FAILED_CHUNKS);
    const callsAtCap = s2.calls.length;
    const again = coop();
    const fresher: AbstractFallbackPaper = { title: "Y", externalIds: { ArXiv: "8.8" } };
    await supplementAbstracts(
      [again, fresher],
      { fetchImpl: s2.fetchImpl, apiKey: "k", ...noSleep },
      tried,
      stats,
    );
    expect(again._gate_abstract).toBe(COOP_ABS);
    expect(hasGateText(fresher)).toBe(false);
    expect(s2.calls.length).toBe(callsAtCap);
  });

  it("the memo belongs to one run: a new `tried` set starts empty", async () => {
    const s2 = stub(answers);
    await supplementAbstracts(
      [coop()],
      { fetchImpl: s2.fetchImpl, apiKey: "k" },
      new Set(),
      fresh(),
    );
    s2.state.status = 500;
    const p = coop();
    await supplementAbstracts(
      [p],
      { fetchImpl: s2.fetchImpl, apiKey: "k", ...noSleep },
      new Set(),
      fresh(),
    );
    expect(hasGateText(p)).toBe(false);
  });
});

describe("fetchRelated twice + supplementAbstracts (#560 reproduction, #566)", () => {
  const coopS2 = {
    paperId: "coop",
    title: COOP_TITLE,
    year: 2022,
    venue: "IJCV",
    citationCount: 3000,
    authors: [],
    externalIds: { ArXiv: "2109.01134" },
  };
  const relDeps = (): { deps: FetchRelatedDeps; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), "s2abs-memo-"));
    const fetchImpl = async (url: string) => {
      if (url.includes("/paper/seed/references"))
        return {
          status: 200,
          json: async () => ({
            data: [{ citedPaper: coopS2, isInfluential: true, intents: ["methodology"] }],
          }),
        };
      throw new Error(`unexpected ${url}`);
    };
    return {
      dir,
      deps: {
        fetchImpl: fetchImpl as never,
        cacheDir: dir,
        sleep: async () => {},
        logger: { warn: () => {} },
      },
    };
  };

  it("(a) the cache-read second list keeps the text, with one POST", async () => {
    const { deps } = relDeps();
    const s2 = stub(answers);
    const tried = new Set<string>();
    const stats = fresh();
    const one = await fetchRelated("seed", "references", 32, deps);
    await supplementAbstracts(one, { fetchImpl: s2.fetchImpl, apiKey: "k" }, tried, stats);
    expect(one.filter((p) => hasGateText(p))).toHaveLength(1);
    const two = await fetchRelated("seed", "references", 32, deps);
    expect(two[0]).not.toBe(one[0]);
    await supplementAbstracts(two, { fetchImpl: s2.fetchImpl, apiKey: "k" }, tried, stats);
    expect(two.filter((p) => hasGateText(p))).toHaveLength(1);
    expect(s2.calls).toHaveLength(1);
  });

  it("(c2) no fetch cache file ever holds _gate_abstract or the S2 text", async () => {
    const { deps, dir } = relDeps();
    const s2 = stub(answers);
    const tried = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const got = await fetchRelated("seed", "references", 32, deps);
      await supplementAbstracts(got, { fetchImpl: s2.fetchImpl, apiKey: "k" }, tried, fresh());
      expect(got[0]?._gate_abstract).toBe(COOP_ABS);
    }
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf-8");
      expect(text).not.toContain("_gate_abstract");
      expect(text).not.toContain(COOP_ABS);
    }
  });
});
