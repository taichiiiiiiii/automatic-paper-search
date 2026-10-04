import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchDeepManifestFile,
  fetchLineageQualityManifest,
  fetchPilotIndex,
} from "../../lib/data-lineage";

function mockFetchOnce(
  body: unknown,
  init?: { ok?: boolean; status?: number; headers?: Record<string, string> },
): void {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  const headers = init?.headers ?? {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      headers: { get: (name: string) => headers[name] ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validQualityManifest = {
  schema_version: "lineage-quality-v1",
  as_of: "2026-08-30T00:00:00Z",
  audit_version: "audit-v1",
  collections: [],
};

describe("fetchLineageQualityManifest", () => {
  it("returns ok for a well-formed manifest", async () => {
    mockFetchOnce(validQualityManifest);
    const result = await fetchLineageQualityManifest();
    expect(result).toEqual({ status: "ok", data: validQualityManifest });
  });

  it("returns a distinct error state on HTTP failure", async () => {
    mockFetchOnce(null, { ok: false, status: 404 });
    const result = await fetchLineageQualityManifest();
    expect(result.status).toBe("error");
  });

  it("returns a distinct error state on schema mismatch (not an empty manifest)", async () => {
    mockFetchOnce({ schema_version: "lineage-quality-v1", collections: [] });
    const result = await fetchLineageQualityManifest();
    expect(result.status).toBe("error");
  });
});

describe("fetchDeepManifestFile", () => {
  const validManifest = {
    schema_version: "deep-manifest-v1",
    conference: "iclr-2026",
    generated_at: "2026-08-30T00:00:00Z",
    entries: [],
  };

  it("fetches /<conf>/deep-manifest.json", async () => {
    mockFetchOnce(validManifest);
    const result = await fetchDeepManifestFile("iclr-2026");
    expect(fetch).toHaveBeenCalledWith("/iclr-2026/deep-manifest.json", { cache: "no-cache" });
    expect(result).toEqual({ status: "ok", data: validManifest });
  });

  it("rejects an unsafe slug without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchDeepManifestFile("../../etc/passwd");
    expect(result.status).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fetchPilotIndex", () => {
  it("accepts the current empty published shape", async () => {
    mockFetchOnce({ schema_version: "lineage-pilot-index-v1", entries: [] });
    const result = await fetchPilotIndex();
    expect(result).toEqual({
      status: "ok",
      data: { schema_version: "lineage-pilot-index-v1", entries: [] },
    });
  });

  it("rejects an oversized declared Content-Length before parsing", async () => {
    mockFetchOnce(
      { schema_version: "lineage-pilot-index-v1", entries: [] },
      { headers: { "content-length": String(256 * 1024 + 1) } },
    );
    const result = await fetchPilotIndex();
    expect(result.status).toBe("error");
  });
});
