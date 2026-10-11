/**
 * Per-catalog source / licence sidecar for the official-proceedings
 * collectors (design 52 §4.1 案 A, user decision D5=A; licence facts:
 * design 51 §2).
 *
 * The shared catalog CSV (`../shared/csvColumns.ts`) has no room for
 * provenance, and its `url` column must be a URL `identityFromUrl` knows
 * (OpenReview / ACL Anthology / CVF / arXiv). So each proceedings collector
 * writes `source_license.json` next to `papers_<date>.csv`, recording where
 * the rows came from, under which licence, whether abstracts were kept, and
 * (when the catalog `url` is not the proceedings page, e.g. PMLR rows keyed
 * by their OpenReview forum) the per-paper proceedings landing URL the
 * licence's attribution clause asks us to link.
 *
 * The catalog build reads it back (R3-3, {@link readSourceLicense} via
 * `catalog/buildPages.ts`): when present it — not the row URL — decides
 * the published `abstract_source` / `abstract_license`, and PMLR rows get
 * their `landing_urls` entry as `abstract_url` for the per-paper credit.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { validateConferenceSlug } from "@paperpilot/core/slug";
import { atomicWriteText } from "../../collect/state/atomic.js";

export const SOURCE_LICENSE_FILENAME = "source_license.json";
export const SOURCE_LICENSE_SCHEMA = "conference-source-license-v1";

export type ProceedingsSource =
  | "pmlr"
  | "acl_anthology"
  | "cvf_open_access"
  | "neurips_proceedings"
  | "iclr_proceedings"
  | "ecva_open_access"
  | "virtual_site_export";

export interface SourceLicense {
  schema_version: typeof SOURCE_LICENSE_SCHEMA;
  conference: string;
  source: ProceedingsSource;
  /** Human-readable collection name, e.g. "PMLR Volume 306 (ICML 2026)". */
  collection: string;
  collection_url: string;
  /** SPDX-like id, or `null` when no licence is granted (rights reserved). */
  license: string | null;
  license_url: string | null;
  /** Attribution text to show with the data (design 51 A6). */
  attribution: string;
  /** Whether `abstract` cells were filled, and the basis for doing so. */
  abstracts: "included" | "omitted";
  abstract_basis: string;
  paper_count: number;
  /** `source_id` -> proceedings landing URL, only when it differs from the catalog `url`. */
  landing_urls?: Record<string, string>;
}

/** Write `<outputRoot>/<conference>/source_license.json` atomically; returns its path. */
export function writeSourceLicense(outputRoot: string, record: SourceLicense): string {
  validateConferenceSlug(record.conference);
  const file = path.join(outputRoot, record.conference, SOURCE_LICENSE_FILENAME);
  const ordered: SourceLicense = {
    ...record,
    ...(record.landing_urls
      ? {
          landing_urls: Object.fromEntries(
            Object.entries(record.landing_urls).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        }
      : {}),
  };
  atomicWriteText(file, `${JSON.stringify(ordered, null, 2)}\n`);
  return file;
}

const PROCEEDINGS_SOURCES: readonly string[] = [
  "pmlr",
  "acl_anthology",
  "cvf_open_access",
  "neurips_proceedings",
  "iclr_proceedings",
  "ecva_open_access",
  "virtual_site_export",
];

/**
 * Validate a parsed `source_license.json`. Throws on anything malformed: a
 * broken sidecar must stop the catalog build rather than silently fall
 * back to guessing the licence from the row URL (that guess is what
 * labelled PMLR abstracts "OpenReview, CC0").
 */
export function parseSourceLicense(raw: unknown): SourceLicense {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("source_license.json: must be an object");
  }
  const r = raw as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new Error(`source_license.json: ${what}`);
  };
  if (r.schema_version !== SOURCE_LICENSE_SCHEMA)
    fail(`schema_version must be ${SOURCE_LICENSE_SCHEMA}`);
  if (typeof r.conference !== "string") fail("conference must be a string");
  validateConferenceSlug(r.conference as string);
  if (typeof r.source !== "string" || !PROCEEDINGS_SOURCES.includes(r.source)) {
    fail(`unknown source ${JSON.stringify(r.source)}`);
  }
  for (const key of ["collection", "collection_url", "attribution", "abstract_basis"]) {
    if (typeof r[key] !== "string") fail(`${key} must be a string`);
  }
  if (r.license !== null && typeof r.license !== "string") fail("license must be a string or null");
  if (r.license_url !== null && typeof r.license_url !== "string") {
    fail("license_url must be a string or null");
  }
  if (r.abstracts !== "included" && r.abstracts !== "omitted") {
    fail('abstracts must be "included" or "omitted"');
  }
  if (!Number.isSafeInteger(r.paper_count)) fail("paper_count must be an integer");
  if (r.landing_urls !== undefined) {
    const urls = r.landing_urls;
    if (!urls || typeof urls !== "object" || Array.isArray(urls))
      fail("landing_urls must be an object");
    for (const [id, url] of Object.entries(urls as Record<string, unknown>)) {
      if (typeof url !== "string" || !url.startsWith("https://")) {
        fail(`landing_urls[${id}] must be an https URL`);
      }
    }
  }
  return r as unknown as SourceLicense;
}

/**
 * Read `<dir>/source_license.json` (the directory holding the conference's
 * `summary.csv`), or `null` when the conference has none (catalogs built
 * before R3-1, OpenReview / arXiv collectors).
 */
export function readSourceLicense(dir: string): SourceLicense | null {
  const file = path.join(dir, SOURCE_LICENSE_FILENAME);
  if (!existsSync(file)) return null;
  return parseSourceLicense(JSON.parse(readFileSync(file, "utf-8")));
}
