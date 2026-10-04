// Ported 1:1 from worker/request-id.test.mjs.

import { describe, expect, it } from "vitest";
import {
  createRequestId,
  dispatchInputs,
  isRequestId,
  REQUEST_ID_PATTERN,
} from "../../src/lib/request-id.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = `theme-${UUID}`;

describe("request-id", () => {
  it("creates a namespaced ID from UUID v4", () =>
    expect(createRequestId(() => UUID)).toBe(REQUEST_ID));
  it("generated ID satisfies the public pattern", () =>
    expect(REQUEST_ID_PATTERN.test(REQUEST_ID)).toBe(true));
  it("recognises a valid generated ID", () => expect(isRequestId(REQUEST_ID)).toBe(true));
  it("rejects blank IDs", () => expect(isRequestId("")).toBe(false));
  it("rejects IDs without namespace", () => expect(isRequestId(UUID)).toBe(false));
  it("rejects non-v4 UUIDs", () =>
    expect(isRequestId("theme-123e4567-e89b-12d3-a456-426614174000")).toBe(false));
  it("rejects every JavaScript line terminator after an otherwise valid ID", () => {
    for (const terminator of ["\n", "\r", " ", " "]) {
      expect(REQUEST_ID_PATTERN.test(`${REQUEST_ID}${terminator}`)).toBe(false);
      expect(isRequestId(`${REQUEST_ID}${terminator}`)).toBe(false);
    }
  });
  it("rejects uppercase IDs", () => expect(isRequestId(REQUEST_ID.toUpperCase())).toBe(false));
  it("create rejects malformed UUID provider output", () =>
    expect(() => createRequestId(() => "bad")).toThrow());
  it("dispatch input carries theme and request_id", () => {
    expect(dispatchInputs(" Vision Transformer ", REQUEST_ID)).toEqual({
      theme: "Vision Transformer",
      request_id: REQUEST_ID,
    });
  });
  it("dispatch input requires a theme", () =>
    expect(() => dispatchInputs(" ", REQUEST_ID)).toThrow());
  it("dispatch input requires a valid ID", () =>
    expect(() => dispatchInputs("RAG", "bad")).toThrow());
});
