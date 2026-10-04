// Behavioural contract for three user-facing paths in docs/assets/theme.js:
//
//   1. submitTheme()'s "exists" branch — the server-returned slug (not the
//      raw free-text input) drives the follow-up link, and an invalid
//      server slug degrades to a linkless banner instead of a dead link.
//   2. renderHeader()'s paper_count guard — a malformed (string / markup)
//      paper_count must never reach innerHTML as markup; it renders as 0.
//   3. submitTheme()'s Worker-failure status -> Japanese message mapping
//      (403/413/415/502/503), the Issue-fallback link reuse for 502/503,
//      and that "invalid"/"rate_limited" messages are shown verbatim,
//      unchanged by the mapping.
//   4. showProgressFailure()'s runUrl handling — the GitHub Actions run
//      link (run.html_url, sourced from the Worker's proxy of the GitHub
//      runs API) must only ever become a clickable link when it is an
//      https:// URL whose host is exactly github.com. Anything else
//      (javascript:, http:, a lookalike host) must render the failure
//      text with no link at all, never a dangerous href.
//
// Unlike test_theme_lineage_contract.mjs's loadViewer() (which stubs out
// render/renderHeader/etc. to isolate init()'s control flow), this harness
// loads theme.js with those functions intact so they can be exercised
// directly — and loads the REAL escapeHtml/formatStars from utils.js
// (not a no-op stub), since every assertion here is specifically about
// whether untrusted strings get escaped before reaching innerHTML.
//
// Run via: node paperpilot/tests/viewer/test_theme_submit_contract.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const THEME_JS = resolve(here, "../../../docs/assets/theme.js");
const UTILS_JS = resolve(here, "../../../docs/assets/utils.js");

let passed = 0;
let failed = 0;
function ok(condition, label) {
  if (condition) {
    console.log(`  ok  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
}

function makeStubElement(id = "") {
  return {
    id,
    value: "",
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    dataset: {},
    children: [],
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    listenerTypes: [],
    addEventListener(type) { this.listenerTypes.push(type); },
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    insertAdjacentHTML() {},
    insertBefore(node) { return node; },
    cloneNode() { return makeStubElement(); },
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() {},
    focus() {},
  };
}

// apiBase === null reproduces the degraded (no-Worker-configured) path;
// a string reproduces the normal POST path with that Worker origin.
function loadViewer({ apiBase = "https://paperpilot-themes.example.workers.dev" } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeStubElement(id));
    return elements.get(id);
  };
  const metaApiBase = { getAttribute: (name) => (name === "content" ? apiBase : null) };

  const ctx = {
    document: {
      getElementById: (id) => element(id),
      querySelector: (sel) => (sel === 'meta[name="paperpilot-api-base"]' ? metaApiBase : null),
      querySelectorAll: () => [],
      createElement: () => makeStubElement(),
      createElementNS: () => makeStubElement(),
      fonts: { ready: Promise.resolve() },
      documentElement: element("document-element"),
      title: "",
    },
    window: {
      location: {
        search: "",
        pathname: "/automatic-paper-search/themes/",
        href: "http://localhost/themes/",
      },
      history: { replaceState() {}, pushState() {} },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
      removeEventListener() {},
      open() {},
      scrollTo() {},
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // Overwritten per-test via ctx.fetch = ...; this default makes an
    // unstubbed fetch call fail loudly instead of hanging.
    fetch: async () => { throw new Error("fetch not stubbed for this test"); },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    crypto: globalThis.crypto,
    TextDecoder,
    URL,
    URLSearchParams,
    Promise,
    Map,
    Set,
    Math,
    JSON,
    Date,
    console,
    setTimeout,
    clearTimeout,
  };
  ctx.window.localStorage = ctx.localStorage;
  ctx.window.document = ctx.document;
  // window.fetch indirection lets tests reassign ctx.fetch per-case while
  // theme.js (which calls the bare global `fetch`) picks up the change.
  ctx.window.fetch = (...args) => ctx.fetch(...args);
  Object.defineProperty(ctx, "fetch", {
    value: ctx.fetch,
    writable: true,
    enumerable: true,
  });
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  // Real escapeHtml/formatStars from utils.js — this file's whole point is
  // asserting real escaping behavior, so a `(s) => String(s)` stub would
  // make every XSS assertion here vacuous.
  const utilsSrc = readFileSync(UTILS_JS, "utf8");
  vm.runInContext(utilsSrc, ctx, { filename: "utils.js" });

  const themeSrcStripped = readFileSync(THEME_JS, "utf8")
    .replace(/\binit\(\);\s*$/, "");
  const probe = `
    globalThis.__test = {
      state, els,
      renderHeader, submitTheme, issueUrlFor,
      localizedFailureMessage,
      showProgressFailure, safeRunUrl,
    };
  `;
  vm.runInContext(themeSrcStripped + "\n" + probe, ctx, { filename: "theme.js" });
  return { ctx, element };
}

function setFetchJson(ctx, status, body) {
  ctx.fetch = async () => ({
    status,
    json: async () => body,
  });
}

console.log("submitTheme(): \"exists\" branch");

{
  const { ctx, element } = loadViewer();
  setFetchJson(ctx, 200, { ok: true, status: "exists", slug: "mixture-of-experts" });
  element("theme-request-input").value = "Mixture of Experts";
  await ctx.__test.submitTheme();
  const status = element("theme-request-status");
  ok(status.hidden === false && status.dataset.kind === "ok",
     "valid server slug shows an ok status banner");
  ok(status.innerHTML.includes('href="?theme=mixture-of-experts"'),
     "valid server slug builds the follow-up link from the SERVER slug, not the raw input");
  ok(!status.innerHTML.includes("Mixture%20of%20Experts") && !status.innerHTML.includes("Mixture of Experts"),
     "the raw free-text input is never spliced into the ?theme= link");
}

{
  const { ctx, element } = loadViewer();
  setFetchJson(ctx, 200, { ok: true, status: "exists", slug: "../x" });
  element("theme-request-input").value = "Mixture of Experts";
  await ctx.__test.submitTheme();
  const status = element("theme-request-status");
  ok(!status.innerHTML.includes("<a "), "an invalid server slug (path-traversal shape) produces no link");
  ok(status.innerHTML.includes("テーマ一覧から確認してください"),
     "an invalid server slug falls back to the linkless banner, not a dead link");
}

console.log("\nrenderHeader(): paper_count guard");

{
  const { ctx, element } = loadViewer();
  const viewer = ctx.__test;
  viewer.state.currentSlug = "evil-theme";
  viewer.state.manifest = [{ slug: "evil-theme", paper_count: "<img onerror=x>" }];
  viewer.state.data = { meta: {} };
  viewer.renderHeader();
  const meta = element("theme-meta");
  ok(!meta.innerHTML.includes("<img"),
     "a malicious string paper_count never reaches innerHTML as markup");
  ok(meta.innerHTML.includes("📄 0 papers"),
     "a non-integer paper_count renders as 0, not the raw value");
}

{
  // Sanity check: a well-formed numeric paper_count still renders normally
  // (guards the test above actually exercises the guard, not a branch
  // that always renders 0 regardless of input).
  const { ctx, element } = loadViewer();
  const viewer = ctx.__test;
  viewer.state.currentSlug = "good-theme";
  viewer.state.manifest = [{ slug: "good-theme", paper_count: 7 }];
  viewer.state.data = { meta: {} };
  viewer.renderHeader();
  ok(element("theme-meta").innerHTML.includes("📄 7 papers"),
     "a well-formed numeric paper_count still renders as-is");
}

console.log("\nsubmitTheme(): Worker-failure status -> Japanese message mapping");

const MAPPED_FAILURES = [
  {
    status: 403,
    serverMessage: "request origin is not allowed",
    expectJa: "このページ以外からの依頼は受け付けていません",
    expectIssueLink: false,
  },
  {
    status: 413,
    serverMessage: "request body exceeds the 1KB limit",
    expectJa: "依頼の形式が正しくありません",
    expectIssueLink: false,
  },
  {
    status: 415,
    serverMessage: "content-type must be application/json",
    expectJa: "依頼の形式が正しくありません",
    expectIssueLink: false,
  },
  {
    status: 502,
    serverMessage: "could not start the generation job; please retry shortly",
    expectJa: "GitHub への依頼に失敗しました。時間をおいて再度お試しください",
    expectIssueLink: true,
  },
  {
    status: 503,
    serverMessage: "could not verify existing themes; please retry shortly",
    expectJa: "既存テーマの確認に失敗しました。時間をおいて再度お試しください",
    expectIssueLink: true,
  },
];

for (const c of MAPPED_FAILURES) {
  const { ctx, element } = loadViewer();
  setFetchJson(ctx, c.status, { ok: false, status: "error", message: c.serverMessage });
  element("theme-request-input").value = "Vision Transformer";
  await ctx.__test.submitTheme();
  const html = element("theme-request-status").innerHTML;
  ok(html.includes(c.expectJa), `HTTP ${c.status} maps to the expected Japanese UI text`);
  ok(!html.includes(c.serverMessage), `HTTP ${c.status} does not leak the Worker's raw English message`);
  ok(html.includes("GitHub Issue") === c.expectIssueLink,
     `HTTP ${c.status} ${c.expectIssueLink ? "shows" : "does not show"} the Issue-fallback link`);
  if (c.expectIssueLink) {
    ok(html.includes(ctx.__test.issueUrlFor("Vision Transformer").replace(/&/g, "&amp;")),
       `HTTP ${c.status}'s Issue link reuses issueUrlFor(), not a second URL builder`);
  }
}

{
  // A Worker message that already contains Japanese must pass through
  // unchanged — the static map must never clobber a future Worker
  // revision that starts localising its own messages.
  const { ctx, element } = loadViewer();
  const jaMessage = "日本語の既存メッセージ";
  setFetchJson(ctx, 503, { ok: false, status: "error", message: jaMessage });
  element("theme-request-input").value = "Vision Transformer";
  await ctx.__test.submitTheme();
  ok(element("theme-request-status").innerHTML.includes(jaMessage),
     "an already-Japanese Worker message is shown verbatim, not overridden by the status map");
}

{
  // "rate_limited" must stay exactly as it is today — verbatim Worker
  // message, no mapping, no Issue link.
  const { ctx, element } = loadViewer();
  const msg = "more than 5 new themes/hour from this IP";
  setFetchJson(ctx, 429, { ok: false, status: "rate_limited", message: msg });
  element("theme-request-input").value = "Vision Transformer";
  await ctx.__test.submitTheme();
  const html = element("theme-request-status").innerHTML;
  ok(html.includes(msg), "rate_limited message is shown verbatim, unchanged by the status mapping");
  ok(!html.includes("GitHub Issue"), "rate_limited never shows the Issue-fallback link");
}

{
  // "invalid" must also stay verbatim — and this is the one case where
  // the Worker message is attacker-influenced in principle (it's not
  // today, but the escaping must hold regardless), so assert escaping.
  const { ctx, element } = loadViewer();
  setFetchJson(ctx, 400, { ok: false, status: "invalid", message: "<img onerror=x>" });
  element("theme-request-input").value = "Vision Transformer";
  await ctx.__test.submitTheme();
  const html = element("theme-request-status").innerHTML;
  ok(!html.includes("<img"), "an invalid-status Worker message is escaped before reaching innerHTML");
}

console.log("\nshowProgressFailure(): runUrl scheme/host gating");

function linkIn(msgEl) {
  return msgEl.children.find((c) => typeof c.href === "string");
}

const UNSAFE_RUN_URLS = [
  ["javascript:alert(1)", "javascript: scheme"],
  ["http://github.com/owner/repo/actions/runs/1", "http: (non-https) github.com"],
  ["https://evil.test/owner/repo", "a non-github.com host"],
];

for (const [runUrl, label] of UNSAFE_RUN_URLS) {
  const { ctx, element } = loadViewer();
  ctx.__test.showProgressFailure({
    title: "失敗しました",
    message: "メッセージ",
    runUrl,
  });
  const msg = element("theme-progress-failure-msg");
  ok(linkIn(msg) === undefined, `${label} → no <a> link is rendered`);
  ok(!JSON.stringify(msg.children).includes("javascript:") &&
     !JSON.stringify(msg.children).includes("evil.test"),
     `${label} → the rejected URL never reaches any rendered node`);
}

{
  const { ctx, element } = loadViewer();
  const validRunUrl = "https://github.com/owner/repo/actions/runs/1";
  ctx.__test.showProgressFailure({
    title: "失敗しました",
    message: "メッセージ",
    runUrl: validRunUrl,
  });
  const msg = element("theme-progress-failure-msg");
  const link = linkIn(msg);
  ok(link !== undefined, "a valid https://github.com/... run URL → a link is rendered");
  ok(link?.href === validRunUrl, "the rendered link's href is exactly the valid run URL");
  ok(link?.target === "_blank" && link?.rel === "noopener noreferrer",
     "the rendered link keeps target=_blank + rel=noopener noreferrer");
}

{
  // No runUrl at all must still behave like today: failure text with no link.
  const { ctx, element } = loadViewer();
  ctx.__test.showProgressFailure({ title: "失敗しました", message: "メッセージ" });
  ok(linkIn(element("theme-progress-failure-msg")) === undefined,
     "no runUrl → no link is rendered");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
