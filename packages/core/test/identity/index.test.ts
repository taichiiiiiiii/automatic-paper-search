/**
 * TS port of `paperpilot/tests/test_identity_source_ids.py` — golden
 * contracts for deterministic source-derived PaperPilot IDs.
 *
 * Merges the two independent test suites that grew up around this
 * module's two former copies (`apps/pipeline/src/catalog/identity.ts` and
 * `apps/pipeline/src/release/identity/sourceIds.ts`) per
 * docs/migration/p4-followups.md #1/#2/#9/#20. No case below is dropped;
 * none conflicted (both suites test the one consolidated implementation
 * identically).
 */
import { describe, expect, it } from "vitest";
import {
  IdentityError,
  identityFromUrl,
  makePaperId,
  normalizeAlias,
} from "../../src/identity/index.js";

describe("identityFromUrl golden vectors", () => {
  const cases: Array<[string, string, string, string]> = [
    [
      "https://arxiv.org/abs/2601.02771v3",
      "arxiv",
      "2601.02771",
      "a975ae530b334ab97e07817de3a60e7ed5d615ad",
    ],
    [
      "http://www.arxiv.org/pdf/2601.02771v1.pdf",
      "arxiv",
      "2601.02771",
      "a975ae530b334ab97e07817de3a60e7ed5d615ad",
    ],
    [
      // The arXiv API's own pdf_url form carries no extension.
      "http://arxiv.org/pdf/2601.02771v1",
      "arxiv",
      "2601.02771",
      "a975ae530b334ab97e07817de3a60e7ed5d615ad",
    ],
    [
      "https://openreview.net/forum?id=rlZeILv3fm#discussion",
      "openreview",
      "rlZeILv3fm",
      "6d4921febdeb651471ac08d4744b5f22c9f62162",
    ],
    [
      "https://aclanthology.org/2025.acl-long.153/",
      "acl_anthology",
      "2025.acl-long.153",
      "e5b9066b221ffb3599ca8fa9df7cd51438080a2e",
    ],
    [
      "https://openaccess.thecvf.com/content/CVPR2025/html/" +
        "Held_3D_Convex_Splatting_Radiance_Field_Rendering_with_3D_Smooth_" +
        "Convexes_CVPR_2025_paper.html",
      "cvf",
      "Held_3D_Convex_Splatting_Radiance_Field_Rendering_with_3D_Smooth_" +
        "Convexes_CVPR_2025_paper",
      "bab7ab158b1a4c717d23d44aa7af7c1e562fce08",
    ],
  ];

  for (const [url, source, sourceId, paperId] of cases) {
    it(`parses ${url}`, () => {
      expect(identityFromUrl(url)).toEqual({ source, sourceId, paperId });
    });
  }

  it("parses a legacy arXiv id (archive/number)", () => {
    const id = identityFromUrl("https://arxiv.org/abs/hep-th/9901001");
    expect(id.source).toBe("arxiv");
    expect(id.sourceId).toBe("hep-th/9901001");
  });

  it("is deterministic (same URL -> same paper_id every time)", () => {
    const a = identityFromUrl("https://arxiv.org/abs/2301.01234");
    const b = identityFromUrl("https://arxiv.org/abs/2301.01234");
    expect(a.paperId).toBe(b.paperId);
  });

  it("normalizes a /pdf/<id>.pdf URL the same as /abs/<id>", () => {
    const abs = identityFromUrl("https://arxiv.org/abs/2301.01234");
    const pdf = identityFromUrl("https://arxiv.org/pdf/2301.01234.pdf");
    expect(pdf.paperId).toBe(abs.paperId);
  });

  it("strips the version suffix from an arXiv id", () => {
    const withV = identityFromUrl("https://arxiv.org/abs/2301.01234v3");
    const withoutV = identityFromUrl("https://arxiv.org/abs/2301.01234");
    expect(withV.paperId).toBe(withoutV.paperId);
  });
});

it("arxiv legacy id preserves subarchive and drops version", () => {
  const identity = identityFromUrl("https://export.arxiv.org/abs/math.GT/0309136v2");
  expect(identity.sourceId).toBe("math.GT/0309136");
  expect(normalizeAlias("ArXiV", "math.GT/0309136v4")).toEqual(["arxiv", "math.GT/0309136"]);
});

it("openreview id is case sensitive", () => {
  const upper = identityFromUrl("https://openreview.net/forum?id=AbC_123");
  const lower = identityFromUrl("https://openreview.net/forum?id=abc_123");
  expect(upper.sourceId).not.toBe(lower.sourceId);
  expect(upper.paperId).not.toBe(lower.paperId);
});

it("doi alias normalization", () => {
  const expected = ["doi", "10.1234/abc.def"];
  expect(normalizeAlias("DOI", "doi:10.1234/ABC.Def")).toEqual(expected);
  expect(normalizeAlias("doi", "https://doi.org/10.1234%2FABC.Def")).toEqual(expected);
  expect(normalizeAlias("doi", "http://dx.doi.org/10.1234/ABC.Def")).toEqual(expected);
});

describe("unknown or ambiguous url fails without title fallback", () => {
  const urls = [
    "",
    "A Paper Title",
    "ftp://arxiv.org/abs/2601.02771",
    "https://example.com/abs/2601.02771",
    "https://user@arxiv.org/abs/2601.02771",
    "https://arxiv.org/abs/2601%2F02771",
    "https://arxiv.org/abs/not-an-id",
    "https://openreview.net/forum",
    "https://openreview.net/forum?id=one&id=two",
    "https://openreview.net/forum?id=one%2Ftwo",
    "https://aclanthology.org/one/two/",
    "https://openaccess.thecvf.com/content/CVPR2025/papers/test.html",
    // From the former catalog/identity.ts suite:
    "https://arxiv.org/abs/2301.01234?x=1",
    "https://user:pass@arxiv.org/abs/2301.01234",
  ];
  for (const url of urls) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(() => identityFromUrl(url)).toThrow(IdentityError);
    });
  }
});

describe("invalid alias fails", () => {
  const cases: Array<[string, string]> = [
    ["doi", ""],
    ["doi", "10.1234"],
    ["doi", "11.1234/abc"],
    ["doi", "https://example.com/10.1234/abc"],
    ["arxiv", "https://arxiv.org/abs/2601.02771"],
    ["arxiv", "2601.02771 v2"],
    ["pmid", "12345"],
    ["ssrn", "123"],
  ];
  for (const [namespace, value] of cases) {
    it(`rejects ${namespace}=${JSON.stringify(value)}`, () => {
      expect(() => normalizeAlias(namespace, value)).toThrow(IdentityError);
    });
  }
});

it("normalizes an arxiv alias the same way as a URL-derived id", () => {
  const [source, id] = normalizeAlias("arxiv", "2301.01234v2");
  expect(source).toBe("arxiv");
  expect(id).toBe("2301.01234");
});

// LOW (P4 review round 2): `parseQsl`'s `max_num_fields=20` cap (:242)
// and `unquote(..., errors="replace")` semantics (:260, used for query
// names/values — distinct from the `errors="strict"` used for path
// segments) were ported but never pinned by a test.
describe("OpenReview query parsing: parse_qsl max_num_fields and replace-mode unquote", () => {
  function openreviewUrlWithExtraFields(extraFieldCount: number): string {
    const extra = Array.from({ length: extraFieldCount }, (_, i) => `x${i}=v`).join("&");
    return `https://openreview.net/forum?id=abc_123&${extra}`;
  }

  it("20 total query fields (the cap) parses fine", () => {
    const id = identityFromUrl(openreviewUrlWithExtraFields(19));
    expect(id.sourceId).toBe("abc_123");
  });

  it("21 total query fields (one over the cap) throws — max_num_fields=20", () => {
    expect(() => identityFromUrl(openreviewUrlWithExtraFields(20))).toThrow(IdentityError);
  });

  it("an invalid (non-hex) %-escape in a query value is left as literal text, not an error (unquote leniency)", () => {
    // Proves `%ZZ` is recognized as "not actually an escape" (both X and Y
    // must be hex digits) rather than mis-decoded or thrown on — the id
    // value survives character-for-character, so the FAILURE that does
    // occur is `normalizeOpenreviewId`'s charset check (the literal `%`
    // is not in `[A-Za-z0-9_-]`), not a decode error.
    expect(() => identityFromUrl("https://openreview.net/forum?id=abc%ZZdef")).toThrow(
      /invalid OpenReview forum ID: "abc%ZZdef"/,
    );
  });

  it('an invalid UTF-8 byte in a query value is replaced (U+FFFD), not thrown on (errors="replace")', () => {
    // `%FF` is a valid hex escape but an invalid standalone UTF-8 byte. The
    // REPLACE-mode decoder used for query values substitutes U+FFFD and
    // keeps going (reaching `normalizeOpenreviewId`'s charset check, which
    // then rejects the replacement character) — a STRICT-mode decoder
    // would instead throw deep inside `parseQsl`, surfacing as the
    // DIFFERENT message "OpenReview query is invalid" instead.
    expect(() => identityFromUrl("https://openreview.net/forum?id=abc%FFdef")).toThrow(
      /invalid OpenReview forum ID: "abc�def"/,
    );
  });
});

describe("makePaperId", () => {
  it("make_paper_id is source scoped and validates input", () => {
    expect(makePaperId("arxiv", "2601.02771v2")).toBe(makePaperId("arxiv", "2601.02771"));
    expect(makePaperId("cvf", "Same_ID")).not.toBe(makePaperId("acl_anthology", "Same_ID"));
    expect(() => makePaperId("unknown", "x")).toThrow(IdentityError);
    expect(() => makePaperId("arxiv", "")).toThrow(IdentityError);
  });

  it("is a 40-hex-character digest (sha256, truncated — not sha1)", () => {
    const id = makePaperId("arxiv", "2301.01234");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("differs for different source ids", () => {
    expect(makePaperId("arxiv", "2301.01234")).not.toBe(makePaperId("arxiv", "2301.01235"));
  });
});
