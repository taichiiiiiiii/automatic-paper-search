import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsonComments } from "./jsonc.js";

describe("stripJsonComments / parseJsonc", () => {
  it("strips a line comment", () => {
    expect(stripJsonComments('{"a": 1} // trailing\n')).toBe('{"a": 1} \n');
  });

  it("strips a block comment", () => {
    expect(stripJsonComments('{"a": /* inline */ 1}')).toBe('{"a":  1}');
  });

  it("does not treat // inside a string as a comment", () => {
    const source = '{"url": "https://example.com/a"}';
    expect(stripJsonComments(source)).toBe(source);
    expect(parseJsonc(source)).toEqual({ url: "https://example.com/a" });
  });

  it("does not treat an escaped quote as closing the string", () => {
    const source = '{"a": "has \\" quote // not a comment"}';
    expect(parseJsonc(source)).toEqual({ a: 'has " quote // not a comment' });
  });

  it("parses a realistic wrangler.jsonc shape with leading comments", () => {
    const source = `{
      // header comment
      "name": "x", // trailing comment
      /* block */
      "vars": { "A": "b" }
    }`;
    expect(parseJsonc(source)).toEqual({ name: "x", vars: { A: "b" } });
  });
});
