/** R3-5: DBLP / OpenReview links for conference_site rows (ICLR 2025). */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaperId } from "@paperpilot/core/identity";
import { describe, expect, it } from "vitest";
import { compactTitleKey, titleScore } from "../../src/catalog/abstractReplacements.js";
import { writeDictCsv } from "../../src/catalog/csv.js";
import {
  type DblpRecord,
  dblpTocQuery,
  isSingleWordTypo,
  linkExternalIds,
  linkRowsToDblp,
  parseDblpSparql,
  parseExternalIds,
} from "../../src/catalog/linkExternalIdsCli.js";
import { PacedClient, pairWithS2 } from "../../src/catalog/resolveAbstractReplacementsCli.js";

const pid = (n: number) => n.toString(16).padStart(40, "0");

function rec(key: string, title: string, authors: string[], or: string | null = null): DblpRecord {
  return { dblp_key: key, title, authors, openreview_id: or };
}

describe("LaTeX-insensitive titles", () => {
  it("equates proceedings LaTeX with DBLP / arXiv Unicode", () => {
    const pairs: Array<[string, string]> = [
      ["$\\gamma-$MoD: Exploring Mixture-of-Depth", "γ-MoD: Exploring Mixture-of-Depth"],
      ["Streaming Algorithms For $\\ell_p$ Flows", "Streaming Algorithms For ℓp Flows"],
      ["$\\text{I}^2\\text{AM}$: Interpreting Image-to-Image", "I2AM: Interpreting Image-to-Image"],
      ["Breaking the $\\log(1/\\Delta_2)$ Barrier", "Breaking the log\u2061(1/Δ2) Barrier"],
      [
        "ThunderKittens: Simple, Fast, and $\\textit{Adorable}$ Kernels",
        "ThunderKittens: Simple, Fast, and Adorable Kernels",
      ],
      ["Co$^{\\mathbf{3}}$Gesture: Towards Coherent", "Co3Gesture: Towards Coherent"],
    ];
    for (const [a, b] of pairs) {
      expect(compactTitleKey(a)).toBe(compactTitleKey(b));
      expect(titleScore(a, b)).toBe(1);
    }
  });

  it("does not equate different titles or tiny keys", () => {
    expect(titleScore("Federated Low-Rank Adaption", "Federated Low-Rank Adaptation")).toBeLessThan(
      1,
    );
    expect(titleScore("$X$", "X.")).toBe(1); // equal after normalizeTitle already
    expect(compactTitleKey("A-B")).toBe("ab");
    expect(titleScore("A-B c", "AB-c")).toBeLessThan(1); // compact key under 8 chars
  });
});

describe("DBLP SPARQL listing", () => {
  it("builds a paged TOC query and refuses an odd toc", () => {
    const q = dblpTocQuery("db/conf/iclr/iclr2025", 2000, 2000);
    expect(q).toContain("<https://dblp.org/db/conf/iclr/iclr2025>");
    expect(q).toContain("LIMIT 2000 OFFSET 2000");
    expect(() => dblpTocQuery("db/conf/x> } DROP {", 1, 0)).toThrow(/invalid DBLP toc/);
  });

  it("parses records, strips homonym numbers and the trailing period, keeps the forum id", () => {
    const body = JSON.stringify({
      results: {
        bindings: [
          {
            p: { value: "https://dblp.org/rec/conf/iclr/0001S0B25" },
            title: { value: "DataEnvGym: Data Generation Agents." },
            ee: { value: "https://openreview.net/forum?id=00SnKBGTsz" },
            authors: { value: "Zaid Khan 0001|Elias Stengel-Eskin|Mohit Bansal" },
          },
          {
            p: { value: "https://dblp.org/rec/conf/iclr/X25" },
            title: { value: "Two Pages." },
            ee: { value: "https://doi.org/10.1/x" },
            authors: { value: "A B" },
          },
          {
            p: { value: "https://dblp.org/rec/conf/iclr/X25" },
            title: { value: "Two Pages." },
            ee: { value: "https://openreview.net/forum?id=abcDEF_12-" },
            authors: { value: "A B" },
          },
        ],
      },
    });
    const out = parseDblpSparql(body);
    expect(out).toEqual([
      rec(
        "conf/iclr/0001S0B25",
        "DataEnvGym: Data Generation Agents",
        ["Zaid Khan", "Elias Stengel-Eskin", "Mohit Bansal"],
        "00SnKBGTsz",
      ),
      rec("conf/iclr/X25", "Two Pages", ["A B"], "abcDEF_12-"),
    ]);
    expect(parseDblpSparql("<html>bot wall</html>")).toBeNull();
  });
});

describe("linkRowsToDblp", () => {
  const records = [
    rec("conf/iclr/A25", "γ-MoD: Exploring Mixture-of-Depth", ["Yaxin Luo", "Gen Luo"], "orA"),
    rec(
      "conf/iclr/B25",
      "Adaptive backtracking line search",
      ["Joao Cavalcanti", "Laurent Lessard", "Ashia C. Wilson"],
      "orB",
    ),
    rec("conf/iclr/C25", "Shared Title", ["Ann Lee", "Bo Chen"], "orC"),
    rec("conf/iclr/D25", "Small Group Paper One", ["Kim Park", "Lee Choi"], "orD"),
    rec("conf/iclr/E25", "Small Group Paper Two", ["Kim Park", "Lee Choi"], "orE"),
  ];

  it("links by LaTeX-insensitive title, and a retitled paper by its unique author set", () => {
    const links = linkRowsToDblp(
      [
        {
          paper_id: pid(1),
          title: "$\\gamma-$MoD: Exploring Mixture-of-Depth",
          authors: ["Yaxin Luo", "Gen Luo", "Rongrong Ji"],
        },
        {
          paper_id: pid(2),
          title: "Adaptive backtracking for faster optimization",
          authors: ["Joao V. Cavalcanti", "Laurent Lessard", "Ashia Wilson"],
        },
      ],
      records,
    );
    expect(links.map((l) => [l.paper_id, l.dblp_key, l.openreview_id, l.match.via])).toEqual([
      [pid(1), "conf/iclr/A25", "orA", "title"],
      [pid(2), "conf/iclr/B25", "orB", "authors"],
    ]);
  });

  it("fails closed: no title-less link when the author set is not unique, a shared record links nobody", () => {
    const links = linkRowsToDblp(
      [
        { paper_id: pid(3), title: "Shared Title", authors: ["Ann Lee", "Bo Chen"] },
        { paper_id: pid(4), title: "Shared Title", authors: ["Ann Lee", "Bo Chen"] },
        {
          paper_id: pid(5),
          title: "Small Group Paper Retitled",
          authors: ["Kim Park", "Lee Choi"],
        },
        // Authors only a subset of the record's: no authors link.
        {
          paper_id: pid(6),
          title: "Adaptive backtracking, retitled",
          authors: ["Laurent Lessard", "Ashia Wilson"],
        },
      ],
      records,
    );
    expect(links).toEqual([]);
  });

  it("links a one-word spelling difference and an identical unique title with reordered authors", () => {
    const recs = [
      rec(
        "conf/iclr/Y25",
        "Federated Residual Low-Rank Adaptation of Large Language Models",
        ["Yunlu Yan", "Wangmeng Zuo", "Rick Siow Mong Goh", "Yong Liu"],
        "orY",
      ),
      rec(
        "conf/iclr/L25",
        "Interpretable Joint Denoising and Enhancement",
        ["Huaqiu Li", "Xiaowan Hu", "Haoqian Wang"],
        "orL",
      ),
      rec("conf/iclr/Z25", "Another Paper Entirely", ["Zed Zhang", "Amy Wu"], "orZ"),
    ];
    const rows = [
      {
        paper_id: pid(7),
        title: "Federated Residual Low-Rank Adaption of Large Language Models",
        authors: ["Yunlu Yan", "Wangmeng Zuo", "Rick Siow Mong Mong", "Yong Liu"],
      },
      {
        paper_id: pid(8),
        title: "Interpretable Joint Denoising and Enhancement",
        authors: ["Li Huaqiu", "HuXiaowan", "Haoqian Wang"],
      },
      // Same title as a record but nobody in common: stays unlinked.
      { paper_id: pid(10), title: "Another Paper Entirely", authors: ["Q R", "S T"] },
    ];
    const links = linkRowsToDblp(rows, recs);
    expect(links.map((l) => [l.paper_id, l.openreview_id, l.match.via])).toEqual([
      [pid(7), "orY", "title"],
      [pid(8), "orL", "title-unique"],
    ]);
    // A typo link still needs the authors.
    expect(
      linkRowsToDblp([{ ...(rows[0] as object), authors: ["Nobody Else"] } as never], recs),
    ).toEqual([]);
    // A second row with the same title makes the title-unique link ambiguous.
    expect(
      linkRowsToDblp(
        [rows[1] as never, { ...(rows[1] as object), paper_id: pid(11) } as never],
        recs,
      ),
    ).toEqual([]);
  });

  it("isSingleWordTypo is narrow", () => {
    expect(
      isSingleWordTypo("Low-Rank Adaption of Large Models", "Low-Rank Adaptation of Large Models"),
    ).toBe(true);
    expect(
      isSingleWordTypo("Low-Rank Adaption of Large Models", "Low-Rank Adaption of Large Model"),
    ).toBe(false); // short word
    expect(isSingleWordTypo("Fast Training of Large Models", "Fast Training of Small Models")).toBe(
      false,
    );
    expect(isSingleWordTypo("A Short Title", "A Short Titel")).toBe(false); // < 4 words / short word
    expect(
      isSingleWordTypo("Efficient Learning Methods Today", "Efficient Learning Methods Today"),
    ).toBe(false);
  });

  it("parses an external_ids file and rejects a malformed one", () => {
    const m = parseExternalIds({
      schema_version: "conference-external-ids-v1",
      papers: [{ paper_id: pid(1), title: "t", dblp_key: "conf/iclr/A25", match: {} }],
    });
    expect(m.get(pid(1))?.dblp_key).toBe("conf/iclr/A25");
    expect(() => parseExternalIds({ schema_version: "x", papers: [] })).toThrow();
    expect(() =>
      parseExternalIds({
        schema_version: "conference-external-ids-v1",
        papers: [{ paper_id: "bad" }],
      }),
    ).toThrow();
  });
});

describe("S2 pairing through the DBLP key", () => {
  it("pairs a row whose S2 record kept another title when the DBLP keys agree", () => {
    const row = {
      paper_id: pid(9),
      title: "Denoising Levy Probabilistic Models",
      authors: ["Dario Shariatian", "Umut Simsekli"],
    };
    const s2 = {
      paperId: "s2x",
      title: "Heavy-Tailed Diffusion with Denoising Levy Probabilistic Models",
      authors: ["Dario Shariatian", "Umut Simsekli"],
      arxivId: null,
      dblpKey: "conf/iclr/ShariatianSD25",
    };
    expect(pairWithS2([row], [s2]).size).toBe(0);
    expect(
      pairWithS2([row], [s2], new Map([[pid(9), "conf/iclr/ShariatianSD25"]])).get(pid(9))?.paperId,
    ).toBe("s2x");
    expect(pairWithS2([row], [s2], new Map([[pid(9), "conf/iclr/Other25"]])).size).toBe(0);
  });
});

describe("linkExternalIds (offline, mocked SPARQL)", () => {
  it("writes external_ids.json with counts, and nothing on an unusable answer", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ext-ids-"));
    const dir = join(tmp, "iclr-2025");
    mkdirSync(dir, { recursive: true });
    const hash = "b3847cda0c8cc0cfcdacf462dc122214";
    const url = `https://proceedings.iclr.cc/paper_files/paper/2025/hash/${hash}-Abstract-Conference.html`;
    const fields = ["title", "authors", "arxiv_url", "abstract", "source", "source_id"] as const;
    writeFileSync(
      join(dir, "summary.csv"),
      writeDictCsv(fields, [
        {
          title: "$\\gamma-$MoD: Exploring Mixture-of-Depth",
          authors: "Yaxin Luo; Gen Luo",
          arxiv_url: url,
          abstract: "",
          source: "conference_site",
          source_id: `iclr-2025-hash-${hash}`,
        },
      ]),
    );
    const sparql = {
      results: {
        bindings: [
          {
            p: { value: "https://dblp.org/rec/conf/iclr/LuoL25" },
            title: { value: "γ-MoD: Exploring Mixture-of-Depth." },
            ee: { value: "https://openreview.net/forum?id=ORid123" },
            authors: { value: "Gen Luo|Yaxin Luo" },
          },
        ],
      },
    };
    let body = JSON.stringify(sparql);
    const seen: string[] = [];
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Accept") ?? "");
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const opts = {
      conference: "iclr-2025",
      inputsRoot: tmp,
      dblpToc: "db/conf/iclr/iclr2025",
      client: new PacedClient(fetchFn, async () => {}),
      log: () => {},
      now: () => new Date("2026-10-11T00:00:00Z"),
    };
    const res = await linkExternalIds(opts);
    expect(res?.counts).toEqual({ rows: 1, dblp_records: 1, linked: 1, openreview: 1 });
    expect(seen).toEqual(["application/sparql-results+json"]);
    const file = JSON.parse(readFileSync(join(dir, "external_ids.json"), "utf-8"));
    expect(file.source.license).toBe("CC0-1.0");
    expect(file.papers[0]).toMatchObject({
      paper_id: makePaperId("conference_site", `iclr-2025-hash-${hash}`),
      dblp_key: "conf/iclr/LuoL25",
      openreview_id: "ORid123",
    });
    body = "<html>Anubis</html>";
    expect(await linkExternalIds(opts)).toBeNull();
    // The earlier file is left as it was.
    expect(JSON.parse(readFileSync(join(dir, "external_ids.json"), "utf-8")).counts.linked).toBe(1);
  });
});
