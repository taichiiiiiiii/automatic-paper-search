/**
 * Broken-link crawler (@prod-crawl; slower, run separately from @prod):
 *
 * 1. Breadth-first crawl of same-origin pages from `/` to depth 2 (capped at
 *    E2E_CRAWL_MAX_PAGES, default 300), following `<a href>` in the served
 *    HTML; every same-origin link and subresource (`src`, `<link href>`)
 *    found on a crawled page must answer < 400.
 * 2. Every `/<conf>/paper-links/` no-JS page of a few sampled catalogs.
 * 3. A small sample of external scholarly links (arXiv, OpenReview, DOI,
 *    ACL Anthology, CVF) checked by HEAD (GET when HEAD is refused), one at
 *    a time with a pause. Only a definite 404/410 fails; 429, 5xx, bot walls
 *    (401/403) and network errors are reported as annotations, never as a
 *    failure, because they say nothing about our links.
 *
 * Uses Playwright's APIRequestContext (no page rendering), so links that
 * only exist after client-side rendering are covered by the @prod UI tests
 * instead. Opt-in locally (E2E_CRAWL=1); always on with E2E_BASE_URL.
 *
 *   E2E_BASE_URL=https://paperpilot.pages.dev pnpm --filter @paperpilot/web \
 *     exec playwright test --grep @prod-crawl --project desktop-chromium
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { conferences, IS_REMOTE, paperLinksPages, publishedThemes } from "./support/site";

const MAX_PAGES = Number(process.env.E2E_CRAWL_MAX_PAGES ?? 300);
const MAX_DEPTH = Number(process.env.E2E_CRAWL_DEPTH ?? 2);
const CONCURRENCY = 4;
const EXTERNAL_PER_HOST = Number(process.env.E2E_CRAWL_EXTERNAL_PER_HOST ?? 3);
const EXTERNAL_PAUSE_MS = 1_500;

const EXTERNAL_HOSTS: Record<string, RegExp> = {
  arxiv: /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//,
  openreview: /^https?:\/\/openreview\.net\/(?:forum|pdf)\?id=/,
  doi: /^https?:\/\/(?:dx\.)?doi\.org\/10\./,
  acl: /^https?:\/\/aclanthology\.org\//,
  cvf: /^https?:\/\/openaccess\.thecvf\.com\//,
};

interface Found {
  url: string;
  from: string;
  status: number | string;
}

const ATTR_RE = /<(a|link|script|img|source|iframe)\b[^>]*?\s(href|src)="([^"]+)"/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}

/** Links in served HTML: `a` = navigable pages, `res` = subresources. */
function extractLinks(html: string, base: string): { a: string[]; res: string[] } {
  const a: string[] = [];
  const res: string[] = [];
  for (const m of html.matchAll(ATTR_RE)) {
    const tag = m[1]!.toLowerCase();
    const raw = decodeEntities(m[3]!);
    if (/^(?:mailto:|tel:|javascript:|data:|#)/i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    url.hash = "";
    if (tag === "link" && /rel="(?:canonical|alternate|preconnect|dns-prefetch)"/.test(m[0])) {
      continue;
    }
    (tag === "a" ? a : res).push(url.toString());
  }
  return { a, res };
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

async function status(request: APIRequestContext, url: string): Promise<number | string> {
  try {
    const res = await request.get(url, {
      maxRedirects: 5,
      failOnStatusCode: false,
      timeout: 30_000,
    });
    return res.status();
  } catch (e) {
    return `error: ${(e as Error).message.split("\n")[0]}`;
  }
}

test.describe("broken-link crawl", { tag: "@prod-crawl" }, () => {
  test.skip(!IS_REMOTE && !process.env.E2E_CRAWL, "opt-in locally: E2E_CRAWL=1");
  test.skip(({ isMobile }) => isMobile, "HTTP-level crawl; one browser project is enough");

  test("same-origin pages, links and assets resolve; sampled external links exist", async ({
    request,
    baseURL,
  }) => {
    test.setTimeout(20 * 60_000);
    const origin = new URL(baseURL!).origin;
    const broken: Found[] = [];
    const checked = new Map<string, number | string>();
    const external = new Map<string, string>(); // url -> first page linking it

    async function check(url: string, from: string): Promise<number | string> {
      const known = checked.get(url);
      if (known !== undefined) {
        if (typeof known !== "number" || known >= 400) broken.push({ url, from, status: known });
        return known;
      }
      const s = await status(request, url);
      checked.set(url, s);
      if (typeof s !== "number" || s >= 400) broken.push({ url, from, status: s });
      return s;
    }

    // 1. BFS over served HTML.
    const seen = new Set<string>([`${origin}/`]);
    let frontier = [`${origin}/`];
    const crawled: string[] = [];
    const extra = publishedThemes()
      .slice(0, 1)
      .map((t) => `${origin}/themes/?theme=${t.slug}`);
    for (const u of extra) seen.add(u);
    frontier.push(...extra);
    for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      const batch = frontier.slice(0, Math.max(0, MAX_PAGES - crawled.length));
      await pool(batch, CONCURRENCY, async (pageUrl) => {
        let res: Awaited<ReturnType<APIRequestContext["get"]>>;
        try {
          res = await request.get(pageUrl, { failOnStatusCode: false, timeout: 60_000 });
        } catch (e) {
          broken.push({ url: pageUrl, from: "(crawl)", status: String(e) });
          return;
        }
        checked.set(pageUrl, res.status());
        crawled.push(pageUrl);
        if (res.status() >= 400) {
          broken.push({ url: pageUrl, from: "(crawl)", status: res.status() });
          return;
        }
        if (!(res.headers()["content-type"] ?? "").startsWith("text/html")) return;
        const { a, res: assets } = extractLinks(await res.text(), res.url());
        for (const r of assets) if (r.startsWith(origin)) await check(r, pageUrl);
        for (const link of a) {
          if (!link.startsWith(`${origin}/`)) {
            if (!external.has(link)) external.set(link, pageUrl);
            continue;
          }
          if (seen.has(link)) continue;
          seen.add(link);
          next.push(link);
        }
      });
      if (depth === MAX_DEPTH) {
        // Links found on the last level are checked, not crawled.
        await pool(next, CONCURRENCY, async (u) => {
          await check(u, "(depth limit)");
        });
        break;
      }
      frontier = next;
    }

    // 2. Sampled no-JS paper-links pages (first, middle and last catalog).
    const confs = conferences().map((c) => c.name);
    const sample = [...new Set([confs[0], confs[Math.floor(confs.length / 2)], confs.at(-1)])];
    for (const conf of sample) {
      if (!conf) continue;
      for (const n of paperLinksPages(conf)) {
        const url = `${origin}/${conf}/paper-links/${n === 1 ? "" : `${n}/`}`;
        const res = await request.get(url, { failOnStatusCode: false, timeout: 60_000 });
        checked.set(url, res.status());
        if (res.status() >= 400) {
          broken.push({ url, from: "(paper-links sample)", status: res.status() });
          continue;
        }
        for (const link of extractLinks(await res.text(), url).a) {
          if (!link.startsWith(origin) && !external.has(link)) external.set(link, url);
        }
      }
    }

    // Theme pages render their paper links client-side: take arXiv/DOI
    // links from the first published theme's lineage.json instead.
    for (const t of publishedThemes().slice(0, 1)) {
      const url = `${origin}/themes/${t.slug}/lineage.json`;
      const res = await request.get(url, { failOnStatusCode: false });
      if (res.status() >= 400) {
        broken.push({ url, from: "(theme data)", status: res.status() });
        continue;
      }
      const text = await res.text();
      const from = `${origin}/themes/?theme=${t.slug}`;
      for (const m of text.matchAll(/"arxiv_id":\s*"([^"]+)"/g)) {
        external.set(`https://arxiv.org/abs/${m[1]}`, from);
      }
      for (const m of text.matchAll(/"doi":\s*"(10\.[^"]+)"/g)) {
        if (!/^10\.48550\//i.test(m[1]!)) external.set(`https://doi.org/${m[1]}`, from);
      }
    }

    // 3. External sample: a few links per scholarly host, sequential.
    const picked: [string, string, string][] = [];
    for (const [host, re] of Object.entries(EXTERNAL_HOSTS)) {
      const matches = [...external].filter(([u]) => re.test(u));
      // Spread the sample over the list instead of the first N rows.
      const step = Math.max(1, Math.floor(matches.length / EXTERNAL_PER_HOST));
      for (
        let i = 0;
        i < matches.length && picked.filter((p) => p[0] === host).length < EXTERNAL_PER_HOST;
        i += step
      ) {
        picked.push([host, matches[i]![0], matches[i]![1]]);
      }
    }
    const externalBroken: Found[] = [];
    const externalSkipped: string[] = [];
    for (const [host, url, from] of picked) {
      let s: number | string;
      try {
        const head = await request.head(url, {
          maxRedirects: 5,
          failOnStatusCode: false,
          timeout: 20_000,
        });
        s = head.status();
        if (s === 405 || s === 403 || s === 400) {
          const get = await request.get(url, {
            maxRedirects: 5,
            failOnStatusCode: false,
            timeout: 20_000,
          });
          s = get.status();
          await get.dispose();
        }
      } catch (e) {
        s = `error: ${(e as Error).message.split("\n")[0]}`;
      }
      if (s === 404 || s === 410) externalBroken.push({ url, from, status: s });
      else if (typeof s !== "number" || s >= 400) externalSkipped.push(`${host} ${s} ${url}`);
      await new Promise((r) => setTimeout(r, EXTERNAL_PAUSE_MS));
    }

    const info = test.info();
    info.annotations.push(
      { type: "crawled-pages", description: String(crawled.length) },
      { type: "checked-urls", description: String(checked.size) },
      { type: "external-checked", description: picked.map((p) => p[1]).join(" ") || "(none)" },
    );
    if (externalSkipped.length > 0) {
      info.annotations.push({
        type: "external-inconclusive",
        description: externalSkipped.join("; "),
      });
    }
    await info.attach("crawl.json", {
      body: JSON.stringify({ crawled, broken, externalBroken, externalSkipped, picked }, null, 2),
      contentType: "application/json",
    });

    expect(crawled.length, "crawled at least the landing page family").toBeGreaterThan(5);
    expect(
      [...new Set(broken.map((b) => `${b.status} ${b.url}  (linked from ${b.from})`))],
      "same-origin 4xx/5xx",
    ).toEqual([]);
    expect(
      externalBroken.map((b) => `${b.status} ${b.url}  (linked from ${b.from})`),
      "external links that do not exist (404/410)",
    ).toEqual([]);
  });
});
