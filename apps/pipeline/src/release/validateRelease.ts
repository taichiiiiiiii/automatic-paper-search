/**
 * Validate the local Pages bundle, or smoke-test one deployed exact-SHA
 * bundle — TS port of `.github/scripts/validate-pages-release.sh`.
 *
 * Implements PUB-26..37 of `docs/migration/safety-contracts.md`, adapted
 * per design doc §4.3 to the Cloudflare/Next.js layout:
 *   - the required-artifact list is still the flat published JSON files
 *     (not Next page routes), but is now a parameter so a later change can
 *     point it at `apps/web`'s actual `out/` layout without touching this
 *     module;
 *   - two checks the shell original does not have: no `docs/design`,
 *     `docs/research`, or `*_IMPLEMENTER.md` published (design doc §4.3
 *     "公開対象"), and every published HTML page carries a CSP `<meta>`
 *     tag (design doc §4.4).
 *
 * `smokeRemote` takes an injected `fetch`-shaped function (never the real
 * network from a test) and never writes to disk — unlike the shell
 * original, which downloads each smoke response to a temp directory only
 * because `curl` is file-oriented. Holding responses in memory removes
 * the temp-directory cleanup trap (PUB-37) as a risk category entirely
 * rather than reimplementing it.
 *
 * Every smoke fetch is bounded and retried like the shell's
 * `curl --connect-timeout 5 --max-time 15 --retry 2 --retry-all-errors`:
 * default 15s per-attempt timeout (`timeoutMs`), 2 retries after the first
 * failure (`retries`, so 3 attempts total), retrying on a non-2xx status
 * exactly like a thrown/timed-out attempt. Two intentional differences from
 * the shell, both acceptable because this never touches the real network in
 * a test and the retry behavior itself isn't a safety contract:
 *   - `--connect-timeout 5` (a separate, shorter deadline for the TCP/TLS
 *     handshake alone) has no equivalent here; `timeoutMs` is one overall
 *     per-attempt deadline covering connect + response, matching `--max-time`.
 *   - curl's default retry backoff is unspecified/exponential-ish; this port
 *     uses an explicit `1000 * 2**attempt` backoff (`sleep`, injectable so
 *     tests don't actually wait).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LAYOUT_MODE, type LayoutMode } from "@paperpilot/core/layout";
import { validateSmokeRelativePath } from "@paperpilot/core/paths";
import { XMLValidator } from "fast-xml-parser";

export class ValidateReleaseError extends Error {}

const SHA_RE = /^[0-9a-f]{40}$/;

export function validateSha(sha: string): void {
  if (!SHA_RE.test(sha)) {
    throw new ValidateReleaseError("source SHA must be 40 lowercase hex");
  }
}

/** Legacy required-artifact list -- unchanged from before this changeset. */
const LEGACY_REQUIRED_ARTIFACTS: readonly string[] = [
  "index.html",
  "404.html",
  "conferences.json",
  "search-index.json",
  "search-index-v2.json",
  "lineage-quality-v1.json",
  "sitemap.xml",
  "assets/versions.json",
];

/**
 * p5-plan.md §2 A4: drops `search-index.json` (v1) and
 * `assets/versions.json` (no longer generated); adds `_redirects` /
 * `_headers` (Next's static-export postbuild outputs). `_paperpilot-
 * deployment.json` (build mode only) is A4's `marker`/`validate bundle`
 * extension, out of this changeset's scope.
 */
const P5_REQUIRED_ARTIFACTS: readonly string[] = [
  "index.html",
  "404.html",
  "conferences.json",
  "search-index-v2.json",
  "lineage-quality-v1.json",
  "sitemap.xml",
  "_redirects",
  "_headers",
];

/** `marker`'s output filename (p5-plan.md §4.3 "Write deterministic deployment marker" / §4.4 A4). */
export const DEPLOYMENT_MARKER_FILENAME = "_paperpilot-deployment.json";

export interface RequiredArtifactsOptions {
  /**
   * p5-plan.md §2 A4: "Plus `_paperpilot-deployment.json` in build mode."
   * The release workflow's `build` stage runs `marker` BEFORE `validate
   * local` (§4.3), so that stage's required list must include it; the
   * promoter's `validate bundle` step (§3 validate step 7) runs before
   * any marker exists in the tree at all, so it must not. Ignored under
   * `"legacy"` mode (the marker doesn't exist pre-P5).
   */
  buildMode?: boolean;
}

/**
 * p5-plan.md §2 A4: the required-artifact list for `mode`, switched by
 * layout mode exactly like {@link DEFAULT_REQUIRED_ARTIFACTS} (which this
 * now derives from), plus the optional build-mode marker addition. Kept
 * as a function (not just the `DEFAULT_REQUIRED_ARTIFACTS` constant) so a
 * caller — `validateBundle`, and any future `validate local --build`
 * wiring — can ask for either list without re-deriving it or flipping
 * `LAYOUT_MODE` in a test.
 */
export function requiredArtifactsFor(
  mode: LayoutMode = LAYOUT_MODE,
  options: RequiredArtifactsOptions = {},
): readonly string[] {
  const base = mode === "p5" ? P5_REQUIRED_ARTIFACTS : LEGACY_REQUIRED_ARTIFACTS;
  if (mode === "p5" && options.buildMode) {
    return [...base, DEPLOYMENT_MARKER_FILENAME];
  }
  return base;
}

export const DEFAULT_REQUIRED_ARTIFACTS: readonly string[] = requiredArtifactsFor();

/** Design doc §4.3 "公開対象": these must never appear in the published site root. */
const FORBIDDEN_PUBLISHED_PREFIXES = ["design", "research"];
const FORBIDDEN_IMPLEMENTER_SUFFIX = "_IMPLEMENTER.md";

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

const CSP_META_RE = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i;

/** Validation 1 (PUB-29/30/31) + the two Cloudflare-era additions (design doc §4.3/§4.4). */
export function validateJsonBundle(docsRoot: string): void {
  const errors: string[] = [];
  const allFiles = listAllFiles(docsRoot);

  for (const path of allFiles.filter((p) => p.endsWith(".json")).sort()) {
    try {
      JSON.parse(readFileSync(path, "utf-8"));
    } catch (exc) {
      errors.push(`invalid JSON ${relative(docsRoot, path)}: ${(exc as Error).message}`);
    }
  }

  const sitemapPath = join(docsRoot, "sitemap.xml");
  try {
    const validation = XMLValidator.validate(readFileSync(sitemapPath, "utf-8"));
    if (validation !== true) {
      errors.push(`invalid sitemap.xml: ${validation.err.msg}`);
    }
  } catch (exc) {
    errors.push(`invalid sitemap.xml: ${(exc as Error).message}`);
  }

  let conferences: unknown = [];
  try {
    conferences = JSON.parse(readFileSync(join(docsRoot, "conferences.json"), "utf-8"));
  } catch (exc) {
    errors.push(`invalid conferences.json: ${(exc as Error).message}`);
  }
  if (!Array.isArray(conferences) || conferences.length === 0) {
    errors.push("conferences.json must be a non-empty array");
  } else {
    for (const conference of conferences) {
      const slug =
        typeof conference === "object" && conference !== null
          ? (conference as Record<string, unknown>).name
          : undefined;
      if (typeof slug !== "string" || !statSyncSafe(join(docsRoot, slug, "papers.json"))) {
        errors.push(`missing catalog for conference ${JSON.stringify(slug)}`);
      }
    }
  }

  for (const path of allFiles) {
    const rel = relative(docsRoot, path).split("/");
    if (FORBIDDEN_PUBLISHED_PREFIXES.includes(rel[0] as string)) {
      errors.push(`forbidden published path: ${rel.join("/")}`);
    }
    if (rel[rel.length - 1]?.endsWith(FORBIDDEN_IMPLEMENTER_SUFFIX)) {
      errors.push(`forbidden published path: ${rel.join("/")}`);
    }
  }

  for (const path of allFiles.filter((p) => p.endsWith(".html"))) {
    const html = readFileSync(path, "utf-8");
    if (!CSP_META_RE.test(html)) {
      errors.push(`missing CSP meta tag: ${relative(docsRoot, path)}`);
    }
  }

  if (errors.length > 0) {
    throw new ValidateReleaseError(errors.join("\n"));
  }
}

function statSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface ValidateLocalOptions {
  expectedSha: string;
  docsRoot: string;
  /** The checked-out HEAD SHA (equivalent to `git rev-parse HEAD`), injected so this stays a pure function of its inputs. */
  actualHeadSha: string;
  requiredArtifacts?: readonly string[];
}

/** Validations 1-6 of the shell original (PUB-26..31), run against a local checkout. */
export function validateLocal(options: ValidateLocalOptions): void {
  validateSha(options.expectedSha);
  if (!isDirectory(options.docsRoot)) {
    throw new ValidateReleaseError(`docs root does not exist: ${options.docsRoot}`);
  }
  if (options.actualHeadSha !== options.expectedSha) {
    throw new ValidateReleaseError(
      `checkout SHA ${options.actualHeadSha} != ${options.expectedSha}`,
    );
  }

  const required = options.requiredArtifacts ?? DEFAULT_REQUIRED_ARTIFACTS;
  for (const artifact of required) {
    if (!statSyncSafe(join(options.docsRoot, artifact))) {
      throw new ValidateReleaseError(`missing Pages artifact: ${artifact}`);
    }
  }
  validateJsonBundle(options.docsRoot);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface ValidateBundleOptions {
  docsRoot: string;
  requiredArtifacts?: readonly string[];
}

/**
 * p5-plan.md §2 A4: "`validate bundle <out-dir>`: same as `validateLocal`
 * without the HEAD==SHA check. Needed because the promote worktree's
 * HEAD is the pre-commit tip" — the promoter's §3 validate step 7 runs
 * inside a detached `git worktree add --detach $tree $remoteSha` BEFORE
 * this attempt's candidate is committed, so there is no meaningful
 * "expected SHA" to check HEAD against yet (unlike the release
 * workflow's `build`/`admit` stages, which validate an already-committed
 * exact SHA via {@link validateLocal}).
 */
export function validateBundle(options: ValidateBundleOptions): void {
  if (!isDirectory(options.docsRoot)) {
    throw new ValidateReleaseError(`docs root does not exist: ${options.docsRoot}`);
  }
  const required = options.requiredArtifacts ?? requiredArtifactsFor();
  for (const artifact of required) {
    if (!statSyncSafe(join(options.docsRoot, artifact))) {
      throw new ValidateReleaseError(`missing Pages artifact: ${artifact}`);
    }
  }
  validateJsonBundle(options.docsRoot);
}

// ---------------------------------------------------------------------------
// Smoke test (remote)
// ---------------------------------------------------------------------------

/**
 * `headers`/`arrayBuffer` are OPTIONAL on the response shape so every
 * pre-existing test's hand-rolled fake (`{status, text()}`, no headers,
 * no `arrayBuffer`) keeps satisfying this type unchanged — only the A4
 * extensions that actually need a header or raw bytes (`--expect-bytes`,
 * `--expect-redirect`, the `_headers` CSP check) require a fake that
 * supplies them, and each of those throws a clear error if the injected
 * `fetchImpl` didn't.
 */
export interface SmokeFetchResponse {
  status: number;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}

export type FetchTextFn = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: "manual" | "follow" },
) => Promise<SmokeFetchResponse>;

/** p5-plan.md §2 A4 `smoke --expect-redirect <from>=<to>`. */
export interface ExpectRedirect {
  from: string;
  to: string;
}

export interface SmokeRemoteOptions {
  baseUrl: string;
  expectedSha: string;
  fetchImpl: FetchTextFn;
  /** Per-attempt timeout, matching the shell's `curl --max-time 15`. Default 15000. */
  timeoutMs?: number;
  /** Additional attempts after the first failure, matching the shell's `curl --retry 2`. Default 2. */
  retries?: number;
  /** Backoff between attempts; injectable so tests don't actually wait. Default a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * `smoke --wait-marker <seconds>`: poll `_paperpilot-deployment.json`
   * until it reports `expectedSha` (alias propagation lag, p5-plan.md §4.3
   * "record" / R13) instead of failing on the first mismatch.
   */
  waitMarkerSeconds?: number;
  /** Poll interval while waiting for the marker. Default 2000ms. */
  waitMarkerPollIntervalMs?: number;
  /** Injectable clock for {@link waitMarkerSeconds}'s deadline, so tests never depend on real wall-clock time. Default `Date.now`. */
  now?: () => number;
  /**
   * `smoke --expect-bytes <out-dir>`: sha256 of the exact bytes served at
   * `/`, `/404.html`, and the representative conference's `/` must equal
   * the same local files' bytes (R14 — Cloudflare auto-injection could
   * otherwise silently rewrite served HTML).
   */
  expectBytesDir?: string;
  /** `smoke --expect-404 <path>` (repeatable). */
  expect404Paths?: readonly string[];
  /** `smoke --expect-redirect <from>=<to>` (repeatable). */
  expectRedirects?: readonly ExpectRedirect[];
  /**
   * `_headers` check (p5-plan.md §2 A4): the deployed `/` response's
   * `Content-Security-Policy` header must equal exactly
   * `frame-ancestors 'self'` — the legacy GitHub Pages site never sent
   * this header at all (CSP was meta-tag only), so this defaults to
   * `LAYOUT_MODE === "p5"` rather than running unconditionally and
   * breaking legacy smoke byte-for-byte.
   */
  checkCspHeader?: boolean;
}

export interface SmokeRemoteResult {
  routes: string[];
}

const DEFAULT_SMOKE_TIMEOUT_MS = 15_000;
const DEFAULT_SMOKE_RETRIES = 2;

function defaultSmokeSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One fetch attempt bounded by `timeoutMs`, matching the shell's
 * `curl --connect-timeout 5 --max-time 15` (collapsed here to a single
 * overall per-attempt deadline — see the module doc comment's "intentional
 * differences"). `fetchImpl` is given an `AbortSignal` so a real `fetch`
 * actually cancels the in-flight request rather than merely being raced.
 */
async function fetchOnce(
  fetchImpl: FetchTextFn,
  url: string,
  timeoutMs: number,
  init: { redirect?: "manual" | "follow" } = {},
): Promise<SmokeFetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, ...init });
  } catch (exc) {
    // Normalize to a single, recognizable message regardless of what error
    // text a given `fetchImpl` throws on abort (a real `fetch()` throws its
    // own `AbortError`; a hand-rolled one in a test may throw anything).
    if (controller.signal.aborted) {
      throw new ValidateReleaseError(`timed out after ${timeoutMs}ms fetching ${url}`);
    }
    throw exc;
  } finally {
    clearTimeout(timer);
  }
}

interface RetryConfig {
  timeoutMs: number;
  retries: number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Fetch with a bounded timeout and up to `retries` additional attempts,
 * matching the shell's `curl --retry 2 --retry-all-errors` — retries on a
 * non-2xx status exactly like a thrown/timed-out attempt (the shell's
 * `--retry-all-errors` flag, without which curl would only retry on a
 * narrower set of transient error codes).
 */
/**
 * Fetch with a bounded timeout and up to `retries` additional attempts,
 * matching the shell's `curl --retry 2 --retry-all-errors` — retries on a
 * non-2xx status exactly like a thrown/timed-out attempt (the shell's
 * `--retry-all-errors` flag, without which curl would only retry on a
 * narrower set of transient error codes). Returns the raw response (not
 * its decoded text), so callers that need headers or bytes don't have to
 * re-fetch.
 */
async function fetchResponseOrThrow(
  fetchImpl: FetchTextFn,
  url: string,
  what: string,
  config: RetryConfig,
): Promise<SmokeFetchResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    try {
      const response = await fetchOnce(fetchImpl, url, config.timeoutMs);
      if (response.status < 200 || response.status >= 300) {
        throw new ValidateReleaseError(
          `fetch failed for ${what} (${url}): HTTP ${response.status}`,
        );
      }
      return response;
    } catch (exc) {
      lastError = exc;
      if (attempt < config.retries) {
        await config.sleep(2 ** attempt * 1000);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ValidateReleaseError(`fetch failed for ${what} (${url})`);
}

async function fetchOrThrow(
  fetchImpl: FetchTextFn,
  url: string,
  what: string,
  config: RetryConfig,
): Promise<string> {
  const response = await fetchResponseOrThrow(fetchImpl, url, what, config);
  return response.text();
}

async function fetchBytesOrThrow(
  fetchImpl: FetchTextFn,
  url: string,
  what: string,
  config: RetryConfig,
): Promise<Buffer> {
  const response = await fetchResponseOrThrow(fetchImpl, url, what, config);
  if (!response.arrayBuffer) {
    throw new ValidateReleaseError(
      `fetchImpl for ${what} (${url}) does not support arrayBuffer() (required by --expect-bytes)`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * `smoke --expect-bytes <out-dir>`: the served `/`, `/404.html`, and the
 * representative conference's `/` must be byte-identical to the local
 * build output (R14) — compared as raw bytes, never decoded text, so a
 * non-UTF-8 byte difference can't slip through a `TextDecoder`'s
 * replacement-character smoothing.
 */
async function checkExpectBytes(
  fetchImpl: FetchTextFn,
  baseUrl: string,
  dir: string,
  representative: string,
  config: RetryConfig,
): Promise<void> {
  const pairs: ReadonlyArray<readonly [route: string, localRelPath: string]> = [
    ["/", "index.html"],
    ["/404.html", "404.html"],
    [`/${representative}/`, `${representative}/index.html`],
  ];
  for (const [route, localRelPath] of pairs) {
    const remote = await fetchBytesOrThrow(
      fetchImpl,
      `${baseUrl}${route}`,
      `bytes at ${route}`,
      config,
    );
    let local: Buffer;
    try {
      local = readFileSync(join(dir, ...localRelPath.split("/")));
    } catch (exc) {
      throw new ValidateReleaseError(
        `--expect-bytes: cannot read local ${localRelPath} under ${dir}: ${(exc as Error).message}`,
      );
    }
    if (sha256Hex(remote) !== sha256Hex(local)) {
      throw new ValidateReleaseError(
        `--expect-bytes: deployed ${route} does not byte-match local ${localRelPath}`,
      );
    }
  }
}

/** `smoke --expect-404 <path>`: a single, non-retried fetch — a 404 here is the EXPECTED outcome, not a transient failure to retry past. */
async function checkExpect404(
  fetchImpl: FetchTextFn,
  baseUrl: string,
  rawPath: string,
  timeoutMs: number,
): Promise<void> {
  const relative = rawPath.replace(/^\/+/, "");
  validateSmokeRelativePath(relative);
  const url = `${baseUrl}/${percentEncodeSmokePath(relative)}`;
  const response = await fetchOnce(fetchImpl, url, timeoutMs);
  if (response.status !== 404) {
    throw new ValidateReleaseError(
      `--expect-404 ${rawPath}: expected HTTP 404, got ${response.status}`,
    );
  }
}

/**
 * `smoke --expect-redirect <from>=<to>`: a single, non-retried fetch with
 * `redirect: "manual"` so the injected `fetchImpl` (and a real `fetch`)
 * surfaces the 301 itself instead of transparently following it. The
 * `Location` header is resolved against `baseUrl` before comparing
 * `pathname` — Cloudflare Pages may emit either an absolute or a
 * path-relative `Location` (R21, unverified offline either way), and
 * both normalize to the same `URL`.
 */
async function checkExpectRedirect(
  fetchImpl: FetchTextFn,
  baseUrl: string,
  redirect: ExpectRedirect,
  timeoutMs: number,
): Promise<void> {
  const response = await fetchOnce(fetchImpl, `${baseUrl}${redirect.from}`, timeoutMs, {
    redirect: "manual",
  });
  if (response.status !== 301) {
    throw new ValidateReleaseError(
      `--expect-redirect ${redirect.from}=${redirect.to}: expected HTTP 301, got ${response.status}`,
    );
  }
  const location = response.headers?.get("location");
  if (!location) {
    throw new ValidateReleaseError(
      `--expect-redirect ${redirect.from}=${redirect.to}: response has no Location header`,
    );
  }
  const resolved = new URL(location, baseUrl);
  const expected = new URL(redirect.to, baseUrl);
  if (resolved.origin !== expected.origin || resolved.pathname !== expected.pathname) {
    throw new ValidateReleaseError(
      `--expect-redirect ${redirect.from}=${redirect.to}: Location resolved to ${resolved.pathname}`,
    );
  }
}

/** `_headers` check: the deployed `/` response's CSP header, not the meta tag — `frame-ancestors` has no effect in a meta CSP (apps/web/scripts/csp-hash.ts's own doc comment), so only the HTTP header proves it shipped. */
async function checkCspHeader(
  fetchImpl: FetchTextFn,
  baseUrl: string,
  config: RetryConfig,
): Promise<void> {
  const response = await fetchResponseOrThrow(
    fetchImpl,
    `${baseUrl}/`,
    "index.html (CSP header)",
    config,
  );
  if (!response.headers) {
    throw new ValidateReleaseError(
      "fetchImpl for / does not expose headers (required by the CSP header check)",
    );
  }
  const header = response.headers.get("content-security-policy");
  if (header !== "frame-ancestors 'self'") {
    throw new ValidateReleaseError(
      `expected Content-Security-Policy header "frame-ancestors 'self'" at /, got ${JSON.stringify(header)}`,
    );
  }
}

/**
 * `smoke --wait-marker <seconds>`: polls the marker until it reports
 * `expectedSha`, instead of failing on the very first fetch (R13, alias
 * propagation lag). A mismatch or any fetch error is swallowed and
 * retried until `seconds` elapses (per the injectable `now`/`sleep`, never
 * real wall-clock time in a test); the final poll's actual failure is
 * what gets thrown, not a generic timeout.
 */
async function waitForMarker(
  fetchImpl: FetchTextFn,
  baseUrl: string,
  expectedSha: string,
  waitSeconds: number,
  pollIntervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = now() + waitSeconds * 1000;
  let lastError: unknown;
  for (;;) {
    try {
      const text = await fetchOrThrow(
        fetchImpl,
        `${baseUrl}/${DEPLOYMENT_MARKER_FILENAME}`,
        "deployment marker",
        {
          timeoutMs,
          retries: 0,
          sleep,
        },
      );
      const marker = JSON.parse(text) as Record<string, unknown>;
      if (marker.source_sha === expectedSha) return;
      lastError = new ValidateReleaseError("deployed marker does not match requested source SHA");
    } catch (exc) {
      lastError = exc;
    }
    if (now() >= deadline) {
      throw lastError instanceof Error
        ? lastError
        : new ValidateReleaseError(`marker did not report ${expectedSha} within ${waitSeconds}s`);
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Percent-encode a validated smoke-route path exactly like the shell
 * original's `urllib.parse.quote(parts.path, safe="/-._~")`: every UTF-8
 * byte of a character outside `[A-Za-z0-9\-._~/]` becomes an uppercase
 * `%XX` escape (so `/` stays a path separator, unlike plain
 * `encodeURIComponent`, which would also escape `/` and leaves `!*'()`
 * un-escaped — neither matches Python's `quote()`).
 */
const SMOKE_PATH_SAFE_RE = /^[A-Za-z0-9\-._~/]$/;

function percentEncodeSmokePath(path: string): string {
  let out = "";
  for (const ch of path) {
    if (ch.codePointAt(0)! < 128 && SMOKE_PATH_SAFE_RE.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of Buffer.from(ch, "utf-8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Validations 7-11 of the shell original (PUB-32..36), run against a deployed exact-SHA bundle. */
export async function smokeRemote(options: SmokeRemoteOptions): Promise<SmokeRemoteResult> {
  validateSha(options.expectedSha);
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!/^https:\/\//.test(baseUrl)) {
    throw new ValidateReleaseError("Pages URL must use https");
  }

  const config: RetryConfig = {
    timeoutMs: options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_SMOKE_RETRIES,
    sleep: options.sleep ?? defaultSmokeSleep,
  };
  const get = (url: string, what: string): Promise<string> =>
    fetchOrThrow(options.fetchImpl, url, what, config);

  if (options.waitMarkerSeconds !== undefined) {
    await waitForMarker(
      options.fetchImpl,
      baseUrl,
      options.expectedSha,
      options.waitMarkerSeconds,
      options.waitMarkerPollIntervalMs ?? 2000,
      options.now ?? Date.now,
      config.sleep,
      config.timeoutMs,
    );
  }

  const indexHtml = await get(`${baseUrl}/`, "index.html");
  if (!indexHtml.toLowerCase().includes("<!doctype html")) {
    throw new ValidateReleaseError("root page is not HTML");
  }

  const deploymentText = await get(`${baseUrl}/${DEPLOYMENT_MARKER_FILENAME}`, "deployment marker");
  const deployment = JSON.parse(deploymentText) as Record<string, unknown>;
  if (deployment.source_sha !== options.expectedSha) {
    throw new ValidateReleaseError("deployed marker does not match requested source SHA");
  }

  const conferencesText = await get(`${baseUrl}/conferences.json`, "conferences.json");
  const conferences = JSON.parse(conferencesText);
  if (!Array.isArray(conferences) || conferences.length === 0) {
    throw new ValidateReleaseError("deployed conferences.json is empty");
  }
  const representative = (conferences[0] as Record<string, unknown>)?.name;
  if (typeof representative !== "string") {
    throw new ValidateReleaseError("representative conference has no name");
  }

  const searchText = await get(`${baseUrl}/search-index-v2.json`, "search-index-v2.json");
  const search = JSON.parse(searchText);
  if (!Array.isArray(search) || search.length === 0) {
    throw new ValidateReleaseError("deployed search-index-v2.json is empty");
  }

  const qualityText = await get(`${baseUrl}/lineage-quality-v1.json`, "lineage-quality-v1.json");
  const quality = JSON.parse(qualityText) as { collections?: Array<Record<string, unknown>> };
  const lineagePaths = (quality.collections ?? [])
    .filter((row) => row.availability === "ready" && row.audit_status === "passed")
    .map((row) => row.path)
    .filter((path): path is string => typeof path === "string");

  const paths = [
    `${representative}/`,
    ...(lineagePaths.length > 0 ? [lineagePaths[0] as string] : []),
  ];

  const routes: string[] = [];
  for (const relativePath of paths) {
    validateSmokeRelativePath(relativePath);
    const url = `${baseUrl}/${percentEncodeSmokePath(relativePath.replace(/^\/+/, ""))}`;
    await get(url, `smoke route ${relativePath}`);
    routes.push(url);
  }

  for (const path of options.expect404Paths ?? []) {
    await checkExpect404(options.fetchImpl, baseUrl, path, config.timeoutMs);
  }
  for (const redirect of options.expectRedirects ?? []) {
    await checkExpectRedirect(options.fetchImpl, baseUrl, redirect, config.timeoutMs);
  }
  const shouldCheckCspHeader = options.checkCspHeader ?? LAYOUT_MODE === "p5";
  if (shouldCheckCspHeader) {
    await checkCspHeader(options.fetchImpl, baseUrl, config);
  }
  if (options.expectBytesDir !== undefined) {
    await checkExpectBytes(
      options.fetchImpl,
      baseUrl,
      options.expectBytesDir,
      representative,
      config,
    );
  }

  return { routes };
}
