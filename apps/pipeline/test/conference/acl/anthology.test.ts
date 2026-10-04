/**
 * Port of `paperpilot/tests/test_collect_acl_anthology.py` (CNF-05..10,
 * docs/migration/safety-contracts.md), reimplemented against canned XML
 * fixtures delivered through an injected `fetchXmlText`/`arxiv.fetchText`
 * rather than mocking Python's internal `fetch_xml`/`arxiv` seams, which
 * don't exist in this port.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AclFetchText,
  fetchXml,
  parsePapers,
  presentVolumeIds,
  runCollectAclMain,
} from "../../../src/conference/acl/anthology.js";
import {
  type ArxivFetchDeps,
  type ArxivTextResponse,
  writeOutputs,
} from "../../../src/conference/shared/index.js";

function xmlResponse(status: number, body = ""): { status: number; text: () => Promise<string> } {
  return { status, text: async () => body };
}

function anthologyXml(
  volumes: {
    id: string;
    papers: { stub: string; title: string; authors: [string, string][]; abstract?: string }[];
  }[],
): string {
  const volumeXml = volumes
    .map(
      (v) => `
    <volume id="${v.id}">
      <paper id="0"><title>Front Matter</title></paper>
      ${v.papers
        .map(
          (p) => `
      <paper id="${p.stub.split(".").pop()}">
        <title>${p.title}</title>
        ${p.authors.map(([f, l]) => `<author><first>${f}</first><last>${l}</last></author>`).join("")}
        <url>${p.stub}</url>
        <abstract>${p.abstract ?? ""}</abstract>
      </paper>`,
        )
        .join("")}
    </volume>`,
    )
    .join("");
  return `<?xml version="1.0"?><collection id="2025.acl">${volumeXml}</collection>`;
}

let outputRoot: string;
beforeEach(() => {
  outputRoot = mkdtempSync(join(tmpdir(), "acl-test-"));
});

describe("fetchXml (CNF-05)", () => {
  it("returns the body text on 200", async () => {
    const fetchText: AclFetchText = async () => xmlResponse(200, "<x/>");
    expect(await fetchXml("2025.acl", fetchText)).toBe("<x/>");
  });

  it("returns null on a non-200 response (fail-safe)", async () => {
    const fetchText: AclFetchText = async () => xmlResponse(404);
    expect(await fetchXml("2025.acl", fetchText)).toBeNull();
  });
});

describe("presentVolumeIds", () => {
  it("lists every volume id the file carries, duplicates kept", () => {
    const xml = anthologyXml([
      { id: "long", papers: [{ stub: "2025.acl-long.1", title: "A", authors: [["A", "B"]] }] },
      { id: "short", papers: [{ stub: "2025.acl-short.1", title: "B", authors: [["C", "D"]] }] },
      { id: "findings", papers: [] },
    ]);
    expect(presentVolumeIds(xml)).toEqual(["long", "short", "findings"]);
  });

  it("returns [] for unparseable XML", () => {
    expect(presentVolumeIds("not xml <<<")).toEqual([]);
  });

  it("returns [] for a truncated document (H2)", () => {
    const xml = anthologyXml([
      { id: "long", papers: [{ stub: "2025.acl-long.1", title: "X", authors: [["A", "B"]] }] },
    ]);
    // Chop off the closing </volume></collection> tags.
    const truncated = xml.slice(0, xml.lastIndexOf("</paper>") + "</paper>".length);
    expect(presentVolumeIds(truncated)).toEqual([]);
  });

  it("returns [] for a wrong/mismatched closing tag (H2)", () => {
    const xml = anthologyXml([
      { id: "long", papers: [{ stub: "2025.acl-long.1", title: "X", authors: [["A", "B"]] }] },
    ]).replace("</collection>", "</wrong-tag>");
    expect(presentVolumeIds(xml)).toEqual([]);
  });

  it("returns [] for an undefined entity (H2/M8)", () => {
    const xml = anthologyXml([
      {
        id: "long",
        papers: [
          { stub: "2025.acl-long.1", title: "X &undefinedentity; Y", authors: [["A", "B"]] },
        ],
      },
    ]);
    expect(presentVolumeIds(xml)).toEqual([]);
  });
});

describe("parsePapers", () => {
  it("parses main-track papers with authors, skipping front matter (no authors)", () => {
    const xml = anthologyXml([
      {
        id: "long",
        papers: [
          {
            stub: "2025.acl-long.1",
            title: "Great Paper",
            authors: [["Jane", "Doe"]],
            abstract: "An abstract.",
          },
        ],
      },
      {
        id: "findings",
        papers: [{ stub: "2025.findings-acl.1", title: "Skip me", authors: [["X", "Y"]] }],
      },
    ]);
    const rows = parsePapers(xml, "ACL");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Great Paper",
      authors: "Jane Doe",
      venue: "ACL",
      abstract: "An abstract.",
      url: "https://aclanthology.org/2025.acl-long.1/",
      pdf_url: "https://aclanthology.org/2025.acl-long.1.pdf",
    });
  });

  it("flattens nested inline markup (fixed-case) in titles", () => {
    const xml = `<?xml version="1.0"?><collection id="2025.acl"><volume id="long">
      <paper id="1"><title>A <fixed-case>BERT</fixed-case> Model</title>
      <author><first>A</first><last>B</last></author>
      <url>2025.acl-long.1</url></paper>
    </volume></collection>`;
    const rows = parsePapers(xml, "ACL");
    expect(rows[0]?.title).toBe("A BERT Model");
  });

  it("decodes numeric XML character references like ET.fromstring (M8)", () => {
    const xml = `<?xml version="1.0"?><collection id="2025.acl"><volume id="long">
      <paper id="1"><title>Caf&#233; na&#xEF;ve</title>
      <author><first>Andr&#233;</first><last>B</last></author>
      <url>2025.acl-long.1</url>
      <abstract>Tr&#232;s bien &amp; bon</abstract></paper>
    </volume></collection>`;
    const rows = parsePapers(xml, "ACL");
    expect(rows[0]?.title).toBe("Café naïve");
    expect(rows[0]?.authors).toBe("André B");
    expect(rows[0]?.abstract).toBe("Très bien & bon");
  });

  it("returns [] when a numeric reference uses uppercase X (invalid per XML 1.0) (M8)", () => {
    const xml = `<?xml version="1.0"?><collection id="2025.acl"><volume id="long">
      <paper id="1"><title>Bad &#X49; ref</title>
      <author><first>A</first><last>B</last></author>
      <url>2025.acl-long.1</url></paper>
    </volume></collection>`;
    expect(parsePapers(xml, "ACL")).toEqual([]);
  });
});

describe("runCollectAclMain (CNF-05..10)", () => {
  const baseArgv = ["--conference", "acl-2025", "--venue", "ACL", "--xml-id", "2025.acl"];

  it("CNF-05: exits 1 and writes nothing when the XML fetch fails", async () => {
    const code = await runCollectAclMain(baseArgv, {
      fetchXmlText: async () => xmlResponse(500),
      outputRoot,
      print: () => {},
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "acl-2025"))).toBe(false);
  });

  // Both of these use EMNLP's single-"main"-volume convention (not
  // ACL's long+short) so the fixture carries every volume the convention
  // check wants: a false pass (exit 0) here can only come from H2's bug
  // (the malformed document parsing "successfully"), never from CNF-07's
  // separate missing-volume gate.
  const emnlpArgv = ["--conference", "emnlp-2025", "--venue", "EMNLP", "--xml-id", "2025.emnlp"];

  it("H2: exits 1 and writes nothing for a truncated XML document", async () => {
    const xml = anthologyXml([
      { id: "main", papers: [{ stub: "2025.emnlp-main.1", title: "X", authors: [["A", "B"]] }] },
    ]);
    // Keep the one real paper fully closed, but drop the document's own
    // closing tags (</volume></collection>) — fast-xml-parser's lenient
    // parser happily treats this as if those tags were there (H2's bug),
    // so without the fix this would parse to a complete, valid-looking
    // single-paper proceedings and exit 0.
    const truncated = xml.slice(0, xml.lastIndexOf("</paper>") + "</paper>".length);
    const code = await runCollectAclMain(emnlpArgv, {
      fetchXmlText: async () => xmlResponse(200, truncated),
      outputRoot,
      print: () => {},
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "emnlp-2025"))).toBe(false);
  });

  it("H2: exits 1 and writes nothing for a mismatched closing tag", async () => {
    const xml = anthologyXml([
      { id: "main", papers: [{ stub: "2025.emnlp-main.1", title: "X", authors: [["A", "B"]] }] },
    ]).replace("</collection>", "</wrong-tag>");
    const code = await runCollectAclMain(emnlpArgv, {
      fetchXmlText: async () => xmlResponse(200, xml),
      outputRoot,
      print: () => {},
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "emnlp-2025"))).toBe(false);
  });

  it("CNF-06: refuses a collection with no main-track volume", async () => {
    const xml = anthologyXml([
      {
        id: "findings",
        papers: [{ stub: "2025.findings-acl.1", title: "X", authors: [["A", "B"]] }],
      },
    ]);
    const code = await runCollectAclMain(baseArgv, {
      fetchXmlText: async () => xmlResponse(200, xml),
      outputRoot,
      print: () => {},
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "acl-2025"))).toBe(false);
  });

  it("CNF-07: refuses a missing volume within the long/short convention", async () => {
    const xml = anthologyXml([
      { id: "long", papers: [{ stub: "2025.acl-long.1", title: "X", authors: [["A", "B"]] }] },
    ]);
    const code = await runCollectAclMain(baseArgv, {
      fetchXmlText: async () => xmlResponse(200, xml),
      outputRoot,
      print: () => {},
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "acl-2025"))).toBe(false);
  });

  it("CNF-07: does not refuse a complete convention (single EMNLP main volume)", async () => {
    const xml = anthologyXml([
      { id: "main", papers: [{ stub: "2025.emnlp-main.1", title: "X", authors: [["A", "B"]] }] },
    ]);
    const code = await runCollectAclMain(
      ["--conference", "emnlp-2025", "--venue", "EMNLP", "--xml-id", "2025.emnlp"],
      { fetchXmlText: async () => xmlResponse(200, xml), outputRoot, print: () => {} },
    );
    expect(code).toBe(0);
    expect(existsSync(join(outputRoot, "emnlp-2025"))).toBe(true);
  });

  it("CNF-08: collects once the operator acknowledges the missing volume", async () => {
    const xml = anthologyXml([
      { id: "long", papers: [{ stub: "2025.acl-long.1", title: "X", authors: [["A", "B"]] }] },
    ]);
    const code = await runCollectAclMain([...baseArgv, "--allow-missing-volume", "short"], {
      fetchXmlText: async () => xmlResponse(200, xml),
      outputRoot,
      print: () => {},
    });
    expect(code).toBe(0);
    expect(existsSync(join(outputRoot, "acl-2025"))).toBe(true);
  });

  it("CNF-09: refuses an acknowledgement that names nothing missing", async () => {
    const xml = anthologyXml([
      { id: "long", papers: [{ stub: "2025.acl-long.1", title: "X", authors: [["A", "B"]] }] },
      { id: "short", papers: [{ stub: "2025.acl-short.1", title: "Y", authors: [["C", "D"]] }] },
    ]);
    const code = await runCollectAclMain([...baseArgv, "--allow-missing-volume", "main"], {
      fetchXmlText: async () => xmlResponse(200, xml),
      outputRoot,
      print: () => {},
    });
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "acl-2025"))).toBe(false);
  });

  it("CNF-10: reports volumes found and exits 1 when 0 papers survive parsing", async () => {
    // Main-track volume ids present, but every paper lacks authors (front matter only).
    const xml = `<?xml version="1.0"?><collection id="2025.acl"><volume id="main">
      <paper id="0"><title>Front Matter</title></paper>
    </volume></collection>`;
    const code = await runCollectAclMain(
      ["--conference", "emnlp-2025", "--venue", "EMNLP", "--xml-id", "2025.emnlp"],
      { fetchXmlText: async () => xmlResponse(200, xml), outputRoot, print: () => {} },
    );
    expect(code).toBe(1);
    expect(existsSync(join(outputRoot, "emnlp-2025"))).toBe(false);
  });

  it("unknown flags are rejected (no silent typo acceptance)", async () => {
    await expect(
      runCollectAclMain([...baseArgv, "--allow-partial"], {
        fetchXmlText: async () => xmlResponse(200, anthologyXml([])),
        outputRoot,
      }),
    ).rejects.toThrow();
  });

  it("writes a CSV with the expected row on success", async () => {
    const xml = anthologyXml([
      {
        id: "long",
        papers: [{ stub: "2025.acl-long.1", title: "X", authors: [["A", "B"]], abstract: "abs" }],
      },
      { id: "short", papers: [] },
    ]);
    const code = await runCollectAclMain(baseArgv, {
      fetchXmlText: async () => xmlResponse(200, xml),
      outputRoot,
      now: () => new Date("2026-01-01T00:00:00Z"),
      print: () => {},
    });
    expect(code).toBe(0);
    const files = readFileSync(join(outputRoot, "acl-2025", "papers_2026-01-01.csv"), "utf-8");
    expect(files).toContain("X");
    expect(files).toContain("acl_anthology");
  });

  describe("oral overlay (CNF-14/15/16)", () => {
    function acceptedXml() {
      return anthologyXml([
        { id: "long", papers: [{ stub: "2025.acl-long.1", title: "X", authors: [["A", "B"]] }] },
        { id: "short", papers: [] },
      ]);
    }

    it("skips an incomplete (window-filled) overlay and keeps the published oral md", async () => {
      // Pre-publish an oral md.
      await runCollectAclMain(baseArgv, {
        fetchXmlText: async () => xmlResponse(200, acceptedXml()),
        outputRoot,
        print: () => {},
      });
      writeOutputs("acl-2025", [], ["Old Oral Title"], { outputRoot });

      const feed = (entries: number, total: number) =>
        `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">` +
        `<opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex>` +
        Array.from({ length: entries })
          .map(
            (_, i) =>
              `<entry><id>http://arxiv.org/abs/2501.0000${i}</id><updated>2025-01-01T00:00:00Z</updated><published>2025-01-01T00:00:00Z</published><title>T${i}</title><summary>s</summary></entry>`,
          )
          .join("") +
        `</feed>`;
      const arxiv: ArxivFetchDeps = {
        fetchText: async (): Promise<ArxivTextResponse> => ({
          status: 200,
          text: async () => feed(100, 100),
        }),
      };

      const code = await runCollectAclMain(
        [...baseArgv, "--oral-arxiv-query", 'co:"ACL 2025"', "--oral-max", "100"],
        {
          fetchXmlText: async () => xmlResponse(200, acceptedXml()),
          arxiv,
          outputRoot,
          print: () => {},
        },
      );
      expect(code).toBe(0);
      const oralMd = readFileSync(join(outputRoot, "acl-2025", "oral_summaries_ja.md"), "utf-8");
      expect(oralMd).toContain("Old Oral Title");
    });

    it("CNF-16: skips a malformed-feed overlay and keeps the published oral md (not just the window-filled reason)", async () => {
      await runCollectAclMain(baseArgv, {
        fetchXmlText: async () => xmlResponse(200, acceptedXml()),
        outputRoot,
        print: () => {},
      });
      writeOutputs("acl-2025", [], ["Old Oral Title"], { outputRoot });

      const arxiv: ArxivFetchDeps = {
        fetchText: async (): Promise<ArxivTextResponse> => ({
          status: 200,
          text: async () => "<html>rate limited, not a feed</html>",
        }),
      };

      const code = await runCollectAclMain([...baseArgv, "--oral-arxiv-query", 'co:"ACL 2025"'], {
        fetchXmlText: async () => xmlResponse(200, acceptedXml()),
        arxiv,
        outputRoot,
        print: () => {},
      });
      expect(code).toBe(0);
      const oralMd = readFileSync(join(outputRoot, "acl-2025", "oral_summaries_ja.md"), "utf-8");
      expect(oralMd).toContain("Old Oral Title");
    });

    it("CNF-16: a malformed-feed overlay does not authorize --clear-oral either", async () => {
      await runCollectAclMain(baseArgv, {
        fetchXmlText: async () => xmlResponse(200, acceptedXml()),
        outputRoot,
        print: () => {},
      });
      writeOutputs("acl-2025", [], ["Old Oral Title"], { outputRoot });

      const arxiv: ArxivFetchDeps = {
        fetchText: async (): Promise<ArxivTextResponse> => ({
          status: 200,
          text: async () => "<html>rate limited, not a feed</html>",
        }),
      };

      const code = await runCollectAclMain(
        [...baseArgv, "--oral-arxiv-query", 'co:"ACL 2025"', "--clear-oral"],
        {
          fetchXmlText: async () => xmlResponse(200, acceptedXml()),
          arxiv,
          outputRoot,
          print: () => {},
        },
      );
      expect(code).toBe(0);
      const oralMd = readFileSync(join(outputRoot, "acl-2025", "oral_summaries_ja.md"), "utf-8");
      expect(oralMd).toContain("Old Oral Title");
    });
  });
});
