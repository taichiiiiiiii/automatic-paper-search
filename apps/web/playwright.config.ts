import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end UI suite (`pnpm --filter @paperpilot/web e2e`): drives the
 * BUILT static export (apps/web/out, build it first) in Chromium through a
 * tiny server that mimics Cloudflare Pages (e2e/support/static-server.mjs:
 * `_headers`, `_redirects`, trailing-slash routing, 404.html). Every test
 * fails on console errors, CSP violations, uncaught page errors and failed
 * same-origin requests (e2e/support/fixtures.ts).
 *
 * Remote mode: `E2E_BASE_URL=https://paperpilot.pages.dev pnpm e2e:prod`
 * skips the local server and runs the read-only `@prod` subset against the
 * deployed site; test data (themes, catalogs, paper-links pages) is then
 * read from that site's JSON, not from apps/web/out (e2e/support/site.ts).
 * `pnpm e2e:crawl` runs the slower `@prod-crawl` broken-link crawler.
 * Non-GET requests to the theme-request Worker are blocked in remote mode.
 *
 * One worker by default: the catalog pages parse multi-MB JSON and the
 * suite shares small CI runners / a busy dev machine. Override with
 * `--workers` or E2E_WORKERS.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS ?? 1),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile-chromium",
      // Pixel 5 (touch, mobile UA, DPR) narrowed to the 375px reference width.
      use: { ...devices["Pixel 5"], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `node e2e/support/static-server.mjs --port ${PORT}`,
        url: `${BASE_URL}/`,
        reuseExistingServer: !CI,
        timeout: 30_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
