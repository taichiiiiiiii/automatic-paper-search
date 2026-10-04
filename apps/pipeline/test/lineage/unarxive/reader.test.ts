/**
 * TS port of `paperpilot/tests/test_unarxive.py` for `lineage/unarxive/reader.ts`.
 * The DuckDB execution itself is behind an injected `UnarxiveAdapter` (see
 * the module's doc comment on the "no Node DuckDB binding" follow-up); these
 * tests use a fake adapter in place of Python's `MagicMock`-patched
 * `_open_readonly`.
 */
import { describe, expect, it } from "vitest";
import {
  fetchContexts,
  isAvailable,
  normaliseArxivId,
  normaliseOpenalexShort,
  UNAVAILABLE_ADAPTER,
  type UnarxiveAdapter,
} from "../../../src/lineage/unarxive/reader.js";

describe("normaliseOpenalexShort", () => {
  it("accepts the URL form, the openalex: prefix, and the bare short id", () => {
    expect(normaliseOpenalexShort("https://openalex.org/W2962917714")).toBe("W2962917714");
    expect(normaliseOpenalexShort("openalex:W2962917714")).toBe("W2962917714");
    expect(normaliseOpenalexShort("W2962917714")).toBe("W2962917714");
  });

  it("rejects non-W-prefixed and empty/missing inputs", () => {
    expect(normaliseOpenalexShort("foo")).toBeNull();
    expect(normaliseOpenalexShort("")).toBeNull();
    expect(normaliseOpenalexShort(null)).toBeNull();
    expect(normaliseOpenalexShort("hashhash1234abcd")).toBeNull();
  });
});

describe("normaliseArxivId", () => {
  it("accepts the bare modern form and strips a version suffix", () => {
    expect(normaliseArxivId("2010.11929")).toBe("2010.11929");
    expect(normaliseArxivId("2010.11929v3")).toBe("2010.11929");
    expect(normaliseArxivId("2103.14030v1")).toBe("2103.14030");
  });

  it("strips the arXiv: prefix (case-insensitively)", () => {
    expect(normaliseArxivId("arXiv:2010.11929")).toBe("2010.11929");
    expect(normaliseArxivId("arxiv:2010.11929")).toBe("2010.11929");
  });

  it("rejects old-style ids and garbage", () => {
    expect(normaliseArxivId("cs.LG/0512345")).toBeNull();
    expect(normaliseArxivId("not an id")).toBeNull();
    expect(normaliseArxivId("")).toBeNull();
    expect(normaliseArxivId(null)).toBeNull();
  });

  it("accepts an arXiv abs/pdf URL, case-insensitively, with a version suffix", () => {
    expect(normaliseArxivId("https://arxiv.org/abs/2010.11929")).toBe("2010.11929");
    expect(normaliseArxivId("http://arxiv.org/pdf/2205.14135v2")).toBe("2205.14135");
    expect(normaliseArxivId("HTTPS://ArXiv.org/ABS/2010.11929")).toBe("2010.11929");
  });

  it("accepts a DataCite arXiv DOI, bare or as a doi.org URL", () => {
    expect(normaliseArxivId("https://doi.org/10.48550/arXiv.2010.11929")).toBe("2010.11929");
    expect(normaliseArxivId("10.48550/arXiv.2103.14030")).toBe("2103.14030");
  });

  it("rejects a non-arXiv DOI", () => {
    expect(normaliseArxivId("https://doi.org/10.1234/foo")).toBeNull();
    expect(normaliseArxivId("10.18653/v1/N18-1202")).toBeNull();
  });

  it("checks the host, not a path substring", () => {
    expect(normaliseArxivId("https://example.com/arxiv.org/abs/2010.11929")).toBeNull();
    expect(normaliseArxivId("https://arxiv.org.evil/abs/2010.11929")).toBeNull();
    expect(normaliseArxivId("https://example.com/10.48550/arXiv.2010.11929")).toBeNull();
    expect(normaliseArxivId("https://arxiv.org/abs/2010.11929/extra")).toBeNull();
    expect(normaliseArxivId("https://arxiv.org/pdf/2010.11929v1.pdf")).toBe("2010.11929");
  });
});

describe("fetchContexts", () => {
  it("short-circuits on missing ids without touching the adapter", () => {
    let called = false;
    const adapter: UnarxiveAdapter = {
      available: true,
      query: () => {
        called = true;
        return [];
      },
    };
    expect(fetchContexts({ childArxivId: null, parentOpenalexId: "W123" }, adapter)).toEqual([]);
    expect(fetchContexts({ childArxivId: "2010.11929", parentOpenalexId: "" }, adapter)).toEqual(
      [],
    );
    expect(called).toBe(false);
  });

  it("returns [] when the adapter is unavailable (the default)", () => {
    expect(fetchContexts({ childArxivId: "2010.11929", parentOpenalexId: "W2962917714" })).toEqual(
      [],
    );
    expect(
      fetchContexts(
        { childArxivId: "2010.11929", parentOpenalexId: "W2962917714" },
        UNAVAILABLE_ADAPTER,
      ),
    ).toEqual([]);
  });

  it("returns the paragraphs verbatim and passes the bare-arxiv/full-openalex-URL/limit SQL contract", () => {
    let seenArgs: { arxivId: string; openalexLabel: string; limit: number } | null = null;
    const adapter: UnarxiveAdapter = {
      available: true,
      query: (args) => {
        seenArgs = args;
        return [
          "We build on the framework of [42] to model video diffusion.",
          "Unlike [42], we use a hierarchical attention.",
        ];
      },
    };
    const result = fetchContexts(
      { childArxivId: "2103.14030", parentOpenalexId: "openalex:W2962917714" },
      adapter,
    );
    expect(result).toEqual([
      "We build on the framework of [42] to model video diffusion.",
      "Unlike [42], we use a hierarchical attention.",
    ]);
    expect(seenArgs).toEqual({
      arxivId: "2103.14030",
      openalexLabel: "https://openalex.org/W2962917714",
      limit: 5,
    });
  });

  it("defaults the limit to 5", () => {
    let seenLimit: number | null = null;
    const adapter: UnarxiveAdapter = {
      available: true,
      query: (args) => {
        seenLimit = args.limit;
        return [];
      },
    };
    fetchContexts({ childArxivId: "2103.14030", parentOpenalexId: "W123" }, adapter);
    expect(seenLimit).toBe(5);
  });

  it("drops empty/falsy rows", () => {
    const adapter: UnarxiveAdapter = {
      available: true,
      query: () => ["real context", "", "another context"],
    };
    const result = fetchContexts({ childArxivId: "2010.11929", parentOpenalexId: "W123" }, adapter);
    expect(result).toEqual(["real context", "another context"]);
  });
});

describe("isAvailable", () => {
  it("reflects the adapter's availability", () => {
    expect(isAvailable({ available: true, query: () => [] })).toBe(true);
    expect(isAvailable(UNAVAILABLE_ADAPTER)).toBe(false);
    expect(isAvailable()).toBe(false);
  });
});
