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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { validateSmokeRelativePath } from "@paperpilot/core/paths";
import { XMLValidator } from "fast-xml-parser";

export class ValidateReleaseError extends Error {}

const SHA_RE = /^[0-9a-f]{40}$/;

export function validateSha(sha: string): void {
  if (!SHA_RE.test(sha)) {
    throw new ValidateReleaseError("source SHA must be 40 lowercase hex");
  }
}

export const DEFAULT_REQUIRED_ARTIFACTS: readonly string[] = [
  "index.html",
  "404.html",
  "conferences.json",
  "search-index.json",
  "search-index-v2.json",
  "lineage-quality-v1.json",
  "sitemap.xml",
  "assets/versions.json",
];

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

// ---------------------------------------------------------------------------
// Smoke test (remote)
// ---------------------------------------------------------------------------

export type FetchTextFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

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
): Promise<{ status: number; text(): Promise<string> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
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
async function fetchOrThrow(
  fetchImpl: FetchTextFn,
  url: string,
  what: string,
  config: RetryConfig,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    try {
      const response = await fetchOnce(fetchImpl, url, config.timeoutMs);
      if (response.status < 200 || response.status >= 300) {
        throw new ValidateReleaseError(
          `fetch failed for ${what} (${url}): HTTP ${response.status}`,
        );
      }
      return await response.text();
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

  const indexHtml = await get(`${baseUrl}/`, "index.html");
  if (!indexHtml.toLowerCase().includes("<!doctype html")) {
    throw new ValidateReleaseError("root page is not HTML");
  }

  const deploymentText = await get(`${baseUrl}/_paperpilot-deployment.json`, "deployment marker");
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

  return { routes };
}
