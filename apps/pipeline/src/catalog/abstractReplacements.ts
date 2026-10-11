/**
 * Licence-safe abstracts for the conference catalog (design doc 51 §4,
 * user decision D1=A, R2-26).
 *
 * CVF Open Access abstracts carry no licence ("all rights retained by the
 * authors"), so the catalog never publishes them. For each CVF row the
 * resolver (`resolveAbstractReplacementsCli.ts`) looks for, in order:
 *   1. the same paper's arXiv version (arXiv metadata incl. the abstract is
 *      CC0 1.0), matched conservatively by title AND author overlap;
 *   2. the Semantic Scholar TLDR (ODC-BY 1.0, shown as a machine summary);
 *   3. nothing — the row then shows title / authors / link only.
 * Its findings are cached per conference in
 * `<inputs>/<conf>/abstract_replacements.json`; `buildPages.ts` reads that
 * file through {@link applyAbstractPolicy}. A CVF row without an entry is
 * published without an abstract (fail closed), so a missing or partial
 * cache can only hide abstracts, never leak the CVF text.
 *
 * This module is pure (no I/O besides the JSON (de)serialisers' callers);
 * the matching rules are unit-tested in test/catalog/abstractReplacements.test.ts.
 */

import {
  ABSTRACT_LICENSE,
  type AbstractSource,
  nativeAbstractSource,
  proceedingsAbstractSource,
} from "@paperpilot/core/licensing";
import type { SourceLicense } from "../conference/proceedings/sourceLicense.js";

export const ABSTRACT_REPLACEMENTS_SCHEMA = "abstract-replacements-v1";
export const ABSTRACT_REPLACEMENTS_FILENAME = "abstract_replacements.json";

/** How a replacement was found (kept for audit). */
export type MatchVia = "arxiv_title_search" | "s2_external_id";

export interface AbstractReplacement {
  /** Catalog paper_id (40-hex identity hash). */
  paper_id: string;
  /** Catalog title, for human audit of the cache file. */
  title: string;
  kind: "arxiv" | "s2_tldr" | "none";
  /** kind=arxiv: the matched arXiv id (no version suffix). */
  arxiv_id?: string;
  /** kind=arxiv: the arXiv record's title (audit). */
  arxiv_title?: string;
  /** kind=arxiv: the arXiv abstract (CC0); kind=s2_tldr: the TLDR text. */
  text?: string;
  /** Semantic Scholar paperId, when S2 knew the paper. */
  s2_paper_id?: string;
  /** kind=arxiv: evidence of the match. */
  match?: { via: MatchVia; title_score: number; author_overlap: number };
  /**
   * kind=none: resolver steps already run for this row ("arxiv_title",
   * "s2", "s2_match"), so a resumed run skips them.
   */
  checked?: string[];
}

export interface AbstractReplacementsFile {
  schema_version: typeof ABSTRACT_REPLACEMENTS_SCHEMA;
  conference: string;
  generated_at: string;
  counts: { arxiv: number; s2_tldr: number; none: number };
  papers: AbstractReplacement[];
}

// ---- matching -------------------------------------------------------------

/** NFKC, lower-case, ASCII-fold, every non-alphanumeric run -> one space. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleTokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(" ").filter(Boolean));
}

/** Greek letters and symbols that LaTeX titles spell as commands. */
const SYMBOL_NAMES: Record<string, string> = {
  α: "alpha",
  β: "beta",
  γ: "gamma",
  δ: "delta",
  ε: "epsilon",
  ϵ: "epsilon",
  ζ: "zeta",
  η: "eta",
  θ: "theta",
  ι: "iota",
  κ: "kappa",
  λ: "lambda",
  μ: "mu",
  ν: "nu",
  ξ: "xi",
  π: "pi",
  ρ: "rho",
  σ: "sigma",
  τ: "tau",
  υ: "upsilon",
  φ: "phi",
  ϕ: "phi",
  χ: "chi",
  ψ: "psi",
  ω: "omega",
  ℓ: "ell",
  "∞": "infty",
  "∇": "nabla",
  "∂": "partial",
};
/** LaTeX commands that only format their argument (dropped, argument kept). */
const LATEX_FORMAT_RE =
  /\\(?:text|textit|textbf|textsc|texttt|emph|underline|mathbf|mathrm|mathit|mathsf|mathtt|mathbb|mathcal|mathfrak|boldsymbol|bm|operatorname)\b/g;

/**
 * R3-5: title key that ignores LaTeX markup, so `$\gamma-$MoD` (proceedings)
 * equals `γ-MoD` (DBLP / arXiv) and `$\ell_p$` equals `ℓp`: formatting
 * commands are dropped, other commands keep their name (`\Delta` ->
 * `delta`), Greek letters are spelled out, and every non-alphanumeric
 * character (incl. spaces, `$`, `^`, `_`, braces) is removed.
 */
export function compactTitleKey(title: string): string {
  let s = title.replace(LATEX_FORMAT_RE, "").replace(/\\([A-Za-z]+)/g, " $1 ");
  // Spell symbols out before NFKC, which would fold `ℓ` to `l`.
  s = [...s.toLowerCase()].map((ch) => SYMBOL_NAMES[ch] ?? ch).join("");
  return s
    .normalize("NFKC")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 1 for equal normalised titles (or titles equal once LaTeX markup is
 * ignored), otherwise the token Jaccard similarity.
 */
export function titleScore(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ca = compactTitleKey(a);
  if (ca.length >= 8 && ca === compactTitleKey(b)) return 1;
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Surname key: last name token, diacritics folded, letters only. */
export function surnameKey(name: string): string {
  const parts = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[\s,]+/u)
    .map((p) => p.replace(/[^\p{L}]+/gu, ""))
    .filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Share of the shorter author list whose surname also appears in the
 * other list (0 when either list is empty).
 */
export function authorOverlap(a: readonly string[], b: readonly string[]): number {
  const ka = [...new Set(a.map(surnameKey).filter(Boolean))];
  const kb = new Set(b.map(surnameKey).filter(Boolean));
  if (ka.length === 0 || kb.size === 0) return 0;
  const inter = ka.filter((k) => kb.has(k)).length;
  return inter / Math.min(ka.length, kb.size);
}

export interface MatchCandidate {
  title: string;
  authors: readonly string[];
}

/** Title threshold for a candidate found by title search alone. */
export const TITLE_MATCH_MIN = 0.9;
/** Title threshold when Semantic Scholar already linked the two records. */
export const LINKED_TITLE_MATCH_MIN = 0.5;
/** Author overlap required in both cases. */
export const AUTHOR_OVERLAP_MIN = 0.5;

/**
 * Conservative "same paper" test between a catalog row and an arXiv
 * record. A title-search hit needs a (near-)identical title; a record
 * Semantic Scholar already linked (externalIds.ArXiv on the S2 record
 * whose title equals the catalog title) may carry a retitled arXiv
 * version, so it needs only half the title tokens. Both always need at
 * least half the authors (and at least one) in common.
 */
export function judgeArxivMatch(
  catalog: MatchCandidate,
  arxiv: MatchCandidate,
  via: MatchVia,
): { ok: boolean; title_score: number; author_overlap: number } {
  const ts = titleScore(catalog.title, arxiv.title);
  const ao = authorOverlap(catalog.authors, arxiv.authors);
  const minTitle = via === "s2_external_id" ? LINKED_TITLE_MATCH_MIN : TITLE_MATCH_MIN;
  return {
    ok: ts >= minTitle && ao >= AUTHOR_OVERLAP_MIN,
    title_score: Math.round(ts * 1000) / 1000,
    author_overlap: Math.round(ao * 1000) / 1000,
  };
}

// ---- policy (used by buildPages) ------------------------------------------

export interface PublishedAbstract {
  /** Full text to publish (detail shard); `""` when withheld. */
  abstract: string;
  abstract_source: AbstractSource;
  /** SPDX-style licence id of the text, `""` when withheld. */
  abstract_license: string;
  /** arXiv id of a matched arXiv version, when one was used. */
  arxiv_id?: string;
}

/**
 * What a conference's `source_license.json` says about its abstracts
 * (R3-3). `abstract_source: null` = the collector records no licence
 * (rights reserved), so even rows whose URL looks licensed fail closed.
 */
export interface CollectionAbstractPolicy {
  abstract_source: AbstractSource | null;
  /** `source_id` -> per-paper proceedings page (PMLR), for attribution. */
  landing_urls: Readonly<Record<string, string>>;
}

/**
 * Turn a collector's sidecar into the abstract policy for its rows, or
 * `null` when it says nothing about abstract text (`abstracts: "omitted"`,
 * e.g. CVF `--listing-only`). Throws when it declares a licence the
 * catalog has no source for, or one that disagrees with
 * `@paperpilot/core/licensing` — fail closed instead of mislabelling.
 */
export function collectionAbstractPolicy(
  license: SourceLicense | null,
): CollectionAbstractPolicy | null {
  if (license === null || license.abstracts !== "included") return null;
  const landing_urls = license.landing_urls ?? {};
  if (license.license === null) return { abstract_source: null, landing_urls };
  const source = proceedingsAbstractSource(license.source);
  if (source === null) {
    throw new Error(
      `source_license.json (${license.conference}): no abstract source for licensed collector "${license.source}"`,
    );
  }
  const expected = ABSTRACT_LICENSE[source]?.id;
  if (expected !== license.license) {
    throw new Error(
      `source_license.json (${license.conference}): ${license.source} declares ${license.license}, the catalog expects ${expected}`,
    );
  }
  return { abstract_source: source, landing_urls };
}

/**
 * Decide which abstract text a catalog row may publish. Rows whose native
 * source licenses its abstract (arXiv / OpenReview: CC0, ACL Anthology:
 * CC BY 4.0) keep it; any other source (CVF, unknown) takes the cached
 * replacement or publishes none. When the conference was collected from
 * official proceedings, `collection` (its `source_license.json`) names
 * the real source and licence of that text instead of the row URL (R3-3:
 * PMLR rows carry an OpenReview URL but PMLR's CC BY 4.0 abstract).
 */
export function applyAbstractPolicy(
  source: string,
  nativeAbstract: string,
  replacement: AbstractReplacement | undefined,
  collection: CollectionAbstractPolicy | null = null,
): PublishedAbstract {
  let native = nativeAbstractSource(source);
  if (native !== null && collection !== null) native = collection.abstract_source;
  if (native !== null) {
    return {
      abstract: nativeAbstract,
      abstract_source: native,
      abstract_license: ABSTRACT_LICENSE[native]?.id ?? "",
    };
  }
  const text = (replacement?.text ?? "").trim();
  if (replacement?.kind === "arxiv" && text && replacement.arxiv_id) {
    return {
      abstract: text,
      abstract_source: "arxiv",
      abstract_license: ABSTRACT_LICENSE.arxiv?.id ?? "",
      arxiv_id: replacement.arxiv_id,
    };
  }
  if (replacement?.kind === "s2_tldr" && text) {
    return {
      abstract: text,
      abstract_source: "s2_tldr",
      abstract_license: ABSTRACT_LICENSE.s2_tldr?.id ?? "",
    };
  }
  return { abstract: "", abstract_source: "none", abstract_license: "" };
}

const PAPER_ID_RE = /^[0-9a-f]{40}$/;

/**
 * Parse a replacements file into a paper_id map. Throws on a malformed
 * file (a broken cache must not silently turn into "no replacements" —
 * that would be safe, but would hide every abstract without notice).
 */
export function parseAbstractReplacements(raw: unknown): Map<string, AbstractReplacement> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("abstract replacements: file must be an object");
  }
  const file = raw as Partial<AbstractReplacementsFile>;
  if (file.schema_version !== ABSTRACT_REPLACEMENTS_SCHEMA) {
    throw new Error(
      `abstract replacements: schema_version must be ${ABSTRACT_REPLACEMENTS_SCHEMA}`,
    );
  }
  if (!Array.isArray(file.papers))
    throw new Error("abstract replacements: papers must be an array");
  const out = new Map<string, AbstractReplacement>();
  for (const [i, row] of file.papers.entries()) {
    if (!row || typeof row !== "object") throw new Error(`abstract replacements: row ${i} invalid`);
    const r = row as AbstractReplacement;
    if (!PAPER_ID_RE.test(r.paper_id ?? "")) {
      throw new Error(`abstract replacements: row ${i} has an invalid paper_id`);
    }
    if (r.kind !== "arxiv" && r.kind !== "s2_tldr" && r.kind !== "none") {
      throw new Error(`abstract replacements: row ${i} has an invalid kind`);
    }
    if (r.kind === "arxiv" && !/^\d{4}\.\d{4,5}$/.test(r.arxiv_id ?? "")) {
      throw new Error(`abstract replacements: row ${i} (arxiv) has an invalid arxiv_id`);
    }
    if (out.has(r.paper_id)) throw new Error(`abstract replacements: duplicate ${r.paper_id}`);
    out.set(r.paper_id, r);
  }
  return out;
}

/** Deterministic serialisation (rows sorted by paper_id, counts recomputed). */
export function serializeAbstractReplacements(
  conference: string,
  generatedAt: string,
  rows: Iterable<AbstractReplacement>,
): string {
  const papers = [...rows].sort((a, b) => (a.paper_id < b.paper_id ? -1 : 1));
  const counts = { arxiv: 0, s2_tldr: 0, none: 0 };
  for (const r of papers) counts[r.kind]++;
  const file: AbstractReplacementsFile = {
    schema_version: ABSTRACT_REPLACEMENTS_SCHEMA,
    conference,
    generated_at: generatedAt,
    counts,
    papers,
  };
  return `${JSON.stringify(file, null, 1)}\n`;
}
