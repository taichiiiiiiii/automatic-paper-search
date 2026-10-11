/**
 * `collect-pmlr` entry point: build a conference catalog from one PMLR
 * volume (design 52 §4.3: ICML 2026 = PMLR v306). See `./volume.ts` for the
 * source, identity and licence rules.
 *
 * Fail-closed like the other collectors: a fetch failure, a listing whose
 * paper blocks do not all parse, a paper without an OpenReview forum id, or
 * a duplicate id writes nothing and exits 1. Exactly two requests per run
 * (volume page + bibliography), so politeness needs no rate limiter.
 */

import { writeSourceLicense } from "../proceedings/sourceLicense.js";
import { parseCliArgs } from "../shared/cliArgs.js";
import type { ConferenceRow } from "../shared/csvColumns.js";
import { type WriteOutputsDeps, writeOutputs } from "../shared/writeOutputs.js";
import {
  buildPmlrRows,
  PMLR_AGREEMENT_URL,
  PMLR_BASE,
  PMLR_LICENSE,
  PMLR_LICENSE_URL,
  parseBibAbstracts,
  parseVolumeHtml,
} from "./volume.js";

export interface PmlrTextResponse {
  status: number;
  text(): Promise<string>;
}

export interface PmlrMainDeps {
  fetchText: (url: string) => Promise<PmlrTextResponse>;
  /** REQUIRED — see `writeOutputs`'s module doc. */
  outputRoot: string;
  now?: WriteOutputsDeps["now"];
  print?: (line: string) => void;
}

const ARG_SPEC = {
  conference: { type: "string", required: true } as const,
  venue: { type: "string", required: true } as const,
  volume: { type: "int", required: true } as const,
  "no-abstract": { type: "boolean" } as const,
};

async function fetchOk(url: string, deps: PmlrMainDeps, retries = 2): Promise<string | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await deps.fetchText(url);
      if (resp.status === 200) return await resp.text();
      if (resp.status === 404) return null;
    } catch {
      // retry below
    }
  }
  return null;
}

export function volumeUrl(volume: number): string {
  return `${PMLR_BASE}/v${volume}/`;
}

export function bibliographyUrl(volume: number): string {
  return `${PMLR_BASE}/v${volume}/assets/bib/bibliography.bib`;
}

/** Returns the process exit code (0 written, 1 refused). Usage errors throw `CliUsageError`. */
export async function runPmlrMain(argv: readonly string[], deps: PmlrMainDeps): Promise<number> {
  const args = parseCliArgs(argv, ARG_SPEC);
  const conference = args.conference as string;
  const venue = args.venue as string;
  const volume = args.volume as number;
  const includeAbstracts = !args["no-abstract"];
  const print = deps.print ?? ((line: string) => console.log(line));

  const html = await fetchOk(volumeUrl(volume), deps);
  if (html === null) {
    print(`⚠️  could not fetch ${volumeUrl(volume)}. Nothing written.`);
    return 1;
  }
  const rawBlocks = (html.match(/<div class="paper">/g) ?? []).length;
  const { entries, blockCount, malformed } = parseVolumeHtml(html, volume);
  print(`parsed ${entries.length}/${rawBlocks} papers from PMLR v${volume}`);
  if (rawBlocks === 0 || blockCount !== rawBlocks || malformed > 0) {
    print(
      `⚠️  ${rawBlocks - entries.length} paper block(s) on the PMLR v${volume} page did ` +
        "not parse (layout change?) — the catalog would be incomplete. Nothing written.",
    );
    return 1;
  }
  const noForum = entries.filter((e) => e.openreviewId === null);
  if (noForum.length > 0) {
    print(
      `⚠️  ${noForum.length} paper(s) have no OpenReview link (first: ${noForum[0]?.landingUrl}); ` +
        "rows are keyed by the OpenReview forum id, so they would be dropped. Nothing written.",
    );
    return 1;
  }
  const seen = new Set<string>();
  for (const e of entries) {
    const id = e.openreviewId as string;
    if (seen.has(id)) {
      print(`⚠️  OpenReview id ${id} appears twice in PMLR v${volume}. Nothing written.`);
      return 1;
    }
    seen.add(id);
  }

  let abstracts = new Map<string, string>();
  if (includeAbstracts) {
    const bib = await fetchOk(bibliographyUrl(volume), deps);
    if (bib === null) {
      print(`⚠️  could not fetch ${bibliographyUrl(volume)} (abstracts). Nothing written.`);
      return 1;
    }
    abstracts = parseBibAbstracts(bib, volume);
    const withAbstract = entries.filter((e) => (abstracts.get(e.key) ?? "") !== "").length;
    print(`abstracts: ${withAbstract}/${entries.length} from bibliography.bib`);
  }

  const rows: ConferenceRow[] = buildPmlrRows(entries, abstracts, venue, { includeAbstracts });
  const csvPath = writeOutputs(
    conference,
    rows,
    [],
    { outputRoot: deps.outputRoot },
    { now: deps.now },
  );
  const licensePath = writeSourceLicense(deps.outputRoot, {
    schema_version: "conference-source-license-v1",
    conference,
    source: "pmlr",
    collection: `PMLR Volume ${volume}`,
    collection_url: volumeUrl(volume),
    license: PMLR_LICENSE,
    license_url: PMLR_LICENSE_URL,
    attribution:
      `Title, authors and abstract: © the authors, from Proceedings of Machine Learning Research ` +
      `Volume ${volume} (${volumeUrl(volume)}), licensed CC BY 4.0. Abstract whitespace and ` +
      "BibTeX case-protection braces normalised.",
    abstracts: includeAbstracts ? "included" : "omitted",
    abstract_basis: includeAbstracts
      ? `PMLR publication agreement (${PMLR_AGREEMENT_URL}) grants the public CC BY 4.0 in each article; attribution must cite the proceedings and link the PMLR page (landing_urls).`
      : "omitted by --no-abstract",
    paper_count: rows.length,
    landing_urls: Object.fromEntries(entries.map((e) => [e.openreviewId as string, e.landingUrl])),
  });
  print(`✅ ${rows.length} ${venue.toUpperCase()} papers from PMLR v${volume} -> ${csvPath}`);
  print(`   licence/attribution -> ${licensePath}`);
  return 0;
}
