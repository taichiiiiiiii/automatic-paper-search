/**
 * `collect_openreview` CLI entry point — TS port of
 * `paperpilot/scripts/collect_openreview.py::main` (CNF-01, CNF-02 of
 * docs/migration/safety-contracts.md).
 */

import type { RequestWithRetryDeps } from "../../collect/http/requestWithRetry.js";
import { parseCliArgs } from "../shared/cliArgs.js";
import { type WriteOutputsDeps, writeOutputs } from "../shared/writeOutputs.js";
import { buildRows } from "./buildRows.js";
import { fetchNotes } from "./fetchNotes.js";

export interface OpenreviewMainDeps {
  request: RequestWithRetryDeps;
  /** REQUIRED — see `writeOutputs`'s module doc: the TS port never defaults to `paperpilot/output`. */
  outputRoot: string;
  now?: WriteOutputsDeps["now"];
  /** Defaults to `console.log`. */
  print?: (line: string) => void;
}

const ARG_SPEC = {
  conference: { type: "string", required: true } as const,
  venue: { type: "string", required: true } as const,
  venueid: { type: "string", required: true } as const,
  "clear-oral": { type: "boolean" } as const,
};

/**
 * Runs the collector. Returns the process exit code (0 success, 1 refusal
 * — incomplete pagination or zero accepted papers). Usage errors (unknown
 * flag, missing required flag) throw `CliUsageError` instead of returning
 * a code — mirrors argparse's `SystemExit(2)`. An `IdentityError` /
 * `InvalidConferenceSlugError` from `writeOutputs` also propagates rather
 * than being caught here, matching the Python original (`main()` does not
 * wrap `write_outputs` in a try/except).
 */
export async function runOpenreviewMain(
  argv: readonly string[],
  deps: OpenreviewMainDeps,
): Promise<number> {
  const args = parseCliArgs(argv, ARG_SPEC);
  const conference = args.conference as string;
  const venue = args.venue as string;
  const venueid = args.venueid as string;
  const clearOral = Boolean(args["clear-oral"]);
  const print = deps.print ?? ((line: string) => console.log(line));

  const { notes, complete } = await fetchNotes(venueid, deps.request);
  const { rows, highlighted } = buildRows(notes, venue, venueid);
  print(`fetched ${notes.length} OpenReview notes for venueid: ${venueid}`);

  if (!complete) {
    // No opt-in override: a written papers_<date>.csv has no marker
    // distinguishing "authoritative full catalog" from "partial", so
    // there is no safe way to publish a partial fetch under the same
    // filename/schema the complete case uses (closes #388). Retry the run
    // instead.
    print(
      `⚠️  pagination did not reach a confirmed end (network/API failure, a ` +
        `malformed response, or hitting the max-pages guard) — ${notes.length} ` +
        "notes fetched so far would be an INCOMPLETE, non-authoritative " +
        "catalog. Nothing written. Retry the run.",
    );
    return 1;
  }

  if (rows.length === 0) {
    print(
      `⚠️  0 accepted ${venue.toUpperCase()} papers for venueid '${venueid}' ` +
        "— check --venueid (e.g. 'ICLR.cc/2025/Conference'). Nothing written.",
    );
    return 1;
  }

  const csvPath = writeOutputs(
    conference,
    rows,
    highlighted,
    { outputRoot: deps.outputRoot, clearOral },
    { now: deps.now },
  );
  print(
    `✅ ${rows.length} accepted ${venue.toUpperCase()} papers ` +
      `(${highlighted.length} oral/spotlight) -> ${csvPath}`,
  );
  return 0;
}
