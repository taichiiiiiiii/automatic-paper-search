/**
 * Theme request flow, end to end: built /themes/ page -> real Worker app
 * (local wrangler) -> mock GitHub. Asserts both what the visitor sees and
 * exactly which workflow_dispatch calls reached "GitHub".
 *
 * Run: `pnpm --filter @paperpilot/web e2e:request-flow` (build apps/web
 * first). See playwright.request-flow.config.ts for the wiring.
 */

import { API_BASE } from "@paperpilot/core/site";
import type { Page } from "@playwright/test";
import { expect, test } from "../e2e/support/fixtures";
import { publishedThemes } from "../e2e/support/site";
import { FOREIGN_ORIGIN } from "./support/env";
import { freshClientIp, mockGithub, resetWorld, setKv, uniqueTheme } from "./support/harness";

const REQUEST_ID_RE = /^theme-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const API_THEMES = `${API_BASE}/api/themes`;

/** Chromium logs every non-2xx fetch / CORS refusal as a console error. */
const API_CONSOLE =
  /console: (Failed to load resource|Access to fetch at).*(workers\.dev|status of)/;

async function openRequestForm(page: Page, origin = "") {
  await page.goto(`${origin}/themes/`);
  await page.getByRole("button", { name: "＋ 新しいテーマを依頼" }).click();
}

function themeInput(page: Page) {
  return page.getByRole("textbox", { name: /テーマを自分で生成/ });
}

async function submit(page: Page, theme: string) {
  await themeInput(page).fill(theme);
  await page.getByRole("button", { name: "生成する" }).click();
}

function formStatus(page: Page, kind: "ok" | "err") {
  return page.locator(`form p[role="status"][data-kind="${kind}"]`);
}

/** POST from inside the page (so Origin/CORS are the browser's own). */
async function postFromPage(
  page: Page,
  body: string,
  contentType = "application/json",
): Promise<{ status: number; json: Record<string, unknown> | null } | { error: string }> {
  return page.evaluate(
    async ({ url, body, contentType }) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
          credentials: "omit",
        });
        let json = null;
        try {
          json = await res.json();
        } catch {}
        return { status: res.status, json };
      } catch (e) {
        return { error: String(e) };
      }
    },
    { url: API_THEMES, body, contentType },
  );
}

// Expected error answers (4xx/5xx from the Worker) are logged by Chromium
// as console errors; everything else the guard checks (CSP violations,
// page errors, same-origin failures, other console errors) still fails.
test.use({ allowedProblems: API_CONSOLE });

test.beforeEach(async () => {
  await resetWorld();
});

test.describe("theme request flow (form -> Worker -> GitHub dispatch)", () => {
  test("a valid new theme dispatches theme-on-demand.yml exactly once and shows progress", async ({
    page,
  }) => {
    const theme = uniqueTheme();
    await openRequestForm(page);
    const responsePromise = page.waitForResponse(
      (r) => r.url() === API_THEMES && r.request().method() === "POST",
    );
    await submit(page, theme);
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, status: "queued" });
    expect(body.request_id).toMatch(REQUEST_ID_RE);

    await expect(page.getByText(`「${theme}」を生成中…`)).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "生成の進捗" })).toBeVisible();

    const calls = await mockGithub.calls();
    expect(calls.manifestReads).toBe(1);
    expect(calls.dispatches).toHaveLength(1);
    expect(calls.dispatches[0]).toEqual({
      owner: "taichiiiiiiii",
      repo: "automatic-paper-search",
      workflow: "theme-on-demand.yml",
      ref: "develop",
      inputs: { theme, request_id: body.request_id },
      authorization: "Bearer integration-test-fake-pat",
      apiVersion: "2022-11-28",
      status: 204,
    });
    expect(calls.other).toEqual([]);

    await page.getByRole("button", { name: "キャンセルして既存テーマを見る" }).click();
    await expect(themeInput(page)).toBeVisible();
  });

  test("invalid inputs are rejected in the page and never reach the Worker", async ({ page }) => {
    const apiRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url() === API_THEMES) apiRequests.push(r.method());
    });
    await openRequestForm(page);
    for (const [input, message] of [
      ["視覚トランスフォーマー", "テーマ名は英語で入力してください"],
      ["a", "2〜80 文字"],
      ["bad/char<script>", "2〜80 文字"],
      ["   ", "2〜80 文字"],
    ] as const) {
      await submit(page, input);
      await expect(formStatus(page, "err")).toContainText(message);
    }
    expect(apiRequests).toEqual([]);
    expect((await mockGithub.calls()).dispatches).toEqual([]);
  });

  test("server-side gates hold when the page's own checks are bypassed", async ({ page }) => {
    await openRequestForm(page);
    await expect(themeInput(page)).toBeVisible();

    const invalid = await postFromPage(page, JSON.stringify({ theme: "<img src=x>" }));
    expect(invalid).toMatchObject({ status: 400, json: { ok: false, status: "invalid" } });
    const nonString = await postFromPage(page, JSON.stringify({ theme: 42 }));
    expect(nonString).toMatchObject({ status: 400, json: { status: "invalid" } });
    const notJson = await postFromPage(page, "{theme:");
    expect(notJson).toMatchObject({ status: 400, json: { status: "invalid" } });
    // text/plain is a CORS-"simple" request (no preflight): the Worker
    // itself must refuse it.
    const plain = await postFromPage(page, JSON.stringify({ theme: "Plain Text" }), "text/plain");
    expect(plain).toMatchObject({ status: 415, json: { status: "error" } });
    const oversized = await postFromPage(page, JSON.stringify({ theme: "x".repeat(2048) }));
    expect(oversized).toMatchObject({
      status: 413,
      json: { ok: false, status: "error", message: "request body exceeds the 1KB limit" },
    });

    const calls = await mockGithub.calls();
    expect(calls.dispatches).toEqual([]);
    expect(calls.manifestReads).toBe(0);
  });

  test("an already-published theme answers 'exists' with a link and no dispatch", async ({
    page,
  }) => {
    const existing = publishedThemes()[0];
    test.skip(!existing, "no published theme in this build");
    await openRequestForm(page);
    await submit(page, existing!.theme);
    const ok = formStatus(page, "ok");
    await expect(ok).toContainText("そのテーマは既に生成済です");
    await expect(ok.getByRole("link", { name: "表示する →" })).toHaveAttribute(
      "href",
      new RegExp(`theme=${existing!.slug}`),
    );
    const calls = await mockGithub.calls();
    expect(calls.manifestReads).toBe(1);
    expect(calls.dispatches).toEqual([]);
  });

  test("a double submit sends one request and one dispatch", async ({ page }) => {
    await mockGithub.configure({ delayMs: 1_500 });
    const apiPosts: string[] = [];
    page.on("request", (r) => {
      if (r.url() === API_THEMES && r.method() === "POST") apiPosts.push(r.url());
    });
    const theme = uniqueTheme();
    await openRequestForm(page);
    await themeInput(page).fill(theme);
    const button = page.getByRole("button", { name: "生成する" });
    await button.click();
    // Second activation while the first request is pending.
    await themeInput(page)
      .press("Enter")
      .catch(() => {});
    await button.click({ force: true, timeout: 1_000 }).catch(() => {});
    await expect(page.getByText(`「${theme}」を生成中…`)).toBeVisible();
    expect(apiPosts).toHaveLength(1);
    expect((await mockGithub.calls()).dispatches).toHaveLength(1);
  });

  test("re-requesting a theme whose run is still in flight follows that run (no second dispatch)", async ({
    page,
  }) => {
    const theme = uniqueTheme();
    await openRequestForm(page);
    const first = page.waitForResponse((r) => r.url() === API_THEMES);
    await submit(page, theme);
    const firstBody = await (await first).json();
    await expect(page.getByText(`「${theme}」を生成中…`)).toBeVisible();

    // Same theme again from a fresh page load, different spelling/IP.
    await freshClientIp();
    await openRequestForm(page);
    const second = page.waitForResponse((r) => r.url() === API_THEMES);
    await submit(page, ` ${theme.toLowerCase()} `);
    const secondBody = await (await second).json();
    expect(secondBody).toMatchObject({
      ok: true,
      status: "queued",
      request_id: firstBody.request_id,
      deduplicated: true,
    });
    await expect(page.getByText(/を生成中…/)).toBeVisible();
    expect((await mockGithub.calls()).dispatches).toHaveLength(1);
  });

  test("the per-IP rate limit shows a Japanese message and stops dispatching", async ({ page }) => {
    await openRequestForm(page);
    await expect(themeInput(page)).toBeVisible();
    for (let i = 0; i < 5; i++) {
      const r = await postFromPage(page, JSON.stringify({ theme: uniqueTheme("Quota Probe") }));
      expect(r).toMatchObject({ status: 200, json: { status: "queued" } });
    }
    expect((await mockGithub.calls()).dispatches).toHaveLength(5);

    await submit(page, uniqueTheme("Quota Probe"));
    const err = formStatus(page, "err");
    await expect(err).toContainText("1 時間に 5 件まで");
    await expect(err).not.toContainText("more than");
    expect((await mockGithub.calls()).dispatches).toHaveLength(5);

    // Another client is unaffected.
    await freshClientIp();
    const other = await postFromPage(page, JSON.stringify({ theme: uniqueTheme("Quota Probe") }));
    expect(other).toMatchObject({ status: 200, json: { status: "queued" } });
  });

  for (const [label, dispatchStatus] of [
    ["GitHub 5xx", 500],
    ["GitHub 401 (expired PAT)", 401],
  ] as const) {
    test(`${label} -> generic Japanese error with an Issue fallback; a retry can dispatch`, async ({
      page,
    }) => {
      await mockGithub.configure({ dispatchStatus });
      const theme = uniqueTheme();
      await openRequestForm(page);
      await submit(page, theme);
      const err = formStatus(page, "err");
      await expect(err).toContainText("GitHub への依頼に失敗しました");
      await expect(err.getByRole("link", { name: "GitHub Issue で送信 →" })).toHaveAttribute(
        "href",
        /issues\/new\?labels=theme-request/,
      );
      await expect(err).not.toContainText(/Bad credentials|Server Error|integration-test-fake-pat/);
      let calls = await mockGithub.calls();
      expect(calls.dispatches.map((d) => d.status)).toEqual([dispatchStatus]);

      // The failed attempt released its in-flight claim: fixing GitHub
      // and resubmitting dispatches for real.
      await mockGithub.configure({ dispatchStatus: 204 });
      await page.getByRole("button", { name: "生成する" }).click();
      await expect(page.getByText(`「${theme}」を生成中…`)).toBeVisible();
      calls = await mockGithub.calls();
      expect(calls.dispatches.map((d) => d.status)).toEqual([dispatchStatus, 204]);
    });
  }

  test("an unreadable published manifest fails closed (503, no dispatch)", async ({ page }) => {
    await mockGithub.configure({ manifestStatus: 502 });
    await openRequestForm(page);
    await submit(page, uniqueTheme());
    await expect(formStatus(page, "err")).toContainText("既存テーマの確認に失敗しました");
    expect((await mockGithub.calls()).dispatches).toEqual([]);
  });

  test("the accept switch: closed form when paused at load, paused message when paused later", async ({
    page,
  }) => {
    await setKv("accepting", "false");
    await openRequestForm(page);
    await expect(page.getByText("現在、新しいテーマの受付を停止しています。")).toBeVisible();
    await expect(themeInput(page)).toHaveCount(0);

    await setKv("accepting", "true");
    await openRequestForm(page);
    await expect(themeInput(page)).toBeVisible();
    await setKv("accepting", "false");
    await submit(page, uniqueTheme());
    const err = formStatus(page, "err");
    await expect(err).toContainText("現在受付を一時停止しています");
    await expect(err.getByRole("link", { name: "GitHub Issue で送信 →" })).toBeVisible();
    const calls = await mockGithub.calls();
    expect(calls.dispatches).toEqual([]);
    expect(calls.manifestReads).toBe(0);
  });
});

test.describe("a foreign origin", () => {
  // The fixture guard only watches the site origin's own requests; the
  // CORS refusals below are console errors by design.
  test.use({ allowedProblems: /console: .*(CORS|Access to fetch|Failed to load resource)/ });

  test("cannot use the Worker: the form stays closed and a scripted POST is refused", async ({
    page,
  }) => {
    await openRequestForm(page, FOREIGN_ORIGIN);
    await expect(page.getByText("現在、新しいテーマの受付を停止しています。")).toBeVisible();
    await expect(themeInput(page)).toHaveCount(0);

    const result = await postFromPage(page, JSON.stringify({ theme: uniqueTheme() }));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/TypeError|Failed to fetch/);
    const calls = await mockGithub.calls();
    expect(calls.dispatches).toEqual([]);
    expect(calls.manifestReads).toBe(0);
  });
});
