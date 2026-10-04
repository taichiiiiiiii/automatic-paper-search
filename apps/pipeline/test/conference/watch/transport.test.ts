/**
 * Port of `test_conference_watch_openreview.py`'s `SecurePinnedTransport`
 * cases (CNF-24, docs/migration/safety-contracts.md). Like the Python
 * suite, every test here injects a fake resolver/raw-transport — no real
 * socket is touched. (P4 review round 2, MEDIUM-3: the private-address
 * DNS-rejection tests used to omit `transport`, which meant a passing
 * mutant on the `isPublicAddress` gate would fall through to the REAL
 * default `NodeHttpsTransport` and attempt an actual connection to
 * 10.0.0.5 / 100.64.0.1 from inside a unit test. Both now inject a
 * recording fake transport and assert `request()` is never called, and a
 * dedicated netguard test below spies on `node:https`'s `request` to
 * fail loudly if anything in this file ever reaches it.)
 */
import * as https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

// `node:https`'s native namespace is not configurable, so `vi.spyOn`
// cannot redefine a property on it directly (ESM module namespaces are
// frozen). Replacing the module with a plain (spread) object via
// `vi.mock` makes every export a configurable, writable property — the
// same pattern `collect/state/atomic.test.ts` uses for `node:fs`.
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return { ...actual };
});

import { makeFetchLimits } from "../../../src/conference/watch/models.js";
import {
  type DNSResolver,
  isPublicAddress,
  pinnedLookup,
  type RawResponse,
  type RawTransport,
  SecurePinnedTransport,
  TransportError,
  validateFixedEndpoint,
} from "../../../src/conference/watch/transport.js";

function fakeResolver(addresses: string[]): DNSResolver {
  return { resolve: async () => addresses };
}

/** A `RawTransport` whose `request()` must never be called — fails the test immediately if it is. */
function unreachableTransport(): RawTransport & { calls: number } {
  const t = {
    supportsIpPinning: true as const,
    calls: 0,
    request: async () => {
      t.calls += 1;
      throw new Error("RawTransport.request() must never be called for a rejected private address");
    },
  };
  return t;
}

const clock = { monotonicMs: () => Date.now() };

// Netguard: if ANY test in this file (or a regression in the library code)
// ever reaches Node's real `https.request`, fail loudly instead of
// silently attempting a real socket from inside the test suite.
afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("pinnedLookup (M6)", () => {
  it("replies with an array of {address,family} when called with {all:true} (Node 22 autoSelectFamily)", () => {
    const lookup = pinnedLookup("93.184.216.34");
    const cb = vi.fn();
    lookup("api2.openreview.net", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("replies with the legacy (err, address, family) shape when all is not set", () => {
    const lookup = pinnedLookup("93.184.216.34");
    const cb = vi.fn();
    lookup("api2.openreview.net", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("always resolves to the pinned address regardless of the hostname asked for", () => {
    const lookup = pinnedLookup("93.184.216.34");
    const cb = vi.fn();
    lookup("totally-different-host.example", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("uses family 6 for an IPv6 pin", () => {
    const lookup = pinnedLookup("2606:4700:4700::1111");
    const cb = vi.fn();
    lookup("host", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "2606:4700:4700::1111", 6);
  });
});

describe("isPublicAddress (M6 — exact ipaddress.is_global port)", () => {
  it.each([
    ["8.8.8.8", true],
    ["93.184.216.34", true],
    ["10.0.0.5", false],
    ["127.0.0.1", false],
    ["169.254.1.1", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    // Ranges the old string-prefix check missed entirely:
    ["100.64.0.1", false], // shared address space (CGN), 100.64.0.0/10
    ["100.63.255.255", true], // just outside that range
    ["100.128.0.0", true], // just outside the other side
    ["198.18.0.1", false], // benchmarking, 198.18.0.0/15
    ["192.0.2.1", false], // TEST-NET-1
    ["198.51.100.1", false], // TEST-NET-2
    ["203.0.113.1", false], // TEST-NET-3
    ["240.0.0.1", false], // reserved, 240.0.0.0/4
    ["255.255.255.255", false],
    // The two documented 192.0.0.0/24 exceptions carved back OUT to public:
    ["192.0.0.9", true],
    ["192.0.0.10", true],
    ["192.0.0.8", false], // one below the first exception: still private
    ["192.0.0.11", false], // one above the second exception: still private
  ])("IPv4 %s -> %s", (addr, expected) => {
    expect(isPublicAddress(addr)).toBe(expected);
  });

  it.each([
    ["2606:4700:4700::1111", true],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["fd12:3456:789a::1", false],
    ["2001:db8::1", false], // documentation range, 2001:db8::/32
    ["3fff::1", false], // RFC 9637 documentation range
    ["2001::1", false], // TEREDO, inside 2001::/23
    ["2001:1::1", true], // carved-out exception within 2001::/23
    ["2001:4:112::1", true], // carved-out exception (AMT)
    // Deprecated RFC 3879 site-local is NOT in Python's private list —
    // matching that exactly (not "improving" on it) matters for parity.
    ["fec0::1", true],
  ])("IPv6 %s -> %s", (addr, expected) => {
    expect(isPublicAddress(addr)).toBe(expected);
  });

  it("IPv4-mapped IPv6 defers to the mapped IPv4 address's own rule", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true); // global IPv4, mapped
    expect(isPublicAddress("::ffff:10.0.0.5")).toBe(false); // private IPv4, mapped
  });

  it("rejects garbage that is neither a valid IPv4 nor IPv6 address", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});

describe("SecurePinnedTransport (CNF-24)", () => {
  const limits = makeFetchLimits();

  it("rejects private-address DNS resolution (MEDIUM-3: never falls through to the real transport)", async () => {
    const raw = unreachableTransport();
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["10.0.0.5"]),
      transport: raw,
      ...clock,
    });
    await expect(
      transport.get("https://api2.openreview.net/notes", {
        params: {},
        limits,
        deadlineMs: Date.now() + 10_000,
      }),
    ).rejects.toMatchObject({ code: "CONF_SOURCE_HTTP_ERROR" });
    expect(raw.calls).toBe(0);
  });

  it("rejects DNS resolution to the shared-address-space (100.64.0.0/10) CGN range (MEDIUM-3/M6: never falls through to the real transport)", async () => {
    // This range is NOT private/loopback/link-local by the old naive
    // check, so removing the port's exact `is_global` logic would let
    // this resolve and connect — the exact gap the review flagged as
    // "fails no test".
    const raw = unreachableTransport();
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["100.64.0.1"]),
      transport: raw,
      ...clock,
    });
    await expect(
      transport.get("https://api2.openreview.net/notes", {
        params: {},
        limits,
        deadlineMs: Date.now() + 10_000,
      }),
    ).rejects.toMatchObject({ code: "CONF_SOURCE_HTTP_ERROR" });
    expect(raw.calls).toBe(0);
  });

  it("MEDIUM-3 netguard: a rejected private address never reaches node:https even with the REAL default transport", async () => {
    const httpsRequestSpy = vi.spyOn(https, "request").mockImplementation(() => {
      throw new Error("a real https.request() must never be attempted from a unit test");
    });
    const transport = new SecurePinnedTransport({ resolver: fakeResolver(["10.0.0.5"]), ...clock });
    await expect(
      transport.get("https://api2.openreview.net/notes", {
        params: {},
        limits,
        deadlineMs: Date.now() + 10_000,
      }),
    ).rejects.toThrow(TransportError);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
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

  it("CNF-24: rejects a non-identity Content-Encoding (we never request compression and can't trust its length accounting)", async () => {
    const raw: RawTransport = {
      supportsIpPinning: true,
      request: async () => bufferedResponse(200, Buffer.from("{}"), [["content-encoding", "gzip"]]),
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

  it("CNF-24: an explicit Content-Encoding: identity is fine", async () => {
    const raw: RawTransport = {
      supportsIpPinning: true,
      request: async () =>
        bufferedResponse(200, Buffer.from('{"notes":[],"count":0}'), [
          ["content-encoding", "identity"],
        ]),
    };
    const transport = new SecurePinnedTransport({
      resolver: fakeResolver(["93.184.216.34"]),
      transport: raw,
      ...clock,
    });
    const resp = await transport.get("https://api2.openreview.net/notes", {
      params: {},
      limits,
      deadlineMs: Date.now() + 10_000,
    });
    expect(resp.statusCode).toBe(200);
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
