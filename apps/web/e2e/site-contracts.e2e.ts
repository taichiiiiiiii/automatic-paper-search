/**
 * HTTP-level contracts of the deployed site: security and cache headers,
 * mixed content, sitemap.xml / robots.txt, canonical + Open Graph tags and
 * legacy redirects. All read-only and tagged @prod, so the post-release
 * production smoke (E2E_BASE_URL=https://paperpilot.pages.dev) runs them;
 * locally they check what the build's `_headers` / `_redirects` / postbuild
 * files would make Cloudflare Pages serve (e2e/support/static-server.mjs).
 */
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, PROD, test } from "./support/fixtures";
import { CANONICAL_ORIGIN, conferences, IS_REMOTE, publishedThemes } from "./support/site";

/** One page per family (the theme page is the shared /themes/ document). */
const HTML_PAGES = ["/", "/themes/", "/how-it-works/", "/neurips-2025/"] as const;

async function get(request: APIRequestContext, path: string): Promise<APIResponse> {
  return request.get(path, { maxRedirects: 0, failOnStatusCode: false });
}

function maxAge(cacheControl: string): number | null {
  const m = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
  return m ? Number(m[1]) : null;
}

/** HTML and data must be revalidated on every release (they change in
 * place under the same URL): no-store/no-cache, or max-age<=600, or
 * must-revalidate with max-age=0. */
function expectRevalidated(cacheControl: string | undefined, what: string): void {
  const cc = (cacheControl ?? "").toLowerCase();
  if (/no-store|no-cache/.test(cc)) return;
  const age = maxAge(cc);
  expect(age, `${what}: Cache-Control "${cc}" must bound max-age`).not.toBeNull();
  expect(age!, `${what}: Cache-Control "${cc}" caches a mutable URL too long`).toBeLessThanOrEqual(
    600,
  );
  expect(cc, `${what}: mutable URL must not be immutable`).not.toContain("immutable");
}

async function nextStaticAsset(request: APIRequestContext): Promise<string> {
  const html = await (await get(request, "/")).text();
  const m = /(?:src|href)="(\/_next\/static\/[^"]+\.(?:js|css))"/.exec(html);
  expect(m, "/ references a /_next/static asset").not.toBeNull();
  return m![1]!;
}

test.describe("response headers", () => {
  test.skip(({ isMobile }) => isMobile, "HTTP-level checks: the desktop project covers them");
  test("security headers on HTML, data, feeds and assets", PROD, async ({ request, baseURL }) => {
    const theme = publishedThemes()[0]!;
    const paths = [
      ...HTML_PAGES,
      "/conferences.json",
      `/themes/${theme.slug}/lineage.json`,
      await nextStaticAsset(request),
      "/sitemap.xml",
    ];
    const https = new URL(baseURL!).protocol === "https:";
    for (const path of paths) {
      const res = await get(request, path);
      expect(res.status(), path).toBe(200);
      const h = res.headers();
      expect(h["content-security-policy"], `${path}: CSP header`).toContain(
        "frame-ancestors 'self'",
      );
      expect(h["x-content-type-options"], `${path}: X-Content-Type-Options`).toBe("nosniff");
      expect(h["referrer-policy"], `${path}: Referrer-Policy`).toMatch(
        /^(strict-origin-when-cross-origin|strict-origin|same-origin|no-referrer)$/,
      );
      if (https) {
        const hsts = h["strict-transport-security"] ?? "";
        expect(hsts, `${path}: Strict-Transport-Security`).toMatch(/max-age=\d+/);
        expect(maxAge(hsts) ?? 0, `${path}: HSTS max-age >= 180 days`).toBeGreaterThanOrEqual(
          15_552_000,
        );
      }
      expect(h["content-type"], `${path}: Content-Type`).toBeTruthy();
    }
  });

  test(
    "HTML pages carry a strict meta CSP and the right content type",
    PROD,
    async ({ request }) => {
      for (const path of HTML_PAGES) {
        const res = await get(request, path);
        expect(res.headers()["content-type"], path).toMatch(/^text\/html/);
        const html = await res.text();
        const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
        expect(m, `${path}: meta CSP`).not.toBeNull();
        const csp = m![1]!;
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("base-uri 'self'");
        const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? "";
        expect(scriptSrc, `${path}: script-src`).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*/);
      }
    },
  );

  test(
    "cache headers: mutable URLs revalidate, hashed assets are immutable",
    PROD,
    async ({ request }) => {
      for (const path of [...HTML_PAGES, "/conferences.json", "/lineage-quality-v1.json"]) {
        const res = await get(request, path);
        expectRevalidated(res.headers()["cache-control"], path);
      }
      const asset = await nextStaticAsset(request);
      const cc = (await get(request, asset)).headers()["cache-control"] ?? "";
      expect(cc, `${asset}: hashed asset`).toContain("immutable");
      expect(maxAge(cc) ?? 0, `${asset}: hashed asset max-age`).toBeGreaterThanOrEqual(31_536_000);
      // A missing page must not be cached as if it were content.
      const missing = await get(request, "/__e2e_missing__/");
      expect(missing.status()).toBe(404);
      expectRevalidated(missing.headers()["cache-control"], "404");
    },
  );
});

test.describe("mixed content", () => {
  test("pages load no insecure (http:) subresources", PROD, async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const insecure: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.startsWith("http:") && new URL(url).origin !== origin) insecure.push(url);
      if (origin.startsWith("https:") && url.startsWith("http:")) insecure.push(url);
    });
    const theme = publishedThemes()[0]!;
    for (const path of [...HTML_PAGES, `/themes/?theme=${theme.slug}`]) {
      await page.goto(path);
      // networkidle, not load: the theme pages fetch their side files
      // (new-papers.json, code-links.json) after load, and WebKit reports
      // such a fetch cancelled by the next goto as a page error. Waiting
      // also lets the listener above see every late subresource request.
      await page.waitForLoadState("networkidle");
      const attrs = await page
        .locator("script[src], link[href], img[src], iframe[src], source[src], video[src]")
        .evaluateAll((els) =>
          els
            .filter((e) => !(e instanceof HTMLLinkElement) || e.rel !== "canonical")
            .map((e) => e.getAttribute("src") ?? e.getAttribute("href") ?? ""),
        );
      for (const a of attrs) expect(a, `${path}: subresource URL`).not.toMatch(/^http:/);
    }
    expect([...new Set(insecure)]).toEqual([]);
  });
});

test.describe("sitemap.xml and robots.txt", () => {
  test.skip(({ isMobile }) => isMobile, "HTTP-level checks: the desktop project covers them");
  test("sitemap.xml is valid and lists only canonical, live pages", PROD, async ({ request }) => {
    const res = await get(request, "/sitemap.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/xml/);
    const xml = await res.text();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs.length).toBeGreaterThan(0);
    expect(new Set(locs).size, "no duplicate <loc>").toBe(locs.length);
    for (const loc of locs) expect(loc.startsWith(`${CANONICAL_ORIGIN}/`), loc).toBe(true);
    const paths = locs.map((l) => new URL(l).pathname);
    expect(paths).toContain("/");
    expect(paths).toContain("/themes/");
    for (const c of conferences()) expect(paths, c.name).toContain(`/${c.name}/`);
    // Every listed page answers 200 and declares itself canonical.
    for (const path of paths) {
      const page = await get(request, path);
      expect(page.status(), path).toBe(200);
      const html = await page.text();
      expect(html, `${path}: canonical`).toContain(
        `<link rel="canonical" href="${CANONICAL_ORIGIN}${path}"/>`,
      );
    }
  });

  test("robots.txt allows crawling and points at the sitemap", PROD, async ({ request }) => {
    const res = await get(request, "/robots.txt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
    const txt = await res.text();
    expect(txt, "a User-agent group").toMatch(/^User-agent:\s*\*\s*$/im);
    expect(txt, "Sitemap line").toMatch(
      new RegExp(
        `^Sitemap:\\s*${CANONICAL_ORIGIN.replace(/[.]/g, "\\.")}/sitemap\\.xml\\s*$`,
        "im",
      ),
    );
    expect(txt, "the site is not blocked").not.toMatch(/^Disallow:\s*\/\s*$/im);
  });
});

test.describe("canonical and Open Graph metadata", () => {
  for (const path of HTML_PAGES) {
    test(`${path}: canonical, OG and Twitter tags`, PROD, async ({ page, request }) => {
      await page.goto(path);
      const canonical = page.locator("link[rel='canonical']");
      await expect(canonical).toHaveCount(1);
      await expect(canonical).toHaveAttribute("href", `${CANONICAL_ORIGIN}${path}`);
      const meta = (sel: string) => page.locator(`meta[${sel}]`).first().getAttribute("content");
      expect(await meta("property='og:url'")).toBe(`${CANONICAL_ORIGIN}${path}`);
      expect((await meta("property='og:title'")) ?? "").toMatch(/\S/);
      expect((await meta("property='og:description'")) ?? "").toMatch(/\S/);
      expect((await meta("name='description'")) ?? "").toMatch(/\S/);
      expect(await meta("property='og:type'")).toBeTruthy();
      expect(await meta("name='twitter:card'")).toBe("summary_large_image");
      const image = (await meta("property='og:image'")) ?? "";
      expect(image.startsWith(`${CANONICAL_ORIGIN}/`), `og:image ${image}`).toBe(true);
      const img = await get(request, new URL(image).pathname);
      expect(img.status(), image).toBe(200);
      expect(img.headers()["content-type"]).toMatch(/^image\//);
      await expect(page.locator("html")).toHaveAttribute("lang", "ja");
      await expect(page).toHaveTitle(/PaperPilot/);
    });
  }
});

test.describe("redirects", () => {
  test.skip(({ isMobile }) => isMobile, "HTTP-level checks: the desktop project covers them");
  const LEGACY: [string, string][] = [
    ["/index.html", "/"],
    ["/neurips-2025/index.html?q=diffusion", "/neurips-2025/?q=diffusion"],
    ["/neurips-2025/lineage.html", "/neurips-2025/lineage/"],
    ["/neurips-2025/deep.html", "/neurips-2025/deep/"],
    ["/neurips-2025/paper-links.html", "/neurips-2025/paper-links/"],
  ];

  test(
    "legacy .html URLs 301 to the directory URL, keeping the query",
    PROD,
    async ({ request, baseURL }) => {
      for (const [from, to] of LEGACY) {
        const res = await get(request, from);
        expect(res.status(), from).toBe(301);
        const loc = new URL(res.headers().location ?? "", baseURL);
        expect(`${loc.pathname}${loc.search}`, from).toBe(to);
      }
    },
  );

  test(
    "slash-less directory URLs redirect to the trailing-slash URL",
    PROD,
    async ({ request, baseURL }) => {
      for (const from of ["/how-it-works", "/neurips-2025", "/themes"]) {
        const res = await get(request, from);
        expect([301, 308], from).toContain(res.status());
        expect(new URL(res.headers().location ?? "", baseURL).pathname).toBe(`${from}/`);
      }
    },
  );

  test("the old GitHub Pages site forwards to the same page here", PROD, async ({ request }) => {
    test.skip(!IS_REMOTE, "external site; checked only in remote (production) runs");
    const old = "https://taichiiiiiiii.github.io/automatic-paper-search";
    for (const [from, to] of [
      ["/", "/"],
      ["/neurips-2025/", "/neurips-2025/"],
    ] as const) {
      const res = await request.get(`${old}${from}`, { failOnStatusCode: false });
      expect(res.status(), `${old}${from}`).toBe(200);
      const html = await res.text();
      expect(html).toContain(
        `<meta http-equiv="refresh" content="0; url=${CANONICAL_ORIGIN}${to}">`,
      );
      expect(html).toContain(`<link rel="canonical" href="${CANONICAL_ORIGIN}${to}">`);
      expect(html).toMatch(/<meta name="robots" content="noindex">/);
    }
  });
});
