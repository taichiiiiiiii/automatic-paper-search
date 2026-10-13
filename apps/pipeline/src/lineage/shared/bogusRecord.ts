/**
 * R2-39: catalogue records that are not papers. Semantic Scholar sometimes
 * resolves a reference to an unrelated record with a generic title — the
 * NeurIPS 2025 lineage gained a node "Open Source" (2019, venue
 * "Definitions", one author: a Qeios definition entry) because S2 matched
 * ProRL's and Open-Reasoner-Zero's reference to DAPO ("… An Open-Source LLM
 * Reinforcement Learning System …") to it. Such a record must not become a
 * lineage node: its edges carry another paper's citation sentences.
 *
 * A record is bogus when it has no title, or a generic title (one or two
 * plain dictionary-shaped words, no acronym, digit or hyphenated name)
 * together with a weak record (no year, fewer than two authors, no venue,
 * or a reference-work venue such as "Definitions" / "Encyclopedia").
 * "Deep learning" (LeCun, Bengio, Hinton; Nature) stays, and so does a real
 * report that only lacks metadata ("The Claude 3 Model Family: Opus,
 * Sonnet, Haiku", no year / authors in S2).
 */

const PLAIN_WORD = /^[A-Za-z][a-z]+$/;
const REFERENCE_WORK_VENUE =
  /\b(?:definitions?|encyclop(?:a)?edia|dictionary|glossary|wikipedia|qeios)\b/i;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** One or two plain words ("Open Source", "Introduction"). */
export function isGenericTitle(title: string | null | undefined): boolean {
  const words = str(title)
    .replace(/[.:;,!?]+$/, "")
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 && words.length <= 2 && words.every((w) => PLAIN_WORD.test(w));
}

/** The record is not a usable paper (see the module comment). */
export function isBogusPaperRecord(paper: Record<string, unknown> | null | undefined): boolean {
  if (!paper) return true;
  const title = str(paper.title);
  if (title === "") return true;
  if (!isGenericTitle(title)) return false;
  const year = typeof paper.year === "number" && paper.year > 0 ? paper.year : null;
  const authors = Array.isArray(paper.authors) ? paper.authors.length : 0;
  const venue = str(paper.venue);
  return year === null || authors < 2 || venue === "" || REFERENCE_WORK_VENUE.test(venue);
}
