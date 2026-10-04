/**
 * Port of `test_conference_watch_openreview.py`'s `SecurePinnedTransport`
 * cases (CNF-24, docs/migration/safety-contracts.md). Like the Python
 * suite, every test here injects a fake resolver/raw-transport — no real
 * socket is touched.
 */
import { describe, expect, it, vi } from "vitest";
import { makeFetchLimits } from "../../../src/conference/watch/models.js";
import {
  type DNSResolver,
  type RawResponse,
  type RawTransport,
  SecurePinnedTransport,
  TransportError,
  validateFixedEndpoint,
} from "../../../src/conference/watch/transport.js";

function fakeResolver(addresses: string[]): DNSResolver {
  return { resolve: async () => addresses };
}

const clock = { monotonicMs: () => Date.now() };

function bufferedResponse(
  status: number,
  body: Buffer,
  headers: [string, string][] = [],
): RawResponse {
  let delivered = false;
  return {
    status,
    headers,
    read: async () => {
      if (delivered) return Buffer.alloc(0);
      delivered = true;
      return body;
    },
    close: () => {},
  };
}

describe("validateFixedEndpoint (CNF-24)", () => {
  it("accepts the exact HTTPS api2 /notes endpoint", () => {
    expect(validateFixedEndpoint("https://api2.openreview.net/notes")).toEqual({
      hostname: "api2.openreview.net",
      path: "/notes",
    });
  });

  it("rejects an arbitrary authority", () => {
    expect(() => validateFixedEndpoint("https://evil.example.com/notes")).toThrow(TransportError);
  });

  it("rejects http (non-TLS)", () => {
    expect(() => validateFixedEndpoint("http://api2.openreview.net/notes")).toThrow(TransportError);
  });

  it("rejects a non-default port, userinfo, query, or fragment", () => {
    expect(() => validateFixedEndpoint("https://api2.openreview.net:8443/notes")).toThrow(
      TransportError,
    );
    expect(() => validateFixedEndpoint("https://user:pass@api2.openreview.net/notes")).toThrow(
      TransportError,
    );
    expect(() => validateFixedEndpoint("https://api2.openreview.net/notes?x=1")).toThrow(
      TransportError,
    );
    expect(() => validateFixedEndpoint("https://api2.openreview.net/notes#frag")).toThrow(
      TransportError,
    );
  });
});

describe("SecurePinnedTransport (CNF-24)", () => {
  const limits = makeFetchLimits();

  it("rejects private-address DNS resolution", async () => {
    const transport = new SecurePinnedTransport({ resolver: fakeResolver(["10.0.0.5"]), ...clock });
    await expect(
      transport.get("https://api2.openreview.net/notes", {
        params: {},
        limits,
        deadlineMs: Date.now() + 10_000,
      }),
    ).rejects.toThrow(TransportError);
  });

  it("rejects a 3xx redirect status without following it", async () => {
    const raw: RawTransport = {
      supportsIpPinning: true,
      request: async () => bufferedResponse(302, Buffer.alloc(0)),
    };
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["93.184.216.34"]),
      transport: raw,
      ...clock,
    });
    await expect(
      transport.get("https://api2.openreview.net/notes", {
        params: {},
        limits,
        deadlineMs: Date.now() + 10_000,
      }),
    ).rejects.toThrow(TransportError);
  });

  it("retries a 429 then succeeds", async () => {
    let calls = 0;
    const raw: RawTransport = {
      supportsIpPinning: true,
      request: async () => {
        calls += 1;
        if (calls === 1) return bufferedResponse(429, Buffer.alloc(0));
        return bufferedResponse(200, Buffer.from('{"notes":[],"count":0}'));
      },
    };
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["93.184.216.34"]),
      transport: raw,
      sleep: async () => {},
      ...clock,
    });
    const resp = await transport.get("https://api2.openreview.net/notes", {
      params: {},
      limits,
      deadlineMs: Date.now() + 10_000,
    });
    expect(resp.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("does not retry a malformed response (Content-Length mismatch -> SOURCE_PARTIAL, no second call)", async () => {
    let calls = 0;
    const raw: RawTransport = {
      supportsIpPinning: true,
      request: async () => {
        calls += 1;
        return bufferedResponse(200, Buffer.from("short"), [["content-length", "9999"]]);
      },
    };
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["93.184.216.34"]),
      transport: raw,
      ...clock,
    });
    await expect(
      transport.get("https://api2.openreview.net/notes", {
        params: {},
        limits,
        deadlineMs: Date.now() + 10_000,
      }),
    ).rejects.toThrow(TransportError);
    expect(calls).toBe(1);
  });

  it("rejects an oversized response declared via Content-Length", async () => {
    const raw: RawTransport = {
      supportsIpPinning: true,
      request: async () =>
        bufferedResponse(200, Buffer.alloc(10), [
          ["content-length", String(limits.maxResponseBytes + 1)],
        ]),
    };
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["93.184.216.34"]),
      transport: raw,
      ...clock,
    });
    await expect(
      transport.get("https://api2.openreview.net/notes", {
        params: {},
        limits,
        deadlineMs: Date.now() + 10_000,
      }),
    ).rejects.toThrow(TransportError);
  });

  it("discards and retries a failed response body read", async () => {
    let calls = 0;
    const raw: RawTransport = {
      supportsIpPinning: true,
      request: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 200,
            headers: [],
            read: async () => {
              throw new Error("socket reset");
            },
            close: () => {},
          };
        }
        return bufferedResponse(200, Buffer.from('{"notes":[],"count":0}'));
      },
    };
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["93.184.216.34"]),
      transport: raw,
      sleep: async () => {},
      ...clock,
    });
    const resp = await transport.get("https://api2.openreview.net/notes", {
      params: {},
      limits,
      deadlineMs: Date.now() + 10_000,
    });
    expect(resp.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("exhausts the deadline as a timeout", async () => {
    const raw: RawTransport = { supportsIpPinning: true, request: vi.fn() };
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["93.184.216.34"]),
      transport: raw,
      ...clock,
    });
    await expect(
      transport.get("https://api2.openreview.net/notes", {
        params: {},
        limits,
        deadlineMs: Date.now() - 1,
      }),
    ).rejects.toThrow(TransportError);
  });
});
