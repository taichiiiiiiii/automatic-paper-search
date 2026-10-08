/**
 * SCR-20 had no existing viewer test (safety-contracts.md lists "NONE"
 * for `docs/assets/app.js readPilotLineageIndex`); this is the new
 * bounded-read contract test the P2 port adds.
 */
import { describe, expect, it } from "vitest";
import { readBoundedJson } from "../../lib/catalog-fetch";

function fixedBodyResponse(bytes: Uint8Array, headers: Record<string, string> = {}) {
  let offset = 0;
  return {
    ok: true,
    redirected: false,
    url: "https://example.test/lineage-pilot-index-v1.json",
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.byteLength) return { done: true, value: undefined };
          const chunk = bytes.slice(offset, offset + 16);
          offset += chunk.byteLength;
          return { done: false, value: chunk };
        },
        cancel: async () => {},
      }),
    },
  };
}

const okJson = { schema_version: "lineage-pilot-index-v1", entries: [] };
const okBytes = new TextEncoder().encode(JSON.stringify(okJson));

describe("readBoundedJson", () => {
  it("parses a well-formed, within-budget response", async () => {
    const result = await readBoundedJson(fixedBodyResponse(okBytes), { maxBytes: 1024 });
    expect(result).toEqual(okJson);
  });

  it("fails closed when the response was redirected", async () => {
    const response = { ...fixedBodyResponse(okBytes), redirected: true };
    expect(await readBoundedJson(response, { maxBytes: 1024 })).toBeNull();
  });

  it("fails closed when the response resolves to an unexpected URL", async () => {
    const response = fixedBodyResponse(okBytes);
    expect(
      await readBoundedJson(response, {
        maxBytes: 1024,
        expectedUrl: "https://example.test/other.json",
      }),
    ).toBeNull();
  });

  it("fails closed when the declared Content-Length exceeds the cap", async () => {
    const response = fixedBodyResponse(okBytes, { "content-length": String(10 * 1024 * 1024) });
    expect(await readBoundedJson(response, { maxBytes: 1024 })).toBeNull();
  });

  it("fails closed when the body (lying about its length, or none declared) exceeds the cap while streaming", async () => {
    const big = new Uint8Array(2048).fill(65);
    const response = fixedBodyResponse(big);
    expect(await readBoundedJson(response, { maxBytes: 100 })).toBeNull();
  });

  it("fails closed on invalid JSON", async () => {
    const response = fixedBodyResponse(new TextEncoder().encode("not json"));
    expect(await readBoundedJson(response, { maxBytes: 1024 })).toBeNull();
  });

  it("fails closed on an HTTP error response", async () => {
    const response = { ...fixedBodyResponse(okBytes), ok: false };
    expect(await readBoundedJson(response, { maxBytes: 1024 })).toBeNull();
  });
});
