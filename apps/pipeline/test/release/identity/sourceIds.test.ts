/**
 * TS port of `paperpilot/tests/test_identity_source_ids.py` — golden
 * contracts for deterministic source-derived PaperPilot IDs.
 */
import { describe, expect, it } from "vitest";
import {
  IdentityError,
  identityFromUrl,
  makePaperId,
  normalizeAlias,
} from "../../../src/release/identity/sourceIds.js";

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
  ];
  for (const [namespace, value] of cases) {
    it(`rejects ${namespace}=${JSON.stringify(value)}`, () => {
      expect(() => normalizeAlias(namespace, value)).toThrow(IdentityError);
    });
  }
});

it("make_paper_id is source scoped and validates input", () => {
  expect(makePaperId("arxiv", "2601.02771v2")).toBe(makePaperId("arxiv", "2601.02771"));
  expect(makePaperId("cvf", "Same_ID")).not.toBe(makePaperId("acl_anthology", "Same_ID"));
  expect(() => makePaperId("unknown", "x")).toThrow(IdentityError);
  expect(() => makePaperId("arxiv", "")).toThrow(IdentityError);
});
