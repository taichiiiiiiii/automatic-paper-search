/**
 * Build additive catalog IDs and the Identity Lite alias sidecar — TS port
 * of `paperpilot/scripts/build_identity_lite.py` + `paperpilot/identity/projector.py`.
 *
 * Implements the CAT-32..36 contracts of `docs/migration/safety-contracts.md`:
 *   - CAT-32: the identity coverage gate refuses to replace any public
 *     identity projection (aliases sidecar or catalogs) when the
 *     projection is invalid (unresolved rows, failures, alias conflicts,
 *     hash collisions, or duplicate paper IDs).
 *   - CAT-33: `reportOnly` writes only the coverage report and skips the
 *     validity gate and public writes.
 *   - CAT-34: `check` mode throws (writes nothing) if the coverage report
 *     or any projected file is stale relative to a fresh projection.
 *   - CAT-35: `loadConferenceNames` rejects a non-array, or any
 *     empty/duplicate conference name, in `conferences.json`.
 *   - CAT-36: `--as-of` must be a timezone-aware ISO-8601 timestamp.
 *
 * This is the other "derived builder" the Node promoter (`../promote.ts`)
 * invokes for a `conference`-kind candidate. See `./searchIndex.ts`'s doc
 * comment for why this lives under `release/derived/` instead of
 * `apps/pipeline/src/catalog/` (edit-limit / consolidation note, repeated
 * in the final report for this change).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IdentityError, identityFromUrl, normalizeAlias } from "@paperpilot/core/identity";
import { codepointCompare, pyFloat, pyJsonDumps } from "@paperpilot/core/pycompat";
import { atomicWriteBytes } from "../../collect/state/atomic.js";

export interface IdentityFailure {
  conference: string;
  row: number | null;
  title: string;
  error: string;
}

export interface AliasConflict {
  namespace: string;
  normalized_id: string;
  first_paper_id: string;
  second_paper_id: string;
}

export interface IdentityCoverage {
  schema_version: "identity-coverage-v1";
  as_of: string;
  valid: boolean;
  input_rows: number;
  resolved_rows: number;
  coverage: number;
  unique_paper_ids: number;
  duplicate_paper_ids: number;
  hash_collisions: number;
  alias_conflicts: number;
  field_loss_rows: number;
  source_counts: Record<string, number>;
  failures: IdentityFailure[];
  alias_conflict_details: AliasConflict[];
}

export interface IdentityProjection {
  catalogs: Record<string, Array<Record<string, unknown>>>;
  aliases: Array<[string, string, string]>;
  coverage: IdentityCoverage;
}

const AS_OF_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Port of `_validate_as_of`: `datetime.fromisoformat(value.replace("Z",
 * "+00:00"))` then requires `tzinfo is not None`. Intentionally narrower
 * than Python's full ISO-8601 acceptance (fractional offsets, week dates,
 * etc. are out of scope — no real call site needs them); documented as an
 * intentional narrowing in the final report for this change.
 */
function validateAsOf(value: string): string {
  const match = AS_OF_RE.exec(value);
  if (!match) {
    throw new Error("as_of must be an ISO-8601 timestamp");
  }
  const [, year, month, day, hour, minute, second, , offset] = match;
  if (!offset) {
    throw new Error("as_of must include a timezone");
  }
  const monthNum = Number.parseInt(month as string, 10);
  const dayNum = Number.parseInt(day as string, 10);
  const hourNum = Number.parseInt(hour as string, 10);
  const minuteNum = Number.parseInt(minute as string, 10);
  const secondNum = second ? Number.parseInt(second, 10) : 0;
  if (
    monthNum < 1 ||
    monthNum > 12 ||
    dayNum < 1 ||
    dayNum > 31 ||
    hourNum > 23 ||
    minuteNum > 59 ||
    secondNum > 59
  ) {
    throw new Error("as_of must be an ISO-8601 timestamp");
  }
  void year;
  return value;
}

function nativeUrlFingerprint(url: string): string {
  // Matches Python's `urlsplit(url).hostname or '', urlsplit(url).path`
  // concatenation for the CVF-collision check below. identity_from_url
  // already validated the URL shape upstream for rows that reach here, so
  // a lightweight manual split suffices (no query/fragment stripping
  // needed — only hostname+path are compared).
  let rest = url;
  const schemeColon = rest.indexOf("://");
  let hostname = "";
  if (schemeColon >= 0) {
    rest = rest.slice(schemeColon + 3);
    const pathStart = rest.search(/[/?#]/);
    const authority = pathStart >= 0 ? rest.slice(0, pathStart) : rest;
    rest = pathStart >= 0 ? rest.slice(pathStart) : "";
    const at = authority.lastIndexOf("@");
    const hostport = at >= 0 ? authority.slice(at + 1) : authority;
    const colon = hostport.indexOf(":");
    hostname = (colon >= 0 ? hostport.slice(0, colon) : hostport).toLowerCase();
  } else {
    rest = "";
  }
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) rest = rest.slice(0, hashIdx);
  const qIdx = rest.indexOf("?");
  const path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  return `${hostname}${path}`;
}

/** Project known-source IDs while collecting every coverage failure. */
export function projectCatalogs(
  docsRoot: string,
  conferenceNames: string[],
  asOf: string,
): IdentityProjection {
  const validatedAsOf = validateAsOf(asOf);
  const catalogs: Record<string, Array<Record<string, unknown>>> = {};
  const sourceCounts = new Map<string, number>();
  const failures: IdentityFailure[] = [];
  const paperRecords = new Map<string, [string, string]>();
  const paperOccurrences = new Map<string, number>();
  const aliasMap = new Map<string, string>(); // key: `${namespace}\u0000${normalizedId}`
  const aliasConflicts: AliasConflict[] = [];
  const nativeFingerprints = new Map<string, string>(); // key: `${source}\u0000${sourceId}`
  let inputRows = 0;
  let resolvedRows = 0;
  let hashCollisions = 0;

  function recordAlias(namespace: string, normalizedId: string, paperId: string): void {
    const key = `${namespace}\u0000${normalizedId}`;
    const existing = aliasMap.get(key);
    if (existing === undefined) {
      aliasMap.set(key, paperId);
    } else if (existing !== paperId) {
      aliasConflicts.push({
        namespace,
        normalized_id: normalizedId,
        first_paper_id: existing,
        second_paper_id: paperId,
      });
    }
  }

  const sortedConferences = conferenceNames.slice().sort(codepointCompare);
  for (const conference of sortedConferences) {
    const path = join(docsRoot, conference, "papers.json");
    let rows: unknown;
    try {
      rows = JSON.parse(readFileSync(path, "utf-8"));
    } catch (exc) {
      failures.push({
        conference,
        row: null,
        title: "",
        error: String((exc as Error).message ?? exc),
      });
      continue;
    }
    if (!Array.isArray(rows)) {
      failures.push({ conference, row: null, title: "", error: "papers.json must be an array" });
      continue;
    }

    const enrichedRows: Array<Record<string, unknown>> = [];
    rows.forEach((rawRow, ordinal) => {
      inputRows += 1;
      const isObject = typeof rawRow === "object" && rawRow !== null && !Array.isArray(rawRow);
      const row = isObject ? (rawRow as Record<string, unknown>) : {};
      const title =
        isObject && typeof row.title === "string" ? row.title : isObject ? (row.title ?? "") : "";
      try {
        if (!isObject) {
          throw new IdentityError("paper row must be an object");
        }
        const sourceUrl =
          typeof row.arxiv_url === "string" ? row.arxiv_url : String(row.arxiv_url ?? "");
        const identity = identityFromUrl(sourceUrl);
        const embedded = row.paper_id;
        if (embedded !== undefined && embedded !== null && embedded !== identity.paperId) {
          throw new IdentityError("embedded paper_id does not match source URL");
        }
        if (
          (row.source !== undefined && row.source !== null) ||
          (row.source_id !== undefined && row.source_id !== null)
        ) {
          const source = row.source;
          const sourceId = row.source_id;
          if (typeof source !== "string" || typeof sourceId !== "string") {
            throw new IdentityError("embedded source/source_id must be strings");
          }
          const [normSource, normId] = normalizeAlias(source, sourceId);
          if (normSource !== identity.source || normId !== identity.sourceId) {
            throw new IdentityError("embedded source/source_id does not match URL");
          }
        }

        const existingRecord = paperRecords.get(identity.paperId);
        const nativeRecord: [string, string] = [identity.source, identity.sourceId];
        if (
          existingRecord !== undefined &&
          (existingRecord[0] !== nativeRecord[0] || existingRecord[1] !== nativeRecord[1])
        ) {
          hashCollisions += 1;
          throw new IdentityError("paper_id hash collision");
        }
        paperRecords.set(identity.paperId, nativeRecord);
        paperOccurrences.set(identity.paperId, (paperOccurrences.get(identity.paperId) ?? 0) + 1);

        const nativeKey = `${identity.source}\u0000${identity.sourceId}`;
        const fingerprint = nativeUrlFingerprint(sourceUrl);
        const previousFingerprint = nativeFingerprints.get(nativeKey);
        if (
          identity.source === "cvf" &&
          previousFingerprint !== undefined &&
          previousFingerprint !== fingerprint
        ) {
          throw new IdentityError("CVF filename stem maps to multiple canonical paths");
        }
        nativeFingerprints.set(nativeKey, fingerprint);

        recordAlias(identity.source, identity.sourceId, identity.paperId);
        const arxivId =
          typeof row.arxiv_id === "string"
            ? row.arxiv_id.trim()
            : String(row.arxiv_id ?? "").trim();
        if (arxivId) {
          const [namespace, normalizedId] = normalizeAlias("arxiv", arxivId);
          recordAlias(namespace, normalizedId, identity.paperId);
        }

        enrichedRows.push({
          ...row,
          paper_id: identity.paperId,
          source: identity.source,
          source_id: identity.sourceId,
        });
        sourceCounts.set(identity.source, (sourceCounts.get(identity.source) ?? 0) + 1);
        resolvedRows += 1;
      } catch (exc) {
        if (exc instanceof IdentityError || exc instanceof Error) {
          failures.push({ conference, row: ordinal, title: String(title), error: exc.message });
        } else {
          throw exc;
        }
      }
    });
    catalogs[conference] = enrichedRows;
  }

  let duplicatePaperIds = 0;
  for (const occurrences of paperOccurrences.values()) {
    if (occurrences > 1) duplicatePaperIds += occurrences - 1;
  }
  const valid =
    inputRows > 0 &&
    resolvedRows === inputRows &&
    failures.length === 0 &&
    aliasConflicts.length === 0 &&
    hashCollisions === 0 &&
    duplicatePaperIds === 0;

  const sortedSourceCounts: Record<string, number> = {};
  for (const key of [...sourceCounts.keys()].sort(codepointCompare)) {
    sortedSourceCounts[key] = sourceCounts.get(key) as number;
  }

  const coverage: IdentityCoverage = {
    schema_version: "identity-coverage-v1",
    as_of: validatedAsOf,
    valid,
    input_rows: inputRows,
    resolved_rows: resolvedRows,
    coverage: inputRows ? resolvedRows / inputRows : 0.0,
    unique_paper_ids: paperRecords.size,
    duplicate_paper_ids: duplicatePaperIds,
    hash_collisions: hashCollisions,
    alias_conflicts: aliasConflicts.length,
    field_loss_rows: 0,
    source_counts: sortedSourceCounts,
    failures,
    alias_conflict_details: aliasConflicts,
  };

  const aliases: Array<[string, string, string]> = [...aliasMap.entries()]
    .map(([key, paperId]) => {
      const sep = key.indexOf("\u0000");
      return [key.slice(0, sep), key.slice(sep + 1), paperId] as [string, string, string];
    })
    .sort((a, b) => codepointCompare(`${a[0]}\u0000${a[1]}`, `${b[0]}\u0000${b[1]}`));

  return { catalogs, aliases, coverage };
}

function jsonBytes(value: unknown, indent?: number): Buffer {
  const text =
    indent !== undefined
      ? pyJsonDumps(value, { ensureAscii: false, indent })
      : pyJsonDumps(value, { ensureAscii: false, separators: [",", ":"] });
  return Buffer.from(`${text}\n`, "utf-8");
}

/** Coverage JSON wraps `coverage.coverage` (a ratio) so it always serializes as a float, matching Python's `resolved_rows / input_rows` float division. */
function coveragePayload(coverage: IdentityCoverage): Record<string, unknown> {
  return { ...coverage, coverage: pyFloat(coverage.coverage) };
}

export interface BuildIdentityLiteOptions {
  docsRoot: string;
  conferenceNames: string[];
  asOf: string;
  coveragePath: string;
  check?: boolean;
  reportOnly?: boolean;
}

/** Validate all inputs before replacing any public identity projection (CAT-32..34). */
export function buildIdentityLite(options: BuildIdentityLiteOptions): IdentityProjection {
  const {
    docsRoot,
    conferenceNames,
    asOf,
    coveragePath,
    check = false,
    reportOnly = false,
  } = options;
  const projection = projectCatalogs(docsRoot, conferenceNames, asOf);
  const coveragePayloadBytes = jsonBytes(coveragePayload(projection.coverage), 2);

  if (check) {
    if (!bufferEquals(readFileSync(coveragePath), coveragePayloadBytes)) {
      throw new Error("identity coverage report is stale");
    }
  } else {
    atomicWriteBytes(coveragePath, coveragePayloadBytes);
  }

  if (reportOnly) {
    return projection;
  }
  if (!projection.coverage.valid) {
    throw new Error("identity coverage gate failed; public files were not replaced");
  }

  const expected = new Map<string, Buffer>();
  expected.set(join(docsRoot, "identity-aliases-v1.json"), jsonBytes(projection.aliases));
  for (const [conference, rows] of Object.entries(projection.catalogs)) {
    expected.set(join(docsRoot, conference, "papers.json"), jsonBytes(rows, 0));
  }

  if (check) {
    const stale: string[] = [];
    for (const [path, payload] of expected) {
      if (!bufferEquals(readFileSync(path), payload)) stale.push(path);
    }
    if (stale.length > 0) {
      throw new Error(`identity projections are stale: ${stale.join(", ")}`);
    }
    return projection;
  }

  for (const [path, payload] of expected) {
    atomicWriteBytes(path, payload);
  }
  return projection;
}

function bufferEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

/** CAT-35: reject a non-array, or any empty/duplicate conference name. */
export function loadConferenceNames(docsRoot: string): string[] {
  const rows = JSON.parse(readFileSync(join(docsRoot, "conferences.json"), "utf-8"));
  if (!Array.isArray(rows)) {
    throw new Error("conferences.json must be an array");
  }
  const names = rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => row.name);
  if (names.length === 0 || !names.every((name) => typeof name === "string" && name)) {
    throw new Error("every conference must have a non-empty name");
  }
  const unique = new Set(names as string[]);
  if (unique.size !== names.length) {
    throw new Error("conference names must be unique");
  }
  return names as string[];
}
