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
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { validateSmokeRelativePath } from "./paths.js";

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

export type FetchTextFn = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

export interface SmokeRemoteOptions {
  baseUrl: string;
  expectedSha: string;
  fetchImpl: FetchTextFn;
}

export interface SmokeRemoteResult {
  routes: string[];
}

async function fetchOrThrow(fetchImpl: FetchTextFn, url: string, what: string): Promise<string> {
  const response = await fetchImpl(url);
  if (response.status < 200 || response.status >= 300) {
    throw new ValidateReleaseError(`fetch failed for ${what} (${url}): HTTP ${response.status}`);
  }
  return response.text();
}

/** Validations 7-11 of the shell original (PUB-32..36), run against a deployed exact-SHA bundle. */
export async function smokeRemote(options: SmokeRemoteOptions): Promise<SmokeRemoteResult> {
  validateSha(options.expectedSha);
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  if (!/^https:\/\//.test(baseUrl)) {
    throw new ValidateReleaseError("Pages URL must use https");
  }

  const indexHtml = await fetchOrThrow(options.fetchImpl, `${baseUrl}/`, "index.html");
  if (!indexHtml.toLowerCase().includes("<!doctype html")) {
    throw new ValidateReleaseError("root page is not HTML");
  }

  const deploymentText = await fetchOrThrow(
    options.fetchImpl,
    `${baseUrl}/_paperpilot-deployment.json`,
    "deployment marker",
  );
  const deployment = JSON.parse(deploymentText) as Record<string, unknown>;
  if (deployment.source_sha !== options.expectedSha) {
    throw new ValidateReleaseError("deployed marker does not match requested source SHA");
  }

  const conferencesText = await fetchOrThrow(
    options.fetchImpl,
    `${baseUrl}/conferences.json`,
    "conferences.json",
  );
  const conferences = JSON.parse(conferencesText);
  if (!Array.isArray(conferences) || conferences.length === 0) {
    throw new ValidateReleaseError("deployed conferences.json is empty");
  }
  const representative = (conferences[0] as Record<string, unknown>)?.name;
  if (typeof representative !== "string") {
    throw new ValidateReleaseError("representative conference has no name");
  }

  const searchText = await fetchOrThrow(
    options.fetchImpl,
    `${baseUrl}/search-index-v2.json`,
    "search-index-v2.json",
  );
  const search = JSON.parse(searchText);
  if (!Array.isArray(search) || search.length === 0) {
    throw new ValidateReleaseError("deployed search-index-v2.json is empty");
  }

  const qualityText = await fetchOrThrow(
    options.fetchImpl,
    `${baseUrl}/lineage-quality-v1.json`,
    "lineage-quality-v1.json",
  );
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
    const url = `${baseUrl}/${relativePath.replace(/^\/+/, "")}`;
    await fetchOrThrow(options.fetchImpl, url, `smoke route ${relativePath}`);
    routes.push(url);
  }

  return { routes };
}
