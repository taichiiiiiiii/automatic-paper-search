/**
 * Shared catalog CSV schema — TS port of `collect_conference.py::_CSV_COLUMNS`.
 * The four collectors (arXiv / OpenReview / CVF / ACL) all write this
 * exact column set, in this exact order, via {@link writeOutputs}.
 */
export const CSV_COLUMNS = [
  "title",
  "authors",
  "venue",
  "venue_tier",
  "citation_count",
  "github_stars",
  "arxiv_id",
  "abstract",
  "url",
  "pdf_url",
  "comment",
  "source",
  "source_id",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** A catalog row prior to the source/source_id identity projection `writeOutputs` performs. */
export type ConferenceRow = Record<string, unknown>;
