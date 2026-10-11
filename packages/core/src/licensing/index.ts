/**
 * Source labels and abstract licences for the conference catalog
 * (design doc 51 §4, user decision D1=A, R2-26).
 *
 * Shared by the catalog build (apps/pipeline `catalog/abstractPolicy.ts`,
 * which decides which abstract text may be published) and the web viewer
 * (which labels each link and abstract with its source and licence), so
 * the two can never disagree about what a source is called or under which
 * terms its abstract is shown.
 */

/** Native source of a catalog row (`identityFromUrl(...).source`). */
export type CatalogSource = "arxiv" | "openreview" | "acl_anthology" | "cvf";

/**
 * Where the abstract text published for a catalog row comes from.
 * `none` = withheld by licence policy (CVF Open Access abstracts carry no
 * licence; when no CC0 arXiv version or Semantic Scholar TLDR was matched
 * the row shows title / authors / link only).
 */
export type AbstractSource = "arxiv" | "openreview" | "acl_anthology" | "s2_tldr" | "none";

export const ABSTRACT_SOURCES: readonly AbstractSource[] = [
  "arxiv",
  "openreview",
  "acl_anthology",
  "s2_tldr",
  "none",
];

export interface LicenseInfo {
  /** SPDX-style id written to papers.json (`abstract_license`). */
  id: string;
  /** Human label. */
  label: string;
  url: string;
}

export const LICENSES = {
  cc0: {
    id: "CC0-1.0",
    label: "CC0 1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  ccBy4: {
    id: "CC-BY-4.0",
    label: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
  },
  odcBy: {
    id: "ODC-BY-1.0",
    label: "ODC-BY 1.0",
    url: "https://opendatacommons.org/licenses/by/1-0/",
  },
} as const satisfies Record<string, LicenseInfo>;

/** Licence of the abstract text per abstract source (`none` has none). */
export const ABSTRACT_LICENSE: Readonly<Record<AbstractSource, LicenseInfo | null>> = {
  // arXiv ToU: descriptive metadata incl. the abstract is CC0 1.0.
  arxiv: LICENSES.cc0,
  // OpenReview ToU "Metadata Dedication": title/authors/abstract CC0 1.0.
  openreview: LICENSES.cc0,
  // ACL Anthology (2016+): CC BY 4.0 — attribution required.
  acl_anthology: LICENSES.ccBy4,
  // Semantic Scholar TLDR (machine-generated summary): ODC-BY 1.0.
  s2_tldr: LICENSES.odcBy,
  none: null,
};

/** Display name of a catalog row's native source (the paper-page link). */
export const SOURCE_LABEL: Readonly<Record<CatalogSource, string>> = {
  arxiv: "arXiv",
  openreview: "OpenReview",
  acl_anthology: "ACL Anthology",
  cvf: "CVF Open Access",
};

/** Display name of where an abstract text comes from. */
export const ABSTRACT_SOURCE_LABEL: Readonly<Record<AbstractSource, string>> = {
  arxiv: "arXiv",
  openreview: "OpenReview",
  acl_anthology: "ACL Anthology",
  s2_tldr: "Semantic Scholar TLDR（機械生成の要約）",
  none: "",
};

export function isCatalogSource(value: unknown): value is CatalogSource {
  return typeof value === "string" && Object.hasOwn(SOURCE_LABEL, value);
}

export function isAbstractSource(value: unknown): value is AbstractSource {
  return typeof value === "string" && (ABSTRACT_SOURCES as readonly string[]).includes(value);
}

/**
 * Abstract source a row's own abstract would have if published as-is, or
 * `null` when the native source grants no licence for it (CVF), so the
 * abstract must be replaced or withheld.
 */
export function nativeAbstractSource(source: string): AbstractSource | null {
  switch (source) {
    case "arxiv":
    case "openreview":
    case "acl_anthology":
      return source;
    default:
      // cvf (rights reserved, no licence) and anything unknown: fail closed.
      return null;
  }
}

/**
 * Short author credit: "Beltagy", "Beltagy & Peters", "Beltagy et al.".
 * Uses the last whitespace-separated token of each name as the surname.
 */
export function authorCredit(authors: readonly string[] | null | undefined): string {
  const names = (authors ?? []).map((a) => (typeof a === "string" ? a.trim() : "")).filter(Boolean);
  const surname = (name: string) => {
    const parts = name.split(/\s+/);
    return parts[parts.length - 1] ?? name;
  };
  if (names.length === 0) return "";
  if (names.length === 1) return surname(names[0] as string);
  if (names.length === 2) return `${surname(names[0] as string)} & ${surname(names[1] as string)}`;
  return `${surname(names[0] as string)} et al.`;
}
