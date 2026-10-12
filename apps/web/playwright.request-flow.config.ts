import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_BASE } from "@paperpilot/core/site";
import { defineConfig, devices } from "@playwright/test";
import {
  FOREIGN_PORT,
  MOCK_GITHUB_PORT,
  SITE_PORT,
  WORKER_PORT,
} from "./e2e-integration/support/env";

/**
 * Request-flow integration suite (`pnpm --filter @paperpilot/web
 * e2e:request-flow`): the BUILT site's theme request form -> the REAL
 * Worker app (apps/api, `wrangler dev --local` with the test-only entry
 * apps/api/test/integration/worker-entry.ts: real Hono app, real SQLite
 * Durable Object quota/in-flight ledger, real local KV) -> a mock GitHub
 * (e2e-integration/support/mock-github.mjs) that records every
 * workflow_dispatch.
 *
 * The page keeps its production API origin (API_BASE, the only
 * connect-src besides 'self' in the per-page CSP), and Chromium resolves
 * that host to the local wrangler (`--host-resolver-rules`), served over
 * HTTPS with wrangler's self-signed certificate. So the browser enforces
 * the real CSP and the real CORS answers of the Worker; nothing is
 * stubbed in the page.
 *
 * Servers: allowed site origin (static, :4180), a foreign origin serving
 * the same build (:4181, not in the allowlist), the mock GitHub (:4290,
 * matches MOCK_GITHUB_ORIGIN in wrangler.integration.jsonc) and wrangler
 * (:8787). One worker, serial: the tests share the Worker's state.
 */
const API_HOST = new URL(API_BASE).host;
const CI = !!process.env.CI;
const PERSIST = join(tmpdir(), `paperpilot-request-flow-${process.pid}`);

export default defineConfig({
  testDir: "./e2e-integration",
  testMatch: "**/*.int.ts",
  outputDir: "./test-results/request-flow",
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-report/request-flow" }],
        ["github"],
      ]
    : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${SITE_PORT}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [`--host-resolver-rules=MAP ${API_HOST} 127.0.0.1:${WORKER_PORT}`],
    },
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      command: `node e2e/support/static-server.mjs --port ${SITE_PORT}`,
      url: `http://127.0.0.1:${SITE_PORT}/`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e/support/static-server.mjs --port ${FOREIGN_PORT}`,
      url: `http://127.0.0.1:${FOREIGN_PORT}/`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `node e2e-integration/support/mock-github.mjs --port ${MOCK_GITHUB_PORT}`,
      url: `http://127.0.0.1:${MOCK_GITHUB_PORT}/__calls`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // Local only (`--local`): no Cloudflare account, no deploy, fresh
      // DO/KV state per run in a temp dir.
      command:
        `pnpm exec wrangler dev --local -c test/integration/wrangler.integration.jsonc ` +
        `--ip 127.0.0.1 --port ${WORKER_PORT} --local-protocol https ` +
        `--persist-to ${PERSIST} --show-interactive-dev-session=false`,
      cwd: "../api",
      url: `https://127.0.0.1:${WORKER_PORT}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
      env: { WRANGLER_SEND_METRICS: "false" },
    },
  ],
});
