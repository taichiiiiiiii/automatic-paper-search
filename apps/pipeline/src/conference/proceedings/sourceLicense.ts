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
 * Nothing downstream reads this file yet; surfacing it on the site is
 * design 51 A3/A6 (follow-up). Keeping it beside the CSV means the
 * attribution travels with the data from the first run.
 */

import * as path from "node:path";
import { validateConferenceSlug } from "@paperpilot/core/slug";
import { atomicWriteText } from "../../collect/state/atomic.js";

export const SOURCE_LICENSE_FILENAME = "source_license.json";
export const SOURCE_LICENSE_SCHEMA = "conference-source-license-v1";

export type ProceedingsSource =
  | "pmlr"
  | "acl_anthology"
  | "cvf_open_access"
  | "neurips_proceedings";

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
