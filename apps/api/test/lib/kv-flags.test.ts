// New tests for §4.2-6 (origin allowlist) and §4.2-7 (accept-stop flag).

import { describe, expect, it } from "vitest";
import { KV_KEY_ACCEPTING, KV_KEY_ORIGIN_ALLOWLIST } from "../../src/config.js";
import { isAccepting, resolveOrigin } from "../../src/lib/kv-flags.js";

function fakeKv(store: Record<string, string> = {}) {
  return {
    async get(key: string) {
      return key in store ? store[key]! : null;
    },
  };
}

function throwingKv() {
  return {
    async get(): Promise<string | null> {
      throw new Error("KV unavailable");
    },
  };
}

function req(origin?: string) {
  return new Request("https://worker.test/api/themes", {
    method: "POST",
    headers: origin ? { origin } : {},
  });
}

describe("resolveOrigin", () => {
  it("matches an origin present in the allowlist", async () => {
    const kv = fakeKv({
      [KV_KEY_ORIGIN_ALLOWLIST]: JSON.stringify(["https://a.test", "https://b.test"]),
    });
    const result = await resolveOrigin(req("https://b.test"), kv);
    expect(result).toEqual({ ok: true, origin: "https://b.test" });
  });

  it("rejects a mismatched origin", async () => {
    const kv = fakeKv({ [KV_KEY_ORIGIN_ALLOWLIST]: JSON.stringify(["https://a.test"]) });
    expect((await resolveOrigin(req("https://evil.test"), kv)).ok).toBe(false);
  });

  it("rejects a missing Origin header", async () => {
    const kv = fakeKv({ [KV_KEY_ORIGIN_ALLOWLIST]: JSON.stringify(["https://a.test"]) });
    expect((await resolveOrigin(req(), kv)).ok).toBe(false);
  });

  it("rejects when the allowlist key is missing", async () => {
    expect((await resolveOrigin(req("https://a.test"), fakeKv())).ok).toBe(false);
  });

  it("rejects when the allowlist is unreadable (KV throws)", async () => {
    expect((await resolveOrigin(req("https://a.test"), throwingKv())).ok).toBe(false);
  });

  it("rejects invalid JSON in the allowlist", async () => {
    const kv = fakeKv({ [KV_KEY_ORIGIN_ALLOWLIST]: "not json" });
    expect((await resolveOrigin(req("https://a.test"), kv)).ok).toBe(false);
  });

  it("rejects a non-array allowlist value", async () => {
    const kv = fakeKv({ [KV_KEY_ORIGIN_ALLOWLIST]: JSON.stringify({ origin: "https://a.test" }) });
    expect((await resolveOrigin(req("https://a.test"), kv)).ok).toBe(false);
  });

  it("requires an exact match, not a prefix/substring", async () => {
    const kv = fakeKv({ [KV_KEY_ORIGIN_ALLOWLIST]: JSON.stringify(["https://a.test"]) });
    expect((await resolveOrigin(req("https://a.test.evil.com"), kv)).ok).toBe(false);
  });
});

describe("isAccepting", () => {
  it("true only for the exact string 'true'", async () => {
    expect(await isAccepting(fakeKv({ [KV_KEY_ACCEPTING]: "true" }))).toBe(true);
  });

  it("false for any other value", async () => {
    expect(await isAccepting(fakeKv({ [KV_KEY_ACCEPTING]: "True" }))).toBe(false);
    expect(await isAccepting(fakeKv({ [KV_KEY_ACCEPTING]: "1" }))).toBe(false);
    expect(await isAccepting(fakeKv({ [KV_KEY_ACCEPTING]: "false" }))).toBe(false);
  });

  it("false when the flag is missing (fail closed)", async () => {
    expect(await isAccepting(fakeKv())).toBe(false);
  });

  it("false when KV read throws (fail closed)", async () => {
    expect(await isAccepting(throwingKv())).toBe(false);
  });
});
