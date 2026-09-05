// Shared fail-closed reader for lineage-artifact-v1 and deep-manifest-v1.
(function initPaperPilotLineageCore(root) {
  "use strict";

  const ARTIFACT_VERSION = "lineage-artifact-v1";
  const MANIFEST_VERSION = "deep-manifest-v1";
  const PAPER_ID_RE = /^[0-9a-f]{40}$/;
  const SHA256_RE = /^[0-9a-f]{64}$/;
  const ARXIV_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
  const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const MAX_JSON_BYTES = 8 * 1024 * 1024;
  const EXACT_ALIAS_NAMESPACES = new Set([
    "arxiv", "openreview", "acl_anthology", "cvf", "doi",
  ]);
  const RELATIONS = new Set([
    "supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts",
  ]);
  const METHODS = new Set([
    "llm", "citation_heuristic", "intent_map", "context_pattern", "year_cite",
    "title_version", "foundational_allowlist",
  ]);

  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function nonempty(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function exactKeys(value, expected) {
    if (!record(value)) return false;
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
  }

  function validTimestamp(value) {
    if (typeof value !== "string") return false;
    const match = TIMESTAMP_RE.exec(value);
    if (!match || !validCalendarParts(match.slice(1, 7).map(Number))) return false;
    return Number.isFinite(Date.parse(value));
  }

  function validDate(value) {
    if (typeof value !== "string") return false;
    const match = DATE_RE.exec(value);
    return !!match && validCalendarParts([
      Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0,
    ]);
  }

  function validCalendarParts([year, month, day, hour, minute, second]) {
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= days[month - 1];
  }

  function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function normalizedNodeAlias(alias, kind) {
    if (!Array.isArray(alias) || alias.length !== 2
        || typeof alias[0] !== "string" || typeof alias[1] !== "string") return null;
    const [namespace, sourceId] = alias;
    if (namespace === "semantic_scholar") {
      return kind !== "theme" && nonempty(sourceId) && sourceId === sourceId.trim()
        ? `${namespace}\u0000${sourceId}` : null;
    }
    if (!EXACT_ALIAS_NAMESPACES.has(namespace) || sourceId !== sourceId.trim()) return null;
    if (namespace === "arxiv") {
      if (/^\d{4}\.\d{4,5}$/.test(sourceId)) return `${namespace}\u0000${sourceId}`;
      const legacy = /^([A-Za-z][A-Za-z0-9.-]*)\/(\d{7})$/.exec(sourceId);
      if (!legacy) return null;
      let archive = legacy[1];
      if (archive.includes(".")) {
        const dot = archive.indexOf(".");
        archive = `${archive.slice(0, dot).toLowerCase()}${archive.slice(dot)}`;
      } else {
        archive = archive.toLowerCase();
      }
      return sourceId === `${archive}/${legacy[2]}` ? `${namespace}\u0000${sourceId}` : null;
    }
    if (namespace === "openreview") {
      return /^[A-Za-z0-9_-]{1,256}$/.test(sourceId) ? `${namespace}\u0000${sourceId}` : null;
    }
    if (namespace === "acl_anthology" || namespace === "cvf") {
      return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$/.test(sourceId)
        ? `${namespace}\u0000${sourceId}` : null;
    }
    return /^10\.\d{4,9}\/[^\s\x00-\x1f\x7f]+$/.test(sourceId)
      && sourceId === sourceId.toLowerCase() ? `${namespace}\u0000${sourceId}` : null;
  }

  function validProvenance(value) {
    if (!record(value) || !record(value.producer) || !record(value.evidence)
        || !record(value.classification)) return false;
    const { producer, evidence, classification } = value;
    if (!exactKeys(value, ["producer", "evidence", "classification"])
        || !exactKeys(producer, ["name", "version"])
        || !exactKeys(evidence, ["source", "kind", "sha256"])
        || !exactKeys(classification, [
          "method", "provider", "model", "prompt_version", "schema_version",
        ])
        || !nonempty(producer.name) || !nonempty(producer.version)
        || !nonempty(evidence.source) || !nonempty(evidence.kind)
        || !SHA256_RE.test(evidence.sha256)
        || !METHODS.has(classification.method)
        || !nonempty(classification.schema_version)) return false;
    for (const field of ["provider", "model", "prompt_version"]) {
      if (classification[field] !== null && !nonempty(classification[field])) return false;
    }
    if (classification.method === "llm") {
      return ["provider", "model", "prompt_version"].every(
        (field) => nonempty(classification[field]),
      );
    }
    return true;
  }

  function parseArtifact(data, { kind = "conference" } = {}) {
    if (!record(data) || data.schema_version !== ARTIFACT_VERSION
        || !Array.isArray(data.nodes) || !Array.isArray(data.edges)
        || !Array.isArray(data.clusters) || !record(data.meta)) return null;

    if (kind === "theme" && (data.meta.kind !== "theme"
        || !nonempty(data.meta.generator) || !validTimestamp(data.meta.generated_at)
        || data.clusters.length !== 0)) return null;

    const requireSeed = kind === "conference" || kind === "deep" || kind === "theme";
    const ids = new Set();
    const seedIds = new Set();
    const aliasKeys = new Set();
    const nodes = [];
    for (const node of data.nodes) {
      if (!record(node) || !nonempty(node.id) || ids.has(node.id)
          || typeof node.is_focus !== "boolean") return null;
      if (Object.prototype.hasOwnProperty.call(node, "seed_paper_id")
          && !PAPER_ID_RE.test(node.seed_paper_id)) return null;
      ids.add(node.id);
      if (node.is_focus) {
        if (requireSeed && !PAPER_ID_RE.test(node.seed_paper_id)) return null;
        if (PAPER_ID_RE.test(node.seed_paper_id || "")) {
          if (seedIds.has(node.seed_paper_id)) return null;
          seedIds.add(node.seed_paper_id);
        }
      }
      if (Object.prototype.hasOwnProperty.call(node, "aliases")) {
        if (!Array.isArray(node.aliases)) return null;
        const nodeAliases = new Set();
        for (const alias of node.aliases) {
          const key = normalizedNodeAlias(alias, kind);
          if (key === null || nodeAliases.has(key) || aliasKeys.has(key)) return null;
          nodeAliases.add(key);
          aliasKeys.add(key);
        }
      }
      nodes.push({ ...node });
    }
    const sortedNodeIds = [...ids].sort(compareText);
    if (nodes.some((node, index) => node.id !== sortedNodeIds[index])) return null;
    if (nodes.length === 0) {
      if (data.root !== null) return null;
    } else if (!nonempty(data.root)) {
      return null;
    }
    const rootMatches = nodes.filter(
      (node) => node.id === data.root && node.is_focus === true,
    );
    if (nodes.length > 0 && rootMatches.length !== 1) return null;

    const edgeKeys = new Set();
    const edges = [];
    const degree = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of data.edges) {
      if (!record(edge) || !ids.has(edge.src) || !ids.has(edge.dst)
          || !RELATIONS.has(edge.relation) || edge.rel !== edge.relation
          || typeof edge.confidence !== "number" || !Number.isFinite(edge.confidence)
          || edge.confidence < 0 || edge.confidence > 1
          || edge.conf !== edge.confidence || !nonempty(edge.rationale)
          || !validProvenance(edge.provenance)) return null;
      const key = `${edge.src}\u0000${edge.dst}\u0000${edge.relation}`;
      if (edgeKeys.has(key)) return null;
      edgeKeys.add(key);
      degree.set(edge.src, degree.get(edge.src) + 1);
      degree.set(edge.dst, degree.get(edge.dst) + 1);
      edges.push({
        src: edge.src,
        dst: edge.dst,
        relation: edge.relation,
        confidence: edge.confidence,
        rationale: edge.rationale,
        provenance: edge.provenance,
      });
    }
    const sortedEdges = [...edges].sort((left, right) => compareText(
      [left.src, left.dst, left.relation].join("\u0000"),
      [right.src, right.dst, right.relation].join("\u0000"),
    ));
    if (edges.some((edge, index) => edge.src !== sortedEdges[index].src
        || edge.dst !== sortedEdges[index].dst
        || edge.relation !== sortedEdges[index].relation)) return null;
    if (nodes.length > 0) {
      const rankedFocus = nodes.filter((node) => node.is_focus === true).sort((left, right) =>
        degree.get(right.id) - degree.get(left.id) || compareText(left.id, right.id));
      if (rankedFocus.length === 0 || data.root !== rankedFocus[0].id) return null;
    }
    return {
      schema_version: ARTIFACT_VERSION,
      root: data.root,
      nodes,
      edges,
      clusters: data.clusters.map((cluster) => ({ ...cluster })),
      meta: { ...data.meta },
    };
  }

  function parseDeepManifest(data) {
    if (!exactKeys(data, ["schema_version", "conference", "generated_at", "entries"])
        || data.schema_version !== MANIFEST_VERSION
        || !SLUG_RE.test(data.conference) || !validTimestamp(data.generated_at)
        || !Array.isArray(data.entries)) return null;
    const paperIds = new Set();
    const aliasKeys = new Set();
    const filenames = new Set();
    const entries = [];
    for (const entry of data.entries) {
      if (!exactKeys(entry, ["paper_id", "aliases", "arxiv_id", "title", "filename"])
          || !PAPER_ID_RE.test(entry.paper_id)
          || !ARXIV_RE.test(entry.arxiv_id) || !nonempty(entry.title)
          || entry.filename !== `deep-${entry.arxiv_id}.json`
          || !Array.isArray(entry.aliases) || entry.aliases.length !== 2
          || paperIds.has(entry.paper_id) || filenames.has(entry.filename)) return null;
      const aliasMap = new Map();
      for (const alias of entry.aliases) {
        if (!Array.isArray(alias) || alias.length !== 2
            || !["arxiv", "semantic_scholar"].includes(alias[0])
            || !nonempty(alias[1]) || aliasMap.has(alias[0])) return null;
        const key = `${alias[0]}\u0000${alias[1]}`;
        if (aliasKeys.has(key)) return null;
        aliasKeys.add(key);
        aliasMap.set(alias[0], alias[1]);
      }
      if (aliasMap.get("arxiv") !== entry.arxiv_id
          || !nonempty(aliasMap.get("semantic_scholar"))) return null;
      paperIds.add(entry.paper_id);
      filenames.add(entry.filename);
      entries.push({ ...entry, aliases: entry.aliases.map((alias) => [...alias]) });
    }
    return { ...data, entries };
  }

  const QUALITY_ROW_KEYS = [
    "collection_id", "kind", "slug", "label", "path", "availability",
    "audit_status", "freshness", "generated_at", "snapshot_date", "node_count",
    "edge_count", "artifact_schema_version", "input_sha256", "audit",
  ];
  const QUALITY_DEEP_KEYS = [
    "conference", "paper_id", "arxiv_id", "manifest_path", "manifest_input_sha256",
  ];
  const QUALITY_AUDIT_KEYS = ["fixture_sha256", "evaluated_at", "actor", "checks"];
  const QUALITY_CHECK_KEYS = ["name", "status", "observed", "expected", "evidence"];
  const DEEP_FILENAME_RE = /^deep-[A-Za-z0-9._-]+\.json$/;

  function validQualityAudit(audit) {
    if (!exactKeys(audit, QUALITY_AUDIT_KEYS)
        || (audit.fixture_sha256 !== null && !SHA256_RE.test(audit.fixture_sha256))
        || !validTimestamp(audit.evaluated_at)
        || audit.actor !== "ci:audit-v1"
        || !Array.isArray(audit.checks)) return false;
    let previousName = null;
    for (const check of audit.checks) {
      if (!exactKeys(check, QUALITY_CHECK_KEYS)
          || !nonempty(check.name)
          || !["unknown", "passed", "failed"].includes(check.status)
          || !Array.isArray(check.evidence) || check.evidence.length > 20
          || !check.evidence.every((item) => typeof item === "string")) return false;
      if (previousName !== null && compareText(previousName, check.name) >= 0) return false;
      previousName = check.name;
    }
    return true;
  }

  function auditStatusIsConsistent(row) {
    const statuses = row.audit.checks.map((check) => check.status);
    if (row.audit_status === "passed") {
      return statuses.length > 0 && statuses.every((status) => status === "passed");
    }
    if (row.audit_status === "failed") return statuses.includes("failed");
    return true;
  }

  function rowHasPassedAuditContract(row) {
    if (row.artifact_schema_version !== ARTIFACT_VERSION
        || !SHA256_RE.test(row.input_sha256)
        || !SHA256_RE.test(row.audit.fixture_sha256)
        || !auditStatusIsConsistent(row)) return false;
    const passedNames = new Set(
      row.audit.checks.filter((check) => check.status === "passed").map((check) => check.name),
    );
    return passedNames.has("artifact_contract_v1") && passedNames.has("golden_fixture");
  }

  function parseQualityManifest(data) {
    if (!exactKeys(data, ["schema_version", "as_of", "audit_version", "collections"])
        || data.schema_version !== "lineage-quality-v1"
        || data.audit_version !== "audit-v1"
        || !validTimestamp(data.as_of)
        || !Array.isArray(data.collections)) return null;
    let previousId = null;
    const paths = new Set();
    const collections = [];
    for (const row of data.collections) {
      if (!record(row)
          || !exactKeys(row, row.kind === "deep"
            ? QUALITY_ROW_KEYS.concat(QUALITY_DEEP_KEYS) : QUALITY_ROW_KEYS)
          || !nonempty(row.collection_id)
          || !["conference", "theme", "deep"].includes(row.kind)
          || !SLUG_RE.test(row.slug) || !nonempty(row.label) || !nonempty(row.path)
          || !["unavailable", "sparse", "ready", "failed"].includes(row.availability)
          || !["unknown", "passed", "failed"].includes(row.audit_status)
          || !["fresh", "stale"].includes(row.freshness)
          || (row.generated_at !== null && !validTimestamp(row.generated_at))
          || (row.snapshot_date !== null && !validDate(row.snapshot_date))
          || !Number.isInteger(row.node_count) || row.node_count < 0
          || !Number.isInteger(row.edge_count) || row.edge_count < 0
          || (row.artifact_schema_version !== null
              && typeof row.artifact_schema_version !== "string")
          || (row.input_sha256 !== null && !SHA256_RE.test(row.input_sha256))
          || paths.has(row.path)) return null;
      if (row.kind === "conference") {
        if (row.collection_id !== `conference:${row.slug}`
            || row.path !== `${row.slug}/lineage.json`) return null;
      } else if (row.kind === "theme") {
        if (row.collection_id !== `theme:${row.slug}`
            || row.path !== `themes/${row.slug}/lineage.json`) return null;
      } else {
        if (row.conference !== row.slug || !SLUG_RE.test(row.conference)
            || !row.collection_id.startsWith(`deep:${row.conference}:`)
            || row.collection_id.length <= `deep:${row.conference}:`.length
            || (row.paper_id !== null && !PAPER_ID_RE.test(row.paper_id))
            || (row.arxiv_id !== null && !ARXIV_RE.test(row.arxiv_id))
            || row.manifest_path !== `${row.conference}/deep-manifest.json`
            || (row.manifest_input_sha256 !== null
                && !SHA256_RE.test(row.manifest_input_sha256))
            || !row.path.startsWith(`${row.conference}/`)
            || !DEEP_FILENAME_RE.test(row.path.slice(row.conference.length + 1))) return null;
        if (row.availability === "ready" && row.audit_status === "passed" && (
          !PAPER_ID_RE.test(row.paper_id) || !ARXIV_RE.test(row.arxiv_id)
          || !SHA256_RE.test(row.input_sha256)
          || !SHA256_RE.test(row.manifest_input_sha256)
        )) return null;
      }
      if (!validQualityAudit(row.audit) || !auditStatusIsConsistent(row)) return null;
      if (row.availability === "ready" && row.audit_status === "passed"
          && !rowHasPassedAuditContract(row)) return null;
      if (previousId !== null && compareText(previousId, row.collection_id) >= 0) return null;
      previousId = row.collection_id;
      paths.add(row.path);
      collections.push({
        ...row,
        audit: {
          ...row.audit,
          checks: row.audit.checks.map((check) => ({
            ...check, evidence: [...check.evidence],
          })),
        },
      });
    }
    return { ...data, collections };
  }

  function resolveQualityCollection(quality, selector) {
    if (!quality || !Array.isArray(quality.collections) || !record(selector)) return null;
    const matches = quality.collections.filter((row) => {
      if (row.kind !== selector.kind) return false;
      if (selector.kind === "conference") {
        return row.slug === selector.slug && row.path === selector.path;
      }
      if (selector.kind === "theme") {
        return row.slug === selector.slug
          && row.path === `themes/${selector.slug}/lineage.json`;
      }
      if (selector.kind === "deep") {
        return row.conference === selector.conference && row.slug === selector.conference
          && row.paper_id === selector.paperId && row.path === selector.path;
      }
      return false;
    });
    return uniqueMatch(matches);
  }

  function qualityRowIsEligible(row, { manifestSha256 = null } = {}) {
    if (!row || row.availability !== "ready" || row.audit_status !== "passed"
        || !validQualityAudit(row.audit)
        || !rowHasPassedAuditContract(row)) return false;
    return row.kind !== "deep" || (
      SHA256_RE.test(row.manifest_input_sha256)
      && row.manifest_input_sha256 === manifestSha256
    );
  }

  function qualityRowIsPublishable(
    row, { artifactSha256 = null, manifestSha256 = null } = {},
  ) {
    return qualityRowIsEligible(row, { manifestSha256 })
      && SHA256_RE.test(row.input_sha256)
      && row.input_sha256 === artifactSha256;
  }

  async function readResponseBytes(response) {
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined && declared !== "") {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_BYTES) return null;
    }
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          await reader.cancel();
          return null;
        }
        total += value.byteLength;
        if (total > MAX_JSON_BYTES) {
          await reader.cancel();
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
    const buffer = await response.arrayBuffer();
    return buffer.byteLength <= MAX_JSON_BYTES ? new Uint8Array(buffer) : null;
  }

  async function fetchJsonWithSha256(
    url, options = undefined, { expectedSha256 = null } = {},
  ) {
    try {
      if (expectedSha256 !== null && !SHA256_RE.test(expectedSha256)) return null;
      const response = await fetch(url, options);
      if (!response.ok || !globalThis.crypto?.subtle) return null;
      const bytes = await readResponseBytes(response);
      if (bytes === null) return null;
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      if (expectedSha256 !== null && sha256 !== expectedSha256) return null;
      const data = JSON.parse(new TextDecoder().decode(bytes));
      return { data, sha256 };
    } catch {
      return null;
    }
  }

  function uniqueMatch(matches) {
    return matches.length === 1 ? matches[0] : null;
  }

  function resolveFocus(data, raw) {
    if (!data || !Array.isArray(data.nodes)) return null;
    if (!nonempty(raw)) return uniqueMatch(data.nodes.filter((node) => node.id === data.root));
    const canonicalMatches = data.nodes.filter(
      (node) => node.is_focus === true && PAPER_ID_RE.test(node.seed_paper_id)
        && node.seed_paper_id === raw,
    );
    // Lowercase 40-hex URL values are reserved for canonical PaperPilot IDs.
    // A canonical miss must not fall through to an S2-shaped graph-local ID
    // or alias, even when those happen to use the same wire shape.
    if (PAPER_ID_RE.test(raw)) return uniqueMatch(canonicalMatches);
    if (canonicalMatches.length > 0) return uniqueMatch(canonicalMatches);
    // semantic_scholar is retained as a conference/deep migration field only;
    // graph-local IDs already provide the exact S2 lookup surface.
    const aliasMatches = data.nodes.filter(
      (node) => Array.isArray(node.aliases)
        && node.aliases.some((alias) => Array.isArray(alias)
          && EXACT_ALIAS_NAMESPACES.has(alias[0]) && alias[1] === raw),
    );
    if (aliasMatches.length > 0) return uniqueMatch(aliasMatches);
    return uniqueMatch(data.nodes.filter((node) => node.id === raw));
  }

  function resolveManifestEntry(manifest, { paper = null, arxiv = null } = {}) {
    if (!manifest || !Array.isArray(manifest.entries)) return null;
    if (nonempty(paper)) {
      return uniqueMatch(manifest.entries.filter((entry) => entry.paper_id === paper));
    }
    if (nonempty(arxiv)) {
      return uniqueMatch(manifest.entries.filter((entry) => entry.aliases.some(
        (alias) => alias[0] === "arxiv" && alias[1] === arxiv,
      )));
    }
    return manifest.entries[0] || null;
  }

  function resolveView({ urlView = null, savedView = null, matchMedia = null } = {}) {
    if (["list", "graph"].includes(urlView)) return urlView;
    if (["list", "graph"].includes(savedView)) return savedView;
    return typeof matchMedia === "function" && matchMedia("(max-width: 720px)").matches
      ? "list" : "graph";
  }

  function selectActiveEdges(edges, visibleRelations, positionedNodeIds = null) {
    const relations = visibleRelations instanceof Set
      ? visibleRelations : new Set(visibleRelations || []);
    const positioned = positionedNodeIds === null || positionedNodeIds instanceof Set
      ? positionedNodeIds : new Set(positionedNodeIds);
    return (edges || []).filter((edge) => relations.has(edge.relation)
      && (positioned === null || (positioned.has(edge.src) && positioned.has(edge.dst))));
  }

  root.PaperPilotLineageCore = Object.freeze({
    ARTIFACT_VERSION,
    MANIFEST_VERSION,
    MAX_JSON_BYTES,
    parseArtifact,
    parseDeepManifest,
    parseQualityManifest,
    resolveQualityCollection,
    qualityRowIsEligible,
    qualityRowIsPublishable,
    fetchJsonWithSha256,
    resolveFocus,
    resolveManifestEntry,
    resolveView,
    selectActiveEdges,
    validProvenance,
  });
}(typeof window === "undefined" ? globalThis : window));
