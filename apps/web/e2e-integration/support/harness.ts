/**
 * Harness for the request-flow integration suite: control of the mock
 * GitHub (dispatch log, failure modes) and of the local Worker's KV
 * (origin allowlist, accept switch, simulated client IP).
 */
import { type APIRequestContext, request as pwRequest } from "@playwright/test";
import { MOCK_GITHUB, SITE_ORIGIN, WORKER_DIRECT } from "./env";

export interface RecordedDispatch {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
  inputs: Record<string, unknown>;
  authorization: string | null;
  apiVersion: string | null;
  status: number;
}

export interface MockCalls {
  dispatches: RecordedDispatch[];
  manifestReads: number;
  other: string[];
}

export interface MockConfig {
  dispatchStatus?: number;
  manifestStatus?: number;
  manifest?: unknown;
  delayMs?: number;
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
}

export const mockGithub = {
  reset: () => post(`${MOCK_GITHUB}/__reset`, {}),
  configure: (config: MockConfig) => post(`${MOCK_GITHUB}/__config`, config),
  calls: async (): Promise<MockCalls> => (await fetch(`${MOCK_GITHUB}/__calls`)).json(),
};

let workerApi: APIRequestContext | null = null;
async function worker(): Promise<APIRequestContext> {
  workerApi ??= await pwRequest.newContext({ ignoreHTTPSErrors: true });
  return workerApi;
}

export async function setKv(key: string, value: string): Promise<void> {
  const res = await (await worker()).put(`${WORKER_DIRECT}/__test/kv`, { data: { key, value } });
  if (!res.ok()) throw new Error(`set KV ${key} -> ${res.status()}`);
}

// Random per module load: Playwright restarts the worker process after a
// failed test, which resets module state; a plain counter would then reuse
// an address whose quota earlier tests already spent and fail every later
// test with 429.
const ipPrefix = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ipCounter = 0;
/** Gives the next requests a fresh per-IP quota bucket. */
export async function freshClientIp(): Promise<string> {
  ipCounter += 1;
  const ip = `${ipPrefix}.${ipCounter}`;
  await setKv("test_client_ip", ip);
  return ip;
}

/** Default Worker state: only the site origin allowed, accepting. */
export async function resetWorld(): Promise<void> {
  await mockGithub.reset();
  await setKv("origin_allowlist", JSON.stringify([SITE_ORIGIN]));
  await setKv("accepting", "true");
  await freshClientIp();
}

/** Unique theme names per call, so the in-flight dedup never links tests. */
let themeCounter = 0;
export function uniqueTheme(prefix = "Integration Probe"): string {
  themeCounter += 1;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const tag = `${letters[themeCounter % 26]}${letters[Math.floor(themeCounter / 26) % 26]}`;
  return `${prefix} ${Date.now().toString(36)} ${tag}`;
}
