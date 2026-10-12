/**
 * Self-test of the page-health guard (support/fixtures.ts): proves that a
 * console error, a CSP violation, an uncaught error and a failed
 * same-origin request are each detected. Each case is declared
 * `test.fail()` -- it PASSES only if the guard fails it.
 */
import { expect, test } from "./support/fixtures";

test.describe("page-health guard", () => {
  test("detects a console error", async ({ page }) => {
    test.fail();
    await page.goto("/how-it-works/");
    await page.evaluate(() => console.error("e2e guard self-test"));
  });

  test("detects a CSP violation (inline script)", async ({ page, pageProblems }) => {
    test.fail();
    await page.goto("/how-it-works/");
    await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__e2eInline = 1";
      document.body.append(s);
    });
    await expect.poll(() => pageProblems.some((p) => p.kind === "csp")).toBe(true);
    // CSP blocked it.
    expect(
      await page.evaluate(() => (window as unknown as { __e2eInline?: number }).__e2eInline),
    ).toBeUndefined();
  });

  test("detects a CSP violation (inline style attribute)", async ({ page, pageProblems }) => {
    // Covers the narrow WebKit <select> exemption in support/fixtures.ts:
    // an inline style on any other element must still be reported.
    test.fail();
    await page.goto("/how-it-works/");
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.setAttribute("style", "color: red");
      d.textContent = "e2e";
      document.body.append(d);
    });
    await expect.poll(() => pageProblems.some((p) => p.kind === "csp")).toBe(true);
  });

  test("detects an uncaught page error", async ({ page }) => {
    test.fail();
    await page.goto("/how-it-works/");
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("e2e guard self-test");
      }, 0);
    });
    await page.waitForTimeout(200);
  });

  test("detects a failed same-origin request", async ({ page }) => {
    test.fail();
    await page.goto("/how-it-works/");
    await page.evaluate(() => fetch("/no-such-file-e2e.json").catch(() => {}));
    await page.waitForTimeout(200);
  });
});
