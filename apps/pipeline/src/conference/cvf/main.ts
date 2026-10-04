/**
 * `collect_cvf` CLI entry point — TS port of
 * `paperpilot/scripts/collect_cvf.py::main` (CNF-03, CNF-04, CNF-14,
 * CNF-16 of docs/migration/safety-contracts.md).
 */

import {
  type ArxivFetchDeps,
  ORAL_MALFORMED_FEED,
  ORAL_MAX_RESULTS_DEFAULT,
  ORAL_WINDOW_FILLED,
  oralTitlesFromArxiv,
} from "../shared/arxivOral.js";
import { parseCliArgs } from "../shared/cliArgs.js";
import { type WriteOutputsDeps, writeOutputs } from "../shared/writeOutputs.js";
import { type CvfFetchDeps, type CvfLogger, collect } from "./fetch.js";

export interface CvfMainDeps {
  cvf: CvfFetchDeps;
  arxiv: ArxivFetchDeps;
  /** REQUIRED — see `writeOutputs`'s module doc. */
  outputRoot: string;
  now?: WriteOutputsDeps["now"];
  logger?: CvfLogger;
  /** Defaults to `console.log`. */
  print?: (line: string) => void;
}

const ARG_SPEC = {
  conference: { type: "string", required: true } as const,
  venue: { type: "string", required: true } as const,
  "cvf-id": { type: "string", required: true } as const,
  "max-workers": { type: "int", default: 8 } as const,
  "delay-seconds": { type: "float", default: 0.25 } as const,
  "oral-arxiv-query": { type: "string" } as const,
  "oral-max": { type: "int", default: ORAL_MAX_RESULTS_DEFAULT } as const,
  "clear-oral": { type: "boolean" } as const,
};

/**
 * Runs the collector. Returns the process exit code (0 success, 1 refusal
 * — incomplete fetch or zero papers). Usage errors throw `CliUsageError`.
 * Errors from `writeOutputs` (IdentityError / InvalidConferenceSlugError)
 * propagate rather than being caught, matching the Python original.
 */
export async function runCvfMain(argv: readonly string[], deps: CvfMainDeps): Promise<number> {
  const args = parseCliArgs(argv, ARG_SPEC);
  const conference = args.conference as string;
  const venue = args.venue as string;
  const cvfId = args["cvf-id"] as string;
  const maxWorkers = args["max-workers"] as number;
  const delaySeconds = args["delay-seconds"] as number;
  const oralArxivQuery = args["oral-arxiv-query"] as string | undefined;
  const oralMax = args["oral-max"] as number;
  const clearOral = Boolean(args["clear-oral"]);
  const print = deps.print ?? ((line: string) => console.log(line));

  const { rows, complete } = await collect(cvfId, venue, deps.cvf, {
    maxWorkers,
    delaySeconds,
    logger: deps.logger,
  });
  print(`collected ${rows.length} ${venue.toUpperCase()} papers from CVF ${cvfId}`);

  if (!complete) {
    // Same policy as collect_openreview (#388): a written papers_<date>.csv
    // carries no marker distinguishing an authoritative full catalog from
    // a partial one, so there is no safe way to publish a partial fetch
    // under the filename and schema the complete case uses. Retry the run
    // instead.
    print(
      `⚠️  the CVF fetch did not complete (listing unreadable, or one or ` +
        `more detail pages failed) — the ${rows.length} row(s) collected so far ` +
        "would be an INCOMPLETE, non-authoritative catalog. Nothing written. " +
        "Retry the run.",
    );
    return 1;
  }
  if (rows.length === 0) {
    print("⚠️  0 papers — check --cvf-id (e.g. 'CVPR2025'). Nothing written.");
    return 1;
  }

  let orals: string[] = [];
  let overlayIsKnown = true;
  if (oralArxivQuery) {
    const overlay = await oralTitlesFromArxiv(oralArxivQuery, venue, oralMax, deps.arxiv);
    overlayIsKnown = overlay.titles !== null;
    if (overlay.reason === ORAL_WINDOW_FILLED) {
      print(
        `⚠️  the oral overlay filled the --oral-max ${oralMax} window, so it ` +
          "was skipped: the existing oral_summaries_ja.md is kept as-is " +
          "(raise --oral-max above this window and re-run to refresh it)",
      );
    } else if (overlay.reason === ORAL_MALFORMED_FEED) {
      print(
        "⚠️  the oral overlay was skipped: arXiv returned a malformed feed, so " +
          "the fetched set is missing entries: the existing " +
          "oral_summaries_ja.md is kept as-is (re-run the collection later; " +
          "--clear-oral cannot clear what this run did not establish)",
      );
    } else {
      orals = overlay.titles ?? [];
    }
  }

  const csvPath = writeOutputs(
    conference,
    rows,
    orals,
    // An incomplete overlay is not evidence that the venue has no orals,
    // so it does not authorize removing the published list either.
    { outputRoot: deps.outputRoot, clearOral: clearOral && overlayIsKnown },
    { now: deps.now },
  );
  print(
    `✅ ${rows.length} accepted ${venue.toUpperCase()} papers (${orals.length} oral via arXiv) -> ${csvPath}`,
  );
  return 0;
}
