import { describe, expect, it } from "vitest";
import {
  DuplicateKeyError,
  StrictJsonSyntaxError,
  strictJsonLoads,
} from "../../../src/conference/watch/strictJson.js";

describe("strictJsonLoads", () => {
  it("parses ordinary JSON identically to JSON.parse", () => {
    const text = '{"a":1,"b":[1,2,3],"c":"hello\\nworld","d":null,"e":true,"f":false,"g":-1.5e10}';
    expect(strictJsonLoads(text)).toEqual(JSON.parse(text));
  });

  it("parses unicode escapes and literal unicode the same way", () => {
    const text = '"caf\\u00e9 é"';
    expect(strictJsonLoads(text)).toBe(JSON.parse(text));
  });

  it("rejects a duplicate top-level key", () => {
    expect(() => strictJsonLoads('{"a":1,"a":2}')).toThrow(DuplicateKeyError);
  });

  it("rejects a duplicate nested key", () => {
    expect(() => strictJsonLoads('{"outer":{"a":1,"a":2}}')).toThrow(DuplicateKeyError);
  });

  it("allows the same key name at different nesting levels", () => {
    expect(strictJsonLoads('{"a":{"a":1}}')).toEqual({ a: { a: 1 } });
  });

  it("rejects malformed JSON the same way JSON.parse does (as a syntax error)", () => {
    expect(() => strictJsonLoads("{not json")).toThrow(StrictJsonSyntaxError);
  });

  it("rejects trailing data", () => {
    expect(() => strictJsonLoads("{}x")).toThrow(StrictJsonSyntaxError);
  });

  it("rejects bare NaN/Infinity tokens (not part of strict JSON)", () => {
    expect(() => strictJsonLoads("NaN")).toThrow(StrictJsonSyntaxError);
    expect(() => strictJsonLoads("Infinity")).toThrow(StrictJsonSyntaxError);
  });

  it("round-trips arrays of objects", () => {
    const text = '[{"x":1},{"y":2}]';
    expect(strictJsonLoads(text)).toEqual(JSON.parse(text));
  });
});
