import { describe, expect, it } from "vitest";
import {
  csvLine,
  dictReader,
  parseCsvRows,
  stripBom,
  writeDictCsv,
} from "../../src/catalog/csv.js";

describe("parseCsvRows", () => {
  it("parses plain comma-separated rows", () => {
    expect(parseCsvRows("a,b,c\r\n1,2,3\r\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles a quoted field with an embedded comma", () => {
    expect(parseCsvRows('a,"b,c",d\r\n')).toEqual([["a", "b,c", "d"]]);
  });

  it("handles a quoted field with an embedded newline", () => {
    expect(parseCsvRows('a,"line1\nline2",c\r\n')).toEqual([["a", "line1\nline2", "c"]]);
  });

  it("handles doubled-quote escaping", () => {
    expect(parseCsvRows('a,"say ""hi""",c\r\n')).toEqual([["a", 'say "hi"', "c"]]);
  });

  it("yields an empty row ([]) for a genuinely blank physical line", () => {
    expect(parseCsvRows("a,b\r\n\r\nc,d\r\n")).toEqual([["a", "b"], [], ["c", "d"]]);
  });

  it("does not treat a line of empty fields as blank", () => {
    expect(parseCsvRows("a,b\r\n,\r\n")).toEqual([
      ["a", "b"],
      ["", ""],
    ]);
  });

  it("recognises a quote only at the start of a field, in any column", () => {
    expect(parseCsvRows('x,"second field",y\r\n')).toEqual([["x", "second field", "y"]]);
  });

  it("handles a file with no trailing newline", () => {
    expect(parseCsvRows("a,b")).toEqual([["a", "b"]]);
  });

  it("handles bare LF line endings", () => {
    expect(parseCsvRows("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("dictReader", () => {
  it("zips rows against the header and skips blank lines", () => {
    const { fieldnames, rows } = dictReader("title,abstract\r\nFoo,Bar\r\n\r\nBaz,Qux\r\n");
    expect(fieldnames).toEqual(["title", "abstract"]);
    expect(rows).toEqual([
      { title: "Foo", abstract: "Bar" },
      { title: "Baz", abstract: "Qux" },
    ]);
  });

  it("fills a short row's missing trailing keys with null", () => {
    const { rows } = dictReader("a,b,c\r\n1\r\n");
    expect(rows).toEqual([{ a: "1", b: null, c: null }]);
  });
});

describe("stripBom", () => {
  it("removes a leading UTF-8 BOM character", () => {
    expect(stripBom(`${"﻿"}a,b`)).toBe("a,b");
  });

  it("leaves text without a BOM untouched", () => {
    expect(stripBom("a,b")).toBe("a,b");
  });
});

describe("csvLine / writeDictCsv", () => {
  it("quotes a field containing a comma, quote, or newline", () => {
    expect(csvLine(["a", "b,c", 'd"e', "f\ng"])).toBe('a,"b,c","d""e","f\ng"\r\n');
  });

  it("round-trips through parseCsvRows", () => {
    const text = writeDictCsv(
      ["title", "abstract"],
      [{ title: "Foo, Bar", abstract: 'He said "hi"' }],
    );
    const parsed = parseCsvRows(text);
    expect(parsed).toEqual([
      ["title", "abstract"],
      ["Foo, Bar", 'He said "hi"'],
    ]);
  });
});
