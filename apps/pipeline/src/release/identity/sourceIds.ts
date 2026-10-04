/**
 * Deterministic, source-derived identities for public paper projections —
 * TS port of `paperpilot/identity/source_ids.py`.
 *
 * Identity Lite intentionally does not merge records across sources. It
 * turns a canonical native record ID into a stable PaperPilot ID and
 * rejects ambiguous or unknown inputs instead of falling back to titles.
 *
 * This module lives under `apps/pipeline/src/release/` (not
 * `packages/core/`) only because of this change's edit limits — the
 * Python original and the safety-contracts table (PUB-05, RPL-09) both
 * point at a shared `packages/core` home. See the final report for this
 * change for the consolidation follow-up; `apps/pipeline/src/catalog/**`
 * (owned by a concurrent change) may need the same logic and should not
 * duplicate it independently once that follow-up lands.
 *
 * `identity_from_url` deliberately does NOT use the WHATWG `URL` parser:
 * `URL` normalizes (`..` path collapse, percent-re-encoding, idna host
 * normalization) where Python's `urlsplit` is lax, and this module's
 * failure tests (invalid port, userinfo-bearing authority, raw `%2F`
 * surviving to a validator) depend on that laxness. `urlsplit` /
 * `unquote(errors="strict")` / `parse_qsl` are hand-ported below to the
 * exact subset of behaviour the Python test suite
 * (`paperpilot/tests/test_identity_source_ids.py`) exercises.
 */

import { createHash } from "node:crypto";

export type SourceName = "arxiv" | "openreview" | "acl_anthology" | "cvf";

const SOURCES: ReadonlySet<string> = new Set<SourceName>([
  "arxiv",
  "openreview",
  "acl_anthology",
  "cvf",
]);

const HOST_SOURCE: ReadonlyMap<string, SourceName> = new Map([
  ["arxiv.org", "arxiv"],
  ["www.arxiv.org", "arxiv"],
  ["export.arxiv.org", "arxiv"],
  ["openreview.net", "openreview"],
  ["www.openreview.net", "openreview"],
  ["aclanthology.org", "acl_anthology"],
  ["www.aclanthology.org", "acl_anthology"],
  ["openaccess.thecvf.com", "cvf"],
]);

/** The one definition of the modern (post-2007) arXiv grammar. */
export const ARXIV_MODERN_PATTERN = "[0-9]{4}\\.[0-9]{4,5}";
const ARXIV_MODERN_RE = new RegExp(`^${ARXIV_MODERN_PATTERN}$`);
const ARXIV_LEGACY_RE = /^([A-Za-z][A-Za-z0-9.-]*)\/([0-9]{7})$/;
const ARXIV_VERSION_RE = /v[0-9]+$/;
const OPENREVIEW_RE = /^[A-Za-z0-9_-]{1,256}$/;
const PATH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$/;
// Port of Python's `[^\s\x00-\x1f\x7f]+` (source_ids.py `_DOI_RE`) — the
// control-character exclusion is the point of this pattern, not an accident.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional, see above.
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

// ---------------------------------------------------------------------------
// urlsplit (Python urllib.parse.urlsplit subset)
// ---------------------------------------------------------------------------

interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

const SCHEME_CHARS = /^[A-Za-z0-9+.-]+$/;

/** Port of `urllib.parse.urlsplit` for the subset this module needs. */
function urlsplit(url: string): SplitResult {
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  let rest = url;

  const colon = rest.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(rest[0] ?? "") && SCHEME_CHARS.test(rest.slice(1, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }

  if (rest.startsWith("//")) {
    let delim = rest.length;
    for (const ch of ["/", "?", "#"]) {
      const idx = rest.indexOf(ch, 2);
      if (idx >= 0) delim = Math.min(delim, idx);
    }
    netloc = rest.slice(2, delim);
    rest = rest.slice(delim);
  }

  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }
  const qIdx = rest.indexOf("?");
  if (qIdx >= 0) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  return { scheme, netloc, path: rest, query, fragment };
}

interface HostInfo {
  hostname: string | null;
  username: string | null;
  password: string | null;
  /** Throws IdentityError if the port text is not a valid 0..65535 integer. */
  port: number | null;
}

function hostInfo(netloc: string): HostInfo {
  const atIdx = netloc.lastIndexOf("@");
  const hasUserinfo = atIdx >= 0;
  const userinfo = hasUserinfo ? netloc.slice(0, atIdx) : "";
  const hostinfo = hasUserinfo ? netloc.slice(atIdx + 1) : netloc;

  let username: string | null = null;
  let password: string | null = null;
  if (hasUserinfo) {
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      username = userinfo.slice(0, colon);
      password = userinfo.slice(colon + 1);
    } else {
      username = userinfo;
      password = null;
    }
  }

  let hostname: string;
  let portText: string | null;
  const colon = hostinfo.indexOf(":");
  if (colon >= 0) {
    hostname = hostinfo.slice(0, colon);
    portText = hostinfo.slice(colon + 1);
  } else {
    hostname = hostinfo;
    portText = null;
  }
  if (portText === "") portText = null;

  let port: number | null = null;
  if (portText !== null) {
    if (!/^[0-9]+$/.test(portText)) {
      throw new IdentityError(
        `Port could not be cast to integer value as ${JSON.stringify(portText)}`,
      );
    }
    port = Number.parseInt(portText, 10);
    if (port < 0 || port > 65535) {
      throw new IdentityError("Port out of range 0-65535");
    }
  }

  return {
    hostname: hostname ? hostname.toLowerCase() : null,
    username,
    password,
    port,
  };
}

// ---------------------------------------------------------------------------
// unquote (Python urllib.parse.unquote subset)
// ---------------------------------------------------------------------------

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9A-Fa-f]$/.test(ch);
}

/** Port of `urllib.parse.unquote_to_bytes` for an ASCII-range input string. */
function unquoteToBytes(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; ) {
    const ch = input[i];
    if (ch === "%" && isHexDigit(input[i + 1]) && isHexDigit(input[i + 2])) {
      bytes.push(Number.parseInt(input.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      bytes.push(input.codePointAt(i) ?? 0);
      i += 1;
    }
  }
  return Uint8Array.from(bytes);
}

/** Port of `urllib.parse.unquote(value, encoding="utf-8", errors="strict")`. */
function unquoteStrict(input: string): string {
  if (!input.includes("%")) return input;
  const bytes = unquoteToBytes(input);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IdentityError("value is not valid UTF-8");
  }
}

/** Port of `urllib.parse.unquote(value, encoding="utf-8", errors="replace")`. */
function unquoteReplace(input: string): string {
  if (!input.includes("%")) return input;
  const bytes = unquoteToBytes(input);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Port of `urllib.parse.parse_qsl(query, keep_blank_values=True, strict_parsing=False, max_num_fields=20)`. */
function parseQsl(query: string, maxNumFields: number): Array<[string, string]> {
  if (query === "") return [];
  const fields = query.split("&");
  if (fields.length > maxNumFields) {
    throw new IdentityError("Max number of fields exceeded");
  }
  const pairs: Array<[string, string]> = [];
  for (const nameValue of fields) {
    if (nameValue === "") continue;
    const eq = nameValue.indexOf("=");
    let rawName: string;
    let rawValue: string;
    if (eq >= 0) {
      rawName = nameValue.slice(0, eq);
      rawValue = nameValue.slice(eq + 1);
    } else {
      // keep_blank_values=True: a field with no "=" is kept with an empty value.
      rawName = nameValue;
      rawValue = "";
    }
    const name = unquoteReplace(rawName.replace(/\+/g, " "));
    const value = unquoteReplace(rawValue.replace(/\+/g, " "));
    pairs.push([name, value]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Path-segment decoding and validation
// ---------------------------------------------------------------------------

function decodeSegment(raw: string): string {
  let decoded: string;
  try {
    decoded = unquoteStrict(raw);
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

function pathSegments(parts: SplitResult, trailingSlash = false): string[] {
  if (!parts.path.startsWith("/")) {
    throw new IdentityError("source URL path must be absolute");
  }
  const raw = parts.path.split("/").slice(1);
  if (trailingSlash && raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  if (raw.length === 0 || raw.some((segment) => segment === "")) {
    throw new IdentityError("source URL contains an empty path segment");
  }
  return raw.map(decodeSegment);
}

// ---------------------------------------------------------------------------
// Per-source ID normalization
// ---------------------------------------------------------------------------

function normalizeArxivIdInternal(value: string): string {
  let candidate = value.trim();
  if (!candidate || /\s/.test(candidate)) {
    throw new IdentityError("arXiv ID is empty or contains whitespace");
  }
  candidate = candidate.replace(ARXIV_VERSION_RE, "");
  if (ARXIV_MODERN_RE.test(candidate)) {
    return candidate;
  }
  const legacy = ARXIV_LEGACY_RE.exec(candidate);
  if (!legacy) {
    throw new IdentityError(`invalid arXiv ID: ${JSON.stringify(value)}`);
  }
  let archive = legacy[1] as string;
  if (archive.includes(".")) {
    const dot = archive.indexOf(".");
    const primary = archive.slice(0, dot);
    const suffix = archive.slice(dot + 1);
    archive = `${primary.toLowerCase()}.${suffix}`;
  } else {
    archive = archive.toLowerCase();
  }
  return `${archive}/${legacy[2]}`;
}

function normalizeOpenreviewId(value: string): string {
  const candidate = value.trim();
  if (!OPENREVIEW_RE.test(candidate)) {
    throw new IdentityError(`invalid OpenReview forum ID: ${JSON.stringify(value)}`);
  }
  return candidate;
}

function normalizePathId(value: string, source: string): string {
  const candidate = value.trim();
  if (!PATH_ID_RE.test(candidate)) {
    throw new IdentityError(`invalid ${source} ID: ${JSON.stringify(value)}`);
  }
  return candidate;
}

function normalizeArxivUrl(parts: SplitResult): string {
  if (parts.query) {
    throw new IdentityError("arXiv identity URL must not contain a query");
  }
  const segments = pathSegments(parts);
  if (segments[0] !== "abs" && segments[0] !== "pdf") {
    throw new IdentityError("arXiv path must start with /abs/ or /pdf/");
  }
  const identifier = segments.slice(1);
  if (identifier.length === 0 || identifier.length > 2) {
    throw new IdentityError("arXiv URL has an ambiguous ID path");
  }
  // arXiv's own API returns `/pdf/<id>v<n>` without an extension, and the
  // site serves both forms, so `.pdf` is optional.
  const lastIdx = identifier.length - 1;
  const last = identifier[lastIdx] as string;
  if (segments[0] === "pdf" && last.endsWith(".pdf")) {
    identifier[lastIdx] = last.slice(0, -".pdf".length);
  }
  return normalizeArxivIdInternal(identifier.join("/"));
}

function normalizeOpenreviewUrl(parts: SplitResult): string {
  const segments = pathSegments(parts, true);
  if (segments.length !== 1 || segments[0] !== "forum") {
    throw new IdentityError("OpenReview path must be /forum");
  }
  let pairs: Array<[string, string]>;
  try {
    pairs = parseQsl(parts.query, 20);
  } catch {
    throw new IdentityError("OpenReview query is invalid");
  }
  const candidates = pairs.filter(([key]) => key === "id").map(([, value]) => value);
  if (candidates.length !== 1) {
    throw new IdentityError("OpenReview URL must contain exactly one id query value");
  }
  const candidate = decodeSegment(candidates[0] as string);
  return normalizeOpenreviewId(candidate);
}

function normalizeAclUrl(parts: SplitResult): string {
  if (parts.query) {
    throw new IdentityError("ACL Anthology identity URL must not contain a query");
  }
  const segments = pathSegments(parts, true);
  if (segments.length !== 1) {
    throw new IdentityError("ACL Anthology path must contain one native ID");
  }
  let identifier = segments[0] as string;
  if (identifier.endsWith(".pdf")) {
    identifier = identifier.slice(0, -".pdf".length);
  }
  return normalizePathId(identifier, "ACL Anthology");
}

function normalizeCvfUrl(parts: SplitResult): string {
  if (parts.query) {
    throw new IdentityError("CVF identity URL must not contain a query");
  }
  const segments = pathSegments(parts);
  if (segments.length !== 4 || segments[0] !== "content" || segments[2] !== "html") {
    throw new IdentityError("CVF path must be /content/<collection>/html/<filename>.html");
  }
  normalizePathId(segments[1] as string, "CVF collection");
  const filename = segments[3] as string;
  if (!filename.endsWith(".html")) {
    throw new IdentityError("CVF paper filename must end with .html");
  }
  return normalizePathId(filename.slice(0, -".html".length), "CVF");
}

const URL_NORMALIZERS: Record<SourceName, (parts: SplitResult) => string> = {
  arxiv: normalizeArxivUrl,
  openreview: normalizeOpenreviewUrl,
  acl_anthology: normalizeAclUrl,
  cvf: normalizeCvfUrl,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Normalize a strong alias without performing any fuzzy matching. */
export function normalizeAlias(namespace: string, value: string): [string, string] {
  const normalizedNamespace = namespace.trim().toLowerCase();
  if (normalizedNamespace === "doi") {
    let candidate = value.trim();
    const lowered = candidate.toLowerCase();
    if (lowered.startsWith("doi:")) {
      candidate = candidate.slice(4);
    } else if (lowered.startsWith("http://") || lowered.startsWith("https://")) {
      const parts = urlsplit(candidate);
      const info = hostInfo(parts.netloc);
      if (!info.hostname || !["doi.org", "dx.doi.org"].includes(info.hostname)) {
        throw new IdentityError("DOI URL must use doi.org or dx.doi.org");
      }
      if (info.username || info.password || info.port !== null) {
        throw new IdentityError("DOI URL authority is not canonical");
      }
      candidate = parts.path.replace(/^\/+/, "");
    }
    try {
      candidate = unquoteStrict(candidate).trim().toLowerCase();
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
    openreview: normalizeOpenreviewId,
    acl_anthology: (item) => normalizePathId(item, "ACL Anthology"),
    cvf: (item) => normalizePathId(item, "CVF"),
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
  return sha256Hex40(payload);
}

function sha256Hex40(payload: string): string {
  return createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 40);
}

/** Canonical versionless arXiv ID (modern or legacy); throws IdentityError. */
export function normalizeArxivId(value: string): string {
  return normalizeArxivIdInternal(value);
}

/** Whether `host` (lowercased) is one of the arXiv hosts this module parses. */
export function isArxivHost(host: string): boolean {
  return HOST_SOURCE.get(host) === "arxiv";
}

/**
 * Parse one known source URL into its deterministic identity.
 *
 * Unknown hosts and malformed inputs throw {@link IdentityError}; callers
 * must record a coverage failure rather than substituting a title-derived ID.
 */
export function identityFromUrl(url: string): PaperIdentity {
  const candidate = url.trim();
  if (!candidate) {
    throw new IdentityError("source URL is empty");
  }
  const parts = urlsplit(candidate);
  if (!["http", "https"].includes(parts.scheme.toLowerCase())) {
    throw new IdentityError("source URL must use http or https");
  }
  const info = hostInfo(parts.netloc);
  if (info.username || info.password || info.port !== null) {
    throw new IdentityError("source URL authority is not canonical");
  }
  const host = info.hostname ?? "";
  const source = HOST_SOURCE.get(host);
  if (source === undefined) {
    throw new IdentityError(`unknown paper source host: ${JSON.stringify(host)}`);
  }
  const sourceId = URL_NORMALIZERS[source](parts);
  return { source, sourceId, paperId: makePaperId(source, sourceId) };
}
