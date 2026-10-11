/**
 * Shared Playwright fixtures: every test in the suite imports `test` /
 * `expect` from here (never from "@playwright/test" directly) so the
 * "page health" guard below runs automatically.
 *
 * The guard fails the test, after its body ran, on any of:
 * - a console `error` message (React errors, failed resource loads, …),
 * - a CSP violation (reported both by Chromium's "Refused to …" console
 *   error and by a `securitypolicyviolation` listener installed before
 *   any page script runs),
 * - an uncaught page error,
 * - a failed same-origin request (network failure or HTTP status >= 400).
 *   `net::ERR_ABORTED` is ignored: Next cancels in-flight RSC prefetches
 *   when a navigation starts, which is normal.
 *
 * A test that expects a problem (e.g. the 404 page) opts out narrowly
 * with `test.use({ allowedProblems: /regex/ })` (one RegExp, use `|` for
 * several: Playwright reads an array option value as a fixture tuple).
 *
 * With `javaScriptEnabled: false`, Chromium cancels script loads with the
 * error text "csp"; those are expected and ignored in that mode only.
 */
import { test as base, type ConsoleMessage, expect, type Page } from "@playwright/test";

export interface PageProblem {
  kind: "console" | "csp" | "pageerror" | "requestfailed" | "http";
  text: string;
  page: string;
}

interface Fixtures {
  /** Matched against `"<kind>: <text>"`; a matching problem is not
   * reported. Keep it as narrow as possible. */
  allowedProblems: RegExp;
  /** The problems collected so far for this test (read-only use). */
  pageProblems: PageProblem[];
}

const CSP_TAG = "[e2e-csp-violation]";

function attach(page: Page, origin: string, problems: PageProblem[], jsEnabled: boolean): void {
  const where = () => page.url();
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const loc = msg.location()?.url;
    const kind =
      text.includes(CSP_TAG) || /Content Security Policy/i.test(text) ? "csp" : "console";
    problems.push({ kind, text: loc ? `${text} (${loc})` : text, page: where() });
  });
  page.on("pageerror", (err) => {
    problems.push({ kind: "pageerror", text: `${err.name}: ${err.message}`, page: where() });
  });
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "unknown";
    if (failure.includes("ERR_ABORTED")) return;
    if (!jsEnabled && failure === "csp" && req.resourceType() === "script") return;
    if (!req.url().startsWith(origin)) return;
    problems.push({ kind: "requestfailed", text: `${failure} ${req.url()}`, page: where() });
  });
  page.on("response", (res) => {
    if (res.status() < 400 || !res.url().startsWith(origin)) return;
    problems.push({ kind: "http", text: `${res.status()} ${res.url()}`, page: where() });
  });
}

export const test = base.extend<Fixtures & { _pageGuard: undefined }>({
  allowedProblems: [/(?!)/, { option: true }],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern for the fixtures argument.
  pageProblems: async ({}, use) => {
    await use([]);
  },
  _pageGuard: [
    async (
      { context, baseURL, allowedProblems, pageProblems, javaScriptEnabled },
      use,
      testInfo,
    ) => {
      const js = javaScriptEnabled !== false;
      const origin = new URL(baseURL ?? "http://127.0.0.1").origin;
      // Runs before any page script (and is unaffected by the page CSP).
      await context.addInitScript((tag: string) => {
        document.addEventListener("securitypolicyviolation", (e) => {
          console.error(`${tag} ${e.violatedDirective} blocked=${e.blockedURI || "inline"}`);
        });
      }, CSP_TAG);
      for (const p of context.pages()) attach(p, origin, pageProblems, js);
      context.on("page", (p) => attach(p, origin, pageProblems, js));
      await use(undefined);
      const unexpected = pageProblems.filter((p) => !allowedProblems.test(`${p.kind}: ${p.text}`));
      if (pageProblems.length > 0) {
        await testInfo.attach("page-problems.json", {
          body: JSON.stringify(pageProblems, null, 2),
          contentType: "application/json",
        });
      }
      // Only assert when the body itself passed: a failing test already
      // reports its own error, and this would mask it.
      if (testInfo.status === "passed") {
        expect(
          unexpected.map((p) => `${p.kind}: ${p.text}  @ ${p.page}`),
          "console errors / CSP violations / page errors / failed same-origin requests",
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
