// Ported from worker/themes-post.test.mjs's content-type/body-size gate
// tests (API-03/04/05), isolated to the extracted bounded-body module.

import { describe, expect, it } from "vitest";
import { contentTypeAllowed, readBoundedBody } from "../../src/lib/bounded-body.js";

const MAX_BODY_BYTES = 1024;

function req(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("https://worker.test/api/themes", { method: "POST", headers, body });
}

describe("contentTypeAllowed", () => {
  it("accepts application/json", () => {
    expect(contentTypeAllowed(req(null, { "content-type": "application/json" }))).toBe(true);
  });
  it("accepts application/json with a charset parameter", () => {
    expect(
      contentTypeAllowed(req(null, { "content-type": "application/json; charset=utf-8" })),
    ).toBe(true);
  });
  it("rejects a missing content-type header", () => {
    expect(contentTypeAllowed(req(null))).toBe(false);
  });
  it("rejects text/plain", () => {
    expect(contentTypeAllowed(req(null, { "content-type": "text/plain" }))).toBe(false);
  });
  it("rejects application/json-seq", () => {
    expect(contentTypeAllowed(req(null, { "content-type": "application/json-seq" }))).toBe(false);
  });
  it("rejects application/jsonp", () => {
    expect(contentTypeAllowed(req(null, { "content-type": "application/jsonp" }))).toBe(false);
  });
});

describe("readBoundedBody", () => {
  it("rejects a declared content-length over 1KB without reading the body", async () => {
    let pulled = false;
    const stream = new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ theme: "x".repeat(2000) })));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    // duplex is required by undici for a streamed body but missing from
    // workers-types' RequestInit, so the whole init object is cast through
    // unknown instead of suppressing the error inline.
    const request = new Request("https://worker.test/api/themes", {
      method: "POST",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      body: stream,
      duplex: "half",
    } as unknown as RequestInit);
    const result = await readBoundedBody(request, MAX_BODY_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
    expect(pulled).toBe(false);
  });

  it("rejects a body that streams past 1KB even without content-length", async () => {
    const oversized = JSON.stringify({ theme: "x".repeat(2000) });
    const result = await readBoundedBody(req(oversized), MAX_BODY_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  it("accepts a body exactly at the 1KB boundary", async () => {
    const base = JSON.stringify({ theme: "Vision Transformer", pad: "" });
    const padLen = MAX_BODY_BYTES - base.length;
    const body = JSON.stringify({ theme: "Vision Transformer", pad: "x".repeat(padLen) });
    expect(body.length).toBe(MAX_BODY_BYTES);
    const result = await readBoundedBody(
      req(body, { "content-length": String(body.length) }),
      MAX_BODY_BYTES,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid content-length header", async () => {
    const result = await readBoundedBody(
      req("{}", { "content-length": "not-a-number" }),
      MAX_BODY_BYTES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("returns empty text for a null body", async () => {
    const result = await readBoundedBody(
      new Request("https://worker.test/api/themes", { method: "GET" }),
      MAX_BODY_BYTES,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("");
  });
});
