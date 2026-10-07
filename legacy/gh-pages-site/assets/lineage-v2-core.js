// Strict lineage v2 release reader and deterministic Focus View projection.
(function initPaperPilotLineageV2(root) {
  "use strict";

  const INDEX_VERSION = "lineage-pilot-index-v1";
  const ARTIFACT_VERSION = "lineage-artifact-v2";
  const FIXTURE_VERSION = "lineage-audit-fixtures-v2";
  const QUALITY_VERSION = "lineage-quality-v2";
  const PILOT_PROFILE = "claim-verified-pilot-v1";
  const PAPER_ID_RE = /^[0-9a-f]{40}$/;
  const SHA_RE = /^[0-9a-f]{64}$/;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  const GENEALOGY = new Set(["supersedes", "successor", "extends"]);
  const COMPARISON = new Set(["ablation", "baseline_only", "contrasts"]);
  const RELATIONS = new Set([...GENEALOGY, ...COMPARISON]);
  const DECISIONS = new Set(["accepted", "unknown", "abstained", "rejected"]);
  const TRUST_TIERS = new Set(["verified", "corroborated", "tentative"]);
  const METHODS = new Set([
    "human_review", "llm", "citation_heuristic", "intent_map", "context_pattern",
    "year_cite", "title_version", "foundational_allowlist",
  ]);
  const ALIAS_NAMESPACES = new Set(["arxiv", "openreview", "acl_anthology", "cvf", "doi"]);
  const SUPPORT = new Set(["supports", "insufficient", "conflicts"]);
  const STATUS = new Set(["unknown", "passed", "failed", "not_applicable"]);
  const MAX_JSON_DEPTH = 64;
  const MAX_JSON_VALUES = 100000;
  const MAX_STRING_BYTES = 1024 * 1024;
  const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
  const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
  const MAX_QUALITY_BYTES = 256 * 1024;
  const MAX_INDEX_BYTES = 256 * 1024;
  const MAX_NODES = 10000;
  const MAX_LINKS = 50000;
  const MAX_EVIDENCE = 50000;
  const MAX_CLAIMS = 50000;
  const MAX_EXPANDED_IDS = 64;
  const MAX_STATE_TEXT = 8192;
  const indexBrand = new WeakSet();
  const entryBrand = new WeakSet();
  const releaseBrand = new WeakSet();
  const releasePrivate = new WeakMap();

  function record(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function exactKeys(value, expected) {
    if (!record(value)) return false;
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
  }

  function text(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function nullableText(value) {
    return value === null || text(value);
  }

  function nonnegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function unitNumber(value, nullable = true) {
    return (nullable && value === null)
      || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
  }

  function uniqueTextArray(value, nonempty = false) {
    return Array.isArray(value) && (!nonempty || value.length > 0)
      && value.every(text) && new Set(value).size === value.length;
  }

  function invalidSurrogate(value) {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (++index >= value.length) return true;
        const low = value.charCodeAt(index);
        if (low < 0xdc00 || low > 0xdfff) return true;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function boundedJson(value) {
    const stack = [[value, 0]];
    const seen = new Set();
    let count = 0;
    while (stack.length > 0) {
      const [item, depth] = stack.pop();
      if (++count > MAX_JSON_VALUES || depth > MAX_JSON_DEPTH) return false;
      if (item === null || typeof item === "boolean") continue;
      if (typeof item === "string") {
        if (invalidSurrogate(item) || new TextEncoder().encode(item).byteLength > MAX_STRING_BYTES) {
          return false;
        }
        continue;
      }
      if (typeof item === "number") {
        if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) return false;
        continue;
      }
      if (!record(item) && !Array.isArray(item)) return false;
      if (seen.has(item)) return false;
      seen.add(item);
      if (Array.isArray(item)) {
        for (const child of item) stack.push([child, depth + 1]);
      } else {
        for (const key of Object.keys(item)) {
          if (invalidSurrogate(key)) return false;
          stack.push([item[key], depth + 1]);
        }
      }
    }
    return true;
  }

  function calendarPartsValid(year, month, day, hour = 0, minute = 0, second = 0) {
    if (year < 1 || year > 9999 || month < 1 || month > 12
        || hour > 23 || minute > 59 || second > 59) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= days[month - 1];
  }

  function validDate(value) {
    if (typeof value !== "string") return false;
    const match = DATE_RE.exec(value);
    return !!match && calendarPartsValid(...match.slice(1).map(Number));
  }

  function validTimestamp(value) {
    if (typeof value !== "string") return false;
    const match = TIMESTAMP_RE.exec(value);
    if (!match || !calendarPartsValid(...match.slice(1, 7).map(Number))) return false;
    const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
    if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return false;
    return Number.isFinite(Date.parse(value));
  }

  function dateValue(value) {
    if (validDate(value)) return BigInt(Date.parse(`${value}T00:00:00Z`)) * 1000n;
    if (validTimestamp(value)) return timestampValue(value);
    return null;
  }

  function timestampValue(value) {
    if (!validTimestamp(value)) return null;
    const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || "";
    const withoutFraction = value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, "");
    const wholeMilliseconds = Date.parse(withoutFraction);
    if (!Number.isFinite(wholeMilliseconds)) return null;
    const microseconds = BigInt((fraction.slice(0, 6) || "0").padEnd(6, "0"));
    return BigInt(wholeMilliseconds) * 1000n + microseconds;
  }

  function validHttpUrl(value) {
    if (typeof value !== "string") return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.length > 0;
    } catch (_error) {
      return false;
    }
  }

  function validAlias(namespace, value) {
    if (!ALIAS_NAMESPACES.has(namespace) || !text(value) || value !== value.trim()) return false;
    if (namespace === "arxiv") {
      if (/^\d{4}\.\d{4,5}$/.test(value)) return true;
      const legacy = /^([A-Za-z][A-Za-z0-9.-]*)\/(\d{7})$/.exec(value);
      if (!legacy || /v\d+$/.test(value)) return false;
      const archive = legacy[1].includes(".")
        ? `${legacy[1].split(".", 1)[0].toLowerCase()}${legacy[1].slice(legacy[1].indexOf("."))}`
        : legacy[1].toLowerCase();
      return value === `${archive}/${legacy[2]}`;
    }
    if (namespace === "openreview") return /^[A-Za-z0-9_-]{1,256}$/.test(value);
    if (namespace === "acl_anthology" || namespace === "cvf") {
      return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$/.test(value);
    }
    let decoded;
    try {
      const octets = [];
      for (let index = 0; index < value.length;) {
        const escape = /^%([0-9A-Fa-f]{2})/.exec(value.slice(index));
        if (escape) {
          octets.push(Number.parseInt(escape[1], 16));
          index += 3;
        } else {
          const character = String.fromCodePoint(value.codePointAt(index));
          octets.push(...new TextEncoder().encode(character));
          index += character.length;
        }
      }
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(octets))
        .trim().toLowerCase();
    } catch (_error) {
      return false;
    }
    return decoded === value && /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/.test(decoded);
  }

  function safeJsonPath(value) {
    if (typeof value !== "string" || !value.endsWith(".json") || value.startsWith("/")
        || value.includes("\\") || /^[A-Za-z]:/.test(value)
        || /[\u0000-\u001f\u007f]/.test(value)) return false;
    const parts = value.split("/");
    return parts.every((part) => part !== "" && part !== "." && part !== ".."
      && part.toLowerCase() !== ".git");
  }

  function validPilotPath(value, entry, kind) {
    if (!safeJsonPath(value) || value.includes("%") || value.includes("?") || value.includes("#")) {
      return false;
    }
    const directory = kind === "artifact" ? "artifacts" : kind === "fixture" ? "fixtures" : "quality";
    return value === `lineage-pilots/${entry.conference}/${entry.paper_id}/${directory}/${entry[kind].sha256}.json`;
  }

  function deepFreeze(value) {
    const stack = [value];
    const seen = new Set();
    while (stack.length > 0) {
      const item = stack.pop();
      if ((record(item) || Array.isArray(item)) && !seen.has(item)) {
        seen.add(item);
        for (const child of Object.values(item)) stack.push(child);
        Object.freeze(item);
      }
    }
    return value;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "number"
        || typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }

  function asBytes(value) {
    if (typeof SharedArrayBuffer !== "undefined"
        && (value instanceof SharedArrayBuffer || value?.buffer instanceof SharedArrayBuffer)) return null;
    if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
    if (value instanceof Uint8Array) return new Uint8Array(value);
    return null;
  }

  async function sha256(bytes) {
    const digest = await root.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
  }

  async function canonicalSha(value) {
    return sha256(new TextEncoder().encode(`${canonicalJson(value)}\n`));
  }

  function strictJsonParse(source) {
    let offset = 0;
    let valueCount = 0;
    const numericTokens = [];
    const whitespace = () => {
      while (offset < source.length && /[\t\n\r ]/.test(source[offset])) offset++;
    };
    const stringValue = () => {
      const start = offset++;
      let escaped = false;
      while (offset < source.length) {
        const character = source[offset++];
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") return JSON.parse(source.slice(start, offset));
        else if (character.charCodeAt(0) < 0x20) throw new SyntaxError("control in string");
      }
      throw new SyntaxError("unterminated string");
    };
    const parseValue = (path, depth) => {
      if (++valueCount > MAX_JSON_VALUES || depth > MAX_JSON_DEPTH) {
        throw new SyntaxError("JSON bounds exceeded");
      }
      whitespace();
      const character = source[offset];
      if (character === "\"") return stringValue();
      if (character === "[") {
        offset++;
        const value = [];
        whitespace();
        if (source[offset] === "]") { offset++; return value; }
        while (true) {
          value.push(parseValue([...path, value.length], depth + 1));
          whitespace();
          if (source[offset] === "]") { offset++; return value; }
          if (source[offset++] !== ",") throw new SyntaxError("array separator required");
        }
      }
      if (character === "{") {
        offset++;
        const value = Object.create(null);
        const keys = new Set();
        whitespace();
        if (source[offset] === "}") { offset++; return value; }
        while (true) {
          whitespace();
          if (source[offset] !== "\"") throw new SyntaxError("object key required");
          const key = stringValue();
          if (keys.has(key)) throw new SyntaxError("duplicate object key");
          keys.add(key);
          whitespace();
          if (source[offset++] !== ":") throw new SyntaxError("object colon required");
          value[key] = parseValue([...path, key], depth + 1);
          whitespace();
          if (source[offset] === "}") { offset++; return value; }
          if (source[offset++] !== ",") throw new SyntaxError("object separator required");
        }
      }
      for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
        if (source.startsWith(literal, offset)) { offset += literal.length; return value; }
      }
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
      if (!number) throw new SyntaxError("JSON value required");
      offset += number[0].length;
      const value = Number(number[0]);
      numericTokens.push({
        path,
        value,
        integerLexeme: !/[.eE]/.test(number[0]),
      });
      return value;
    };
    const value = parseValue([], 0);
    whitespace();
    if (offset !== source.length) throw new SyntaxError("trailing JSON content");
    const floatFields = new Set([
      "raw_score", "calibrated_probability", "agreement", "wilson_lower_bound",
      "supersedes_wilson_lower_bound", "macro_precision", "ece", "brier",
      "accepted_coverage", "unknown_abstained_recall",
    ]);
    for (const token of numericTokens) {
      if (!token.integerLexeme && Number.isInteger(token.value)) {
        const field = token.path[token.path.length - 1];
        const arbitraryClusterValue = token.path[0] === "clusters";
        if (!floatFields.has(field) && !arbitraryClusterValue) {
          throw new SyntaxError("integer field used a floating-point token");
        }
      }
    }
    return value;
  }

  async function parseBytes(value, maximum) {
    const bytes = asBytes(value);
    if (bytes === null || bytes.byteLength > maximum) return null;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = strictJsonParse(decoded);
      return boundedJson(parsed) ? { bytes, parsed } : null;
    } catch (_error) {
      return null;
    }
  }

  function parsePilotIndex(value) {
    if (!boundedJson(value) || !exactKeys(value, ["schema_version", "entries"])
        || value.schema_version !== INDEX_VERSION || !Array.isArray(value.entries)
        || value.entries.length > 100
        || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_INDEX_BYTES) return null;
    const ids = new Set();
    for (const entry of value.entries) {
      if (!exactKeys(entry, [
        "paper_id", "conference", "collection_id", "release_id", "release_profile",
        "artifact", "fixture", "quality",
      ]) || !PAPER_ID_RE.test(entry.paper_id) || !SLUG_RE.test(entry.conference)
          || entry.collection_id !== `deep:${entry.conference}:paper:${entry.paper_id}`
          || !text(entry.release_id) || entry.release_profile !== PILOT_PROFILE
          || ids.has(entry.paper_id)) return null;
      ids.add(entry.paper_id);
      for (const kind of ["artifact", "fixture", "quality"]) {
        if (!exactKeys(entry[kind], ["path", "sha256"]) || !SHA_RE.test(entry[kind].sha256)
            || !validPilotPath(entry[kind].path, entry, kind)) return null;
      }
    }
    const parsed = deepFreeze(cloneJson(value));
    indexBrand.add(parsed);
    parsed.entries.forEach((entry) => entryBrand.add(entry));
    return parsed;
  }

  function resolvePilotEntry(index, paperId) {
    if (!record(index) || !indexBrand.has(index) || !PAPER_ID_RE.test(paperId)) return null;
    return index.entries.find((entry) => entry.paper_id === paperId) || null;
  }

  function validateNode(node, nodeIds, aliasOwners, catalogIds) {
    if (!exactKeys(node, ["id", "title", "first_published_at", "is_focus", "seed_paper_id", "aliases"])
        || !text(node.id) || !text(node.title)
        || (dateValue(node.first_published_at) === null) || typeof node.is_focus !== "boolean"
        || !Array.isArray(node.aliases)) return false;
    if (node.is_focus) {
      if (!PAPER_ID_RE.test(node.seed_paper_id) || !catalogIds.has(node.seed_paper_id)) return false;
    } else if (node.seed_paper_id !== null) return false;
    if (nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
    const local = new Set();
    for (const alias of node.aliases) {
      if (!Array.isArray(alias) || alias.length !== 2 || !validAlias(alias[0], alias[1])) return false;
      const key = `${alias[0]}\u0000${alias[1]}`;
      if (local.has(key) || aliasOwners.has(key)) return false;
      local.add(key);
      aliasOwners.set(key, node.id);
    }
    return true;
  }

  function validateLocator(locator) {
    if (!exactKeys(locator, ["page", "section", "reference_marker", "sentence_ordinal", "paragraph_ordinal"])) {
      return false;
    }
    const ordinal = (value, minimum) => value === null || (Number.isSafeInteger(value) && value >= minimum);
    return ordinal(locator.page, 1) && nullableText(locator.section)
      && nullableText(locator.reference_marker) && ordinal(locator.sentence_ordinal, 0)
      && ordinal(locator.paragraph_ordinal, 0) && Object.values(locator).some((value) => value !== null);
  }

  function validateClassification(value) {
    if (!exactKeys(value, ["method", "provider", "model", "prompt_version", "schema_version"])
        || !METHODS.has(value.method) || !nullableText(value.provider) || !nullableText(value.model)
        || !nullableText(value.prompt_version) || !text(value.schema_version)) return false;
    return value.method !== "llm" || [value.provider, value.model, value.prompt_version].every(text);
  }

  async function validateArtifact(artifact, catalogIds) {
    if (!boundedJson(artifact) || !exactKeys(artifact, [
      "schema_version", "release_id", "root", "nodes", "links", "evidence", "claims", "clusters", "meta",
    ]) || artifact.schema_version !== ARTIFACT_VERSION || !text(artifact.release_id)
        || !Array.isArray(artifact.nodes) || artifact.nodes.length > MAX_NODES
        || !Array.isArray(artifact.links) || artifact.links.length > MAX_LINKS
        || !Array.isArray(artifact.evidence) || artifact.evidence.length > MAX_EVIDENCE
        || !Array.isArray(artifact.claims) || artifact.claims.length > MAX_CLAIMS
        || !Array.isArray(artifact.clusters)) return null;
    const nodeIds = new Set();
    const aliasOwners = new Map();
    const nodeDates = new Map();
    const focusNodes = [];
    for (const node of artifact.nodes) {
      if (!validateNode(node, nodeIds, aliasOwners, catalogIds)) return null;
      nodeDates.set(node.id, dateValue(node.first_published_at));
      if (node.is_focus) focusNodes.push(node);
    }
    if (nodeIds.size === 0) {
      if (artifact.root !== null || focusNodes.length !== 0) return null;
    } else if (!text(artifact.root) || !nodeIds.has(artifact.root) || focusNodes.length !== 1
        || focusNodes[0].id !== artifact.root) return null;

    const evidenceIds = new Set();
    const evidenceById = new Map();
    for (const item of artifact.evidence) {
      if (!exactKeys(item, [
        "id", "source", "kind", "source_work_id", "cited_work_id", "citing_work_id", "url",
        "locator", "excerpt", "excerpt_sha256", "input_sha256", "retrieved_at", "snapshot_ref",
      ]) || !text(item.id) || evidenceIds.has(item.id)
          || ![item.source, item.kind, item.source_work_id, item.url, item.snapshot_ref].every(text)
          || !validHttpUrl(item.url) || !nodeIds.has(item.cited_work_id)
          || !nodeIds.has(item.citing_work_id) || item.cited_work_id === item.citing_work_id
          || !validateLocator(item.locator) || !text(item.excerpt) || [...item.excerpt].length > 280
          || !SHA_RE.test(item.excerpt_sha256) || !SHA_RE.test(item.input_sha256)
          || !validTimestamp(item.retrieved_at)) return null;
      if (await sha256(new TextEncoder().encode(item.excerpt)) !== item.excerpt_sha256) return null;
      evidenceIds.add(item.id);
      evidenceById.set(item.id, item);
    }

    const connected = new Set();
    const linkIds = new Set();
    for (const link of artifact.links) {
      if (!exactKeys(link, ["id", "src", "dst", "type", "evidence_ids"])
          || !text(link.id) || linkIds.has(link.id) || link.type !== "citation"
          || !nodeIds.has(link.src) || !nodeIds.has(link.dst) || link.src === link.dst
          || !uniqueTextArray(link.evidence_ids, true)
          || link.evidence_ids.some((id) => !evidenceIds.has(id))) return null;
      if (link.evidence_ids.some((id) => evidenceById.get(id).citing_work_id !== link.src
          || evidenceById.get(id).cited_work_id !== link.dst)) return null;
      linkIds.add(link.id);
      connected.add(link.src);
      connected.add(link.dst);
    }

    const claimIds = new Set();
    const acceptedPairs = new Set();
    const acceptedGraph = new Map([...nodeIds].map((id) => [id, []]));
    for (const claim of artifact.claims) {
      if (!exactKeys(claim, [
        "id", "src", "dst", "claim_family", "relation", "decision", "trust_tier", "raw_score",
        "calibrated_probability", "calibration_id", "evidence_ids", "rationale", "classification",
        "reason_codes", "review_binding",
      ]) || !text(claim.id) || claimIds.has(claim.id) || !nodeIds.has(claim.src)
          || !nodeIds.has(claim.dst) || !DECISIONS.has(claim.decision)
          || !["genealogy", "comparison"].includes(claim.claim_family)
          || !TRUST_TIERS.has(claim.trust_tier) || !unitNumber(claim.raw_score)
          || !unitNumber(claim.calibrated_probability) || !nullableText(claim.calibration_id)
          || ((claim.calibrated_probability === null) !== (claim.calibration_id === null))
          || !uniqueTextArray(claim.evidence_ids)
          || claim.evidence_ids.some((id) => !evidenceIds.has(id))
          || typeof claim.rationale !== "string" || !uniqueTextArray(claim.reason_codes)
          || !validateClassification(claim.classification)) return null;
      const asserted = claim.decision === "accepted" || claim.decision === "rejected";
      const familyRelations = claim.claim_family === "genealogy" ? GENEALOGY : COMPARISON;
      if (asserted && (!familyRelations.has(claim.relation) || !text(claim.rationale))) return null;
      if (!asserted && (claim.relation !== null || claim.reason_codes.length === 0)) return null;
      if (claim.decision === "accepted" && claim.src === claim.dst) return null;
      const bound = claim.evidence_ids.map((id) => evidenceById.get(id));
      if (bound.some((item) => !(
        (item.cited_work_id === claim.src && item.citing_work_id === claim.dst)
        || (item.cited_work_id === claim.dst && item.citing_work_id === claim.src)
      ))) return null;
      if (claim.decision === "accepted" && (bound.length === 0 || bound.some(
        (item) => item.cited_work_id !== claim.src || item.citing_work_id !== claim.dst,
      ))) return null;
      if (claim.trust_tier === "corroborated" && claim.decision === "accepted") {
        if (claim.calibrated_probability === null) return null;
        const sources = new Set(bound.map((item) => `${item.source}\u0000${item.kind}`));
        const works = new Set(bound.map((item) => item.source_work_id));
        if (sources.size < 2 || works.size < 2) return null;
      }
      const binding = claim.review_binding;
      if (binding !== null) {
        if (!exactKeys(binding, ["review_id", "fixture_id", "evidence_sha256"])
            || !text(binding.review_id) || !text(binding.fixture_id)
            || !SHA_RE.test(binding.evidence_sha256)) return null;
        const sortedEvidence = [...bound].sort((left, right) => compareText(left.id, right.id));
        if (await canonicalSha(sortedEvidence) !== binding.evidence_sha256) return null;
      }
      if (claim.decision === "accepted" && claim.trust_tier === "verified" && binding === null) return null;
      if (claim.decision === "accepted" && claim.claim_family === "genealogy") {
        const key = `${claim.src}\u0000${claim.dst}`;
        const reverse = `${claim.dst}\u0000${claim.src}`;
        if (acceptedPairs.has(reverse) || nodeDates.get(claim.src) > nodeDates.get(claim.dst)) return null;
        acceptedPairs.add(key);
        acceptedGraph.get(claim.src).push(claim.dst);
      }
      claimIds.add(claim.id);
      connected.add(claim.src);
      connected.add(claim.dst);
    }
    const color = new Map();
    for (const start of nodeIds) {
      if ((color.get(start) || 0) !== 0) continue;
      color.set(start, 1);
      const stack = [[start, 0]];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const children = acceptedGraph.get(frame[0]);
        if (frame[1] >= children.length) {
          color.set(frame[0], 2);
          stack.pop();
          continue;
        }
        const child = children[frame[1]++];
        if ((color.get(child) || 0) === 1) return null;
        if ((color.get(child) || 0) === 0) {
          color.set(child, 1);
          stack.push([child, 0]);
        }
      }
    }
    for (const id of nodeIds) {
      if (id !== artifact.root && !connected.has(id)) return null;
    }
    if (!exactKeys(artifact.meta, ["kind", "producer", "generated_at", "candidate_universe"])
        || !["conference", "theme", "deep"].includes(artifact.meta.kind)
        || !exactKeys(artifact.meta.producer, ["name", "version"])
        || !text(artifact.meta.producer.name) || !text(artifact.meta.producer.version)
        || !validTimestamp(artifact.meta.generated_at)
        || !exactKeys(artifact.meta.candidate_universe, [
          "snapshot_ref", "input_sha256", "selection_method", "candidate_count",
        ]) || !text(artifact.meta.candidate_universe.snapshot_ref)
        || !SHA_RE.test(artifact.meta.candidate_universe.input_sha256)
        || !text(artifact.meta.candidate_universe.selection_method)
        || !nonnegativeInteger(artifact.meta.candidate_universe.candidate_count)
        || artifact.meta.candidate_universe.candidate_count !== artifact.claims.length) return null;
    return { nodeIds, evidenceById };
  }

  function validGold(value) {
    const family = value.gold_family;
    const relation = value.gold_relation;
    if (!(family === null || family === "genealogy" || family === "comparison")
        || !(relation === null || RELATIONS.has(relation)) || ((family === null) !== (relation === null))) {
      return false;
    }
    return relation === null || (family === "genealogy" ? GENEALOGY : COMPARISON).has(relation);
  }

  function validateReview(value) {
    return exactKeys(value, [
      "reviewer_id", "blind_to_model", "blind_to_peer", "citation_valid", "gold_family",
      "gold_relation", "evidence_support", "notes", "reviewed_at",
    ]) && text(value.reviewer_id) && value.blind_to_model === true && value.blind_to_peer === true
      && typeof value.citation_valid === "boolean" && SUPPORT.has(value.evidence_support)
      && typeof value.notes === "string" && validTimestamp(value.reviewed_at) && validGold(value);
  }

  function validateAdjudication(value) {
    return exactKeys(value, [
      "adjudicator_id", "citation_valid", "gold_family", "gold_relation", "evidence_support",
      "notes", "reviewed_at",
    ]) && text(value.adjudicator_id) && typeof value.citation_valid === "boolean"
      && SUPPORT.has(value.evidence_support) && typeof value.notes === "string"
      && validTimestamp(value.reviewed_at) && validGold(value);
  }

  function validateFixture(fixture) {
    if (!boundedJson(fixture) || !exactKeys(fixture, ["schema_version", "fixture_id", "created_at", "collections"])
        || fixture.schema_version !== FIXTURE_VERSION || !text(fixture.fixture_id)
        || !validTimestamp(fixture.created_at) || !Array.isArray(fixture.collections)) return false;
    const collectionIds = new Set();
    const reviewIds = new Set();
    for (const collection of fixture.collections) {
      if (!exactKeys(collection, [
        "collection_id", "release_id", "artifact_sha256", "candidate_universe", "focus_labels", "edge_labels",
      ]) || !text(collection.collection_id) || collectionIds.has(collection.collection_id)
          || !text(collection.release_id) || !SHA_RE.test(collection.artifact_sha256)
          || !exactKeys(collection.candidate_universe, [
            "snapshot_ref", "input_sha256", "selection_method", "candidate_count",
          ]) || !text(collection.candidate_universe.snapshot_ref)
          || !SHA_RE.test(collection.candidate_universe.input_sha256)
          || !text(collection.candidate_universe.selection_method)
          || !nonnegativeInteger(collection.candidate_universe.candidate_count)
          || !Array.isArray(collection.focus_labels) || collection.focus_labels.length === 0
          || !Array.isArray(collection.edge_labels)
          || collection.edge_labels.length !== collection.candidate_universe.candidate_count) return false;
      collectionIds.add(collection.collection_id);
      const focusIds = new Set();
      for (const label of collection.focus_labels) {
        if (!exactKeys(label, ["node_id", "on_topic"]) || !text(label.node_id)
            || typeof label.on_topic !== "boolean" || focusIds.has(label.node_id)) return false;
        focusIds.add(label.node_id);
      }
      const candidates = new Set();
      let panel = null;
      for (const label of collection.edge_labels) {
        if (!exactKeys(label, [
          "review_id", "collection_id", "src", "dst", "evidence_sha256", "reviews", "adjudication",
        ]) || !text(label.review_id) || reviewIds.has(label.review_id)
            || label.collection_id !== collection.collection_id || !text(label.src) || !text(label.dst)
            || !SHA_RE.test(label.evidence_sha256) || !Array.isArray(label.reviews)
            || label.reviews.length !== 2 || !label.reviews.every(validateReview)
            || !validateAdjudication(label.adjudication)) return false;
        reviewIds.add(label.review_id);
        const identity = `${label.src}\u0000${label.dst}\u0000${label.evidence_sha256}`;
        if (candidates.has(identity)) return false;
        candidates.add(identity);
        const reviewers = label.reviews.map((review) => review.reviewer_id).sort(compareText);
        if (reviewers[0] === reviewers[1] || reviewers.includes(label.adjudication.adjudicator_id)) return false;
        if (panel === null) panel = reviewers.join("\u0000");
        else if (panel !== reviewers.join("\u0000")) return false;
        const reviewTimes = label.reviews.map((review) => timestampValue(review.reviewed_at));
        const latestReview = reviewTimes.reduce((left, right) => left > right ? left : right);
        if (timestampValue(label.adjudication.reviewed_at) < latestReview) return false;
        const confirmationFields = ['citation_valid', 'gold_family', 'gold_relation', 'evidence_support'];
        const agreed = confirmationFields.every(field => label.reviews[0][field] === label.reviews[1][field]);
        if (agreed && confirmationFields.some(field => label.adjudication[field] !== label.reviews[0][field])) {
          return false;
        }
      }
    }
    return true;
  }

  function cohenKappa(pairs) {
    if (pairs.length === 0) return null;
    const first = new Map();
    const second = new Map();
    let agreements = 0;
    for (const [left, right] of pairs) {
      first.set(left, (first.get(left) || 0) + 1);
      second.set(right, (second.get(right) || 0) + 1);
      if (left === right) agreements++;
    }
    const categories = new Set([...first.keys(), ...second.keys()]);
    const total = pairs.length;
    let expected = 0;
    for (const category of categories) expected += (first.get(category) || 0) * (second.get(category) || 0);
    expected /= total * total;
    if (Math.abs(expected - 1) <= 1e-12) return null;
    return (agreements / total - expected) / (1 - expected);
  }

  function validQualityShape(quality) {
    if (!boundedJson(quality) || !exactKeys(quality, ["schema_version", "audit_version", "as_of", "collections"])
        || quality.schema_version !== QUALITY_VERSION || quality.audit_version !== "audit-v2"
        || !validTimestamp(quality.as_of) || !Array.isArray(quality.collections)
        || quality.collections.length !== 1) return false;
    const row = quality.collections[0];
    if (!exactKeys(row, [
      "collection_id", "kind", "slug", "label", "path", "release_id", "release_profile", "availability",
      "audit_status", "artifact_schema_version", "artifact_sha256", "fixture_sha256", "node_count", "link_count",
      "claim_decision_count", "accepted_genealogy_count", "accepted_comparison_count", "decision_counts",
      "calibration", "review", "checks",
    ]) || !text(row.collection_id) || row.kind !== "deep" || !SLUG_RE.test(row.slug) || !text(row.label)
        || !safeJsonPath(row.path) || !row.path.split("/").includes(row.slug) || !text(row.release_id)
        || row.release_profile !== PILOT_PROFILE || row.availability !== "ready" || row.audit_status !== "passed"
        || row.artifact_schema_version !== ARTIFACT_VERSION || !SHA_RE.test(row.artifact_sha256)
        || !SHA_RE.test(row.fixture_sha256) || ![
          row.node_count, row.link_count, row.claim_decision_count, row.accepted_genealogy_count,
          row.accepted_comparison_count,
        ].every(nonnegativeInteger)) return false;
    if (!exactKeys(row.decision_counts, ["accepted", "unknown", "abstained", "rejected"])
        || !Object.values(row.decision_counts).every(nonnegativeInteger)
        || Object.values(row.decision_counts).reduce((sum, value) => sum + value, 0) !== row.claim_decision_count) {
      return false;
    }
    const calibrationKeys = [
      "status", "reason", "sample_count", "wilson_lower_bound", "supersedes_wilson_lower_bound",
      "macro_precision", "ece", "brier", "accepted_coverage", "unknown_abstained_recall",
    ];
    if (!exactKeys(row.calibration, calibrationKeys) || row.calibration.status !== "not_applicable"
        || !text(row.calibration.reason) || !nonnegativeInteger(row.calibration.sample_count)
        || calibrationKeys.slice(3).some((key) => !unitNumber(row.calibration[key]))) return false;
    if (!exactKeys(row.review, ["status", "reviewed_claim_count", "agreement", "fixture_id"])
        || row.review.status !== "passed" || !nonnegativeInteger(row.review.reviewed_claim_count)
        || !unitNumber(row.review.agreement) || !text(row.review.fixture_id)) return false;
    if (!Array.isArray(row.checks) || row.checks.length === 0) return false;
    const required = new Set([
      "artifact_contract_v2", "identity", "evidence_binding", "review_binding", "accepted_dag",
      "accepted_temporal", "frozen_candidate_ledger",
    ]);
    const seen = new Set();
    for (const check of row.checks) {
      if (!exactKeys(check, ["name", "status", "detail"]) || !text(check.name)
          || !STATUS.has(check.status) || typeof check.detail !== "string" || check.status !== "passed"
          || seen.has(check.name)) return false;
      seen.add(check.name);
    }
    return [...required].every((name) => seen.has(name));
  }

  async function verifyBindings(entry, artifact, fixture, quality, catalogIds) {
    if (!validQualityShape(quality) || !validateFixture(fixture)) return null;
    const row = quality.collections[0];
    const artifactValidation = await validateArtifact(artifact, catalogIds);
    if (artifactValidation === null || row.collection_id !== entry.collection_id || row.slug !== entry.conference
        || row.path !== entry.artifact.path || row.release_id !== entry.release_id
        || row.artifact_sha256 !== entry.artifact.sha256 || row.fixture_sha256 !== entry.fixture.sha256
        || artifact.release_id !== entry.release_id || artifact.meta.kind !== "deep"
        || row.node_count !== artifact.nodes.length || row.link_count !== artifact.links.length
        || row.claim_decision_count !== artifact.claims.length) return null;
    const focus = artifact.nodes.filter((node) => node.is_focus);
    if (focus.length !== 1 || focus[0].seed_paper_id !== entry.paper_id
        || row.collection_id !== `deep:${entry.conference}:paper:${focus[0].seed_paper_id}`) return null;
    const decisionCounts = { accepted: 0, unknown: 0, abstained: 0, rejected: 0 };
    let acceptedGenealogy = 0;
    let acceptedComparison = 0;
    for (const claim of artifact.claims) {
      decisionCounts[claim.decision]++;
      if (claim.decision === "accepted" && claim.claim_family === "genealogy") acceptedGenealogy++;
      if (claim.decision === "accepted" && claim.claim_family === "comparison") acceptedComparison++;
      if (claim.decision === "accepted" && claim.trust_tier !== "verified") return null;
    }
    if (row.accepted_genealogy_count !== acceptedGenealogy
        || row.accepted_comparison_count !== acceptedComparison
        || Object.keys(decisionCounts).some((key) => row.decision_counts[key] !== decisionCounts[key])
        || row.review.reviewed_claim_count !== acceptedGenealogy + acceptedComparison
        || row.review.fixture_id !== fixture.fixture_id) return null;
    const matches = fixture.collections.filter((item) => item.collection_id === entry.collection_id);
    if (matches.length !== 1) return null;
    const fixtureCollection = matches[0];
    if (fixtureCollection.release_id !== entry.release_id
        || fixtureCollection.artifact_sha256 !== entry.artifact.sha256
        || canonicalJson(fixtureCollection.candidate_universe) !== canonicalJson(artifact.meta.candidate_universe)) {
      return null;
    }
    const nodeIds = artifactValidation.nodeIds;
    const rootLabels = fixtureCollection.focus_labels.filter((label) => label.node_id === artifact.root);
    const offTopic = fixtureCollection.focus_labels.filter((label) => !label.on_topic).length;
    if (fixtureCollection.focus_labels.some((label) => !nodeIds.has(label.node_id))
        || rootLabels.length !== 1 || !rootLabels[0].on_topic
        || offTopic / fixtureCollection.focus_labels.length > 0.1) return null;
    const generatedAt = timestampValue(artifact.meta.generated_at);
    const fixtureAt = timestampValue(fixture.created_at);
    const asOf = timestampValue(quality.as_of);
    if (generatedAt > fixtureAt) return null;
    const claimRows = new Map();
    for (const claim of artifact.claims) {
      const bound = claim.evidence_ids.map((id) => artifactValidation.evidenceById.get(id))
        .sort((left, right) => compareText(left.id, right.id));
      const evidenceHash = await canonicalSha(bound);
      const identity = `${claim.src}\u0000${claim.dst}\u0000${evidenceHash}`;
      if (claimRows.has(identity)) return null;
      claimRows.set(identity, claim);
    }
    const labelRows = new Map();
    const labelsByReview = new Map();
    const relationPairs = [];
    const supportPairs = [];
    for (const label of fixtureCollection.edge_labels) {
      const identity = `${label.src}\u0000${label.dst}\u0000${label.evidence_sha256}`;
      if (labelRows.has(identity) || labelsByReview.has(label.review_id)) return null;
      labelRows.set(identity, label);
      labelsByReview.set(label.review_id, label);
      const times = [...label.reviews.map((review) => timestampValue(review.reviewed_at)),
        timestampValue(label.adjudication.reviewed_at)];
      if (times.some((time) => time < generatedAt || time < fixtureAt || time > asOf)) return null;
      const reviews = [...label.reviews].sort((left, right) => compareText(left.reviewer_id, right.reviewer_id));
      relationPairs.push([reviews[0].gold_relation, reviews[1].gold_relation]);
      supportPairs.push([reviews[0].evidence_support, reviews[1].evidence_support]);
      const fields = ["citation_valid", "gold_family", "gold_relation", "evidence_support"];
      const agreed = fields.every((field) => reviews[0][field] === reviews[1][field]);
      const final = agreed ? reviews[0] : label.adjudication;
      const claim = claimRows.get(identity);
      if (!claim || (claim.decision === "accepted" && (final.citation_valid !== true
          || final.evidence_support !== "supports" || final.gold_family !== claim.claim_family
          || final.gold_relation !== claim.relation))) return null;
    }
    if (claimRows.size !== labelRows.size || [...claimRows.keys()].some((key) => !labelRows.has(key))) return null;
    const relationKappa = cohenKappa(relationPairs);
    const supportKappa = cohenKappa(supportPairs);
    if (relationKappa === null || supportKappa === null) return null;
    const agreement = Math.min(relationKappa, supportKappa);
    if (agreement < 0.7 || Math.abs(row.review.agreement - agreement) > 1e-12) return null;
    for (const claim of artifact.claims) {
      if (claim.decision !== "accepted" || claim.trust_tier !== "verified") continue;
      const binding = claim.review_binding;
      const label = labelsByReview.get(binding.review_id);
      if (!label || binding.fixture_id !== fixture.fixture_id
          || label.evidence_sha256 !== binding.evidence_sha256 || label.src !== claim.src
          || label.dst !== claim.dst) return null;
    }
    return { artifactValidation, fixtureCollection, row };
  }

  async function verifyPilotRelease({
    entry, artifactBytes, fixtureBytes, qualityBytes, catalogPaperIds,
  } = {}) {
    try {
      if (!record(entry) || !entryBrand.has(entry) || !Array.isArray(catalogPaperIds)
          || catalogPaperIds.length === 0 || catalogPaperIds.length > MAX_JSON_VALUES
          || new Set(catalogPaperIds).size !== catalogPaperIds.length
          || !catalogPaperIds.every((id) => PAPER_ID_RE.test(id)) || !catalogPaperIds.includes(entry.paper_id)) {
        return null;
      }
      // Snapshot every caller-owned BufferSource before the first await. Hashing
      // and parsing then consume the same private bytes even if a caller mutates
      // or transfers its buffers while Web Crypto is pending.
      const artifactSnapshot = asBytes(artifactBytes);
      const fixtureSnapshot = asBytes(fixtureBytes);
      const qualitySnapshot = asBytes(qualityBytes);
      if (artifactSnapshot === null || fixtureSnapshot === null || qualitySnapshot === null) return null;
      const [artifactInput, fixtureInput, qualityInput] = await Promise.all([
        parseBytes(artifactSnapshot, MAX_ARTIFACT_BYTES),
        parseBytes(fixtureSnapshot, MAX_FIXTURE_BYTES),
        parseBytes(qualitySnapshot, MAX_QUALITY_BYTES),
      ]);
      if (artifactInput === null || fixtureInput === null || qualityInput === null) return null;
      const hashes = await Promise.all([
        sha256(artifactInput.bytes), sha256(fixtureInput.bytes), sha256(qualityInput.bytes),
      ]);
      if (hashes[0] !== entry.artifact.sha256 || hashes[1] !== entry.fixture.sha256
          || hashes[2] !== entry.quality.sha256) return null;
      const catalogIds = new Set(catalogPaperIds);
      const binding = await verifyBindings(
        entry, artifactInput.parsed, fixtureInput.parsed, qualityInput.parsed, catalogIds,
      );
      if (binding === null) return null;
      deepFreeze(artifactInput.parsed);
      deepFreeze(fixtureInput.parsed);
      deepFreeze(qualityInput.parsed);
      const release = Object.create(null);
      Object.assign(release, {
        entry,
        artifact: artifactInput.parsed,
        fixture: fixtureInput.parsed,
        fixtureCollection: binding.fixtureCollection,
        quality: qualityInput.parsed,
        qualityRow: binding.row,
        row: binding.row,
      });
      deepFreeze(release);
      releaseBrand.add(release);
      releasePrivate.set(release, {
        nodeById: new Map(release.artifact.nodes.map((node) => [node.id, node])),
        claimById: new Map(release.artifact.claims.map((claim) => [claim.id, claim])),
        evidenceById: new Map(release.artifact.evidence.map((item) => [item.id, item])),
      });
      return release;
    } catch (_error) {
      return null;
    }
  }

  function resolveFocus(release, requestedFocus = null) {
    if (!record(release) || !releaseBrand.has(release)) return null;
    const indexes = releasePrivate.get(release);
    if (requestedFocus === null || requestedFocus === undefined || requestedFocus === "") {
      return indexes.nodeById.get(release.artifact.root) || null;
    }
    if (typeof requestedFocus !== "string") return null;
    if (PAPER_ID_RE.test(requestedFocus)) {
      const matches = release.artifact.nodes.filter(
        (node) => node.is_focus && node.seed_paper_id === requestedFocus,
      );
      return matches.length === 1 ? matches[0] : null;
    }
    return indexes.nodeById.get(requestedFocus) || null;
  }

  function escapedCsvParse(value) {
    if (typeof value !== "string" || value.length > MAX_STATE_TEXT) return null;
    const output = [];
    let current = "";
    let escaped = false;
    for (const character of value) {
      if (escaped) {
        if (character !== "," && character !== "\\") return null;
        current += character;
        escaped = false;
      } else if (character === "\\") escaped = true;
      else if (character === ",") {
        output.push(current);
        current = "";
      } else current += character;
    }
    if (escaped) return null;
    output.push(current);
    return output;
  }

  function escapedCsvWrite(values) {
    return values.map((value) => value.replaceAll("\\", "\\\\").replaceAll(",", "\\,")).join(",");
  }

  function paramSource(params) {
    if (params instanceof URLSearchParams) return params;
    if (typeof params === "string") return new URLSearchParams(params);
    if (record(params)) {
      const converted = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === "string") converted.set(key, value);
      }
      return converted;
    }
    return new URLSearchParams();
  }

  function readState(release, { params, prefs = {}, mobile = false } = {}) {
    if (!record(release) || !releaseBrand.has(release)) return null;
    const query = paramSource(params);
    const statuses = new Set();
    const duplicates = new Set([...query.keys()].filter((key) => query.getAll(key).length !== 1));
    duplicates.forEach((key) => statuses.add(`duplicate_${key}`));
    const preferenceKeys = {
      focus: "focusId",
      limit: "nodeLimit",
      min_conf: "minConfidence",
      trust: "trustTiers",
      relations: "relations",
      rels: "relations",
      evidence_sources: "evidenceSources",
      evidence_kinds: "evidenceKinds",
      expanded: "expandedNodeIds",
    };
    const preference = (key, fallback) => {
      if (!record(prefs)) return fallback;
      const candidate = Object.hasOwn(prefs, key) ? prefs[key] : prefs[preferenceKeys[key]];
      return Array.isArray(candidate) ? escapedCsvWrite(candidate) : candidate ?? fallback;
    };
    const source = (key, fallback) => duplicates.has(key) ? null : query.has(key) ? query.get(key)
      : preference(key, fallback);
    const requestedFocus = duplicates.has("focus") ? false : source("focus", null);
    const focus = resolveFocus(release, requestedFocus);
    if (requestedFocus !== null && requestedFocus !== "" && focus === null) statuses.add("unknown_focus");
    const rawView = source("view", mobile ? "list" : "graph");
    const view = rawView === "list" || rawView === "graph" ? rawView : (mobile ? "list" : "graph");
    if (rawView !== view) statuses.add("invalid_view");
    const enumNumber = (key, allowed, fallback) => {
      const raw = source(key, String(fallback));
      const number = Number(raw);
      if (allowed.includes(number) && String(number) === String(raw)) return number;
      if (raw !== undefined && raw !== null && String(raw) !== String(fallback)) statuses.add(`invalid_${key}`);
      return fallback;
    };
    const hops = enumNumber("hops", [1, 2, 3], 1);
    const rawLimit = source("limit", "7");
    const parsedLimit = Number(rawLimit);
    const nodeLimit = Number.isInteger(parsedLimit) && parsedLimit >= 5 && parsedLimit <= 50 ? parsedLimit : 7;
    if (nodeLimit !== parsedLimit) statuses.add("invalid_limit");
    const minConfidence = enumNumber("min_conf", [0.5, 0.7, 0.9], 0.7);
    const parseAllowed = (key, fallback, allowed, explicitEmpty = false) => {
      const present = query.has(key) || (record(prefs)
        && (Object.hasOwn(prefs, key) || Object.hasOwn(prefs, preferenceKeys[key])));
      if (!present && fallback.length === 0) return [];
      const raw = source(key, escapedCsvWrite(fallback));
      const parsed = escapedCsvParse(raw);
      if (parsed === null) {
        statuses.add(`invalid_${key}`);
        return present ? [] : fallback;
      }
      if (explicitEmpty && present && parsed.length === 1 && parsed[0] === "") return [];
      const valid = [];
      for (const item of parsed) {
        if (allowed.has(item) && !valid.includes(item)) valid.push(item);
        else statuses.add(`unknown_${key}`);
      }
      return present ? valid : fallback;
    };
    const trustTiers = parseAllowed("trust", ["verified", "corroborated"], TRUST_TIERS);
    const families = parseAllowed("families", ["genealogy"], new Set(["genealogy", "comparison"]));
    const ambiguousRelations = query.has("relations") && query.has("rels");
    if (ambiguousRelations) statuses.add("ambiguous_relations");
    const relationKey = query.has("relations") || !query.has("rels") ? "relations" : "rels";
    const relationFilterExplicit = query.has(relationKey) || (record(prefs)
      && (typeof prefs.relationFilterExplicit === "boolean"
        ? prefs.relationFilterExplicit
        : Object.hasOwn(prefs, relationKey)));
    const defaultRelations = [...GENEALOGY];
    const relations = ambiguousRelations ? []
      : parseAllowed(relationKey, defaultRelations, RELATIONS, true);
    const evidenceSources = new Set(release.artifact.evidence.map((item) => item.source));
    const evidenceKinds = new Set(release.artifact.evidence.map((item) => item.kind));
    let selectedSources = parseAllowed("evidence_sources", [], evidenceSources, true);
    let selectedKinds = parseAllowed("evidence_kinds", [], evidenceKinds, true);
    let evidenceSourcesExplicit = query.has("evidence_sources")
      || (record(prefs) && (typeof prefs.evidenceSourcesExplicit === "boolean"
        ? prefs.evidenceSourcesExplicit
        : Object.hasOwn(prefs, "evidence_sources") || Object.hasOwn(prefs, "evidenceSources")));
    let evidenceKindsExplicit = query.has("evidence_kinds")
      || (record(prefs) && (typeof prefs.evidenceKindsExplicit === "boolean"
        ? prefs.evidenceKindsExplicit
        : Object.hasOwn(prefs, "evidence_kinds") || Object.hasOwn(prefs, "evidenceKinds")));
    const ambiguousEvidence = query.has("evidence")
      && (query.has("evidence_sources") || query.has("evidence_kinds"));
    if (duplicates.has("evidence")) {
      selectedSources = [];
      selectedKinds = [];
      evidenceSourcesExplicit = true;
      evidenceKindsExplicit = true;
    } else if (ambiguousEvidence) {
      statuses.add("ambiguous_evidence");
      selectedSources = [];
      selectedKinds = [];
      evidenceSourcesExplicit = true;
      evidenceKindsExplicit = true;
    } else if (query.has("evidence") && !query.has("evidence_sources") && !query.has("evidence_kinds")) {
      const legacy = escapedCsvParse(query.get("evidence"));
      if (legacy === null) statuses.add("invalid_evidence");
      else {
        selectedSources = [];
        selectedKinds = [];
        evidenceSourcesExplicit = true;
        evidenceKindsExplicit = true;
        for (const token of legacy) {
          if (token.startsWith("source:") && evidenceSources.has(token.slice(7))) selectedSources.push(token.slice(7));
          else if (token.startsWith("kind:") && evidenceKinds.has(token.slice(5))) selectedKinds.push(token.slice(5));
          else statuses.add("unknown_evidence");
        }
      }
    }
    const rawExpanded = source("expanded", "");
    const parsedExpanded = escapedCsvParse(rawExpanded);
    const expandedNodeIds = [];
    if (parsedExpanded === null) statuses.add("invalid_expanded");
    else {
      for (const id of parsedExpanded) {
        if (id === "") continue;
        if (releasePrivate.get(release).nodeById.has(id) && !expandedNodeIds.includes(id)
            && expandedNodeIds.length < MAX_EXPANDED_IDS) expandedNodeIds.push(id);
        else statuses.add("unknown_expanded");
      }
    }
    expandedNodeIds.sort(compareText);
    const state = Object.create(null);
    Object.assign(state, {
      focusId: focus?.id || null,
      view,
      hops,
      nodeLimit,
      claimLimit: 18,
      minConfidence,
      trustTiers: [...trustTiers].sort(compareText),
      families: [...families].sort(compareText),
      relations: [...relations].sort(compareText),
      relationFilterExplicit,
      evidenceSources: [...new Set(selectedSources)].sort(compareText),
      evidenceKinds: [...new Set(selectedKinds)].sort(compareText),
      evidenceSourcesExplicit,
      evidenceKindsExplicit,
      expandedNodeIds,
      pageSize: 20,
      statusCodes: [...statuses].sort(compareText),
    });
    return deepFreeze(state);
  }

  function writeState(url, state) {
    const output = url instanceof URL ? new URL(url.href) : new URL(url, root.location?.href || "https://paperpilot.local/");
    if (!record(state)) return output;
    const set = (key, value) => output.searchParams.set(key, String(value));
    if (state.focusId === null) output.searchParams.delete("focus"); else set("focus", state.focusId);
    set("view", state.view);
    set("hops", state.hops);
    set("limit", state.nodeLimit);
    set("min_conf", state.minConfidence);
    set("trust", escapedCsvWrite(state.trustTiers));
    set("families", escapedCsvWrite(state.families));
    if (state.relationFilterExplicit) set("relations", escapedCsvWrite(state.relations));
    else output.searchParams.delete("relations");
    output.searchParams.delete("rels");
    if (state.evidenceSourcesExplicit) set("evidence_sources", escapedCsvWrite(state.evidenceSources));
    else output.searchParams.delete("evidence_sources");
    if (state.evidenceKindsExplicit) set("evidence_kinds", escapedCsvWrite(state.evidenceKinds));
    else output.searchParams.delete("evidence_kinds");
    output.searchParams.delete("evidence");
    if (state.expandedNodeIds.length) set("expanded", escapedCsvWrite(state.expandedNodeIds));
    else output.searchParams.delete("expanded");
    return output;
  }

  function validState(release, state) {
    return record(state) && Object.isFrozen(state) && Array.isArray(state.statusCodes)
      && (state.focusId === null || releasePrivate.get(release).nodeById.has(state.focusId))
      && (state.view === "graph" || state.view === "list") && [1, 2, 3].includes(state.hops)
      && Number.isInteger(state.nodeLimit) && state.nodeLimit >= 5 && state.nodeLimit <= 50
      && state.claimLimit === 18 && [0.5, 0.7, 0.9].includes(state.minConfidence)
      && Array.isArray(state.trustTiers) && state.trustTiers.every((item) => TRUST_TIERS.has(item))
      && Array.isArray(state.families) && state.families.every((item) => ["genealogy", "comparison"].includes(item))
      && Array.isArray(state.relations) && state.relations.every((item) => RELATIONS.has(item))
      && Array.isArray(state.evidenceSources) && Array.isArray(state.evidenceKinds)
      && typeof state.evidenceSourcesExplicit === "boolean" && typeof state.evidenceKindsExplicit === "boolean"
      && Array.isArray(state.expandedNodeIds) && state.expandedNodeIds.length <= MAX_EXPANDED_IDS;
  }

  function selectFocusProjection(release, state) {
    if (!record(release) || !releaseBrand.has(release) || !validState(release, state)) return null;
    const indexes = releasePrivate.get(release);
    const focus = state.focusId === null ? null : indexes.nodeById.get(state.focusId);
    if (!focus) return null;
    const trust = new Set(state.trustTiers);
    const families = new Set(state.families);
    const relations = new Set(state.relations);
    const sources = new Set(state.evidenceSources);
    const kinds = new Set(state.evidenceKinds);
    const exclusions = {
      decision: 0, trust: 0, family: 0, relation: 0, confidence: 0, evidence: 0,
      hop: 0, branch: 0, nodeCap: 0, claimCap: 0, collapse: 0,
    };
    const acceptedGenealogy = release.artifact.claims.filter(
      (claim) => claim.decision === "accepted" && claim.claim_family === "genealogy",
    );
    const acceptedComparison = release.artifact.claims.filter(
      (claim) => claim.decision === "accepted" && claim.claim_family === "comparison",
    );
    const degree = new Map(release.artifact.nodes.map((node) => [node.id, 0]));
    for (const claim of acceptedGenealogy) {
      degree.set(claim.src, degree.get(claim.src) + 1);
      degree.set(claim.dst, degree.get(claim.dst) + 1);
    }
    const relationRank = new Map([
      ["supersedes", 0], ["successor", 1], ["extends", 2],
      ["ablation", 3], ["baseline_only", 4], ["contrasts", 5],
    ]);
    const trustRank = new Map([["verified", 0], ["corroborated", 1], ["tentative", 2]]);
    const comparator = (left, right, from = null) => {
      const leftProbability = left.calibrated_probability;
      const rightProbability = right.calibrated_probability;
      const opposite = (claim) => from === null ? Math.max(degree.get(claim.src), degree.get(claim.dst))
        : degree.get(claim.src === from ? claim.dst : claim.src);
      return trustRank.get(left.trust_tier) - trustRank.get(right.trust_tier)
        || (rightProbability === null ? -1 : rightProbability) - (leftProbability === null ? -1 : leftProbability)
        || relationRank.get(left.relation) - relationRank.get(right.relation)
        || opposite(right) - opposite(left)
        || compareText(left.src, right.src) || compareText(left.dst, right.dst)
        || compareText(left.id, right.id);
    };
    const eligible = [];
    for (const claim of release.artifact.claims) {
      if (claim.decision !== "accepted") { exclusions.decision++; continue; }
      if (!trust.has(claim.trust_tier)) { exclusions.trust++; continue; }
      if (!families.has(claim.claim_family)) { exclusions.family++; continue; }
      if (!relations.has(claim.relation)) { exclusions.relation++; continue; }
      if (claim.trust_tier === "corroborated"
          && (claim.calibrated_probability === null || claim.calibrated_probability < state.minConfidence)) {
        exclusions.confidence++;
        continue;
      }
      const bound = claim.evidence_ids.map((id) => indexes.evidenceById.get(id));
      if ((state.evidenceSourcesExplicit && !bound.some((item) => sources.has(item.source)))
          || (state.evidenceKindsExplicit && !bound.some((item) => kinds.has(item.kind)))) {
        exclusions.evidence++;
        continue;
      }
      eligible.push(claim);
    }
    // Tentative exploration is deliberately excluded from the trusted spine and
    // branch budget even when the caller explicitly enables it.
    const genealogy = eligible.filter((claim) => claim.claim_family === "genealogy"
      && claim.trust_tier !== "tentative");
    const tentative = eligible.filter((claim) => claim.claim_family === "genealogy"
      && claim.trust_tier === "tentative");
    const comparison = eligible.filter((claim) => claim.claim_family === "comparison");
    const adjacent = new Map(release.artifact.nodes.map((node) => [node.id, []]));
    for (const claim of genealogy) {
      adjacent.get(claim.src).push(claim);
      adjacent.get(claim.dst).push(claim);
    }
    for (const [nodeId, claims] of adjacent) claims.sort((a, b) => comparator(a, b, nodeId));
    const distances = new Map([[focus.id, 0]]);
    const distanceQueue = [focus.id];
    for (let index = 0; index < distanceQueue.length; index++) {
      const nodeId = distanceQueue[index];
      const distance = distances.get(nodeId);
      if (distance >= state.hops) continue;
      for (const claim of adjacent.get(nodeId)) {
        const other = claim.src === nodeId ? claim.dst : claim.src;
        if (!distances.has(other)) {
          distances.set(other, distance + 1);
          distanceQueue.push(other);
        }
      }
    }
    const selectedNodes = new Set([focus.id]);
    const selectedClaims = new Set();
    const traversalOrder = [];
    const addClaim = (claim, nodeCap, claimCap) => {
      if (selectedClaims.has(claim.id)) return true;
      const newNodes = [claim.src, claim.dst].filter((id) => !selectedNodes.has(id));
      if (selectedNodes.size + newNodes.length > nodeCap) return false;
      if (selectedClaims.size >= claimCap) return false;
      newNodes.forEach((id) => selectedNodes.add(id));
      selectedClaims.add(claim.id);
      traversalOrder.push(claim);
      return true;
    };
    const spineNodes = [focus.id];
    const spineCurrent = { parent: focus.id, child: focus.id };
    // Interleave directions by hop so a tight cap always preserves nearer
    // ancestors and successors before either direction's more distant node.
    for (let hop = 0; hop < state.hops; hop++) {
      for (const direction of ["parent", "child"]) {
        const current = spineCurrent[direction];
        const candidates = adjacent.get(current).filter((claim) => direction === "parent"
          ? claim.dst === current : claim.src === current);
        const chosen = candidates.find((claim) => !selectedClaims.has(claim.id));
        if (!chosen || !addClaim(chosen, state.nodeLimit, state.claimLimit)) continue;
        spineCurrent[direction] = direction === "parent" ? chosen.src : chosen.dst;
        spineNodes.push(spineCurrent[direction]);
      }
    }
    const branchQueue = [...new Set(spineNodes)];
    for (let index = 0; index < branchQueue.length; index++) {
      const nodeId = branchQueue[index];
      let branches = 0;
      for (const claim of adjacent.get(nodeId)) {
        if (selectedClaims.has(claim.id)) continue;
        const other = claim.src === nodeId ? claim.dst : claim.src;
        if ((distances.get(other) ?? Infinity) > state.hops) continue;
        if (selectedNodes.has(other)) continue;
        if (branches >= 2) break;
        if (!addClaim(claim, state.nodeLimit, state.claimLimit)) continue;
        branchQueue.push(other);
        branches++;
      }
    }
    const sortedGenealogy = [...genealogy].sort(comparator);
    for (const claim of sortedGenealogy) {
      if (selectedClaims.size >= state.claimLimit) break;
      if (selectedNodes.has(claim.src) && selectedNodes.has(claim.dst)) {
        addClaim(claim, state.nodeLimit, state.claimLimit);
      }
    }
    const validExpanded = state.expandedNodeIds.filter((id) => selectedNodes.has(id));
    const statusCodes = new Set(state.statusCodes);
    for (const id of state.expandedNodeIds) {
      if (!selectedNodes.has(id)) statusCodes.add("collapsed_expansion_target");
    }
    for (const nodeId of validExpanded) {
      let added = 0;
      for (const claim of adjacent.get(nodeId)) {
        if (selectedClaims.has(claim.id)) continue;
        const other = claim.src === nodeId ? claim.dst : claim.src;
        if (selectedNodes.has(other)) continue;
        if (added >= 2) break;
        if (addClaim(claim, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) added++;
      }
    }
    let tentativeAdded = 0;
    for (const claim of [...tentative].sort(comparator)) {
      if (tentativeAdded >= 6 || selectedClaims.size >= state.claimLimit) break;
      if (selectedNodes.has(claim.src) || selectedNodes.has(claim.dst)) {
        if (addClaim(claim, state.nodeLimit, state.claimLimit)) tentativeAdded++;
      }
    }
    let comparisonAdded = 0;
    for (const claim of [...comparison].sort(comparator)) {
      if (comparisonAdded >= 6 || selectedClaims.size >= state.claimLimit) break;
      const bothSelected = selectedNodes.has(claim.src) && selectedNodes.has(claim.dst);
      const touchesFocus = claim.src === focus.id || claim.dst === focus.id;
      if ((bothSelected || touchesFocus)
          && addClaim(claim, bothSelected ? Number.MAX_SAFE_INTEGER : state.nodeLimit, state.claimLimit)) comparisonAdded++;
    }
    const selectedClaimRows = traversalOrder;
    const selectedClaimIds = new Set(selectedClaimRows.map((claim) => claim.id));
    for (const claim of eligible) {
      if (selectedClaimIds.has(claim.id)) continue;
      const srcDistance = distances.get(claim.src) ?? Infinity;
      const dstDistance = distances.get(claim.dst) ?? Infinity;
      if (claim.claim_family === "genealogy" && Math.max(srcDistance, dstDistance) > state.hops) exclusions.hop++;
      else if (selectedNodes.size >= state.nodeLimit && (!selectedNodes.has(claim.src) || !selectedNodes.has(claim.dst))) exclusions.nodeCap++;
      else if (selectedClaims.size >= state.claimLimit) exclusions.claimCap++;
      else exclusions.branch++;
    }
    const nodes = [...selectedNodes].map((id) => indexes.nodeById.get(id));
    const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
    nodes.sort((left, right) => (left.id === focus.id ? -1 : right.id === focus.id ? 1
      : (nodeOrder.get(left.id) - nodeOrder.get(right.id)) || compareText(left.id, right.id)));
    const hiddenBranches = nodes.map((node) => {
      let parent = 0;
      let child = 0;
      for (const claim of adjacent.get(node.id)) {
        if (selectedClaimIds.has(claim.id)) continue;
        if (claim.dst === node.id) parent++;
        if (claim.src === node.id) child++;
      }
      return { nodeId: node.id, parent, child };
    }).filter((item) => item.parent > 0 || item.child > 0).sort((a, b) => compareText(a.nodeId, b.nodeId));
    const genealogyClaims = selectedClaimRows.filter((claim) => claim.claim_family === "genealogy");
    const comparisonClaims = selectedClaimRows.filter((claim) => claim.claim_family === "comparison");
    const counts = {
      totalNodes: release.artifact.nodes.length,
      rawLinks: release.artifact.links.length,
      allClaims: release.artifact.claims.length,
      acceptedClaims: release.artifact.claims.filter((claim) => claim.decision === "accepted").length,
      acceptedGenealogyClaims: acceptedGenealogy.length,
      acceptedComparisonClaims: acceptedComparison.length,
      eligibleClaims: eligible.length,
      shownNodes: nodes.length,
      shownClaims: selectedClaimRows.length,
    };
    const projection = Object.create(null);
    Object.assign(projection, {
      focus,
      nodes,
      claims: selectedClaimRows,
      genealogyClaims,
      comparisonClaims,
      hiddenBranches,
      counts,
      exclusions,
      expandedNodeIds: [...validExpanded].sort(compareText),
      forceList: nodes.length > 50 || selectedClaimRows.length > 80,
      statusCodes: [...statusCodes].sort(compareText),
    });
    return deepFreeze(projection);
  }

  root.PaperPilotLineageV2 = Object.freeze({
    parsePilotIndex,
    resolvePilotEntry,
    verifyPilotRelease,
    resolveFocus,
    readState,
    writeState,
    selectFocusProjection,
  });
})(typeof window === "undefined" ? globalThis : window);
