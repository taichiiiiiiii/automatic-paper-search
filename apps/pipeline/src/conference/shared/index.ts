/** Barrel for `conference/shared` — the pieces the openreview/cvf (and, per the
 * task brief, the concurrently-developed arxiv/acl) collectors share. */

export { InvalidConferenceSlugError, validateConferenceSlug } from "@paperpilot/core/slug";
export { venueTier } from "../../collect/signals/venue.js";
export {
  type ArxivAcceptedResult,
  type ArxivFetchDeps,
  type ArxivTextResponse,
  buildArxivRows,
  fetchArxivResultsChecked,
  ORAL_MALFORMED_FEED,
  ORAL_MAX_RESULTS_DEFAULT,
  ORAL_WINDOW_FILLED,
  type OralOverlay,
  oralTitlesFromArxiv,
} from "./arxivOral.js";
export { CliUsageError, type FlagSpec, type ParsedFlag, parseCliArgs } from "./cliArgs.js";
export { type ConferenceRow, CSV_COLUMNS, type CsvColumn } from "./csvColumns.js";
export {
  fetchImplWithTimeout,
  fetchTextWithTimeout,
  type TextResponse,
} from "./networkTimeout.js";
export { htmlUnescape, pyWhitespaceCollapse, stripTagsUnescapeCollapse } from "./pyText.js";
export { type WriteOutputsDeps, type WriteOutputsOptions, writeOutputs } from "./writeOutputs.js";
