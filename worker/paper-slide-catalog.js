// Read-only adapter for a code-pinned Paper Slide catalog snapshot. The
// adapter performs no network requests and returns only the projection used by
// paper-slide-api.js; canonical source material never crosses that boundary.

import {
  PAPER_ID_PATTERN,
  isPaperSlideFailureCode,
} from "./paper-slide-contract.js";

export const PAPER_SLIDE_CATALOG_PIN_SCHEMA = "paper-slide-approved-catalog-pin-v1";
export const PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA =
  "paper-slide-approved-catalog-manifest-v1";
export const PAPER_SLIDE_CATALOG_RECORD_SCHEMA =
  "paper-slide-approved-catalog-record-v1";
export const PAPER_SLIDE_JOB_KEY_SCHEMA = "paper-slide-job-key-v1";

export const PAPER_SLIDE_CATALOG_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const PAPER_SLIDE_CATALOG_MAX_RECORD_BYTES = 64 * 1024;
export const PAPER_SLIDE_CATALOG_MAX_RECORDS = 100_000;

const SHA256_PATTERN = /^[0-9a-f]{64}(?![\s\S])/;
const SNAPSHOT_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}(?![\s\S])/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}(?![\s\S])/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}(?![\s\S])/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/()+=-]{0,511}(?![\s\S])/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}(?![\s\S])/;
const LANGUAGES = new Set(["ja", "en"]);
const COVERAGES = new Set(["full_text", "abstract_only"]);

const PIN_KEYS = Object.freeze([
  "manifest_key",
  "manifest_sha256",
  "records_prefix",
  "schema_version",
  "snapshot_version",
]);
const MANIFEST_KEYS = Object.freeze([
  "record_count",
  "records",
  "schema_version",
  "snapshot_version",
]);
const MANIFEST_ENTRY_KEYS = Object.freeze(["paper_id", "sha256"]);
const RECORD_KEYS = Object.freeze([
  "canonical_material",
  "eligible",
  "failure_code",
  "paper_id",
  "schema_version",
  "snapshot_version",
]);
const MATERIAL_KEYS = Object.freeze([
  "deck_profile",
  "deck_schema_version",
  "extractor_version",
  "input",
  "license_policy_version",
  "model",
  "paper_id",
  "prompt_version",
  "provider",
  "source",
]);
const SOURCE_KEYS = Object.freeze(["landing_url", "source", "source_id"]);
const INPUT_KEYS = Object.freeze(["content_sha256", "coverage", "pdf_url"]);

function hasExactOwnDataKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined && Object.hasOwn(descriptor, "value") &&
      descriptor.enumerable === true;
  });
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function isPaperId(value) {
  return typeof value === "string" && PAPER_ID_PATTERN.test(value);
}

function isLanguage(value) {
  return typeof value === "string" && LANGUAGES.has(value);
}

function isSafeBindingKey(value, { prefix = false } = {}) {
  if (typeof value !== "string" || !SAFE_KEY_PATTERN.test(value)) return false;
  if (value.startsWith("/") || value.includes("//") || value.includes("\\")) return false;
  const parts = value.split("/");
  if (prefix && parts.at(-1) === "") parts.pop();
  if (prefix !== value.endsWith("/")) return false;
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function isCanonicalHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" &&
      parsed.hash === "" && parsed.href === value;
  } catch {
    return false;
  }
}

function validatePin(value) {
  if (!hasExactOwnDataKeys(value, PIN_KEYS) ||
      value.schema_version !== PAPER_SLIDE_CATALOG_PIN_SCHEMA ||
      !matches(value.snapshot_version, SNAPSHOT_VERSION_PATTERN) ||
      !isSha256(value.manifest_sha256) ||
      !isSafeBindingKey(value.manifest_key) ||
      !isSafeBindingKey(value.records_prefix, { prefix: true })) {
    throw new TypeError("Paper Slide catalog pin is invalid");
  }
  return Object.freeze({
    schema_version: value.schema_version,
    snapshot_version: value.snapshot_version,
    manifest_key: value.manifest_key,
    manifest_sha256: value.manifest_sha256,
    records_prefix: value.records_prefix,
  });
}

function validateMaximum(value, maximum, label) {
  if (!Number.isInteger(value) || value < 128 || value > maximum) {
    throw new TypeError(`Paper Slide catalog ${label} byte limit is invalid`);
  }
  return value;
}

function byteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

async function readStreamBounded(stream, maximumBytes) {
  let reader;
  try {
    reader = stream.getReader();
  } catch {
    throw new Error("Paper Slide catalog object body is unreadable");
  }
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Paper Slide catalog chunk is invalid");
      length += value.byteLength;
      if (length > maximumBytes) throw new Error("Paper Slide catalog object is oversized");
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Keep the original closed read failure.
    }
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function normalizeBindingValue(value, maximumBytes) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > maximumBytes) throw new Error("Paper Slide catalog object is oversized");
    return bytes;
  }
  const direct = byteView(value);
  if (direct !== null) {
    if (direct.byteLength > maximumBytes) throw new Error("Paper Slide catalog object is oversized");
    return direct.slice();
  }
  if (typeof value !== "object") throw new Error("Paper Slide catalog object is invalid");
  if (value.body && typeof value.body.getReader === "function") {
    return readStreamBounded(value.body, maximumBytes);
  }
  if (typeof value.arrayBuffer === "function") {
    const buffered = byteView(await value.arrayBuffer());
    if (buffered === null) throw new Error("Paper Slide catalog object is invalid");
    if (buffered.byteLength > maximumBytes) throw new Error("Paper Slide catalog object is oversized");
    return buffered.slice();
  }
  throw new Error("Paper Slide catalog object is invalid");
}

async function sha256Bytes(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Paper Slide catalog object is not UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Paper Slide catalog object is not JSON");
  }
}

function validateManifest(value, pin) {
  if (!hasExactOwnDataKeys(value, MANIFEST_KEYS) ||
      value.schema_version !== PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA ||
      value.snapshot_version !== pin.snapshot_version ||
      !Number.isInteger(value.record_count) || value.record_count < 0 ||
      value.record_count > PAPER_SLIDE_CATALOG_MAX_RECORDS ||
      !Array.isArray(value.records) || value.records.length !== value.record_count) {
    throw new Error("Paper Slide catalog manifest is invalid");
  }
  const records = new Map();
  let previous = null;
  for (const entry of value.records) {
    if (!hasExactOwnDataKeys(entry, MANIFEST_ENTRY_KEYS) ||
        !isPaperId(entry.paper_id) || !isSha256(entry.sha256)) {
      throw new Error("Paper Slide catalog manifest entry is invalid");
    }
    if (previous !== null && entry.paper_id <= previous) {
      throw new Error("Paper Slide catalog manifest entries are not canonical");
    }
    previous = entry.paper_id;
    records.set(entry.paper_id, entry.sha256);
  }
  return records;
}

function validateCanonicalMaterial(value, paperId) {
  if (!hasExactOwnDataKeys(value, MATERIAL_KEYS) || value.paper_id !== paperId ||
      !hasExactOwnDataKeys(value.source, SOURCE_KEYS) ||
      !hasExactOwnDataKeys(value.input, INPUT_KEYS)) return false;
  if (!matches(value.source.source, NAME_PATTERN) ||
      !matches(value.source.source_id, SOURCE_ID_PATTERN) ||
      !isCanonicalHttpsUrl(value.source.landing_url) ||
      !COVERAGES.has(value.input.coverage) || !isSha256(value.input.content_sha256)) return false;
  if (value.input.coverage === "full_text") {
    if (!isCanonicalHttpsUrl(value.input.pdf_url)) return false;
  } else if (value.input.pdf_url !== null) {
    return false;
  }
  return matches(value.deck_profile, VERSION_PATTERN) &&
    matches(value.deck_schema_version, VERSION_PATTERN) &&
    matches(value.extractor_version, VERSION_PATTERN) &&
    matches(value.license_policy_version, VERSION_PATTERN) &&
    matches(value.model, NAME_PATTERN) && matches(value.prompt_version, VERSION_PATTERN) &&
    matches(value.provider, NAME_PATTERN);
}

function canonicalJobKeyPayload(material, language) {
  return JSON.stringify({
    job_key_schema: PAPER_SLIDE_JOB_KEY_SCHEMA,
    paper_id: material.paper_id,
    source: {
      source: material.source.source,
      source_id: material.source.source_id,
      landing_url: material.source.landing_url,
    },
    input: {
      coverage: material.input.coverage,
      content_sha256: material.input.content_sha256,
      pdf_url: material.input.pdf_url,
    },
    language,
    deck_profile: material.deck_profile,
    extractor_version: material.extractor_version,
    provider: material.provider,
    model: material.model,
    prompt_version: material.prompt_version,
    deck_schema_version: material.deck_schema_version,
    license_policy_version: material.license_policy_version,
  });
}

export async function canonicalPaperSlideJobKey(material, language) {
  let paperId;
  try {
    paperId = material?.paper_id;
  } catch {
    throw new TypeError("Paper Slide canonical job material is invalid");
  }
  if (!isPaperId(paperId) || !isLanguage(language) ||
      !validateCanonicalMaterial(material, paperId)) {
    throw new TypeError("Paper Slide canonical job material is invalid");
  }
  return sha256Bytes(new TextEncoder().encode(canonicalJobKeyPayload(material, language)));
}

async function unavailableJobKey(record, language) {
  const payload = JSON.stringify({
    job_key_schema: "paper-slide-unavailable-key-v1",
    paper_id: record.paper_id,
    language,
    snapshot_version: record.snapshot_version,
    failure_code: record.failure_code,
  });
  return sha256Bytes(new TextEncoder().encode(payload));
}

async function projectRecord(value, pin, paperId, language) {
  if (!hasExactOwnDataKeys(value, RECORD_KEYS) ||
      value.schema_version !== PAPER_SLIDE_CATALOG_RECORD_SCHEMA ||
      value.snapshot_version !== pin.snapshot_version || value.paper_id !== paperId ||
      typeof value.eligible !== "boolean") {
    throw new Error("Paper Slide catalog record is invalid");
  }
  let derivedJobKey;
  if (value.eligible) {
    if (value.failure_code !== null ||
        !validateCanonicalMaterial(value.canonical_material, paperId)) {
      throw new Error("Paper Slide catalog eligible record is invalid");
    }
    derivedJobKey = await canonicalPaperSlideJobKey(value.canonical_material, language);
  } else {
    if (value.canonical_material !== null || !isPaperSlideFailureCode(value.failure_code)) {
      throw new Error("Paper Slide catalog unavailable record is invalid");
    }
    derivedJobKey = await unavailableJobKey(value, language);
  }
  const projection = {
    paper_id: paperId,
    eligible: value.eligible,
    snapshot_version: pin.snapshot_version,
    job_key: derivedJobKey,
  };
  if (!value.eligible) projection.failure_code = value.failure_code;
  return Object.freeze(projection);
}

export function createPaperSlideCatalogAdapter({
  binding,
  pin: pinValue,
  maximumManifestBytes = PAPER_SLIDE_CATALOG_MAX_MANIFEST_BYTES,
  maximumRecordBytes = PAPER_SLIDE_CATALOG_MAX_RECORD_BYTES,
}) {
  let get;
  try {
    if (binding === null || (typeof binding !== "object" && typeof binding !== "function")) {
      throw new TypeError("invalid binding");
    }
    const getMethod = binding.get;
    if (typeof getMethod !== "function") throw new TypeError("invalid binding");
    get = getMethod.bind(binding);
  } catch {
    throw new TypeError("Paper Slide catalog read-only binding is required");
  }
  const pin = validatePin(pinValue);
  const manifestLimit = validateMaximum(
    maximumManifestBytes,
    PAPER_SLIDE_CATALOG_MAX_MANIFEST_BYTES,
    "manifest",
  );
  const recordLimit = validateMaximum(
    maximumRecordBytes,
    PAPER_SLIDE_CATALOG_MAX_RECORD_BYTES,
    "record",
  );
  let manifestPromise = null;

  async function read(key, maximumBytes) {
    return normalizeBindingValue(await get(key), maximumBytes);
  }

  async function loadManifest() {
    if (manifestPromise === null) {
      manifestPromise = (async () => {
        const bytes = await read(pin.manifest_key, manifestLimit);
        if (bytes === null || await sha256Bytes(bytes) !== pin.manifest_sha256) {
          throw new Error("Paper Slide catalog manifest is absent or unpinned");
        }
        return validateManifest(parseJson(bytes), pin);
      })();
    }
    try {
      return await manifestPromise;
    } catch (error) {
      manifestPromise = null;
      throw error;
    }
  }

  return Object.freeze({
    async resolve(paperId, language) {
      if (!isPaperId(paperId) || !isLanguage(language)) {
        throw new TypeError("Paper Slide catalog lookup is invalid");
      }
      const manifest = await loadManifest();
      const expectedDigest = manifest.get(paperId);
      if (expectedDigest === undefined) return null;
      const key = `${pin.records_prefix}${paperId}.json`;
      const bytes = await read(key, recordLimit);
      if (bytes === null || await sha256Bytes(bytes) !== expectedDigest) {
        throw new Error("Paper Slide catalog record is absent or unpinned");
      }
      return projectRecord(parseJson(bytes), pin, paperId, language);
    },
  });
}
