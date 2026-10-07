/* Dependency-free contracts shared by the catalog viewer and Node tests. */
(function (root) {
  "use strict";

  const PAPER_ID_RE = /^[0-9a-f]{40}$/;
  const SHA256_RE = /^[0-9a-f]{64}$/;
  const DECK_ID_RE = /^sd1-[0-9a-f]{64}$/;
  const REVIEWED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;
  const PUBLIC_SLIDE_ROOT = "/automatic-paper-search/paper-slides-v1";
  const PUBLIC_SLIDE_MANIFEST_PATH = `${PUBLIC_SLIDE_ROOT}/manifest.json`;
  const PUBLIC_SLIDE_MANIFEST_VERSION = "paper-slide-public-manifest-v1";
  const PUBLIC_SLIDE_INDEX_VERSION = "paper-slide-public-index-v1";
  const MAX_PUBLIC_SLIDE_MANIFEST_BYTES = 256 * 1024;
  const MAX_PUBLIC_SLIDE_SHARD_BYTES = 8 * 1024 * 1024;
  const MAX_PUBLIC_SLIDE_DECK_BYTES = 512 * 1024;
  const MAX_PUBLIC_SLIDE_HTML_BYTES = 1024 * 1024;
  const MAX_PUBLIC_SLIDE_ENTRIES = 10_000;
  const PAPER_SLIDE_REQUEST_ID_RE = /^paper-slide-[A-Za-z0-9_-]{22}$/;
  const PAPER_SLIDE_STATUS_CAP_RE = /^psc_[A-Za-z0-9_-]{43}$/;
  const PAPER_SLIDE_DECK_PATH_RE = new RegExp(
    `^${PUBLIC_SLIDE_ROOT}/decks/sd1-[0-9a-f]{64}/[0-9a-f]{64}-[0-9a-f]{64}\\.html$`,
  );
  const PAPER_SLIDE_STATUSES = new Set([
    "queued", "running", "validating", "awaiting_review", "publishing",
    "published", "failed", "rejected", "expired",
  ]);
  const PAPER_SLIDE_PHASES = new Set([
    "resolving_source", "fetching", "extracting", "generating", "validating",
    "awaiting_review", "promoting", "deploying", "smoke",
  ]);
  const PAPER_SLIDE_COVERAGES = new Set(["full_text", "abstract_only"]);
  const PAPER_SLIDE_TERMINAL_STATUSES = new Set(["published", "failed", "rejected", "expired"]);
  const PAPER_SLIDE_FAILURE_STATUSES = new Set(["failed", "rejected", "expired"]);
  const PAPER_SLIDE_RUNNING_PHASES = new Set([
    "resolving_source", "fetching", "extracting", "generating",
  ]);
  const PAPER_SLIDE_PUBLISHING_PHASES = new Set(["promoting", "deploying", "smoke"]);
  const PAPER_SLIDE_MESSAGE_CODES = Object.freeze({
    queued: "PAPER_SLIDE_QUEUED",
    resolving_source: "PAPER_SLIDE_RESOLVING_SOURCE",
    fetching: "PAPER_SLIDE_FETCHING",
    extracting: "PAPER_SLIDE_EXTRACTING",
    generating: "PAPER_SLIDE_GENERATING",
    validating: "PAPER_SLIDE_VALIDATING",
    awaiting_review: "PAPER_SLIDE_AWAITING_REVIEW",
    promoting: "PAPER_SLIDE_PROMOTING",
    deploying: "PAPER_SLIDE_DEPLOYING",
    smoke: "PAPER_SLIDE_SMOKE",
    published: "PAPER_SLIDE_PUBLISHED",
    failed: "PAPER_SLIDE_FAILED",
    rejected: "PAPER_SLIDE_REJECTED",
    expired: "PAPER_SLIDE_EXPIRED",
  });

  // Deployment must replace this code-owned value and update the asset
  // version in one release. null intentionally prevents a dead production
  // CTA while the live Worker binding is absent.
  const PAPER_SLIDE_API_BASE = null;

  // paper-slides-public-root.js is the browser's code-owned trust root, not a
  // value read from the public manifest. Publication must replace null with
  // the exact builder-produced manifest SHA-256 and bump both asset versions
  // in the same release. Until then, lookup deliberately returns "unverified".
  const PUBLIC_SLIDE_TRUST_ROOT = root.PaperPilotPublicSlideTrustRoot
    || Object.freeze({
      schema_version: "paper-slide-public-trust-root-v1",
      manifest_path: PUBLIC_SLIDE_MANIFEST_PATH,
      manifest_sha256: null,
    });

  function isPaperId(value) {
    return typeof value === "string" && PAPER_ID_RE.test(value);
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasExactKeys(value, expected) {
    if (!isRecord(value)) return false;
    try {
      const keys = Object.keys(value).sort();
      const sortedExpected = [...expected].sort();
      return keys.length === sortedExpected.length
        && keys.every((key, index) => key === sortedExpected[index]);
    } catch (_) {
      return false;
    }
  }

  function isSha256(value) {
    return typeof value === "string" && SHA256_RE.test(value);
  }

  function validReviewedAt(value) {
    if (typeof value !== "string" || value.length < 20 || value.length > 27) return false;
    const match = REVIEWED_AT_RE.exec(value);
    if (!match) return false;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
      return false;
    }
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= days[month - 1] && Number.isFinite(Date.parse(value));
  }

  function parsePaperSlideApiBase(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password
          || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
      return parsed.origin;
    } catch (_) {
      return null;
    }
  }

  function isPaperSlideRequestId(value) {
    return typeof value === "string" && PAPER_SLIDE_REQUEST_ID_RE.test(value);
  }

  function isPaperSlideStatusCapability(value) {
    return typeof value === "string" && PAPER_SLIDE_STATUS_CAP_RE.test(value);
  }

  function paperSlideEligibility(paper, publicState, apiBase = PAPER_SLIDE_API_BASE) {
    if (publicState === "published") {
      return Object.freeze({ state: "published", reason: null, coverage: null });
    }
    if (publicState !== "not_published") {
      return Object.freeze({ state: "unavailable", reason: "public_unverified", coverage: null });
    }
    if (parsePaperSlideApiBase(apiBase) === null) {
      return Object.freeze({ state: "unavailable", reason: "api_unavailable", coverage: null });
    }
    if (!isRecord(paper) || !isPaperId(paper.paper_id)) {
      return Object.freeze({ state: "unavailable", reason: "paper_invalid", coverage: null });
    }
    const usablePdf = typeof paper.pdf_url === "string" && /^https:\/\/[^\s]+$/i.test(paper.pdf_url);
    const usableAbstract = typeof paper.abstract === "string" && paper.abstract.trim().length > 0;
    if (!usablePdf && !usableAbstract) {
      return Object.freeze({ state: "unavailable", reason: "source_unavailable", coverage: null });
    }
    return Object.freeze({
      state: "requestable",
      reason: null,
      coverage: usablePdf ? "auto" : "abstract_only",
    });
  }

  function parsePaperSlideRequestResponse(value, expectedPaperId, previousCredentials = null) {
    const fields = ["deduplicated", "ok", "paper_id", "request_id", "status", "status_cap"];
    if (!isPaperId(expectedPaperId) || !hasExactKeys(value, fields)
        || value.ok !== true || value.status !== "queued"
        || value.paper_id !== expectedPaperId
        || !isPaperSlideRequestId(value.request_id)
        || !isPaperSlideStatusCapability(value.status_cap)
        || value.request_id === value.status_cap
        || typeof value.deduplicated !== "boolean") return null;
    if (isRecord(previousCredentials)
        && (value.request_id === previousCredentials.request_id
          || value.status_cap === previousCredentials.status_cap)) return null;
    return Object.freeze({ ...value });
  }

  function validStatusTimestamp(value) {
    return validReviewedAt(value);
  }

  function parsePaperSlideStatusResponse(value, expectedRequestId, expectedPaperId) {
    const commonFields = [
      "coverage", "deck_id", "message_code", "ok", "paper_id", "phase",
      "preview_available", "preview_expires_at", "public_url", "request_id",
      "status", "updated_at",
    ];
    if (!isRecord(value) || !isPaperSlideRequestId(expectedRequestId)
        || !isPaperId(expectedPaperId) || value.status === undefined) return null;
    const failure = PAPER_SLIDE_FAILURE_STATUSES.has(value.status);
    if (!hasExactKeys(value, failure ? [...commonFields, "retryable"] : commonFields)
        || value.ok !== true || value.request_id !== expectedRequestId
        || value.paper_id !== expectedPaperId || !PAPER_SLIDE_STATUSES.has(value.status)
        || (value.phase !== null && !PAPER_SLIDE_PHASES.has(value.phase))
        || (value.coverage !== null && !PAPER_SLIDE_COVERAGES.has(value.coverage))
        || (value.deck_id !== null && (typeof value.deck_id !== "string" || !DECK_ID_RE.test(value.deck_id)))
        || typeof value.preview_available !== "boolean"
        || (value.preview_expires_at !== null && !validStatusTimestamp(value.preview_expires_at))
        || (value.public_url !== null
          && (typeof value.public_url !== "string" || !PAPER_SLIDE_DECK_PATH_RE.test(value.public_url)))
        || typeof value.message_code !== "string"
        || !validStatusTimestamp(value.updated_at)
        || (failure && typeof value.retryable !== "boolean")) return null;

    if (value.preview_available !== (value.preview_expires_at !== null)) return null;
    let expectedMessageCode;
    if (value.status === "queued") {
      expectedMessageCode = PAPER_SLIDE_MESSAGE_CODES.queued;
      if (value.phase !== null || value.coverage !== null || value.deck_id !== null
          || value.preview_available || value.public_url !== null) return null;
    } else if (value.status === "running") {
      expectedMessageCode = PAPER_SLIDE_MESSAGE_CODES[value.phase];
      if (!PAPER_SLIDE_RUNNING_PHASES.has(value.phase) || value.coverage !== null
          || value.deck_id !== null || value.preview_available || value.public_url !== null) return null;
    } else if (value.status === "validating") {
      expectedMessageCode = PAPER_SLIDE_MESSAGE_CODES.validating;
      if (value.phase !== "validating" || value.coverage !== null || value.deck_id !== null
          || value.preview_available || value.public_url !== null) return null;
    } else if (value.status === "awaiting_review") {
      expectedMessageCode = PAPER_SLIDE_MESSAGE_CODES.awaiting_review;
      if (value.phase !== "awaiting_review" || !PAPER_SLIDE_COVERAGES.has(value.coverage)
          || value.deck_id === null || value.public_url !== null) return null;
      if (value.preview_available
          && Date.parse(value.preview_expires_at) <= Date.parse(value.updated_at)) return null;
    } else if (value.status === "publishing") {
      expectedMessageCode = PAPER_SLIDE_MESSAGE_CODES[value.phase];
      if (!PAPER_SLIDE_PUBLISHING_PHASES.has(value.phase)
          || !PAPER_SLIDE_COVERAGES.has(value.coverage) || value.deck_id === null
          || value.preview_available || value.public_url !== null) return null;
    } else if (value.status === "published") {
      expectedMessageCode = PAPER_SLIDE_MESSAGE_CODES.published;
      if (value.phase !== null || !PAPER_SLIDE_COVERAGES.has(value.coverage)
          || value.deck_id === null || value.preview_available
          || typeof value.public_url !== "string"
          || !value.public_url.startsWith(`${PUBLIC_SLIDE_ROOT}/decks/${value.deck_id}/`)) {
        return null;
      }
    } else {
      expectedMessageCode = PAPER_SLIDE_MESSAGE_CODES[value.status];
      if (value.phase !== null || value.preview_available || value.public_url !== null) return null;
      if ((value.status === "rejected" || value.status === "expired")
          && (!PAPER_SLIDE_COVERAGES.has(value.coverage) || value.deck_id === null)) return null;
      if (value.deck_id !== null && !PAPER_SLIDE_COVERAGES.has(value.coverage)) return null;
    }
    if (value.message_code !== expectedMessageCode) return null;
    return Object.freeze({ ...value });
  }

  function paperSlideDisplayState(status) {
    if (["running", "validating", "publishing"].includes(status)) return "generating";
    if (["failed", "rejected", "expired"].includes(status)) return "failed";
    return PAPER_SLIDE_STATUSES.has(status) ? status : "unavailable";
  }

  function paperSlideStatusMayFollow(previous, next) {
    if (!PAPER_SLIDE_STATUSES.has(previous) || !PAPER_SLIDE_STATUSES.has(next)) return false;
    if (previous === next) return true;
    if (PAPER_SLIDE_TERMINAL_STATUSES.has(previous)) return false;
    if (["failed", "rejected", "expired"].includes(next)) return true;
    const rank = {
      queued: 0,
      running: 1,
      validating: 2,
      awaiting_review: 3,
      publishing: 4,
      published: 5,
    };
    return Number.isInteger(rank[previous]) && Number.isInteger(rank[next])
      && rank[next] >= rank[previous];
  }

  function paperSlideStatusResponseMayFollow(previous, next) {
    if (!isRecord(previous) || !isRecord(next)
        || !paperSlideStatusMayFollow(previous.status, next.status)
        || !validStatusTimestamp(previous.updated_at)
        || !validStatusTimestamp(next.updated_at)
        || Date.parse(next.updated_at) < Date.parse(previous.updated_at)) return false;

    const phaseRank = {
      running: {
        resolving_source: 0,
        fetching: 1,
        extracting: 2,
        generating: 3,
      },
      publishing: { promoting: 0, deploying: 1, smoke: 2 },
    };
    if (previous.status === next.status && phaseRank[previous.status]) {
      const ranks = phaseRank[previous.status];
      if (!Number.isInteger(ranks[previous.phase]) || !Number.isInteger(ranks[next.phase])
          || ranks[next.phase] < ranks[previous.phase]) return false;
    }

    // Once validation has assigned immutable deck identity, later success
    // states must stay bound to the same reviewed candidate. Failure states
    // may intentionally omit that identity, but may not substitute another.
    if (previous.deck_id !== null && next.deck_id !== null
        && previous.deck_id !== next.deck_id) return false;
    if (previous.coverage !== null && next.coverage !== null
        && previous.coverage !== next.coverage) return false;
    return true;
  }

  function publicSlideEntryMatchesStatus(entry, status) {
    return Boolean(
      isRecord(entry) && isRecord(status) && status.status === "published"
      && entry.paper_id === status.paper_id
      && entry.deck_id === status.deck_id
      && entry.coverage === status.coverage
      && entry.deck_path === status.public_url
      && PAPER_SLIDE_DECK_PATH_RE.test(entry.deck_path),
    );
  }

  function serializePaperSlideSession(value) {
    if (!isRecord(value) || !hasExactKeys(value, ["paper_id", "request_id", "status_cap"])
        || !isPaperId(value.paper_id) || !isPaperSlideRequestId(value.request_id)
        || !isPaperSlideStatusCapability(value.status_cap)
        || value.request_id === value.status_cap) return null;
    return JSON.stringify({
      paper_id: value.paper_id,
      request_id: value.request_id,
      status_cap: value.status_cap,
    });
  }

  function parsePaperSlideSession(serialized, expectedPaperId) {
    if (typeof serialized !== "string" || serialized.length > 256 || !isPaperId(expectedPaperId)) {
      return null;
    }
    try {
      const value = JSON.parse(serialized);
      const canonical = serializePaperSlideSession(value);
      return canonical === serialized && value.paper_id === expectedPaperId
        ? Object.freeze({ ...value })
        : null;
    } catch (_) {
      return null;
    }
  }

  function paperSlidePollDelay(attempt) {
    if (!Number.isInteger(attempt) || attempt < 0) return 30_000;
    return Math.min(30_000, 2_000 * (2 ** Math.min(attempt, 4)));
  }

  function parsePublicSlideTrustRoot(value) {
    if (!hasExactKeys(value, ["schema_version", "manifest_path", "manifest_sha256"])
        || value.schema_version !== "paper-slide-public-trust-root-v1"
        || value.manifest_path !== PUBLIC_SLIDE_MANIFEST_PATH
        || !isSha256(value.manifest_sha256)) return null;
    return Object.freeze({ ...value });
  }

  function parsePublicSlideManifest(value) {
    if (!hasExactKeys(value, ["manifest_path", "schema_version", "shards"])
        || value.schema_version !== PUBLIC_SLIDE_MANIFEST_VERSION
        || value.manifest_path !== PUBLIC_SLIDE_MANIFEST_PATH
        || !Array.isArray(value.shards) || value.shards.length !== 256) return null;

    let totalEntries = 0;
    const shards = [];
    for (let ordinal = 0; ordinal < 256; ordinal++) {
      const row = value.shards[ordinal];
      const prefix = ordinal.toString(16).padStart(2, "0");
      if (!hasExactKeys(row, ["entry_count", "path", "prefix", "sha256"])
          || row.prefix !== prefix
          || row.path !== `${PUBLIC_SLIDE_ROOT}/index/${prefix}.json`
          || !isSha256(row.sha256)
          || !Number.isInteger(row.entry_count) || row.entry_count < 0
          || row.entry_count > MAX_PUBLIC_SLIDE_ENTRIES) return null;
      totalEntries += row.entry_count;
      if (totalEntries > MAX_PUBLIC_SLIDE_ENTRIES) return null;
      shards.push(Object.freeze({ ...row }));
    }
    return Object.freeze({
      manifest_path: value.manifest_path,
      schema_version: value.schema_version,
      shards: Object.freeze(shards),
    });
  }

  function parsePublicSlideEntry(value, prefix) {
    const fields = [
      "coverage", "deck_id", "deck_json_path", "deck_path", "deck_sha256",
      "html_sha256", "language", "paper_id", "reviewed_at",
    ];
    if (!hasExactKeys(value, fields) || !isPaperId(value.paper_id)
        || !value.paper_id.startsWith(prefix)
        || typeof value.deck_id !== "string" || !DECK_ID_RE.test(value.deck_id)
        || !["ja", "en"].includes(value.language)
        || !["full_text", "abstract_only"].includes(value.coverage)
        || !isSha256(value.deck_sha256) || !isSha256(value.html_sha256)
        || !validReviewedAt(value.reviewed_at)) return null;
    const revision = `${value.deck_sha256}-${value.html_sha256}`;
    const revisionRoot = `${PUBLIC_SLIDE_ROOT}/decks/${value.deck_id}/${revision}`;
    if (value.deck_path !== `${revisionRoot}.html`
        || value.deck_json_path !== `${revisionRoot}.deck.json`) {
      return null;
    }
    return Object.freeze({ ...value });
  }

  function parsePublicSlideShard(value, options = {}) {
    const prefix = isRecord(options) ? options.prefix : null;
    const entryCount = isRecord(options) ? options.entryCount : null;
    if (typeof prefix !== "string" || !/^[0-9a-f]{2}$/.test(prefix)
        || !Number.isInteger(entryCount) || entryCount < 0
        || entryCount > MAX_PUBLIC_SLIDE_ENTRIES
        || !hasExactKeys(value, ["entries", "schema_version"])
        || value.schema_version !== PUBLIC_SLIDE_INDEX_VERSION
        || !Array.isArray(value.entries) || value.entries.length !== entryCount) return null;

    const entries = [];
    const identities = new Set();
    let previousKey = null;
    for (const rawEntry of value.entries) {
      const entry = parsePublicSlideEntry(rawEntry, prefix);
      if (!entry) return null;
      const identity = `${entry.paper_id}\u0000${entry.language}`;
      const orderKey = `${identity}\u0000${entry.deck_id}`;
      if (identities.has(identity) || (previousKey !== null && previousKey >= orderKey)) return null;
      identities.add(identity);
      previousKey = orderKey;
      entries.push(entry);
    }
    return Object.freeze({
      schema_version: value.schema_version,
      entries: Object.freeze(entries),
    });
  }

  function resolvePublicSlideState(shard, paperId) {
    if (!isPaperId(paperId) || !shard || !Array.isArray(shard.entries)) {
      return Object.freeze({ state: "unverified", entry: null });
    }
    const matches = shard.entries.filter((entry) => entry.paper_id === paperId);
    if (matches.length === 0) return Object.freeze({ state: "not_published", entry: null });
    const entry = matches.find((item) => item.language === "ja") || matches[0];
    return Object.freeze({ state: "published", entry });
  }

  function equalBytes(left, right) {
    return left.byteLength === right.byteLength
      && left.every((byte, index) => byte === right[index]);
  }

  async function readBoundedResponse(response, maximumBytes) {
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined && declared !== "") {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) return null;
    }
    if (typeof response.body?.getReader !== "function") return null;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => {});
        return null;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  function isAbortError(error) {
    return error?.name === "AbortError";
  }

  async function fetchVerifiedBytes(
    path, expectedSha256, maximumBytes, { fetchImpl, cryptoImpl, origin, signal },
  ) {
    try {
      if (typeof fetchImpl !== "function" || !cryptoImpl?.subtle
          || !isSha256(expectedSha256) || typeof origin !== "string") return null;
      const originUrl = new URL(origin);
      const expectedUrl = new URL(path, originUrl);
      if (expectedUrl.origin !== originUrl.origin) return null;
      const response = await fetchImpl(expectedUrl.href, {
        cache: "no-cache",
        credentials: "same-origin",
        redirect: "error",
        signal,
      });
      if (!response?.ok || response.redirected === true || response.url !== expectedUrl.href) {
        return null;
      }
      const bytes = await readBoundedResponse(response, maximumBytes);
      if (!bytes || bytes.byteLength === 0) return null;
      const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
      const actualSha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      return actualSha256 === expectedSha256 ? bytes : null;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  async function fetchVerifiedCanonicalJson(
    path, expectedSha256, maximumBytes, options,
  ) {
    try {
      const bytes = await fetchVerifiedBytes(path, expectedSha256, maximumBytes, options);
      if (!bytes) return null;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const data = JSON.parse(text);
      const canonical = new TextEncoder().encode(`${JSON.stringify(data)}\n`);
      return equalBytes(bytes, canonical) ? data : null;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  function publicSlideDeckMatchesEntry(deck, entry) {
    try {
      return isRecord(deck)
        && deck.paper_id === entry.paper_id
        && deck.deck_id === entry.deck_id
        && deck.language === entry.language
        && isRecord(deck.coverage)
        && deck.coverage.kind === entry.coverage
        && isRecord(deck.review)
        && deck.review.status === "reviewed";
    } catch (_) {
      return false;
    }
  }

  async function loadPublicSlideState(
    paperId,
    {
      trustRoot = PUBLIC_SLIDE_TRUST_ROOT,
      fetchImpl = globalThis.fetch,
      cryptoImpl = globalThis.crypto,
      origin = globalThis.location?.origin,
      signal,
    } = {},
  ) {
    if (!isPaperId(paperId)) return Object.freeze({ state: "unverified", entry: null });
    const root = parsePublicSlideTrustRoot(trustRoot);
    if (!root) return Object.freeze({ state: "unverified", entry: null });
    const manifestData = await fetchVerifiedCanonicalJson(
      root.manifest_path,
      root.manifest_sha256,
      MAX_PUBLIC_SLIDE_MANIFEST_BYTES,
      { fetchImpl, cryptoImpl, origin, signal },
    );
    const manifest = parsePublicSlideManifest(manifestData);
    if (!manifest) return Object.freeze({ state: "unverified", entry: null });
    const shardRow = manifest.shards[Number.parseInt(paperId.slice(0, 2), 16)];
    const shardData = await fetchVerifiedCanonicalJson(
      shardRow.path,
      shardRow.sha256,
      MAX_PUBLIC_SLIDE_SHARD_BYTES,
      { fetchImpl, cryptoImpl, origin, signal },
    );
    const shard = parsePublicSlideShard(shardData, {
      prefix: shardRow.prefix,
      entryCount: shardRow.entry_count,
    });
    if (!shard) return Object.freeze({ state: "unverified", entry: null });
    const resolved = resolvePublicSlideState(shard, paperId);
    if (resolved.state !== "published") return resolved;

    const deck = await fetchVerifiedCanonicalJson(
      resolved.entry.deck_json_path,
      resolved.entry.deck_sha256,
      MAX_PUBLIC_SLIDE_DECK_BYTES,
      { fetchImpl, cryptoImpl, origin, signal },
    );
    if (!publicSlideDeckMatchesEntry(deck, resolved.entry)) {
      return Object.freeze({ state: "unverified", entry: null });
    }
    const html = await fetchVerifiedBytes(
      resolved.entry.deck_path,
      resolved.entry.html_sha256,
      MAX_PUBLIC_SLIDE_HTML_BYTES,
      { fetchImpl, cryptoImpl, origin, signal },
    );
    return html
      ? resolved
      : Object.freeze({ state: "unverified", entry: null });
  }

  function validateCatalog(papers) {
    if (!Array.isArray(papers)) throw new Error("catalog must be an array");
    const byId = new Map();
    papers.forEach((paper, ordinal) => {
      if (!paper || typeof paper !== "object" || Array.isArray(paper)) {
        throw new Error(`catalog row ${ordinal} must be an object`);
      }
      if (!isPaperId(paper.paper_id)) {
        throw new Error(`catalog row ${ordinal} has invalid paper_id`);
      }
      if (byId.has(paper.paper_id)) {
        throw new Error(`duplicate paper_id: ${paper.paper_id}`);
      }
      if (typeof paper.title !== "string" || !paper.title.trim()) {
        throw new Error(`catalog row ${ordinal} has invalid title`);
      }
      if (!Array.isArray(paper.authors) || !paper.authors.every((item) => typeof item === "string")) {
        throw new Error(`catalog row ${ordinal} has invalid authors`);
      }
      if (!Array.isArray(paper.tags) || !paper.tags.every((item) => typeof item === "string")) {
        throw new Error(`catalog row ${ordinal} has invalid tags`);
      }
      if (typeof paper.abstract !== "string") {
        throw new Error(`catalog row ${ordinal} has invalid abstract`);
      }
      byId.set(paper.paper_id, paper);
    });
    return byId;
  }

  function readPaperParam(search) {
    const raw = new URLSearchParams(search).get("paper");
    return { raw, paperId: isPaperId(raw) ? raw : null };
  }

  function pinSelected(papers, selected) {
    if (!selected) return [...papers];
    return [
      selected,
      ...papers.filter((paper) => paper.paper_id !== selected.paper_id),
    ];
  }

  function detailShardUrl(paperId) {
    if (!isPaperId(paperId)) throw new Error("invalid paper_id for detail shard");
    return `../paper-details-v1/${paperId.slice(0, 2)}.json`;
  }

  function readDetailAbstract(data, paperId) {
    if (!isPaperId(paperId)) throw new Error("invalid paper_id for detail lookup");
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("detail shard must be an object");
    }
    const keys = Object.keys(data).sort();
    const expectedKeys = ["papers", "prefix", "schema_version"];
    if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) {
      throw new Error("detail shard has unexpected fields");
    }
    if (data.schema_version !== "paper-details-v1") {
      throw new Error("detail shard schema_version is invalid");
    }
    const prefix = paperId.slice(0, 2);
    if (data.prefix !== prefix) throw new Error("detail shard prefix does not match paper_id");
    if (!Array.isArray(data.papers)) throw new Error("detail shard papers must be an array");

    let previous = null;
    data.papers.forEach((row, ordinal) => {
      if (
        !Array.isArray(row) || row.length !== 2 ||
        !isPaperId(row[0]) || !row[0].startsWith(prefix) || typeof row[1] !== "string"
      ) {
        throw new Error(`detail shard row ${ordinal} is invalid`);
      }
      if (previous !== null && previous >= row[0]) {
        throw new Error("detail shard paper IDs must be strictly sorted");
      }
      previous = row[0];
    });

    let low = 0;
    let high = data.papers.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const row = data.papers[mid];
      if (row[0] === paperId) return row[1];
      if (row[0] < paperId) low = mid + 1;
      else high = mid - 1;
    }
    throw new Error(`paper_id not found in detail shard: ${paperId}`);
  }

  function setPaperParam(urlValue, paperId) {
    const url = new URL(urlValue);
    if (paperId === null) url.searchParams.delete("paper");
    else {
      if (!isPaperId(paperId)) throw new Error("invalid paper_id for URL");
      url.searchParams.set("paper", paperId);
    }
    return url.toString();
  }

  root.PaperPilotCatalogCore = Object.freeze({
    isPaperId,
    validateCatalog,
    readPaperParam,
    pinSelected,
    detailShardUrl,
    readDetailAbstract,
    setPaperParam,
    PUBLIC_SLIDE_TRUST_ROOT,
    MAX_PUBLIC_SLIDE_MANIFEST_BYTES,
    MAX_PUBLIC_SLIDE_SHARD_BYTES,
    MAX_PUBLIC_SLIDE_DECK_BYTES,
    MAX_PUBLIC_SLIDE_HTML_BYTES,
    parsePublicSlideTrustRoot,
    parsePublicSlideManifest,
    parsePublicSlideShard,
    resolvePublicSlideState,
    publicSlideDeckMatchesEntry,
    loadPublicSlideState,
    PAPER_SLIDE_API_BASE,
    parsePaperSlideApiBase,
    paperSlideEligibility,
    parsePaperSlideRequestResponse,
    parsePaperSlideStatusResponse,
    paperSlideDisplayState,
    paperSlideStatusMayFollow,
    paperSlideStatusResponseMayFollow,
    publicSlideEntryMatchesStatus,
    serializePaperSlideSession,
    parsePaperSlideSession,
    paperSlidePollDelay,
  });
})(typeof globalThis === "undefined" ? this : globalThis);
