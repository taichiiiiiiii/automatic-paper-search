/**
 * Regenerate a strict `deep-manifest-v1` from audited deep artifacts — TS
 * port of `paperpilot/scripts/generate_deep_manifest.py`.
 *
 * Identity is read only from the canonical seed and exact aliases carried by
 * a `lineage-artifact-v1` file. Filename, title and first-node fallbacks are
 * intentionally forbidden; legacy files remain unavailable until regenerated.
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { codepointCompare, pyJsonDumps } from "@paperpilot/core";
import { IdentityError, normalizeAlias } from "../../catalog/identity.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import {
  ARXIV_ID_RE,
  canonicalFocusNode,
  DEEP_MANIFEST_VERSION,
  isPaperId,
  LINEAGE_ARTIFACT_VERSION,
  validateDeepManifest,
  validateLineageArtifact,
} from "../contract/v1.js";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deep artifact exists but could not be read at all (distinct from a stated rejection). */
export class UnreadableArtifactError extends Error {}

/** `papers.json` could not be read, so no artifact can be validated. */
export class UnreadableCatalogError extends Error {}

const MANIFEST_NAME = "deep-manifest.json";
const EMPTY_GENERATED_AT = "1970-01-01T00:00:00Z";
const FILENAME_RE = /^deep-(\d{4}\.\d{4,5}(?:v\d+)?)\.json$/;

export interface ManifestEntry {
  paper_id: string;
  aliases: string[][];
  arxiv_id: string;
  title: string;
  filename: string;
}

export interface DeepManifest {
  schema_version: string;
  conference: string;
  generated_at: string;
  entries: ManifestEntry[];
}

function arraysOfStringsEqual(a: unknown, b: readonly (readonly string[])[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return a.every(
    (row, i) =>
      Array.isArray(row) && row.length === b[i]!.length && row.every((v, j) => v === b[i]![j]),
  );
}

function entryFromFile(
  path: string,
  options: { catalogIds: ReadonlySet<string>; catalogArxivByPaper: ReadonlyMap<string, string> },
): [ManifestEntry, string] | null {
  const { catalogIds, catalogArxivByPaper } = options;
  const name = basename(path);
  const match = FILENAME_RE.exec(name);
  if (match === null) {
    return null;
  }
  const filenameArxiv = match[1]!;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (exc) {
    // NOT a skip — see UnreadableArtifactError's doc comment.
    throw new UnreadableArtifactError(`${path}: ${(exc as Error).message ?? exc}`);
  }
  if (!isMapping(payload) || payload.schema_version !== LINEAGE_ARTIFACT_VERSION) {
    return null;
  }

  const meta = payload.meta;
  if (!isMapping(meta)) return null;
  const arxivId = meta.arxiv_id;
  const seedPaperId = meta.seed_paper_id;
  const root = payload.root;
  if (
    typeof arxivId !== "string" ||
    !ARXIV_ID_RE.test(arxivId) ||
    arxivId !== filenameArxiv ||
    !isPaperId(seedPaperId) ||
    typeof root !== "string"
  ) {
    return null;
  }
  if (catalogArxivByPaper.get(seedPaperId) !== arxivId) {
    return null;
  }

  const focus = canonicalFocusNode(payload);
  const aliases: string[][] = [
    ["arxiv", arxivId],
    ["semantic_scholar", root],
  ];
  if (
    focus === null ||
    focus.seed_paper_id !== seedPaperId ||
    !arraysOfStringsEqual(focus.aliases, aliases) ||
    !arraysOfStringsEqual(meta.aliases, aliases)
  ) {
    return null;
  }
  const title = focus.title;
  const generatedAt = meta.generated_at;
  if (typeof title !== "string" || !title.trim() || typeof generatedAt !== "string") {
    return null;
  }

  const issues = validateLineageArtifact(payload, {
    kind: "deep",
    catalogIds,
    expectedSeedPaperId: seedPaperId,
  });
  if (issues.length > 0) {
    return null;
  }
  return [
    { paper_id: seedPaperId, aliases, arxiv_id: arxivId, title: title.trim(), filename: name },
    generatedAt,
  ];
}

/**
 * Return canonical IDs and unambiguous paper_id -> arXiv pairs.
 *
 * A paper ID and an arXiv ID appearing somewhere in the same catalog are not
 * sufficient: publication requires both values to be declared by one row.
 * Conflicting explicit aliases fail the whole manifest instead of choosing a
 * row or silently dropping the ambiguity.
 */
export function loadCatalogIdentity(docsDir: string): {
  catalogIds: Set<string>;
  catalogArxivByPaper: Map<string, string>;
} {
  const catalogPath = join(docsDir, "papers.json");
  let raw: string;
  try {
    raw = readFileSync(catalogPath, "utf8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") {
      // A conference directory with no catalog at all is a real state
      // (nothing collected yet), not a read failure.
      return { catalogIds: new Set(), catalogArxivByPaper: new Map() };
    }
    throw new UnreadableCatalogError(
      `conference catalog in ${docsDir} could not be read (${(exc as Error).message}); refusing to ` +
        "build a manifest that would omit every deep artifact",
    );
  }
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch (exc) {
    throw new UnreadableCatalogError(
      `conference catalog in ${docsDir} could not be read (${(exc as Error).message}); refusing to ` +
        "build a manifest that would omit every deep artifact",
    );
  }
  if (!Array.isArray(rows)) {
    throw new Error("conference catalog must be an array");
  }

  const catalogIds = new Set<string>();
  const arxivByPaper = new Map<string, string>();
  const paperByArxiv = new Map<string, string>();
  rows.forEach((row, index) => {
    if (!isMapping(row) || !isPaperId(row.paper_id)) return;
    const paperId = row.paper_id;
    catalogIds.add(paperId);
    const candidates: string[] = [];
    if (typeof row.arxiv_id === "string" && row.arxiv_id.trim()) candidates.push(row.arxiv_id);
    if (row.source === "arxiv" && typeof row.source_id === "string") candidates.push(row.source_id);
    const normalized = new Set<string>();
    for (const candidate of candidates) {
      try {
        const [, arxivId] = normalizeAlias("arxiv", candidate);
        normalized.add(arxivId);
      } catch (e) {
        if (!(e instanceof IdentityError)) throw e;
        throw new Error(`catalog row ${index} has invalid arXiv identity`);
      }
    }
    if (normalized.size > 1) {
      throw new Error(`catalog paper ${paperId} has ambiguous arXiv identities`);
    }
    if (normalized.size === 0) return;
    const arxivId = normalized.values().next().value as string;
    const previousArxiv = arxivByPaper.get(paperId);
    const previousPaper = paperByArxiv.get(arxivId);
    if (
      (previousArxiv !== undefined && previousArxiv !== arxivId) ||
      (previousPaper !== undefined && previousPaper !== paperId)
    ) {
      throw new Error("catalog contains an ambiguous paper_id/arXiv mapping");
    }
    arxivByPaper.set(paperId, arxivId);
    paperByArxiv.set(arxivId, paperId);
  });
  return { catalogIds, catalogArxivByPaper: arxivByPaper };
}

function listDirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Scan deep artifacts and return one deterministic strict manifest. */
export function generateManifest(docsDir: string): DeepManifest {
  const { catalogIds, catalogArxivByPaper } = loadCatalogIdentity(docsDir);
  const entries: ManifestEntry[] = [];
  const timestamps: string[] = [];
  const unreadable: string[] = [];
  {
    const names = listDirOrEmpty(docsDir)
      .filter((name) => !name.startsWith(".") && /^deep-.*\.json$/.test(name))
      .sort(codepointCompare);
    for (const name of names) {
      if (name === MANIFEST_NAME) continue;
      const path = join(docsDir, name);
      try {
        const result = entryFromFile(path, { catalogIds, catalogArxivByPaper });
        if (result !== null) {
          const [entry, generatedAt] = result;
          entries.push(entry);
          timestamps.push(generatedAt);
        }
      } catch (exc) {
        if (exc instanceof UnreadableArtifactError) {
          unreadable.push(exc.message);
          continue;
        }
        throw exc;
      }
    }
  }

  if (unreadable.length > 0) {
    throw new UnreadableArtifactError(
      `refusing to build a manifest that silently omits ${unreadable.length} unreadable artifact(s):\n  ` +
        unreadable.join("\n  "),
    );
  }

  entries.sort(
    (a, b) => codepointCompare(a.paper_id, b.paper_id) || codepointCompare(a.arxiv_id, b.arxiv_id),
  );
  const generatedAt =
    timestamps.length === 0
      ? EMPTY_GENERATED_AT
      : timestamps.reduce((max, t) => (codepointCompare(t, max) > 0 ? t : max));
  const manifest: DeepManifest = {
    schema_version: DEEP_MANIFEST_VERSION,
    conference: basename(docsDir),
    generated_at: generatedAt,
    entries,
  };
  const issues = validateDeepManifest(manifest, { catalogIds });
  if (issues.length > 0) {
    const detail = issues
      .slice(0, 8)
      .map((i) => `${i.code}:${i.path}`)
      .join("; ");
    throw new Error(`deep manifest is ambiguous or invalid: ${detail}`);
  }
  return manifest;
}

/** Atomically replace `deep-manifest.json` after complete validation. */
export function writeManifest(docsDir: string): string {
  mkdirSync(docsDir, { recursive: true });
  const manifest = generateManifest(docsDir);
  const out = join(docsDir, MANIFEST_NAME);
  atomicWriteText(out, `${pyJsonDumps(manifest, { ensureAscii: false, indent: 2 })}\n`);
  return out;
}
