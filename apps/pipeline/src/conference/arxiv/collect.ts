/**
 * `collect_conference` CLI entry point — TS port of
 * `paperpilot/scripts/collect_conference.py::main` (CNF-11, CNF-12,
 * CNF-13 of docs/migration/safety-contracts.md).
 *
 * The fetch/parse/filter machinery this collector's `main()` is built on
 * (`fetchArxivResultsChecked`, `buildArxivRows`, `oralTitlesFromArxiv`,
 * `writeOutputs`) lives in `../shared/` — a concurrently-developed module
 * this collector shares with the CVF/OpenReview collectors (see
 * `../shared/arxivOral.ts`'s module doc: "per the task brief, the
 * concurrently-developed arxiv/acl collectors share" it). This module
 * contributes the one thing specific to `collect_conference.py`: judging
 * the PRIMARY fetch's completeness/truncation (not an oral overlay's) and
 * the resulting CLI exit-code policy.
 */

import {
  type ArxivFetchDeps,
  buildArxivRows,
  type ConferenceRow,
  fetchArxivResultsChecked,
  parseCliArgs,
  type WriteOutputsDeps,
  writeOutputs,
} from "../shared/index.js";

export type { ConferenceRow };

export interface CollectConferenceMainDeps {
  arxiv: ArxivFetchDeps;
  /** REQUIRED — see `writeOutputs`'s module doc: the TS port never defaults to `paperpilot/output`. */
  outputRoot: string;
  now?: WriteOutputsDeps["now"];
  /** Defaults to `console.log`. */
  print?: (line: string) => void;
}

const ARG_SPEC = {
  conference: { type: "string", required: true } as const,
  venue: { type: "string", required: true } as const,
  query: { type: "string", required: true } as const,
  max: { type: "int", default: 800 } as const,
  "clear-oral": { type: "boolean" } as const,
};

/**
 * Runs the collector. Returns the process exit code (0 success, 1
 * refusal — malformed feed, `--max` window filled, or zero matched
 * papers). Usage errors throw `CliUsageError`. `IdentityError` /
 * `InvalidConferenceSlugError` from `writeOutputs` propagate rather than
 * being caught, matching the Python original.
 */
export async function runCollectConferenceMain(
  argv: readonly string[],
  deps: CollectConferenceMainDeps,
): Promise<number> {
  const args = parseCliArgs(argv, ARG_SPEC);
  const conference = args.conference as string;
  const venue = args.venue as string;
  const query = args.query as string;
  const max = args.max as number;
  const clearOral = Boolean(args["clear-oral"]);
  const print = deps.print ?? ((line: string) => console.log(line));

  const { results, complete } = await fetchArxivResultsChecked(query, max, deps.arxiv);
  const { rows, oralTitles } = buildArxivRows(results, venue);

  print(`scanned ${results.length} arXiv results for query: ${query}`);
  if (!complete) {
    // A malformed, skipped-entry or non-feed page was detected and the
    // fetch kept going, so entries are missing from the middle of the
    // window. Nothing here proves which papers were lost, so the fetched
    // set cannot be called a venue's full acceptance list — re-run instead.
    print(
      "⚠️  incomplete arXiv feed: a malformed, skipped-entry or non-feed page " +
        "was detected and the client kept going, so this fetch is missing " +
        "entries and the catalog would silently drop papers. Re-run the " +
        "collection. Nothing written.",
    );
    return 1;
  }
  if (results.length >= max) {
    // Same reasoning as the oral overlay's own window check: the scan is
    // newest-first and bounded, so a window that full proves nothing
    // about older acceptances. No opt-in override (same policy as the
    // OpenReview/CVF collectors, closes #388): a written
    // papers_<date>.csv carries no marker telling "complete" from
    // "partial", so there is no safe way to force-publish a truncated
    // window under the same schema.
    print(
      `⚠️  --max window truncated: the arXiv fetch returned the full ${max}-result ` +
        "window (newest first), so older acceptances are outside the scan and the " +
        `catalog would be partial. Raise --max above ${max} and re-run. Nothing written.`,
    );
    return 1;
  }
  if (rows.length === 0) {
    // Do NOT call writeOutputs: it would write a header-only CSV for
    // today's date and silently overwrite/mask an existing good catalog
    // file from an earlier run on the same day (closes #389).
    print(
      "⚠️  0 papers matched — VenueSignal needs an 'accepted to <venue>' " +
        "style comment; check --venue / --query. Nothing written.",
    );
    return 1;
  }

  const csvPath = writeOutputs(
    conference,
    rows,
    oralTitles,
    { outputRoot: deps.outputRoot, clearOral },
    { now: deps.now },
  );
  print(
    `✅ ${rows.length} genuine ${venue.toUpperCase()} papers ` +
      `(${oralTitles.length} oral/highlight) -> ${csvPath}`,
  );
  return 0;
}
