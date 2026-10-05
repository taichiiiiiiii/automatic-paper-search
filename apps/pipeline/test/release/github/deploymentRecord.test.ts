/**
 * p5-plan.md §2 A4 `gh-record`: creates a GitHub Deployment, then a
 * success status on it. Fake `fetchImpl` only — never the real network.
 */
import { expect, it } from "vitest";
import {
  type GhFetchFn,
  GithubApiError,
  recordDeployment,
} from "../../../src/release/github/deploymentRecord.js";

const SHA = "a".repeat(40);
const SECRET_TOKEN = "gh-secret-token-should-never-leak";

function baseOptions(fetchImpl: GhFetchFn) {
  return {
    fetchImpl,
    token: SECRET_TOKEN,
    repo: "taichiiiiiiii/automatic-paper-search",
    sourceSha: SHA,
    cfDeploymentId: "dep-1",
    releaseKind: "normal",
    requestId: null,
    artifactName: `github-pages-${SHA}`,
    environmentUrl: "https://paperpilot.pages.dev",
  };
}

it("recordDeployment POSTs the deployment then its success status, returning the numeric id", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: GhFetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/deployments")) {
      return { status: 201, text: async () => JSON.stringify({ id: 4242 }) };
    }
    return { status: 201, text: async () => JSON.stringify({ id: 1, state: "success" }) };
  };
  const result = await recordDeployment(baseOptions(fetchImpl));
  expect(result).toEqual({ deploymentId: 4242 });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toBe(
    "https://api.github.com/repos/taichiiiiiiii/automatic-paper-search/deployments",
  );
});

it("the second call targets /deployments/{id}/statuses with state success and the environment_url", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: GhFetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/deployments")) {
      return { status: 201, text: async () => JSON.stringify({ id: 99 }) };
    }
    return { status: 201, text: async () => "{}" };
  };
  await recordDeployment(baseOptions(fetchImpl));
  const statusCall = calls[1];
  expect(statusCall?.url).toBe(
    "https://api.github.com/repos/taichiiiiiiii/automatic-paper-search/deployments/99/statuses",
  );
  expect(statusCall?.body).toMatchObject({
    state: "success",
    environment_url: "https://paperpilot.pages.dev",
  });
});

it("the first call's payload carries source_sha/cf_deployment_id/release_kind/request_id/artifact_name", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: GhFetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return url.endsWith("/deployments")
      ? { status: 201, text: async () => JSON.stringify({ id: 1 }) }
      : { status: 201, text: async () => "{}" };
  };
  await recordDeployment({ ...baseOptions(fetchImpl), requestId: "push-123-1" });
  expect(calls[0]?.body).toMatchObject({
    ref: SHA,
    environment: "cloudflare-pages-production",
    production_environment: true,
    payload: {
      source_sha: SHA,
      cf_deployment_id: "dep-1",
      release_kind: "normal",
      request_id: "push-123-1",
      artifact_name: `github-pages-${SHA}`,
    },
  });
});

it("rejects a malformed repo before making any request", async () => {
  let called = false;
  const fetchImpl: GhFetchFn = async () => {
    called = true;
    return { status: 201, text: async () => "{}" };
  };
  await expect(recordDeployment({ ...baseOptions(fetchImpl), repo: "not-a-repo" })).rejects.toThrow(
    GithubApiError,
  );
  expect(called).toBe(false);
});

// L1 (P5 tier-A review): cfDeploymentId/requestId/artifactName used to
// reach the GitHub API payload with no format check at all -- each must
// now be regex-validated BEFORE the first request, same as repo above.
it("rejects a malformed cfDeploymentId before making any request", async () => {
  let called = false;
  const fetchImpl: GhFetchFn = async () => {
    called = true;
    return { status: 201, text: async () => "{}" };
  };
  await expect(
    recordDeployment({ ...baseOptions(fetchImpl), cfDeploymentId: "has a space" }),
  ).rejects.toThrow(GithubApiError);
  await expect(
    recordDeployment({ ...baseOptions(fetchImpl), cfDeploymentId: "has\nnewline" }),
  ).rejects.toThrow(GithubApiError);
  expect(called).toBe(false);
});

it("rejects a malformed requestId before making any request (null is still allowed)", async () => {
  let called = false;
  const rejectingFetch: GhFetchFn = async () => {
    called = true;
    return { status: 201, text: async () => "{}" };
  };
  await expect(
    recordDeployment({ ...baseOptions(rejectingFetch), requestId: "bad id with spaces" }),
  ).rejects.toThrow(GithubApiError);
  expect(called).toBe(false);

  const acceptingFetch: GhFetchFn = async (url) =>
    url.endsWith("/deployments")
      ? { status: 201, text: async () => JSON.stringify({ id: 1 }) }
      : { status: 201, text: async () => "{}" };
  await expect(
    recordDeployment({ ...baseOptions(acceptingFetch), requestId: null }),
  ).resolves.toBeDefined();
});

it("rejects a malformed artifactName before making any request", async () => {
  let called = false;
  const fetchImpl: GhFetchFn = async () => {
    called = true;
    return { status: 201, text: async () => "{}" };
  };
  await expect(
    recordDeployment({ ...baseOptions(fetchImpl), artifactName: "has a space" }),
  ).rejects.toThrow(GithubApiError);
  await expect(
    recordDeployment({ ...baseOptions(fetchImpl), artifactName: "has/slash" }),
  ).rejects.toThrow(GithubApiError);
  expect(called).toBe(false);
});

it("rejects a deployment response with no numeric id", async () => {
  const fetchImpl: GhFetchFn = async () => ({
    status: 201,
    text: async () => JSON.stringify({ id: "not-a-number" }),
  });
  await expect(recordDeployment(baseOptions(fetchImpl))).rejects.toThrow(/no numeric id/);
});

it("surfaces the API's own error message, never the token, when the first POST fails", async () => {
  const fetchImpl: GhFetchFn = async () => ({
    status: 422,
    text: async () => JSON.stringify({ message: "Validation Failed" }),
  });
  let caught: unknown;
  try {
    await recordDeployment(baseOptions(fetchImpl));
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(GithubApiError);
  const message = (caught as Error).message;
  expect(message).toContain("Validation Failed");
  expect(message).not.toContain(SECRET_TOKEN);
});

it("surfaces an error when the second POST (statuses) fails, never the token", async () => {
  const fetchImpl: GhFetchFn = async (url) => {
    if (url.endsWith("/deployments")) {
      return { status: 201, text: async () => JSON.stringify({ id: 1 }) };
    }
    return { status: 500, text: async () => JSON.stringify({ message: "internal error" }) };
  };
  let caught: unknown;
  try {
    await recordDeployment(baseOptions(fetchImpl));
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(GithubApiError);
  const message = (caught as Error).message;
  expect(message).not.toContain(SECRET_TOKEN);
});

it("the Authorization header carries the token and a non-empty User-Agent is always sent", async () => {
  let seenAuth: string | undefined;
  let seenUserAgent: string | undefined;
  const fetchImpl: GhFetchFn = async (_url, init) => {
    seenAuth = init.headers.Authorization;
    seenUserAgent = init.headers["User-Agent"];
    return { status: 201, text: async () => JSON.stringify({ id: 1 }) };
  };
  await recordDeployment(baseOptions(fetchImpl));
  expect(seenAuth).toBe(`Bearer ${SECRET_TOKEN}`);
  expect(seenUserAgent).toBeTruthy();
});
