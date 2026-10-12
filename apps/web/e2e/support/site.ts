/**
 * Test data the suite derives from the site under test, so it follows
 * whatever is published instead of hard-coding theme/conference lists.
 *
 * - Local mode (default): read from the built static export (apps/web/out).
 * - Remote mode (`E2E_BASE_URL=https://…`): read the same files from the
 *   remote site over HTTP, so a production run is checked against what
 *   production actually serves, not against a local build that may be
 *   newer or older (or missing: no build is needed in remote mode).
 *
 * Playwright evaluates these helpers synchronously while it collects tests
 * (e.g. `for (const t of publishedThemes())`), so remote reads go through a
 * synchronous child `node` fetch, memoised in-process and in a short-lived
 * disk cache shared by the runner and its workers (one download per run).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "out");

/** Origin of a remote site under test, or null when testing the local build. */
export const REMOTE_ORIGIN: string | null = process.env.E2E_BASE_URL
  ? new URL(process.env.E2E_BASE_URL).origin
  : null;

/** True when the suite runs against a deployed site (production or a preview). */
export const IS_REMOTE = REMOTE_ORIGIN !== null;

/** The production origin canonical/OG/sitemap URLs must point at, even when
 * a per-deployment URL is under test. Mirrors @paperpilot/core's
 * PUBLIC_ORIGIN (literal on purpose: a mismatch is caught by the canonical
 * checks themselves). */
export const CANONICAL_ORIGIN = process.env.E2E_CANONICAL_ORIGIN ?? "https://paperpilot.pages.dev";

const CACHE_TTL_MS = 15 * 60_000;

export interface RemoteResponse {
  status: number;
  body: string;
}

const memo = new Map<string, RemoteResponse>();

// Writes to a file, not stdout: process.exit() right after a large
// stdout.write to a pipe truncates it at 64 KiB.
const FETCH_SCRIPT = `
import { writeFileSync } from "node:fs";
const [url, method, out] = process.argv.slice(1);
let last;
for (let i = 0; i < 3; i++) {
  try {
    const r = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(30000) });
    const body = method === "HEAD" ? "" : await r.text();
    writeFileSync(out, JSON.stringify({ status: r.status, body }));
    process.exit(0);
  } catch (e) {
    last = e;
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
}
console.error(String(last));
process.exit(1);
`;

/** Synchronous GET/HEAD against the remote site (memoised + disk cache). */
export function remoteFetchSync(path: string, method: "GET" | "HEAD" = "GET"): RemoteResponse {
  if (!REMOTE_ORIGIN) throw new Error("remoteFetchSync needs E2E_BASE_URL");
  const url = new URL(path, REMOTE_ORIGIN).toString();
  const key = `${method} ${url}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const dir = join(tmpdir(), "paperpilot-e2e-remote");
  const file = join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < CACHE_TTL_MS) {
    const cached = JSON.parse(readFileSync(file, "utf8")) as RemoteResponse;
    memo.set(key, cached);
    return cached;
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  execFileSync(process.execPath, ["--input-type=module", "-e", FETCH_SCRIPT, url, method, tmp], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  renameSync(tmp, file);
  const res = JSON.parse(readFileSync(file, "utf8")) as RemoteResponse;
  memo.set(key, res);
  return res;
}

function readJson<T>(rel: string): T {
  if (REMOTE_ORIGIN) {
    const res = remoteFetchSync(`/${rel}`);
    if (res.status !== 200) throw new Error(`${REMOTE_ORIGIN}/${rel} returned ${res.status}`);
    return JSON.parse(res.body) as T;
  }
  const file = join(OUT_DIR, rel);
  if (!existsSync(file)) {
    throw new Error(`${file} missing: build apps/web first (pnpm --filter @paperpilot/web build)`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Whether `rel` (an out-relative file path, no leading slash) is served by
 * the site under test. Remotely, `x/index.html` is probed as `x/` (Pages
 * redirects `/index.html` URLs). */
function siteHas(rel: string): boolean {
  if (REMOTE_ORIGIN) {
    const path = `/${rel.replace(/(^|\/)index\.html$/, "$1")}`;
    return remoteFetchSync(path, "HEAD").status === 200;
  }
  return existsSync(join(OUT_DIR, rel));
}

export interface PublishedTheme {
  slug: string;
  theme: string;
  paper_count: number;
}

interface QualityRow {
  kind: string;
  slug: string;
  publication_tier: string;
  availability: string;
}

/** Themes listed in the manifest whose quality row is publishable
 * (audited/unaudited and ready) -- the ones /themes/ actually renders. */
export function publishedThemes(): PublishedTheme[] {
  const manifest = readJson<PublishedTheme[]>("themes/themes-manifest.json");
  const quality = readJson<{ collections: QualityRow[] }>("lineage-quality-v1.json");
  const ok = new Set(
    quality.collections
      .filter(
        (c) =>
          c.kind === "theme" &&
          c.availability === "ready" &&
          (c.publication_tier === "audited" || c.publication_tier === "unaudited"),
      )
      .map((c) => c.slug),
  );
  return manifest.filter((t) => ok.has(t.slug));
}

export interface ConferenceSummary {
  name: string;
  papers: number;
}

export function conferences(): ConferenceSummary[] {
  return readJson<ConferenceSummary[]>("conferences.json");
}

export function conferencePaperCount(conf: string): number {
  const c = conferences().find((x) => x.name === conf);
  if (!c) throw new Error(`conference ${conf} not in conferences.json`);
  return c.papers;
}

/** `/<conf>/paper-links/<n>/` pages present on the site (n >= 2). */
export function paperLinksPages(conf: string): number[] {
  const pages = [1];
  for (let n = 2; siteHas(`${conf}/paper-links/${n}/index.html`); n++) {
    pages.push(n);
  }
  return pages;
}

export function themeHasFeed(slug: string): boolean {
  return siteHas(`themes/${slug}/feed.xml`);
}

/** Whether the theme ships a code-links.json with at least one paper, i.e.
 * the page renders the "コードとモデル" section (it loads after the tree). */
export function themeHasCodeLinks(slug: string): boolean {
  if (!siteHas(`themes/${slug}/code-links.json`)) return false;
  const data = readJson<{ nodes?: Record<string, unknown> }>(`themes/${slug}/code-links.json`);
  return Object.keys(data.nodes ?? {}).length > 0;
}
