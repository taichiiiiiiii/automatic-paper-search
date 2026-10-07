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

it("getProductionDeploymentId skips a newer deploy for the same commit that is skipped, failed or not production", async () => {
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
      id: "dep-failed",
      url: "https://f.pages.dev",
      created_on: "2026-06-02T00:00:00Z",
      environment: "production",
      latest_stage: { status: "failure" },
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
