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
 *   Aborted requests are ignored (Chromium `net::ERR_ABORTED`, Firefox
 *   `NS_BINDING_ABORTED`, WebKit "cancelled"): Next cancels in-flight RSC
 *   prefetches when a navigation starts, which is normal.
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

/** A request cancelled by the page (e.g. Next aborting an RSC prefetch when
 * a navigation starts), in each engine's wording: Chromium
 * `net::ERR_ABORTED`, Firefox `NS_BINDING_ABORTED`, WebKit
 * "Load request cancelled" / "cancelled". */
const ABORTED = /ERR_ABORTED|NS_BINDING_ABORTED|^(Load request )?cancelled$/i;

/** WebKit engine bug, not an app problem: every native `<select>` applies
 * an inline style inside its user-agent shadow tree, which WebKit checks
 * against the PAGE's CSP (`style-src 'self'`) and reports as a
 * `style-src-attr` violation (plus a "Refused to apply a stylesheet"
 * console error). Reproduced with a bare `<select><option>a</option>
 * </select>` page; Chromium and Firefox do not report it. The event
 * targets the SELECT, or the document when React builds the select
 * off-DOM during a client-side render. Only these exact reports are
 * ignored, and only in WebKit: the Chromium projects run the same app code
 * and still catch any real inline style (style props included), and an
 * inline style on a connected element is still caught here
 * (guard.e2e.ts). */
const WEBKIT_SELECT_UA_STYLE = /^\S+ style-src-attr blocked=inline target=(SELECT|#document)$/;

/** Next logs this when an in-flight RSC fetch (link prefetch / soft
 * navigation) dies because the test navigates away mid-request; WebKit and
 * Firefox surface the cancelled fetch as a network TypeError, Chromium as a
 * silent abort. Next then falls back to a normal navigation. A payload
 * that is really missing still fails the test as an `http: 404`. */
const RSC_FETCH_CANCELLED =
  /^Failed to fetch RSC payload for .*Falling back to browser navigation\. TypeError: (Load failed|NetworkError when attempting to fetch resource\.)/;

function attach(
  page: Page,
  origin: string,
  problems: PageProblem[],
  jsEnabled: boolean,
  browserName: string,
): void {
  const where = () => page.url();
  const webkit = browserName === "webkit";
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const tagged = text.includes(CSP_TAG);
    if (webkit) {
      // WebKit's native CSP console line carries no element, so it cannot
      // be told apart from the <select> noise above; the tagged
      // `securitypolicyviolation` report (which fires for every violation)
      // stands in for it there.
      if (!tagged && /Content Security Policy/i.test(text)) return;
      if (tagged && WEBKIT_SELECT_UA_STYLE.test(text)) return;
    }
    if (RSC_FETCH_CANCELLED.test(text)) return;
    const loc = tagged ? undefined : msg.location()?.url;
    const kind = tagged || /Content Security Policy/i.test(text) ? "csp" : "console";
    problems.push({ kind, text: loc ? `${text} (${loc})` : text, page: where() });
  });
  page.on("pageerror", (err) => {
    problems.push({ kind: "pageerror", text: `${err.name}: ${err.message}`, page: where() });
  });
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "unknown";
    if (ABORTED.test(failure)) return;
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
      { context, baseURL, allowedProblems, pageProblems, javaScriptEnabled, browserName },
      use,
      testInfo,
    ) => {
      const js = javaScriptEnabled !== false;
      const origin = new URL(baseURL ?? "http://127.0.0.1").origin;
      // Runs before any page script (and is unaffected by the page CSP).
      await context.addInitScript((tag: string) => {
        document.addEventListener("securitypolicyviolation", (e) => {
          const t = e.target as Element | null;
          const target = t && "nodeName" in t ? t.nodeName : "document";
          console.error(
            `${tag} ${e.violatedDirective} blocked=${e.blockedURI || "inline"} target=${target}`,
          );
        });
      }, CSP_TAG);
      for (const p of context.pages()) attach(p, origin, pageProblems, js, browserName);
      context.on("page", (p) => attach(p, origin, pageProblems, js, browserName));
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
