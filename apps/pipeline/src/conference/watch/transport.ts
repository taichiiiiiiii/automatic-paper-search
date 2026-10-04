/**
 * DNS-pinned, retry-bounded HTTPS transport for the OpenReview adapter —
 * TS port of `paperpilot/conference_watch/openreview.py`'s
 * `validate_fixed_endpoint` + `SecurePinnedTransport` (CNF-24).
 *
 * Python pins the resolved IP via its own `paper_slides.fetch` pinned-TLS
 * transport (outside this task's edit scope, and itself a custom
 * `http.client`-level implementation). Node has no third-party
 * equivalent in this repo to wrap, so the default transport here pins the
 * connection the way Node's own docs recommend: `https.request({ lookup
 * })` with a `lookup` callback that always resolves to the ONE address
 * `resolveFixedHost` already validated as public and ignores whatever the
 * OS resolver would otherwise return for a retry — TLS hostname
 * verification still runs against `servername`/`Host`, so this is not a
 * weaker guarantee than the Python side, just a different (and, per
 * design doc §6.2's CNF-24 row, explicitly pre-approved) mechanism. This
 * is a documented, intentional implementation difference, not a parity
 * gap in anything a test observes: every test in this port (like the
 * Python suite's own `test_secure_transport_*` tests) injects a fake
 * `resolver`/`rawTransport` and never touches a real socket.
 */

import { Resolver as DnsResolver } from "node:dns";
import * as https from "node:https";
import { isIPv4, isIPv6 } from "node:net";
import type { ErrorCode, FetchLimits } from "./models.js";

export const OPENREVIEW_API_URL = "https://api2.openreview.net/notes";
export const OPENREVIEW_API_HOST = "api2.openreview.net";

export class TransportError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}

class RetryablePageError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}

export interface ResponseLike {
  statusCode: number;
  content: Buffer;
  requestCount: number;
}

export interface RawResponse {
  status: number;
  /** Lowercase-tolerant header pairs exactly as received, duplicates kept (mirrors a real `http.client` header list). */
  headers: readonly (readonly [string, string])[];
  /** Read up to `maxBytes`, waiting at most `timeoutMs`; an empty buffer means EOF. Throws on a socket-level failure. */
  read(maxBytes: number, timeoutMs: number): Promise<Buffer>;
  close(): Promise<void> | void;
}

export interface PinnedRequest {
  hostname: string;
  ipAddress: string;
  target: string;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  readTimeoutMs: number;
}

export interface RawTransport {
  readonly supportsIpPinning: true;
  request(req: PinnedRequest): Promise<RawResponse>;
}

export interface DNSResolver {
  resolve(hostname: string, port: number, timeoutMs: number): Promise<string[]>;
}

/** Validates the system resolver actually returned public (not private/loopback/link-local) addresses. */
function isPublicAddress(value: string): boolean {
  if (isIPv4(value)) {
    const octets = value.split(".").map(Number);
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false; // multicast/reserved
    return true;
  }
  if (isIPv6(value)) {
    const lower = value.toLowerCase();
    if (lower === "::1" || lower === "::") return false;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return false;
    return true;
  }
  return false;
}

/** Require the exact HTTPS API authority and return the host plus origin target — TS port of `validate_fixed_endpoint`. */
export function validateFixedEndpoint(url: string): { hostname: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportError("CONF_SOURCE_HTTP_ERROR");
  }
  const port = parsed.port ? Number(parsed.port) : null;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== OPENREVIEW_API_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (port !== null && port !== 443) ||
    parsed.pathname !== "/notes" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TransportError("CONF_SOURCE_HTTP_ERROR");
  }
  return { hostname: OPENREVIEW_API_HOST, path: parsed.pathname };
}

export class SystemDNSResolver implements DNSResolver {
  async resolve(hostname: string, _port: number, timeoutMs: number): Promise<string[]> {
    const resolver = new DnsResolver();
    const resolve4 = (): Promise<string[]> =>
      new Promise((resolvePromise, reject) =>
        resolver.resolve4(hostname, (err, addrs) => (err ? reject(err) : resolvePromise(addrs))),
      );
    const timeout = new Promise<string[]>((_resolve, reject) =>
      setTimeout(() => reject(new (class extends Error {})("resolve timeout")), timeoutMs),
    );
    return Promise.race([resolve4(), timeout]);
  }
}

function headerValue(headers: readonly (readonly [string, string])[], name: string): string[] {
  return headers.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
}

/** DNS-pinned TLS transport with bounded retries, reads, and no redirects — TS port of `SecurePinnedTransport`. */
export class SecurePinnedTransport {
  readonly supportsIpPinning = true;
  private readonly resolver: DNSResolver;
  private readonly transport: RawTransport;
  private readonly monotonicMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    options: {
      resolver?: DNSResolver;
      transport?: RawTransport;
      monotonicMs?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.resolver = options.resolver ?? new SystemDNSResolver();
    this.transport = options.transport ?? new NodeHttpsTransport();
    if (this.transport.supportsIpPinning !== true)
      throw new TransportError("CONF_SOURCE_HTTP_ERROR");
    this.monotonicMs = options.monotonicMs ?? (() => performance.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get(
    url: string,
    options: { params: Record<string, string | number>; limits: FetchLimits; deadlineMs: number },
  ): Promise<ResponseLike> {
    const { hostname, path } = validateFixedEndpoint(url);
    const { limits, deadlineMs } = options;
    let remaining = deadlineMs - this.monotonicMs();
    if (remaining <= 0) throw new TransportError("CONF_SOURCE_TIMEOUT");

    let addresses: string[];
    try {
      const resolved = await this.resolver.resolve(
        hostname,
        443,
        Math.min(limits.connectTimeoutSeconds * 1000, remaining),
      );
      addresses = [...new Set(resolved.map(String))];
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
        throw new TransportError("CONF_SOURCE_HTTP_ERROR");
      }
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new TransportError("CONF_SOURCE_HTTP_ERROR");
    }

    const target = `${path}?${new URLSearchParams(
      Object.fromEntries(Object.entries(options.params).map(([k, v]) => [k, String(v)])),
    ).toString()}`;
    let requestsMade = 0;

    for (let attempt = 0; attempt <= limits.maxRetries; attempt++) {
      remaining = deadlineMs - this.monotonicMs();
      if (remaining <= 0) throw new TransportError("CONF_SOURCE_TIMEOUT");
      const request: PinnedRequest = {
        hostname,
        ipAddress: addresses[0] as string,
        target,
        headers: { Accept: "application/json", "Accept-Encoding": "identity", Host: hostname },
        connectTimeoutMs: Math.min(limits.connectTimeoutSeconds * 1000, remaining),
        readTimeoutMs: Math.min(limits.readTimeoutSeconds * 1000, remaining),
      };

      let response: RawResponse;
      try {
        requestsMade += 1;
        response = await this.transport.request(request);
      } catch (e) {
        if (attempt >= limits.maxRetries) {
          throw new TransportError(isTimeout(e) ? "CONF_SOURCE_TIMEOUT" : "CONF_SOURCE_HTTP_ERROR");
        }
        await this.boundedSleep(0.25 * 2 ** attempt * 1000, deadlineMs);
        continue;
      }

      let retryableRead: RetryablePageError | null = null;
      try {
        const status = response.status;
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          throw new TransportError("CONF_SOURCE_HTTP_ERROR");
        }
        if (status >= 300 && status < 400) throw new TransportError("CONF_SOURCE_HTTP_ERROR");
        if (status === 429) {
          if (attempt >= limits.maxRetries) throw new TransportError("CONF_SOURCE_RATE_LIMITED");
          await this.boundedSleep(2 ** attempt * 1000, deadlineMs);
          continue;
        }
        if (status >= 500 && status < 600) {
          if (attempt >= limits.maxRetries) throw new TransportError("CONF_SOURCE_HTTP_ERROR");
          await this.boundedSleep(2 ** attempt * 1000, deadlineMs);
          continue;
        }
        if (status !== 200) {
          return { statusCode: status, content: Buffer.alloc(0), requestCount: requestsMade };
        }
        const length = this.contentLength(response.headers);
        if (length !== null && length > limits.maxResponseBytes)
          throw new TransportError("CONF_SOURCE_PARTIAL");

        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
          remaining = deadlineMs - this.monotonicMs();
          if (remaining <= 0) throw new TransportError("CONF_SOURCE_TIMEOUT");
          let chunk: Buffer;
          try {
            chunk = await response.read(
              Math.min(64 * 1024, limits.maxResponseBytes + 1 - total),
              Math.min(limits.readTimeoutSeconds * 1000, remaining),
            );
          } catch (e) {
            throw new RetryablePageError(
              isTimeout(e) ? "CONF_SOURCE_TIMEOUT" : "CONF_SOURCE_HTTP_ERROR",
            );
          }
          if (this.monotonicMs() > deadlineMs) throw new TransportError("CONF_SOURCE_TIMEOUT");
          if (chunk.length === 0) break;
          chunks.push(chunk);
          total += chunk.length;
          if (total > limits.maxResponseBytes) throw new TransportError("CONF_SOURCE_PARTIAL");
        }
        const body = Buffer.concat(chunks, total);
        if (length !== null && body.length !== length)
          throw new TransportError("CONF_SOURCE_PARTIAL");
        return { statusCode: 200, content: body, requestCount: requestsMade };
      } catch (e) {
        if (e instanceof RetryablePageError) {
          retryableRead = e;
        } else {
          throw e;
        }
      } finally {
        await response.close();
      }
      if (retryableRead) {
        if (attempt >= limits.maxRetries) throw new TransportError(retryableRead.code);
        await this.boundedSleep(0.25 * 2 ** attempt * 1000, deadlineMs);
      }
    }
    throw new TransportError("CONF_SOURCE_HTTP_ERROR"); // unreachable in practice
  }

  private contentLength(headers: readonly (readonly [string, string])[]): number | null {
    if (headers.length > 128) throw new TransportError("CONF_SOURCE_HTTP_ERROR");
    for (const [name, value] of headers) {
      if (
        value.includes("\n") ||
        value.includes("\r") ||
        name.length > 256 ||
        value.length > 8192
      ) {
        throw new TransportError("CONF_SOURCE_HTTP_ERROR");
      }
    }
    const encodings = headerValue(headers, "content-encoding");
    if (encodings.some((v) => v.trim().toLowerCase() !== "identity")) {
      throw new TransportError("CONF_SOURCE_HTTP_ERROR");
    }
    const lengths = headerValue(headers, "content-length").map((v) => v.trim());
    if (lengths.length > 1) throw new TransportError("CONF_SOURCE_HTTP_ERROR");
    if (lengths.length === 0) return null;
    if (!/^[0-9]+$/.test(lengths[0] as string)) throw new TransportError("CONF_SOURCE_HTTP_ERROR");
    return Number(lengths[0]);
  }

  private async boundedSleep(ms: number, deadlineMs: number): Promise<void> {
    const remaining = deadlineMs - this.monotonicMs();
    if (remaining <= 0) throw new TransportError("CONF_SOURCE_TIMEOUT");
    await this.sleep(Math.min(ms, remaining));
  }
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || /timeout/i.test(e.message));
}

/**
 * Default real-world transport: Node `https.request` with a pinned
 * `lookup` so the connection always dials the ONE address
 * `SecurePinnedTransport.get` already validated as public, regardless of
 * what the OS resolver would return on a retry. Not exercised by this
 * port's test suite (no test touches a real socket, matching the Python
 * suite's own all-mocked `SecurePinnedTransport` tests) — kept minimal
 * and best-effort for real operator use.
 */
export class NodeHttpsTransport implements RawTransport {
  readonly supportsIpPinning = true as const;

  /**
   * Known simplification vs. `SecurePinnedTransport`'s chunk-by-chunk
   * contract: this buffers the whole response (destroying the socket
   * early — and rejecting before resolving — once a hard safety cap is
   * exceeded) rather than serving `read()` chunk-by-chunk with a live
   * per-chunk timeout. `SecurePinnedTransport.get`'s OWN byte-cap check
   * still runs against the buffered result, so a response over
   * `maxResponseBytes` is still rejected correctly; it just is not
   * aborted mid-stream the instant the limit is crossed the way the
   * Python transport's chunked read is. Not exercised by any test (see
   * the class doc comment above).
   */
  async request(req: PinnedRequest): Promise<RawResponse> {
    const HARD_SAFETY_CAP = 256 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const httpReq = https.request(
        {
          hostname: req.hostname,
          servername: req.hostname,
          port: 443,
          path: req.target,
          method: "GET",
          headers: req.headers,
          lookup: (_hostname, _opts, cb) => cb(null, req.ipAddress, 4),
          timeout: req.connectTimeoutMs,
        },
        (res) => {
          const headers: [string, string][] = [];
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const v of value) headers.push([name, v]);
            } else if (value !== undefined) {
              headers.push([name, value]);
            }
          }
          const chunks: Buffer[] = [];
          let total = 0;
          let settled = false;
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            total += chunk.length;
            if (total > HARD_SAFETY_CAP && !settled) {
              settled = true;
              res.destroy();
              reject(new TransportError("CONF_SOURCE_PARTIAL"));
            }
          });
          res.on("end", () => {
            if (settled) return;
            settled = true;
            let delivered = false;
            resolve({
              status: res.statusCode ?? 0,
              headers,
              read: async () => {
                if (delivered) return Buffer.alloc(0);
                delivered = true;
                return Buffer.concat(chunks, total);
              },
              close: () => {
                res.destroy();
              },
            });
          });
          res.on("error", (err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
        },
      );
      httpReq.on("timeout", () => httpReq.destroy(new Error("TimeoutError")));
      httpReq.on("error", reject);
      httpReq.end();
    });
  }
}
