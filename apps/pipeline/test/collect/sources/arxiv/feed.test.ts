/**
 * Port of the BODY-SHAPE half of `paperpilot/tests/test_arxiv_feed.py` —
 * the part that is about what a response body looks like, not about
 * watching the (Python-only) `arxiv` package's internal logger/handler
 * machinery.
 *
 * N/A (no TS port — see `feed.ts`'s module doc comment): every test in the
 * Python file that exercises `MalformedFeedWatch` as a logging.Handler
 * (attach/detach, ambient level lifting, per-URL body-hook flag clearing on
 * a requests.Session, hook install/removal, `test_installed_arxiv_client_*`
 * contract-pinning of the third-party `arxiv` package itself). This port
 * owns its own parser, so there is no lenient third-party library and no
 * log-based side channel to watch — `parseArxivFeed` reports everything
 * directly in its return value. COL-04 (per-URL flag clearing) is closed by
 * construction in `arxiv.ts` instead: each page fetch judges only the
 * response it just received.
 */
import { describe, expect, it } from "vitest";
import { parseArxivFeed } from "../../../../src/collect/sources/arxiv/feed.js";

const VALID_EMPTY_FEED =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">' +
  "<opensearch:totalResults>0</opensearch:totalResults>" +
  "<opensearch:itemsPerPage>0</opensearch:itemsPerPage>" +
  "<opensearch:startIndex>0</opensearch:startIndex>" +
  "</feed>";

const VALID_FEED_WITH_ENTRY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">' +
  "<opensearch:totalResults>1</opensearch:totalResults>" +
  "<opensearch:itemsPerPage>1</opensearch:itemsPerPage>" +
  "<opensearch:startIndex>0</opensearch:startIndex>" +
  "<entry>" +
  "<id>http://arxiv.org/abs/2604.00002v1</id>" +
  "<updated>2026-04-02T00:00:00Z</updated>" +
  "<published>2026-04-02T00:00:00Z</published>" +
  "<title>Good Paper</title>" +
  "<summary>an abstract</summary>" +
  "<author><name>Alice</name></author>" +
  "</entry>" +
  "</feed>";

const FEED_ONE_ENTRY_MISSING_PUBLISHED =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">' +
  "<opensearch:totalResults>1</opensearch:totalResults>" +
  "<opensearch:itemsPerPage>1</opensearch:itemsPerPage>" +
  "<opensearch:startIndex>0</opensearch:startIndex>" +
  "<entry>" +
  "<id>http://arxiv.org/abs/2604.00002v1</id>" +
  "<updated>2026-04-02T00:00:00Z</updated>" +
  "<title>Missing Published</title>" +
  "<summary>an abstract</summary>" +
  "<author><name>Alice</name></author>" +
  "</entry>" +
  "</feed>";

const FEED_MIDDLE_ENTRY_MISSING_PUBLISHED =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">' +
  "<opensearch:totalResults>3</opensearch:totalResults>" +
  "<opensearch:itemsPerPage>3</opensearch:itemsPerPage>" +
  "<opensearch:startIndex>0</opensearch:startIndex>" +
  "<entry><id>http://arxiv.org/abs/2604.00001v1</id><updated>2026-04-01T00:00:00Z</updated><published>2026-04-01T00:00:00Z</published><title>P1</title><summary>abs</summary><author><name>Alice</name></author></entry>" +
  "<entry><id>http://arxiv.org/abs/2604.00002v1</id><updated>2026-04-02T00:00:00Z</updated><title>P2 (missing published)</title><summary>abs</summary><author><name>Alice</name></author></entry>" +
  "<entry><id>http://arxiv.org/abs/2604.00003v1</id><updated>2026-04-03T00:00:00Z</updated><published>2026-04-03T00:00:00Z</published><title>P3</title><summary>abs</summary><author><name>Alice</name></author></entry>" +
  "</feed>";

const FEED_NONZERO_TOTAL_ZERO_ENTRIES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">' +
  "<opensearch:totalResults>5</opensearch:totalResults>" +
  "<opensearch:itemsPerPage>5</opensearch:itemsPerPage>" +
  "<opensearch:startIndex>0</opensearch:startIndex>" +
  "</feed>";

const FEED_PAST_THE_END_IS_LEGITIMATELY_EMPTY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">' +
  "<opensearch:totalResults>5</opensearch:totalResults>" +
  "<opensearch:itemsPerPage>5</opensearch:itemsPerPage>" +
  "<opensearch:startIndex>5</opensearch:startIndex>" +
  "</feed>";

// `_MALFORMED_BODIES` from the Python suite.
const MALFORMED_BODIES = ["", "not xml at all", '<?xml version="1.0"?>'];

// `_SILENTLY_EMPTY_BODIES` — bodies the Python library's OWN lenient parser does
// NOT consider malformed at all (HIGH-1); this port's strict parser must still
// reject every one of them.
const SILENTLY_EMPTY_BODIES = [
  "<html><body>rate limited</body></html>",
  "<error>rate limit exceeded</error>",
  "<not xml",
];

describe("parseArxivFeed — COL-02/03: non-feed body detection", () => {
  it.each(MALFORMED_BODIES)("rejects malformed body %j", (body) => {
    const result = parseArxivFeed(body);
    expect(result.ok).toBe(false);
  });

  it.each(SILENTLY_EMPTY_BODIES)(
    "rejects a body the lenient library reads as a clean empty page: %j",
    (body) => {
      const result = parseArxivFeed(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("non-feed 200 response body");
    },
  );

  it("does not flag a well-formed empty feed", () => {
    const result = parseArxivFeed(VALID_EMPTY_FEED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.totalResults).toBe(0);
    }
  });

  it("does not flag a well-formed feed with entries", () => {
    const result = parseArxivFeed(VALID_FEED_WITH_ENTRY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((e) => e.title)).toEqual(["Good Paper"]);
      expect(result.skipped).toEqual([]);
    }
  });

  it("flags totalResults>0 with zero <entry> elements as a lost page (COL-03)", () => {
    const result = parseArxivFeed(FEED_NONZERO_TOTAL_ZERO_ENTRIES);
    expect(result.ok).toBe(false);
  });

  it("does not flag a page genuinely past the end of the result set", () => {
    const result = parseArxivFeed(FEED_PAST_THE_END_IS_LEGITIMATELY_EMPTY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
      expect(result.skipped).toEqual([]);
    }
  });
});

describe("parseArxivFeed — COL-01/06: per-entry skip within a well-formed page", () => {
  it("skips a single entry missing <published> and counts it, keeping the page well-formed", () => {
    const result = parseArxivFeed(FEED_ONE_ENTRY_MISSING_PUBLISHED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toContain("missing <published>");
    }
  });

  it("skips exactly the bad entry among good ones, keeping the others", () => {
    const result = parseArxivFeed(FEED_MIDDLE_ENTRY_MISSING_PUBLISHED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((e) => e.title)).toEqual(["P1", "P3"]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toContain("missing <published>");
    }
  });

  it("skips an entry without <id>", () => {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">' +
      "<opensearch:totalResults>1</opensearch:totalResults>" +
      "<opensearch:itemsPerPage>1</opensearch:itemsPerPage>" +
      "<opensearch:startIndex>0</opensearch:startIndex>" +
      "<entry><updated>2026-04-02T00:00:00Z</updated><published>2026-04-02T00:00:00Z</published><title>No Id</title></entry>" +
      "</feed>";
    const result = parseArxivFeed(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
      expect(result.skipped).toEqual(["Skipping entry without <id>"]);
    }
  });
});

describe("parseArxivFeed — entry field mapping", () => {
  it("maps title, authors, abstract, links, comment, categories", () => {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">' +
      "<opensearch:totalResults>1</opensearch:totalResults>" +
      "<opensearch:itemsPerPage>1</opensearch:itemsPerPage>" +
      "<opensearch:startIndex>0</opensearch:startIndex>" +
      "<entry>" +
      "<id>http://arxiv.org/abs/1706.03762v5</id>" +
      "<updated>2017-06-12T17:50:16Z</updated>" +
      "<published>2017-06-12T17:50:16Z</published>" +
      "<title>Attention   Is\nAll You Need</title>" +
      "<summary>We propose the Transformer.</summary>" +
      "<author><name>Vaswani</name></author>" +
      "<author><name>Shazeer</name></author>" +
      '<link href="http://arxiv.org/abs/1706.03762v5" rel="alternate" type="text/html"/>' +
      '<link title="pdf" href="http://arxiv.org/pdf/1706.03762v5" rel="related" type="application/pdf"/>' +
      '<category term="cs.CL"/>' +
      '<category term="cs.LG"/>' +
      "<arxiv:comment>Accepted at NeurIPS 2017</arxiv:comment>" +
      "<arxiv:doi>10.1234/abc</arxiv:doi>" +
      "</entry>" +
      "</feed>";
    const result = parseArxivFeed(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0];
    expect(e).toBeDefined();
    if (!e) return;
    expect(e.title).toBe("Attention Is All You Need"); // whitespace collapsed
    expect(e.authors.map((a) => a.name)).toEqual(["Vaswani", "Shazeer"]);
    expect(e.summary).toBe("We propose the Transformer.");
    expect(e.pdfUrl).toBe("http://arxiv.org/pdf/1706.03762v5");
    expect(e.categories).toEqual(["cs.CL", "cs.LG"]);
    expect(e.comment).toBe("Accepted at NeurIPS 2017");
    expect(e.doi).toBe("10.1234/abc");
    expect(e.entryId).toBe("http://arxiv.org/abs/1706.03762v5");
    expect(e.publishedDate).toBe("2017-06-12");
  });
});
