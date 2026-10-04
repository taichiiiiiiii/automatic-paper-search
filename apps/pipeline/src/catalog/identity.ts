/**
 * Deterministic, source-derived identities for public paper projections —
 * TS port of `paperpilot/identity/source_ids.py` (CAT-16/17/21/26 of
 * docs/migration/safety-contracts.md; those rows have no Python unit tests
 * ("NONE") but the behaviour is still load-bearing for `build_summary_csv`
 * and `build_pages`, so it is ported in full rather than stubbed).
 *
 * Identity Lite intentionally does not merge records across sources. It
 * turns a canonical native record ID into a stable PaperPilot ID and
 * rejects ambiguous or unknown inputs instead of falling back to titles.
 *
 * Scope note: this belongs in a shared `packages/core/identity` module per
 * docs/design/39-typescript-cloudflare-migration.md §7.2 / the
 * safety-contracts "移植先" column (`packages/core/identity`), but this
 * task's edit scope is limited to `apps/pipeline/src/catalog/**`, so it
 * lives here for now. It is exported cleanly (no `_private` naming) so a
 * later task can promote it to `packages/core` without an API change, and
 * so the sibling `apps/pipeline/src/release/**` work (search index,
 * identity-lite, promoter) can import it from here meanwhile.
 *
 * `paper_id` is a SHA-256 digest truncated to 40 hex characters (NOT a
 * SHA-1 digest — the 40-hex-character shape is a coincidence of the
 * truncation length, not the algorithm) — see {@link makePaperId}.
 */

import { createHash } from "node:crypto";

export type SourceName = "arxiv" | "openreview" | "acl_anthology" | "cvf";

const SOURCES: ReadonlySet<string> = new Set(["arxiv", "openreview", "acl_anthology", "cvf"]);

const HOST_SOURCE: Readonly<Record<string, SourceName>> = {
  "arxiv.org": "arxiv",
  "www.arxiv.org": "arxiv",
  "export.arxiv.org": "arxiv",
  "openreview.net": "openreview",
  "www.openreview.net": "openreview",
  "aclanthology.org": "acl_anthology",
  "www.aclanthology.org": "acl_anthology",
  "openaccess.thecvf.com": "cvf",
};

// The one definition of the modern (post-2007) arXiv grammar.
export const ARXIV_MODERN_PATTERN = "[0-9]{4}\\.[0-9]{4,5}";
const ARXIV_MODERN_RE = new RegExp(`^${ARXIV_MODERN_PATTERN}$`);
const ARXIV_LEGACY_RE = /^([A-Za-z][A-Za-z0-9.-]*)\/([0-9]{7})$/;
const ARXIV_VERSION_RE = /v[0-9]+$/;
const OPENREVIEW_RE = /^[A-Za-z0-9_-]{1,256}$/;
const PATH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors Python's `[^\s\x00-\x1f\x7f]+` (DOI_RE) exactly — excluding control chars is the point.
const DOI_RE = /^10\.[0-9]{4,9}\/[^\s\x00-\x1f\x7f]+$/;

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export interface PaperIdentity {
  readonly source: SourceName;
  readonly sourceId: string;
  readonly paperId: string;
}

// ---- minimal urlsplit() equivalent -----------------------------------

interface SplitUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
  username: string | null;
  password: string | null;
  hostname: string | null;
  port: number | null;
}

/** Raised for the same cases Python's `urlsplit(...).port` raises ValueError. */
class UrlSplitError extends Error {}

const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

function splitUrl(candidate: string): SplitUrl {
  const match = URL_RE.exec(candidate);
  if (!match) {
    // No scheme-shaped prefix at all — treat the whole thing as a path,
    // matching urlsplit()'s behaviour for a schemeless/relative input.
    return {
      scheme: "",
      netloc: "",
      path: candidate,
      query: "",
      fragment: "",
      username: null,
      password: null,
      hostname: null,
      port: null,
    };
  }
  const scheme = (match[1] ?? "").toLowerCase();
  const netloc = match[3] ?? "";
  const path = match[4] ?? "";
  const query = match[5] ?? "";
  const fragment = match[6] ?? "";

  let username: string | null = null;
  let password: string | null = null;
  let hostport = netloc;
  const atIndex = netloc.lastIndexOf("@");
  if (atIndex !== -1) {
    const userinfo = netloc.slice(0, atIndex);
    hostport = netloc.slice(atIndex + 1);
    const colonIndex = userinfo.indexOf(":");
    if (colonIndex === -1) {
      username = userinfo;
      password = null;
    } else {
      username = userinfo.slice(0, colonIndex);
      password = userinfo.slice(colonIndex + 1);
    }
  }

  let hostname: string | null = null;
  let port: number | null = null;
  if (hostport) {
    const colonIndex = hostport.lastIndexOf(":");
    if (colonIndex === -1) {
      hostname = hostport.toLowerCase();
    } else {
      hostname = hostport.slice(0, colonIndex).toLowerCase();
      const portStr = hostport.slice(colonIndex + 1);
      if (portStr !== "") {
        if (!/^[0-9]+$/.test(portStr)) {
          throw new UrlSplitError(
            `Port could not be cast to integer value as ${JSON.stringify(portStr)}`,
          );
        }
        const parsed = Number(portStr);
        if (parsed < 0 || parsed > 65535) {
          throw new UrlSplitError(`Port out of range 0-65535`);
        }
        port = parsed;
      }
    }
    if (hostname === "") hostname = null;
  }

  return { scheme, netloc, path, query, fragment, username, password, hostname, port };
}

function decodeSegment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new IdentityError("URL path is not valid UTF-8");
  }
  if (!decoded) {
    throw new IdentityError("source ID contains an empty path segment");
  }
  if (decoded.includes("/") || decoded.includes("\\")) {
    throw new IdentityError("encoded slash or backslash is forbidden in a source ID");
  }
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      throw new IdentityError("control characters are forbidden in a source ID");
    }
  }
  return decoded;
}

function pathSegments(path: string, options: { trailingSlash?: boolean } = {}): string[] {
  if (!path.startsWith("/")) {
    throw new IdentityError("source URL path must be absolute");
  }
  const raw = path.split("/").slice(1);
  if (options.trailingSlash && raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  if (raw.length === 0 || raw.some((segment) => segment === "")) {
    throw new IdentityError("source URL contains an empty path segment");
  }
  return raw.map(decodeSegment);
}

function normalizeArxivIdInternal(value: string): string {
  const candidate0 = value.trim();
  if (!candidate0 || /\s/.test(candidate0)) {
    throw new IdentityError("arXiv ID is empty or contains whitespace");
  }
  const candidate = candidate0.replace(ARXIV_VERSION_RE, "");
  if (ARXIV_MODERN_RE.test(candidate)) {
    return candidate;
  }
  const legacy = ARXIV_LEGACY_RE.exec(candidate);
  if (!legacy) {
    throw new IdentityError(`invalid arXiv ID: ${JSON.stringify(value)}`);
  }
  let archive = legacy[1] as string;
  const number = legacy[2] as string;
  if (archive.includes(".")) {
    const dotIndex = archive.indexOf(".");
    const primary = archive.slice(0, dotIndex);
    const suffix = archive.slice(dotIndex + 1);
    archive = `${primary.toLowerCase()}.${suffix}`;
  } else {
    archive = archive.toLowerCase();
  }
  return `${archive}/${number}`;
}

function normalizeOpenreviewIdInternal(value: string): string {
  const candidate = value.trim();
  if (!OPENREVIEW_RE.test(candidate)) {
    throw new IdentityError(`invalid OpenReview forum ID: ${JSON.stringify(value)}`);
  }
  return candidate;
}

function normalizePathIdInternal(value: string, source: string): string {
  const candidate = value.trim();
  if (!PATH_ID_RE.test(candidate)) {
    throw new IdentityError(`invalid ${source} ID: ${JSON.stringify(value)}`);
  }
  return candidate;
}

function normalizeArxivUrl(parts: SplitUrl): string {
  if (parts.query) {
    throw new IdentityError("arXiv identity URL must not contain a query");
  }
  const segments = pathSegments(parts.path);
  if (segments[0] !== "abs" && segments[0] !== "pdf") {
    throw new IdentityError("arXiv path must start with /abs/ or /pdf/");
  }
  const identifier = segments.slice(1);
  if (identifier.length === 0 || identifier.length > 2) {
    throw new IdentityError("arXiv URL has an ambiguous ID path");
  }
  if (segments[0] === "pdf") {
    const last = identifier[identifier.length - 1] as string;
    if (last.endsWith(".pdf")) {
      identifier[identifier.length - 1] = last.slice(0, -".pdf".length);
    }
  }
  return normalizeArxivIdInternal(identifier.join("/"));
}

function parseQuery(query: string): Array<[string, string]> {
  if (query === "") return [];
  const pairs: Array<[string, string]> = [];
  for (const part of query.split("&")) {
    if (part === "") continue;
    const eqIndex = part.indexOf("=");
    const rawKey = eqIndex === -1 ? part : part.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? "" : part.slice(eqIndex + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch {
      throw new IdentityError("OpenReview query is invalid");
    }
    pairs.push([key, value]);
  }
  return pairs;
}

function normalizeOpenreviewUrl(parts: SplitUrl): string {
  const segments = pathSegments(parts.path, { trailingSlash: true });
  if (segments.length !== 1 || segments[0] !== "forum") {
    throw new IdentityError("OpenReview path must be /forum");
  }
  const pairs = parseQuery(parts.query);
  const candidates = pairs.filter(([key]) => key === "id").map(([, value]) => value);
  if (candidates.length !== 1) {
    throw new IdentityError("OpenReview URL must contain exactly one id query value");
  }
  // `parseQuery` already percent-decoded this value (mirroring Python's
  // `parse_qsl`, which internally calls `unquote`); `decodeSegment` runs
  // the same validation + a second (normally no-op) decode pass that
  // Python's own `_decode_segment(candidates[0])` performs on top of
  // `parse_qsl`'s decoding.
  const candidate = decodeSegment(candidates[0] as string);
  return normalizeOpenreviewIdInternal(candidate);
}

function normalizeAclUrl(parts: SplitUrl): string {
  if (parts.query) {
    throw new IdentityError("ACL Anthology identity URL must not contain a query");
  }
  const segments = pathSegments(parts.path, { trailingSlash: true });
  if (segments.length !== 1) {
    throw new IdentityError("ACL Anthology path must contain one native ID");
  }
  let identifier = segments[0] as string;
  if (identifier.endsWith(".pdf")) {
    identifier = identifier.slice(0, -".pdf".length);
  }
  return normalizePathIdInternal(identifier, "ACL Anthology");
}

function normalizeCvfUrl(parts: SplitUrl): string {
  if (parts.query) {
    throw new IdentityError("CVF identity URL must not contain a query");
  }
  const segments = pathSegments(parts.path);
  if (segments.length !== 4 || segments[0] !== "content" || segments[2] !== "html") {
    throw new IdentityError("CVF path must be /content/<collection>/html/<filename>.html");
  }
  normalizePathIdInternal(segments[1] as string, "CVF collection");
  const filename = segments[3] as string;
  if (!filename.endsWith(".html")) {
    throw new IdentityError("CVF paper filename must end with .html");
  }
  return normalizePathIdInternal(filename.slice(0, -".html".length), "CVF");
}

const URL_NORMALIZERS: Record<SourceName, (parts: SplitUrl) => string> = {
  arxiv: normalizeArxivUrl,
  openreview: normalizeOpenreviewUrl,
  acl_anthology: normalizeAclUrl,
  cvf: normalizeCvfUrl,
};

/** Normalize a strong alias without performing any fuzzy matching. */
export function normalizeAlias(namespace: string, value: string): [string, string] {
  const normalizedNamespace = namespace.trim().toLowerCase();
  if (normalizedNamespace === "doi") {
    let candidate = value.trim();
    const lowered = candidate.toLowerCase();
    if (lowered.startsWith("doi:")) {
      candidate = candidate.slice(4);
    } else if (lowered.startsWith("http://") || lowered.startsWith("https://")) {
      let parts: SplitUrl;
      try {
        parts = splitUrl(candidate);
      } catch {
        throw new IdentityError("invalid DOI URL");
      }
      if (!["doi.org", "dx.doi.org"].includes((parts.hostname ?? "").toLowerCase())) {
        throw new IdentityError("DOI URL must use doi.org or dx.doi.org");
      }
      if (parts.username || parts.password || parts.port !== null) {
        throw new IdentityError("DOI URL authority is not canonical");
      }
      candidate = parts.path.replace(/^\/+/, "");
    }
    try {
      candidate = decodeURIComponent(candidate).trim().toLowerCase();
    } catch {
      throw new IdentityError("DOI is not valid UTF-8");
    }
    if (!DOI_RE.test(candidate)) {
      throw new IdentityError(`invalid DOI alias: ${JSON.stringify(value)}`);
    }
    return ["doi", candidate];
  }

  if (!SOURCES.has(normalizedNamespace)) {
    throw new IdentityError(`unknown alias namespace: ${JSON.stringify(namespace)}`);
  }
  const source = normalizedNamespace as SourceName;
  const normalizers: Record<SourceName, (item: string) => string> = {
    arxiv: normalizeArxivIdInternal,
    openreview: normalizeOpenreviewIdInternal,
    acl_anthology: (item) => normalizePathIdInternal(item, "ACL Anthology"),
    cvf: (item) => normalizePathIdInternal(item, "CVF"),
  };
  return [source, normalizers[source](value)];
}

/** Return the stable 40-hex PaperPilot ID for one native record. */
export function makePaperId(source: string, sourceId: string): string {
  const [normalizedSource, normalizedId] = normalizeAlias(source, sourceId);
  if (!SOURCES.has(normalizedSource)) {
    throw new IdentityError("a DOI alias cannot be a canonical paper source");
  }
  const payload = `paperpilot:v1:${normalizedSource}:${normalizedId}`;
  return createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 40);
}

/** Canonical versionless arXiv ID (modern or legacy); throws IdentityError. */
export function normalizeArxivId(value: string): string {
  return normalizeArxivIdInternal(value);
}

/** Whether `host` (lowercased) is one of the arXiv hosts this module parses. */
export function isArxivHost(host: string): boolean {
  return HOST_SOURCE[host] === "arxiv";
}

/**
 * Parse one known source URL into its deterministic identity. Unknown hosts
 * and malformed inputs throw {@link IdentityError}; callers must record a
 * coverage failure rather than substituting a title-derived ID.
 */
export function identityFromUrl(url: string): PaperIdentity {
  const candidate = url.trim();
  if (!candidate) {
    throw new IdentityError("source URL is empty");
  }
  let parts: SplitUrl;
  try {
    parts = splitUrl(candidate);
  } catch {
    throw new IdentityError("source URL is invalid");
  }
  if (parts.scheme !== "http" && parts.scheme !== "https") {
    throw new IdentityError("source URL must use http or https");
  }
  if (parts.username !== null || parts.password !== null || parts.port !== null) {
    throw new IdentityError("source URL authority is not canonical");
  }
  const host = (parts.hostname ?? "").toLowerCase();
  const source = HOST_SOURCE[host];
  if (source === undefined) {
    throw new IdentityError(`unknown paper source host: ${JSON.stringify(host)}`);
  }
  const sourceId = URL_NORMALIZERS[source](parts);
  return { source, sourceId, paperId: makePaperId(source, sourceId) };
}
