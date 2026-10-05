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
  type CfFetchFn,
  CloudflareApiError,
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
