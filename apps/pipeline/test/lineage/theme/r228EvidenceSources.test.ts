/**
 * R2-28: arXiv HTML citation contexts, Crossref reference lists and DBLP
 * venues (design 41 R2-28, research 47). Recorded / synthetic fixtures
 * only — no network.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import {
  arxivIdsIn,
  matchBibEntry,
  parseArxivHtml,
  splitSentences,
} from "../../../src/lineage/theme/arxivHtml.js";
import {
  ARXIV_CRAWL_DELAY_MS,
  ArxivHtmlContextSource,
  type FetchTextLike,
  readArxivHtmlCache,
} from "../../../src/lineage/theme/arxivHtmlSource.js";
import { addCrossNodeEdges } from "../../../src/lineage/theme/bfs.js";
import { optInEvidenceDeps } from "../../../src/lineage/theme/cli.js";
import {
  CROSSREF_MAX_CONCURRENT,
  CrossrefReferenceSource,
  compactReference,
  listsPaper,
} from "../../../src/lineage/theme/crossrefReferences.js";
import {
  DblpVenueSource,
  isPreprintVenue,
  parseTitleRecords,
  pickVenue,
} from "../../../src/lineage/theme/dblpVenues.js";
import type { ThemeEdge } from "../../../src/lineage/theme/edges.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";
import { deriveS2Relation, newS2RelationStats } from "../../../src/lineage/theme/s2Relations.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

/** A synthetic page in LaTeXML's structure (arxiv.org/html). */
const PAGE = `<!DOCTYPE html><html><head><title>Switch-like paper</title></head><body>
<header class="ltx_page_header">arXiv:2101.03961v3 [cs.LG]</header>
<article class="ltx_document">
<div class="ltx_authors"><span class="ltx_note ltx_role_thanks">Equal contribution [1].</span></div>
<section id="S1" class="ltx_section"><h2 class="ltx_title">1 Introduction</h2>
<div class="ltx_para"><p class="ltx_p">MoE models have had notable successes
<cite class="ltx_cite ltx_citemacro_citep">(<a href="#bib.bib30" class="ltx_ref">Lepikhin et&nbsp;al., 2020</a>)</cite>, however adoption is hindered by complexity.
Lepikhin et&nbsp;al. <cite class="ltx_cite ltx_citemacro_citep">(<a href="#bib.bib30" class="ltx_ref">2020</a>)</cite> adapts a Mixture-of-Expert model and addresses expert overflow by passing its representation to the next layer, which we also follow.
See Fig. 3 for the layout of <math alttext="x_{1}" display="inline"><mi>x</mi></math> tokens in the router <cite class="ltx_cite">[<a href="#bib.bib2" class="ltx_ref">2</a>]</cite>.</p></div>
<figure class="ltx_table"><figcaption class="ltx_caption">Table 1: Following <cite class="ltx_cite">[<a href="#bib.bib30" class="ltx_ref">30</a>]</cite>, we build upon it.</figcaption>
<table class="ltx_tabular"><tr><td>GShard <cite>[<a href="#bib.bib30">30</a>]</cite> 1.2</td></tr></table></figure>
<div class="ltx_para"><p class="ltx_p">Footnote-bearing text<span class="ltx_note ltx_role_footnote"><span class="ltx_note_content">We extend <a href="#bib.bib30">[30]</a> in the appendix.</span></span> ends here.</p></div>
</section>
<section id="bib" class="ltx_bibliography"><h2 class="ltx_title">References</h2><ul class="ltx_biblist">
<li id="bib.bib2" class="ltx_bibitem"><span class="ltx_tag">[2]</span><span class="ltx_bibblock">E. Bengio, P.-L. Bacon. Conditional computation in neural networks for faster models. arXiv preprint arXiv:1511.06297, 2015.</span></li>
<li id="bib.bib30" class="ltx_bibitem"><span class="ltx_tag">Lepikhin et al. (2020)</span><span class="ltx_bibblock">Dmitry Lepikhin, HyoukJoong Lee, Yuanzhong Xu. Gshard: Scaling giant models with conditional computation and automatic sharding. arXiv preprint arXiv:2006.16668, 2020.</span></li>
<li id="bib.bib31" class="ltx_bibitem"><span class="ltx_bibblock">A. Author. Some work. <a href="https://doi.org/10.1145/3219819.3220007">doi</a>, 2018.</span></li>
</ul></section></article></body></html>`;

const GSHARD = {
  paperId: "openalex:WGSHARD",
  title: "GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding",
  authors: ["Dmitry Lepikhin", "HyoukJoong Lee"],
  year: 2020,
};
const SWITCH = {
  paperId: "openalex:WSWITCH",
  title:
    "Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity",
  authors: ["William Fedus"],
  year: 2021,
  arxiv_id: "2101.03961",
};

function textResp(status: number, body = "") {
  return { status, text: async () => body };
}

describe("arXiv HTML parsing (LaTeXML)", () => {
  it("reads the bibliography with arXiv ids and DOIs", () => {
    const p = parseArxivHtml(PAGE, "2101.03961");
    expect(p.version).toBe("v3");
    expect(p.bibs.map((b) => b.key)).toEqual(["bib.bib2", "bib.bib30", "bib.bib31"]);
    expect(p.bibs[1]?.arxiv).toEqual(["2006.16668"]);
    expect(p.bibs[2]?.dois).toEqual(["10.1145/3219819.3220007"]);
  });

  it("keeps body sentences only: no captions, tables, footnotes; et al. / Fig. do not split", () => {
    const ctx = parseArxivHtml(PAGE, "2101.03961").contexts.get("bib.bib30") ?? [];
    expect(ctx).toHaveLength(2);
    expect(ctx[1]).toBe(
      "Lepikhin et al. (2020) adapts a Mixture-of-Expert model and addresses expert overflow by passing its representation to the next layer, which we also follow.",
    );
    expect(ctx.join(" ")).not.toMatch(/build upon|We extend|1\.2/);
    const other = parseArxivHtml(PAGE).contexts.get("bib.bib2") ?? [];
    expect(other[0]).toMatch(/^See Fig\. 3 for the layout of x_1 tokens in the router \[2\]\.$/);
  });

  it("splits on sentence ends but not after abbreviations / initials", () => {
    expect(
      splitSentences("We follow Shazeer et al. [22]. Next, e.g. this one. A. Smith did it."),
    ).toEqual(["We follow Shazeer et al. [22].", "Next, e.g. this one.", "A. Smith did it."]);
  });

  it("matches the cited paper by arXiv id, DOI, title, fuzzy title + surname; never ambiguously", () => {
    const { bibs } = parseArxivHtml(PAGE);
    expect(matchBibEntry(bibs, { arxiv: "2006.16668v2", title: "x" })).toEqual({
      key: "bib.bib30",
      how: "arxiv",
    });
    expect(matchBibEntry(bibs, { doi: "10.1145/3219819.3220007", title: "x" })?.how).toBe("doi");
    expect(matchBibEntry(bibs, GSHARD)).toEqual({ key: "bib.bib30", how: "title" });
    expect(
      matchBibEntry(bibs, {
        title: "GShard: Scaling Giant Models with Conditional Computation and Sharding",
        authors: ["Dmitry Lepikhin"],
      })?.how,
    ).toBe("title_fuzzy");
    // Same tokens, wrong first author: no match.
    expect(
      matchBibEntry(bibs, {
        title: "GShard: Scaling Giant Models with Conditional Computation and Sharding",
        authors: ["Someone Else"],
      }),
    ).toBeNull();
    expect(
      matchBibEntry(bibs, { title: "Attention is all you need", authors: ["Ashish Vaswani"] }),
    ).toBeNull();
  });

  it("finds arXiv ids only in arXiv-mentioning text", () => {
    expect(arxivIdsIn("arXiv preprint arXiv:1312.4314v2")).toEqual(["1312.4314"]);
    expect(arxivIdsIn("pages 1234.5678")).toEqual([]);
  });
});

describe("ArxivHtmlContextSource: politeness, budget and cache", () => {
  function source(path: string | null, pages: Record<string, number | string>, extra = {}) {
    const urls: string[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    const fetchText: FetchTextLike = async (url, init) => {
      urls.push(url);
      expect(init.headers?.["User-Agent"]).toMatch(/PaperPilot.*mailto:ops@example\.org/);
      const id = url.replace("https://arxiv.org/html/", "");
      const p = pages[id];
      return typeof p === "string" ? textResp(200, p) : textResp(p ?? 404);
    };
    const src = new ArxivHtmlContextSource(path, {
      fetchText,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      monotonicNow: () => clock,
      now: () => new Date("2026-10-11T00:00:00Z"),
      contact: "ops@example.org",
      ...extra,
    });
    return { src, urls, sleeps };
  }

  it("waits the 15 s crawl delay between pages, fetches each page once per run, never /e-print", async () => {
    const { src, urls, sleeps } = source(null, { "2101.03961": PAGE, "1701.06538": PAGE });
    const a = await src.contexts("2101.03961", GSHARD);
    expect(a.kind).toBe("contexts");
    expect(
      await src.contexts("2101.03961", {
        paperId: "openalex:X",
        title: "Unrelated work on graphs",
      }),
    ).toEqual({
      kind: "none",
      reason: "no-bib-match",
    });
    await src.contexts("1701.06538", GSHARD);
    expect(urls).toEqual([
      "https://arxiv.org/html/2101.03961",
      "https://arxiv.org/html/1701.06538",
    ]);
    expect(sleeps).toEqual([ARXIV_CRAWL_DELAY_MS]);
    expect(urls.some((u) => /e-print|\/src\//.test(u))).toBe(false);
  });

  it("stops at the per-run budget and after a 429 (no retry loop)", async () => {
    const budget = source(null, { "2101.03961": PAGE, "1701.06538": PAGE }, { maxFetches: 1 });
    await budget.src.contexts("2101.03961", GSHARD);
    expect(await budget.src.contexts("1701.06538", GSHARD)).toEqual({
      kind: "none",
      reason: "budget",
    });
    expect(budget.urls).toHaveLength(1);
    const blocked = source(null, { "2101.03961": 429, "1701.06538": PAGE });
    expect(await blocked.src.contexts("2101.03961", GSHARD)).toEqual({
      kind: "none",
      reason: "blocked",
    });
    expect(await blocked.src.contexts("1701.06538", GSHARD)).toEqual({
      kind: "none",
      reason: "blocked",
    });
    expect(blocked.urls).toHaveLength(1);
    expect(blocked.src.summary()).toMatch(/BLOCKED/);
  });

  it("caches asked pairs (not the HTML) and 'no HTML'; a cached pair needs no request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r228-html-"));
    const path = join(dir, "arxiv_html_contexts.json");
    const first = source(path, { "2101.03961": PAGE, "2201.00001": 404 });
    await first.src.contexts("2101.03961", GSHARD);
    expect(await first.src.contexts("2201.00001", GSHARD)).toEqual({
      kind: "none",
      reason: "no-html",
    });
    first.src.flush();
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("<p");
    const cache = readArxivHtmlCache(path);
    expect(cache["2101.03961"]?.v).toBe("v3");
    expect(cache["2101.03961"]?.pairs["openalex:WGSHARD"]?.b).toBe("bib.bib30");
    expect(cache["2201.00001"]?.ok).toBe(false);
    const second = source(path, {});
    expect((await second.src.contexts("2101.03961", GSHARD)).kind).toBe("contexts");
    expect((await second.src.contexts("2201.00001", GSHARD)).kind).toBe("none");
    expect(second.urls).toEqual([]);
  });
});

describe("deriveS2Relation + arXiv HTML (pairs S2 has no sentence for)", () => {
  function htmlSource(page = PAGE) {
    return new ArxivHtmlContextSource(null, {
      fetchText: async () => textResp(200, page),
      sleep: async () => {},
      crawlDelayMs: 0,
    });
  }
  const s2 = (signals: unknown) => ({ lookup: async () => ({ kind: "pair", signals }) });

  it("adds a quote-backed strong claim with arXiv HTML attribution (Switch <- GShard)", async () => {
    const html = htmlSource();
    const ctx = {
      source: s2({ found: true, intents: [], contexts: [], isInfluential: false }),
      provider: null,
      stats: newS2RelationStats(),
      arxivHtml: html,
    };
    const before = await deriveS2Relation(GSHARD, SWITCH, { ...ctx, arxivHtml: null } as never);
    expect(before).toBeNull();
    const edge = await deriveS2Relation(GSHARD, SWITCH, ctx as never);
    expect(edge?.relation).toBe("extends");
    expect(edge?.provenance).toBe("s2_context_rule");
    expect(edge?.evidence?.source).toBe("arxiv_html");
    expect(edge?.rationale).toContain(
      "（arXiv HTML（arXiv:2101.03961v3）の本文の引用文から規則で判定）",
    );
    expect(edge?.rationale).toMatch(
      /引用文: "Lepikhin et al\. \(2020\) adapts .*which we also follow\."$/,
    );
    expect(html.stats.strongEdges).toBe(1);
  });

  it("is not asked when S2 has a usable sentence, or S2 was unreachable", async () => {
    let asked = 0;
    const html = {
      contexts: async () => {
        asked += 1;
        return { kind: "none", reason: "no-html" };
      },
      stats: { strongEdges: 0 },
    };
    await deriveS2Relation(GSHARD, SWITCH, {
      source: s2({
        found: true,
        intents: ["background"],
        contexts: ["GShard (Lepikhin et al., 2020) scaled MoE Transformers to 600B parameters."],
        isInfluential: false,
      }),
      provider: null,
      stats: newS2RelationStats(),
      arxivHtml: html,
    } as never);
    await deriveS2Relation(GSHARD, SWITCH, {
      source: { lookup: async () => ({ kind: "no_s2_data", reason: "fetch-failed" }) },
      provider: null,
      stats: newS2RelationStats(),
      arxivHtml: html,
    } as never);
    expect(asked).toBe(0);
  });

  it("keeps the S2-only result when the HTML sentences carry no strong cue", async () => {
    const plain = PAGE.replace(", which we also follow.", ".");
    const out = await deriveS2Relation(GSHARD, SWITCH, {
      source: s2({ found: true, intents: [], contexts: [], isInfluential: false }),
      provider: null,
      stats: newS2RelationStats(),
      arxivHtml: htmlSource(plain),
    } as never);
    expect(out).toBeNull();
  });
});

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

describe("Crossref reference lists (publisher-withheld S2 lists)", () => {
  const recorded = fixture("crossref-pipemoe-r228.json");
  const refs = (recorded.message.reference as Record<string, unknown>[]).map(compactReference);

  it("compacts references and finds in-graph papers by title / arXiv id / DOI", () => {
    expect(refs.length).toBe(5);
    expect(
      listsPaper(refs, {
        title: "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
      }),
    ).toBe(true);
    expect(listsPaper(refs, { title: "Mixture-of-Experts with Expert Choice Routing" })).toBe(true);
    expect(listsPaper(refs, { title: "Attention Is All You Need" })).toBe(false);
    expect(compactReference({ DOI: "10.48550/arXiv.1312.4314" })).toEqual([
      "10.48550/arxiv.1312.4314",
      "1312.4314",
      "",
    ]);
  });

  it("polite pool: mailto, <= 3 in flight, one request per DOI, 429 stops the run", async () => {
    let inflight = 0;
    let peak = 0;
    const urls: string[] = [];
    const src = new CrossrefReferenceSource(null, {
      fetchImpl: async (url: string) => {
        urls.push(url);
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
        if (url.includes("blocked")) return jsonResp(429, null);
        return jsonResp(200, recorded);
      },
      sleep: async () => {},
      mailto: "ops@example.org",
    });
    const dois = ["10.1/a", "10.1/b", "10.1/c", "10.1/d", "10.1/e", "10.1/a"];
    const got = await Promise.all(dois.map((d) => src.references(d)));
    expect(got.every((r) => r?.length === 5)).toBe(true);
    expect(peak).toBeLessThanOrEqual(CROSSREF_MAX_CONCURRENT);
    expect(urls).toHaveLength(5);
    expect(urls[0]).toContain("mailto=ops%40example.org");
    expect(await src.references("10.1/blocked")).toBeNull();
    expect(await src.references("10.1/z")).toBeNull();
    expect(src.stats.blocked).toBe(true);
    expect(await src.references("10.48550/arXiv.1312.4314")).toBeNull(); // DataCite, not asked
    expect(urls).toHaveLength(6);
  });

  it("cross-node pass: adds api_citation edges from Crossref when OpenAlex and S2 have no list", async () => {
    const node = (id: string, title: string, year: number, extra = {}) =>
      ({
        id,
        title,
        year,
        venue: "",
        venue_tier: "preprint",
        authors: [],
        kinds: [],
        citation_count: 10,
        github_stars: 0,
        tldr: "",
        ...extra,
      }) as ThemeGraphNode;
    const pipe = node(
      "openalex:WPIPE",
      "PipeMoE: Accelerating Mixture-of-Experts through Adaptive Pipelining",
      2023,
      {
        doi: "10.1109/INFOCOM53939.2023.10228874",
      },
    );
    const shazeer = node(
      "openalex:WSHAZ",
      "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer",
      2017,
    );
    const other = node("openalex:WOTHER", "Attention Is All You Need", 2017);
    const nodes = new Map([pipe, shazeer, other].map((n) => [n.id, n]));
    // S2 knows PipeMoE but returns no references (publisher-withheld).
    const s2source = new S2CitationSource(null, {
      fetchImpl: async (url: string, _i: FetchInit) =>
        /references/.test(url) ? jsonResp(200, { data: null }) : jsonResp(404, null),
      sleep: async () => {},
    });
    const crossref = new CrossrefReferenceSource(null, {
      fetchImpl: async () => jsonResp(200, recorded),
      sleep: async () => {},
      mailto: null,
    });
    const deps = {
      fetchImpl: async () => jsonResp(200, { data: [] }),
      cacheDir: mkdtempSync(join(tmpdir(), "r228-cross-")),
      sleep: async () => {},
      logger: { warn: () => {} },
    } as unknown as FetchRelatedDeps;
    const edges: ThemeEdge[] = [];
    const apiStats = { apiCitations: 0, s2Unreachable: 0 };
    const added = await addCrossNodeEdges(
      nodes,
      edges,
      {
        provider: null,
        strictMode: "off",
        s2Relations: { source: s2source, provider: null, stats: newS2RelationStats() },
        apiCitations: true,
        apiStats,
        crossref,
      },
      deps,
    );
    expect(added).toBe(1);
    expect(edges[0]).toMatchObject({
      src: "openalex:WSHAZ",
      dst: "openalex:WPIPE",
      relation: "baseline_only",
    });
    expect(edges[0]?.rationale).toContain("Crossref の参考文献リストで確認");
    expect((edges[0] as ThemeEdge).provenance.classification).toMatchObject({
      method: "api_citation",
    });
    expect(crossref.stats.pairsAdded).toBe(1);
    // Without the Crossref source nothing is added (S2 list withheld).
    const none: ThemeEdge[] = [];
    await addCrossNodeEdges(
      nodes,
      none,
      {
        provider: null,
        strictMode: "off",
        s2Relations: { source: s2source, provider: null, stats: newS2RelationStats() },
        apiCitations: true,
      },
      deps,
    );
    expect(none).toEqual([]);
  });
});

describe("DBLP venue correction (SPARQL, recorded)", () => {
  const body = fixture("dblp-sparql-r228.json");
  const records = parseTitleRecords(body);

  it("picks the non-CoRR record with the same title, a plausible year and a shared author", () => {
    expect(
      pickVenue(
        {
          title: "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
          year: 2022,
          authors: ["Tri Dao"],
        },
        records,
      )?.venue,
    ).toBe("NeurIPS");
    expect(
      pickVenue(
        {
          title:
            "Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity",
          year: 2021,
          authors: ["William Fedus"],
        },
        records,
      )?.venue,
    ).toBe("J. Mach. Learn. Res.");
    // Same title, no shared author -> not accepted.
    expect(
      pickVenue(
        {
          title: "PipeMoE: Accelerating Mixture-of-Experts through Adaptive Pipelining",
          year: 2023,
          authors: ["Nobody Here"],
        },
        records,
      ),
    ).toBeNull();
    // Year far off -> not accepted.
    expect(
      pickVenue(
        { title: "Inductive Representation Learning on Large Graphs", year: 2010, authors: [] },
        records,
      ),
    ).toBeNull();
    expect(isPreprintVenue("arXiv (Cornell University)")).toBe(true);
    expect(isPreprintVenue("ICLR")).toBe(false);
  });

  it("corrects preprint-venue nodes only, bounded queries, cached", async () => {
    const queries: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "r228-dblp-"));
    const path = join(dir, "dblp_venues.json");
    const mk = () =>
      new DblpVenueSource(path, {
        fetchImpl: async (_url: string, init: FetchInit) => {
          queries.push(decodeURIComponent(String(init.body)));
          return jsonResp(
            200,
            /dblp:doi \?doi/.test(decodeURIComponent(String(init.body)))
              ? { results: { bindings: [] } }
              : body,
          );
        },
        sleep: async () => {},
        now: () => new Date("2026-10-11T00:00:00Z"),
      });
    const nodes = [
      {
        id: "openalex:WFA",
        title: "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
        year: 2022,
        authors: ["Tri Dao"],
        venue: "arXiv (Cornell University)",
        venue_tier: "preprint",
        arxiv_id: "2205.14135",
      },
      {
        id: "openalex:WPIPE",
        title: "PipeMoE: Accelerating Mixture-of-Experts through Adaptive Pipelining",
        year: 2023,
        authors: ["Shaohuai Shi"],
        venue: "arXiv",
        venue_tier: "preprint",
      },
      {
        id: "openalex:WICLR",
        title: "Graph Attention Networks",
        year: 2018,
        authors: ["Petar Velickovic"],
        venue: "ICLR",
        venue_tier: "A+",
      },
    ] as unknown as ThemeGraphNode[];
    const first = mk();
    expect(await first.correctVenues(nodes)).toBe(2);
    expect(nodes.map((n) => [n.venue, n.venue_tier])).toEqual([
      ["NeurIPS", "A+"],
      ["INFOCOM", "preprint"],
      ["ICLR", "A+"],
    ]);
    expect(queries).toHaveLength(2); // one DOI query + one title query for the batch
    expect(queries[1]).toContain(
      '"PipeMoE: Accelerating Mixture-of-Experts through Adaptive Pipelining."',
    );
    first.flush();
    // Second run: cache only.
    nodes[0]!.venue = "arXiv (Cornell University)";
    const second = mk();
    expect(await second.correctVenues(nodes)).toBe(1);
    expect(queries).toHaveLength(2);
  });
});

describe("opt-in switches (CI defaults off)", () => {
  it("all three sources are off unless set to on; bounds are configurable", () => {
    const warns: string[] = [];
    const off = optInEvidenceDeps({}, "/tmp/c", null, (m) => warns.push(m));
    expect(off).toEqual({ arxivHtml: null, crossref: null, dblpVenues: null });
    const on = optInEvidenceDeps(
      {
        PAPERPILOT_ARXIV_HTML: "on",
        PAPERPILOT_ARXIV_HTML_MAX_FETCHES: "12",
        PAPERPILOT_CROSSREF_REFERENCES: "ON",
        PAPERPILOT_DBLP_VENUES: "yes",
      },
      "/tmp/c",
      "ops@example.org",
      (m) => warns.push(m),
    );
    expect(on.arxivHtml?.maxFetches).toBe(12);
    expect(on.arxivHtml?.cachePath).toBe("/tmp/c/arxiv_html_contexts.json");
    expect(on.crossref?.mailto).toBe("ops@example.org");
    expect(on.dblpVenues).toBeNull();
    expect(warns.join("\n")).toMatch(/PAPERPILOT_DBLP_VENUES/);
  });
});
