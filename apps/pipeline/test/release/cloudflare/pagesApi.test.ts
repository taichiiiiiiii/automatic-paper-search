/**
 * p5-plan.md §2 A4 `cf-deployment-id` / `cf-rollback`. All (verify) shapes
 * are exercised against a fake `fetchImpl` only — never the real network.
 * The secret test (apiToken never appearing anywhere observable) runs
 * for both the success and the error path, since an error message is
 * exactly the kind of place a careless `${apiToken}` interpolation would
 * leak it.
 */
import { expect, it } from "vitest";
import {
  assertCommitHashMatches,
  type CfFetchFn,
  CloudflareApiError,
  getDeploymentCommitHash,
  getProductionDeploymentId,
  pickNewest,
  rollbackDeployment,
} from "../../../src/release/cloudflare/pagesApi.js";

const SHA = "a".repeat(40);
const SECRET_TOKEN = "cf-secret-token-should-never-leak";

function listFetch(result: unknown, status = 200): CfFetchFn {
  return async () => ({ status, json: async () => ({ success: status < 300, result }) });
}

it("getProductionDeploymentId picks the newest matching deployment by created_on, not list order", async () => {
  const fetchImpl = listFetch([
    {
      id: "dep-older",
      url: "https://older.pages.dev",
      created_on: "2026-01-01T00:00:00Z",
      deployment_trigger: { metadata: { commit_hash: SHA } },
    },
    {
      id: "dep-newer",
      url: "https://newer.pages.dev",
      created_on: "2026-06-01T00:00:00Z",
      deployment_trigger: { metadata: { commit_hash: SHA } },
    },
  ]);
  const result = await getProductionDeploymentId({
    fetchImpl,
    accountId: "acct",
    project: "proj",
    apiToken: SECRET_TOKEN,
    sourceSha: SHA,
  });
  expect(result).toEqual({ deploymentId: "dep-newer", deploymentUrl: "https://newer.pages.dev" });
});

it("getProductionDeploymentId asks for an explicit page size", async () => {
  let seenUrl = "";
  const fetchImpl: CfFetchFn = async (url) => {
    seenUrl = String(url);
    return {
      status: 200,
      json: async () => ({
        success: true,
        result: [
          {
            id: "dep-1",
            url: "https://one.pages.dev",
            created_on: "2026-06-01T00:00:00Z",
            deployment_trigger: { metadata: { commit_hash: SHA } },
          },
        ],
      }),
    };
  };
  await getProductionDeploymentId({
    fetchImpl,
    accountId: "acct",
    project: "proj",
    apiToken: SECRET_TOKEN,
    sourceSha: SHA,
  });
  expect(seenUrl).toContain("/deployments?env=production&per_page=25");
});

it("getProductionDeploymentId skips a newer deploy for the same commit that is skipped or not production", async () => {
  const base = { deployment_trigger: { metadata: { commit_hash: SHA } } };
  const fetchImpl = listFetch([
    {
      ...base,
      id: "dep-good",
      url: "https://good.pages.dev",
      created_on: "2026-01-01T00:00:00Z",
      environment: "production",
      is_skipped: false,
      latest_stage: { status: "success" },
    },
    {
      ...base,
      id: "dep-skipped",
      url: "https://s.pages.dev",
      created_on: "2026-06-01T00:00:00Z",
      environment: "production",
      is_skipped: true,
      latest_stage: { status: "success" },
    },
    {
      ...base,
      id: "dep-stage-skipped",
      url: "https://ss.pages.dev",
      created_on: "2026-06-02T00:00:00Z",
      environment: "production",
      latest_stage: { status: "skipped" },
    },
    {
      ...base,
      id: "dep-preview",
      url: "https://p.pages.dev",
      created_on: "2026-06-03T00:00:00Z",
      environment: "preview",
      latest_stage: { status: "success" },
    },
  ]);
  const result = await getProductionDeploymentId({
    fetchImpl,
    accountId: "acct",
    project: "proj",
    apiToken: SECRET_TOKEN,
    sourceSha: SHA,
  });
  expect(result).toEqual({ deploymentId: "dep-good", deploymentUrl: "https://good.pages.dev" });
});

it("getProductionDeploymentId ignores deployments for a different commit", async () => {
  const fetchImpl = listFetch([
    {
      id: "dep-other",
      url: "https://other.pages.dev",
      created_on: "2026-06-01T00:00:00Z",
      deployment_trigger: { metadata: { commit_hash: "b".repeat(40) } },
    },
  ]);
  await expect(
    getProductionDeploymentId({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      sourceSha: SHA,
    }),
  ).rejects.toThrow(CloudflareApiError);
});

it("getProductionDeploymentId rejects an id with an unexpected format before returning it", async () => {
  const fetchImpl = listFetch([
    {
      id: "has a space",
      url: "https://x.pages.dev",
      created_on: "2026-06-01T00:00:00Z",
      deployment_trigger: { metadata: { commit_hash: SHA } },
    },
  ]);
  await expect(
    getProductionDeploymentId({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      sourceSha: SHA,
    }),
  ).rejects.toThrow(/unexpected format/);
});

it("getProductionDeploymentId rejects a url with an unexpected format", async () => {
  const fetchImpl = listFetch([
    {
      id: "dep-1",
      url: "https://evil.example.com/",
      created_on: "2026-06-01T00:00:00Z",
      deployment_trigger: { metadata: { commit_hash: SHA } },
    },
  ]);
  await expect(
    getProductionDeploymentId({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      sourceSha: SHA,
    }),
  ).rejects.toThrow(/url has an unexpected format/);
});

it("getProductionDeploymentId surfaces the API's own error message, never the token, on failure", async () => {
  const fetchImpl: CfFetchFn = async () => ({
    status: 403,
    json: async () => ({ success: false, errors: [{ message: "authentication error" }] }),
  });
  let caught: unknown;
  try {
    await getProductionDeploymentId({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      sourceSha: SHA,
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CloudflareApiError);
  const message = (caught as Error).message;
  expect(message).toContain("authentication error");
  expect(message).not.toContain(SECRET_TOKEN);
});

it("rollbackDeployment returns the new deployment's id and never the token on success", async () => {
  const fetchImpl: CfFetchFn = async () => ({
    status: 200,
    json: async () => ({ success: true, result: { id: "dep-rolled-back" } }),
  });
  const result = await rollbackDeployment({
    fetchImpl,
    accountId: "acct",
    project: "proj",
    apiToken: SECRET_TOKEN,
    deploymentId: "dep-target",
  });
  expect(result).toEqual({ deploymentId: "dep-rolled-back" });
});

it("rollbackDeployment rejects a malformed target deployment id before making any request", async () => {
  let called = false;
  const fetchImpl: CfFetchFn = async () => {
    called = true;
    return { status: 200, json: async () => ({ success: true, result: { id: "x" } }) };
  };
  await expect(
    rollbackDeployment({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      deploymentId: "bad id!",
    }),
  ).rejects.toThrow(/unexpected format/);
  expect(called).toBe(false);
});

it("rollbackDeployment rejects a malformed response id", async () => {
  const fetchImpl: CfFetchFn = async () => ({
    status: 200,
    json: async () => ({ success: true, result: { id: "bad id!" } }),
  });
  await expect(
    rollbackDeployment({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      deploymentId: "dep-target",
    }),
  ).rejects.toThrow(/unexpected format/);
});

it("rollbackDeployment surfaces the API's own error message, never the token, on failure", async () => {
  const fetchImpl: CfFetchFn = async () => ({
    status: 400,
    json: async () => ({ success: false, errors: [{ message: "deployment not found" }] }),
  });
  let caught: unknown;
  try {
    await rollbackDeployment({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      deploymentId: "dep-target",
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CloudflareApiError);
  const message = (caught as Error).message;
  expect(message).toContain("deployment not found");
  expect(message).not.toContain(SECRET_TOKEN);
});

it("getDeploymentCommitHash returns the deployment's commit_hash", async () => {
  const fetchImpl: CfFetchFn = async () => ({
    status: 200,
    json: async () => ({
      success: true,
      result: { deployment_trigger: { metadata: { commit_hash: SHA } } },
    }),
  });
  const commitHash = await getDeploymentCommitHash({
    fetchImpl,
    accountId: "acct",
    project: "proj",
    apiToken: SECRET_TOKEN,
    deploymentId: "dep-1",
  });
  expect(commitHash).toBe(SHA);
});

it("getDeploymentCommitHash rejects a malformed deployment id before making any request (M2)", async () => {
  let called = false;
  const fetchImpl: CfFetchFn = async () => {
    called = true;
    return {
      status: 200,
      json: async () => ({
        success: true,
        result: { deployment_trigger: { metadata: { commit_hash: SHA } } },
      }),
    };
  };
  await expect(
    getDeploymentCommitHash({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      deploymentId: "bad id!",
    }),
  ).rejects.toThrow(/unexpected format/);
  expect(called).toBe(false);
});

it("getDeploymentCommitHash rejects a missing commit_hash rather than returning undefined (M2)", async () => {
  const fetchImpl: CfFetchFn = async () => ({
    status: 200,
    json: async () => ({ success: true, result: { deployment_trigger: { metadata: {} } } }),
  });
  await expect(
    getDeploymentCommitHash({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      deploymentId: "dep-1",
    }),
  ).rejects.toThrow(/unexpected format/);
});

// P5 tier-A review round 2 (survivor fix): the "missing" case above
// never exercises COMMIT_HASH_RE itself (`typeof commitHash !==
// "string"` already rejects `undefined` on its own) -- a mutant that
// made the regex check a no-op (e.g. always `true`) survived. These
// cover commit_hash values that ARE a string, but not 40 lowercase hex
// characters.
it("getDeploymentCommitHash rejects a present-but-malformed commit_hash (M2, round 2)", async () => {
  for (const bad of ["not-hex-at-all", "A".repeat(40), "a".repeat(39), `${"a".repeat(40)}\n`]) {
    const fetchImpl: CfFetchFn = async () => ({
      status: 200,
      json: async () => ({
        success: true,
        result: { deployment_trigger: { metadata: { commit_hash: bad } } },
      }),
    });
    await expect(
      getDeploymentCommitHash({
        fetchImpl,
        accountId: "acct",
        project: "proj",
        apiToken: SECRET_TOKEN,
        deploymentId: "dep-1",
      }),
    ).rejects.toThrow(/unexpected format/);
  }
});

// P5 tier-A review round 2 (survivor fix): `cli.ts`'s
// `runCfVerifyDeployment` used to inline this compare right after an
// `await getDeploymentCommitHash(...)` call, which only a live
// Cloudflare fetch could drive far enough to exercise -- no test could
// kill a `!==` -> `===` (or dropped-check) mutant without a real
// network call. Extracted as a pure function so it's testable here.
it("assertCommitHashMatches passes silently when the hashes match", () => {
  expect(() => assertCommitHashMatches("dep-1", SHA, SHA)).not.toThrow();
});

it("assertCommitHashMatches throws, naming both the deployment id and both hashes, on a mismatch", () => {
  const other = "b".repeat(40);
  expect(() => assertCommitHashMatches("dep-1", SHA, other)).toThrow(CloudflareApiError);
  try {
    assertCommitHashMatches("dep-1", SHA, other);
    throw new Error("expected assertCommitHashMatches to throw");
  } catch (e) {
    expect((e as Error).message).toContain("dep-1");
    expect((e as Error).message).toContain(SHA);
    expect((e as Error).message).toContain(other);
  }
});

it("getDeploymentCommitHash surfaces the API's own error message, never the token, on failure", async () => {
  const fetchImpl: CfFetchFn = async () => ({
    status: 404,
    json: async () => ({ success: false, errors: [{ message: "deployment not found" }] }),
  });
  let caught: unknown;
  try {
    await getDeploymentCommitHash({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      deploymentId: "dep-1",
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CloudflareApiError);
  const message = (caught as Error).message;
  expect(message).toContain("deployment not found");
  expect(message).not.toContain(SECRET_TOKEN);
});

it("the Authorization header carries the token, but it never reaches the URL or any other header", async () => {
  let seenAuth: string | undefined;
  let seenUrl: string | undefined;
  const fetchImpl: CfFetchFn = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.Authorization;
    return { status: 200, json: async () => ({ success: true, result: [] }) };
  };
  await expect(
    getProductionDeploymentId({
      fetchImpl,
      accountId: "acct",
      project: "proj",
      apiToken: SECRET_TOKEN,
      sourceSha: SHA,
    }),
  ).rejects.toThrow(/no production Cloudflare Pages deployment found/);
  expect(seenAuth).toBe(`Bearer ${SECRET_TOKEN}`);
  expect(seenUrl).not.toContain(SECRET_TOKEN);
});

// Review fix (MEDIUM): `wrangler pages deploy` can return before the
// deploy stage finishes. The newest entry for the SHA is polled
// (bounded, injected sleep) instead of being filtered out.
function entry(id: string, createdOn: string, status?: string, sha = SHA) {
  return {
    id,
    url: `https://${id}.pages.dev`,
    created_on: createdOn,
    environment: "production",
    ...(status === undefined ? {} : { latest_stage: { status } }),
    deployment_trigger: { metadata: { commit_hash: sha } },
  };
}

/** Serves one list response per call (the last one repeats), counting calls. */
function sequenceFetch(pages: unknown[][]): CfFetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: CfFetchFn = async (url) => {
    calls.push(url);
    const result = pages[Math.min(calls.length - 1, pages.length - 1)];
    return { status: 200, json: async () => ({ success: true, result }) };
  };
  return Object.assign(fn, { calls });
}

function baseOptions(fetchImpl: CfFetchFn, sleeps: number[] = []) {
  return {
    fetchImpl,
    accountId: "acct",
    project: "proj",
    apiToken: SECRET_TOKEN,
    sourceSha: SHA,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

it("getProductionDeploymentId polls an in-progress newest deployment until it succeeds", async () => {
  const fetchImpl = sequenceFetch([
    [entry("dep-new", "2026-06-01T00:00:00Z", "idle")],
    [entry("dep-new", "2026-06-01T00:00:00Z", "active")],
    [entry("dep-new", "2026-06-01T00:00:00Z", "success")],
  ]);
  const sleeps: number[] = [];
  const result = await getProductionDeploymentId({
    ...baseOptions(fetchImpl, sleeps),
    pollIntervalMs: 6000,
  });
  expect(result).toEqual({ deploymentId: "dep-new", deploymentUrl: "https://dep-new.pages.dev" });
  expect(fetchImpl.calls).toHaveLength(3);
  expect(sleeps).toEqual([6000, 6000]);
});

it("getProductionDeploymentId does not return an older success while a newer deploy of the same SHA is in progress", async () => {
  const older = entry("dep-old", "2026-01-01T00:00:00Z", "success");
  const fetchImpl = sequenceFetch([
    [older, entry("dep-new", "2026-06-01T00:00:00Z", "active")],
    [older, entry("dep-new", "2026-06-01T00:00:00Z", "success")],
  ]);
  const result = await getProductionDeploymentId(baseOptions(fetchImpl));
  expect(result.deploymentId).toBe("dep-new");
  expect(fetchImpl.calls).toHaveLength(2);
});

it("getProductionDeploymentId throws when the newest deployment for the SHA failed, even if an older one succeeded", async () => {
  for (const status of ["failure", "canceled"]) {
    const fetchImpl = sequenceFetch([
      [
        entry("dep-old", "2026-01-01T00:00:00Z", "success"),
        entry("dep-new", "2026-06-01T00:00:00Z", status),
      ],
    ]);
    const sleeps: number[] = [];
    await expect(getProductionDeploymentId(baseOptions(fetchImpl, sleeps))).rejects.toThrow(
      new RegExp(`ended with status "${status}"`),
    );
    expect(sleeps).toEqual([]);
  }
});

it("getProductionDeploymentId throws a CloudflareApiError when the polling budget runs out", async () => {
  const fetchImpl = sequenceFetch([[entry("dep-new", "2026-06-01T00:00:00Z", "active")]]);
  const sleeps: number[] = [];
  let caught: unknown;
  try {
    await getProductionDeploymentId({ ...baseOptions(fetchImpl, sleeps), maxAttempts: 4 });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CloudflareApiError);
  expect((caught as Error).message).toMatch(/still has status "active" after 4 attempts/);
  expect((caught as Error).message).not.toContain(SECRET_TOKEN);
  expect(fetchImpl.calls).toHaveLength(4);
  expect(sleeps).toHaveLength(3);
});

it("getProductionDeploymentId defaults to 10 polls 6 s apart", async () => {
  const fetchImpl = sequenceFetch([[entry("dep-new", "2026-06-01T00:00:00Z", "idle")]]);
  const sleeps: number[] = [];
  await expect(getProductionDeploymentId(baseOptions(fetchImpl, sleeps))).rejects.toThrow(
    /after 10 attempts/,
  );
  expect(fetchImpl.calls).toHaveLength(10);
  expect(sleeps).toEqual(Array(9).fill(6000));
});

// Review fix (LOW): list order is undocumented, so follow
// result_info.total_pages (bounded) until the SHA shows up.
function pagedFetch(totalPages: number, shaOnPage: number | null): CfFetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: CfFetchFn = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const result =
      page === shaOnPage
        ? [entry("dep-found", "2026-06-01T00:00:00Z", "success")]
        : [entry(`dep-other-${page}`, "2026-06-01T00:00:00Z", "success", "b".repeat(40))];
    return {
      status: 200,
      json: async () => ({ success: true, result, result_info: { total_pages: totalPages } }),
    };
  };
  return Object.assign(fn, { calls });
}

it("getProductionDeploymentId follows pagination to find the SHA on page 2", async () => {
  const fetchImpl = pagedFetch(5, 2);
  const result = await getProductionDeploymentId(baseOptions(fetchImpl));
  expect(result.deploymentId).toBe("dep-found");
  // R0-2: a match on page 2 does not end the walk (order is undocumented).
  expect(fetchImpl.calls).toHaveLength(5);
  expect(fetchImpl.calls[0]).toContain("/deployments?env=production&per_page=25");
  expect(fetchImpl.calls[0]).not.toContain("&page=");
  expect(fetchImpl.calls[1]).toContain("/deployments?env=production&per_page=25&page=2");
});

it("getProductionDeploymentId stops at total_pages", async () => {
  const fetchImpl = pagedFetch(3, null);
  await expect(getProductionDeploymentId(baseOptions(fetchImpl))).rejects.toThrow(
    /no production Cloudflare Pages deployment found/,
  );
  expect(fetchImpl.calls).toHaveLength(3);
});

it("getProductionDeploymentId never walks more than 10 pages", async () => {
  const fetchImpl = pagedFetch(1000, 11);
  await expect(getProductionDeploymentId(baseOptions(fetchImpl))).rejects.toThrow(
    /no production Cloudflare Pages deployment found/,
  );
  expect(fetchImpl.calls).toHaveLength(10);
});

it("getProductionDeploymentId fails on a page-2 API error without leaking the token", async () => {
  let n = 0;
  const fetchImpl: CfFetchFn = async () => {
    n++;
    if (n === 1) {
      return {
        status: 200,
        json: async () => ({ success: true, result: [], result_info: { total_pages: 2 } }),
      };
    }
    return {
      status: 429,
      json: async () => ({ success: false, errors: [{ message: "rate limited" }] }),
    };
  };
  let caught: unknown;
  try {
    await getProductionDeploymentId(baseOptions(fetchImpl));
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(CloudflareApiError);
  expect((caught as Error).message).toContain("rate limited");
  expect((caught as Error).message).not.toContain(SECRET_TOKEN);
});

it("no getProductionDeploymentId error path ever contains the token", async () => {
  const cases: CfFetchFn[] = [
    sequenceFetch([[entry("dep-new", "2026-06-01T00:00:00Z", "failure")]]),
    sequenceFetch([[entry("dep-new", "2026-06-01T00:00:00Z", "active")]]),
    sequenceFetch([[]]),
    sequenceFetch([[{ ...entry("dep-new", "2026-06-01T00:00:00Z"), id: "bad id" }]]),
  ];
  for (const fetchImpl of cases) {
    let caught: unknown;
    try {
      await getProductionDeploymentId({ ...baseOptions(fetchImpl), maxAttempts: 2 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CloudflareApiError);
    expect(String((caught as Error).message)).not.toContain(SECRET_TOKEN);
    expect(String((caught as Error).stack)).not.toContain(SECRET_TOKEN);
  }
});

// R0-2 (review LOW): the walk used to stop at the first page with any
// match. List order is undocumented, so a newer deploy of the same SHA can
// sit on a later page; every page up to the cap is scanned and the newest
// match by created_on wins.
function pagesFetch(
  totalPages: number,
  byPage: Record<number, unknown[]>,
): CfFetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: CfFetchFn = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const result = byPage[page] ?? [
      entry(`dep-other-${page}`, "2026-06-01T00:00:00Z", "success", "b".repeat(40)),
    ];
    return {
      status: 200,
      json: async () => ({ success: true, result, result_info: { total_pages: totalPages } }),
    };
  };
  return Object.assign(fn, { calls });
}

it("getProductionDeploymentId picks a newer match on a later page over an older match on page 1", async () => {
  const fetchImpl = pagesFetch(4, {
    1: [entry("dep-old", "2026-01-01T00:00:00Z", "success")],
    3: [entry("dep-new", "2026-06-01T00:00:00Z", "success")],
  });
  const result = await getProductionDeploymentId(baseOptions(fetchImpl));
  expect(result).toEqual({ deploymentId: "dep-new", deploymentUrl: "https://dep-new.pages.dev" });
  expect(fetchImpl.calls).toHaveLength(4);
});

it("getProductionDeploymentId keeps the page-1 match when later pages only hold older ones", async () => {
  const fetchImpl = pagesFetch(3, {
    1: [entry("dep-new", "2026-06-01T00:00:00Z", "success")],
    2: [entry("dep-old", "2026-01-01T00:00:00Z", "success")],
  });
  const result = await getProductionDeploymentId(baseOptions(fetchImpl));
  expect(result.deploymentId).toBe("dep-new");
  expect(fetchImpl.calls).toHaveLength(3);
});

it("getProductionDeploymentId does not return a page-1 success while a newer deploy on page 2 is in progress", async () => {
  let attempt = 0;
  const calls: string[] = [];
  const fetchImpl: CfFetchFn = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    if (page === 1) attempt++;
    const result =
      page === 1
        ? [entry("dep-old", "2026-01-01T00:00:00Z", "success")]
        : [entry("dep-new", "2026-06-01T00:00:00Z", attempt === 1 ? "active" : "success")];
    return {
      status: 200,
      json: async () => ({ success: true, result, result_info: { total_pages: 2 } }),
    };
  };
  const sleeps: number[] = [];
  const result = await getProductionDeploymentId(baseOptions(fetchImpl, sleeps));
  expect(result.deploymentId).toBe("dep-new");
  expect(calls).toHaveLength(4);
  expect(sleeps).toHaveLength(1);
});

it("getProductionDeploymentId fails on a newer failed deploy on a later page even if page 1 has a success", async () => {
  const fetchImpl = pagesFetch(2, {
    1: [entry("dep-old", "2026-01-01T00:00:00Z", "success")],
    2: [entry("dep-new", "2026-06-01T00:00:00Z", "failure")],
  });
  await expect(getProductionDeploymentId(baseOptions(fetchImpl))).rejects.toThrow(
    /ended with status "failure"/,
  );
});

it("getProductionDeploymentId still caps the scan at 10 pages when matches exist", async () => {
  const byPage: Record<number, unknown[]> = {
    1: [entry("dep-in-cap", "2026-01-01T00:00:00Z", "success")],
    11: [entry("dep-beyond-cap", "2026-06-01T00:00:00Z", "success")],
  };
  const fetchImpl = pagesFetch(1000, byPage);
  const result = await getProductionDeploymentId(baseOptions(fetchImpl));
  expect(result.deploymentId).toBe("dep-in-cap");
  expect(fetchImpl.calls).toHaveLength(10);
});

it("pickNewest is order-independent and treats a missing/unparseable created_on as the oldest", () => {
  type E = { id: string; created_on?: string };
  const a: E = { id: "a", created_on: "2026-03-01T00:00:00Z" };
  const b: E = { id: "b", created_on: "2026-05-01T00:00:00Z" };
  const c: E = { id: "c", created_on: "2026-04-01T00:00:00Z" };
  const bad: E = { id: "bad", created_on: "not a date" };
  const missing: E = { id: "missing" };
  const orders: E[][] = [
    [a, b, c],
    [b, c, a],
    [c, a, b],
    [bad, a, b, missing, c],
  ];
  for (const order of orders) {
    expect(pickNewest(order).id).toBe("b");
  }
  expect(pickNewest([bad, a]).id).toBe("a");
  expect(pickNewest([missing, bad]).id).toBe("missing");
  // Tie: the earlier-seen entry wins.
  const tie: E = { id: "x", created_on: "2026-05-01T00:00:00Z" };
  expect(pickNewest([tie, b]).id).toBe("x");
});
