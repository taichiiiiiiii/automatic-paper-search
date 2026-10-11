/**
 * `collect-conference-site` entry point (R3-4, design 52 §8.6): a
 * listing-only conference catalog (titles, authors, links; no abstracts)
 * from an official conference listing that carries no shared paper id.
 *
 *   --kind proceedings     --site neurips|iclr  (papers.nips.cc / proceedings.iclr.cc; 1 request)
 *   --kind ecva                                   (www.ecva.net/papers.php; 1 request)
 *   --kind virtual-export  --site neurips|icml|iclr|eccv  (virtual site `Downloads/<year>` CSV)
 *
 * `virtual-export` is gated on `--allow-virtual-site` (design 52 D6: the
 * user decided D5=A = official proceedings, virtual site excluded; the
 * `/Downloads` export is allowed by robots.txt but its use is a separate
 * decision). It reads `--input <csv>` (downloaded by a human from the
 * Downloads page) or, without `--input`, performs the page's own form
 * submission once (GET for the CSRF token, then one POST; the server takes
 * ~2 minutes to build the NeurIPS file).
 *
 * Fail-closed like the other collectors: a fetch failure, any malformed
 * entry, or zero rows writes nothing and exits 1.
 */

import { readFileSync } from "node:fs";
import { writeSourceLicense } from "../proceedings/sourceLicense.js";
import { CliUsageError, parseCliArgs } from "../shared/cliArgs.js";
import { type WriteOutputsDeps, writeOutputs } from "../shared/writeOutputs.js";
import {
  ECVA_PAPERS_URL,
  PROCEEDINGS_SITES,
  type ProceedingsSite,
  parseEcvaListing,
  parseProceedingsSiteListing,
  parseVirtualSiteExport,
  proceedingsListingUrl,
  type SiteParseResult,
  siteRows,
  VIRTUAL_SITES,
  type VirtualSite,
  virtualDownloadsUrl,
} from "./parsers.js";

export interface SiteResponse {
  status: number;
  headers?: { get(name: string): string | null; getSetCookie?: () => string[] };
  text(): Promise<string>;
}

export interface SiteRequestInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface SiteMainDeps {
  fetch: (url: string, init?: SiteRequestInit) => Promise<SiteResponse>;
  /** REQUIRED — see `writeOutputs`'s module doc. */
  outputRoot: string;
  readFile?: (path: string) => string;
  now?: WriteOutputsDeps["now"];
  print?: (line: string) => void;
}

const ARG_SPEC = {
  conference: { type: "string", required: true } as const,
  venue: { type: "string", required: true } as const,
  kind: { type: "string", required: true } as const,
  year: { type: "int", required: true } as const,
  site: { type: "string" } as const,
  track: { type: "repeated-string" } as const,
  input: { type: "string" } as const,
  "allow-virtual-site": { type: "boolean" } as const,
};

export const SITE_KINDS = ["proceedings", "ecva", "virtual-export"] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

async function getText(url: string, deps: SiteMainDeps, retries = 2): Promise<string | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await deps.fetch(url);
      if (resp.status === 200) return await resp.text();
      if (resp.status === 404) return null;
    } catch {
      // retry below
    }
  }
  return null;
}

function cookiesOf(resp: SiteResponse): string {
  const raw = resp.headers?.getSetCookie?.() ?? [resp.headers?.get("set-cookie") ?? ""];
  return raw
    .flatMap((c) => c.split(/,(?=\s*[A-Za-z0-9_-]+=)/))
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.includes("="))
    .join("; ");
}

/** The Downloads page's own form submission (CSV of posters only). */
async function fetchVirtualExport(
  site: VirtualSite,
  year: number,
  deps: SiteMainDeps,
): Promise<string | null> {
  const url = virtualDownloadsUrl(site, year);
  const page = await deps.fetch(url);
  if (page.status !== 200) return null;
  const html = await page.text();
  const token = /name="csrfmiddlewaretoken" value="([^"]+)"/.exec(html)?.[1];
  if (!token) return null;
  const body = new URLSearchParams({
    csrfmiddlewaretoken: token,
    format: "0",
    posters: "on",
    resource: "0",
    submitaction: "Download Data",
  }).toString();
  const resp = await deps.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: url,
      Cookie: cookiesOf(page),
    },
    body,
  });
  if (resp.status !== 200) return null;
  return resp.text();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], flag: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new CliUsageError(`${flag} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Returns the process exit code (0 written, 1 refused). Usage errors throw `CliUsageError`. */
export async function runSiteMain(argv: readonly string[], deps: SiteMainDeps): Promise<number> {
  const args = parseCliArgs(argv, ARG_SPEC);
  const conference = args.conference as string;
  const venue = args.venue as string;
  const year = args.year as number;
  const kind = oneOf(args.kind, SITE_KINDS, "--kind");
  const print = deps.print ?? ((line: string) => console.log(line));

  let parsed: SiteParseResult | null = null;
  let source:
    | "neurips_proceedings"
    | "iclr_proceedings"
    | "ecva_open_access"
    | "virtual_site_export";
  let collection: string;
  let collectionUrl: string;
  let basis: string;

  if (kind === "proceedings") {
    const site = oneOf(args.site, Object.keys(PROCEEDINGS_SITES) as ProceedingsSite[], "--site");
    const requested = (args.track as string[] | undefined) ?? [];
    const tracks = new Set(requested.length > 0 ? requested : ["conference"]);
    collectionUrl = proceedingsListingUrl(site, year);
    const html = await getText(collectionUrl, deps);
    if (html === null) {
      print(`⚠️  ${collectionUrl} is not available (not published yet?). Nothing written.`);
      return 1;
    }
    parsed = parseProceedingsSiteListing(html, site, year, tracks);
    source = site === "neurips" ? "neurips_proceedings" : "iclr_proceedings";
    collection = `${site === "neurips" ? "NeurIPS" : "ICLR"} ${year} proceedings (${[...tracks].join(", ")})`;
    basis =
      site === "neurips"
        ? "Authors grant NeurIPS a non-exclusive licence only (nips.cc/FAQ/Copyright); no public licence for abstracts."
        : "proceedings.iclr.cc states no licence for the abstracts; titles, authors and links only.";
  } else if (kind === "ecva") {
    collectionUrl = ECVA_PAPERS_URL;
    const html = await getText(collectionUrl, deps);
    if (html === null) {
      print(`⚠️  could not fetch ${collectionUrl}. Nothing written.`);
      return 1;
    }
    parsed = parseEcvaListing(html, year);
    if (parsed === null) {
      print(`⚠️  ${collectionUrl} has no "ECCV ${year} Papers" section yet. Nothing written.`);
      return 1;
    }
    source = "ecva_open_access";
    collection = `ECVA open access, ECCV ${year}`;
    basis =
      "ECVA open access grants no licence (copyright retained by the authors / Springer); titles, authors and links only.";
  } else {
    if (!args["allow-virtual-site"]) {
      throw new CliUsageError(
        "--kind virtual-export needs --allow-virtual-site: using the virtual site's Downloads export " +
          "is pending user decision D6 (design 52 §8.6). D5=A covers official proceedings only.",
      );
    }
    const site = oneOf(args.site, Object.keys(VIRTUAL_SITES) as VirtualSite[], "--site");
    collectionUrl = virtualDownloadsUrl(site, year);
    const input = args.input as string | undefined;
    const csv = input
      ? (deps.readFile ?? ((p: string) => readFileSync(p, "utf-8")))(input)
      : await fetchVirtualExport(site, year, deps);
    if (csv === null) {
      print(`⚠️  could not download ${collectionUrl}. Nothing written.`);
      return 1;
    }
    parsed = parseVirtualSiteExport(csv, site, year);
    source = "virtual_site_export";
    collection = `${venue.toUpperCase()} ${year} virtual site (Downloads export, posters)`;
    basis =
      "The export's abstract column is not read: authors grant the conference a non-exclusive licence only; titles, authors and links only.";
  }

  const skipped = Object.entries(parsed.skipped)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  print(
    `parsed ${parsed.entries.length} papers from ${collectionUrl} ` +
      `(seen ${parsed.seen}, malformed ${parsed.malformed}${skipped ? `, ${skipped}` : ""})`,
  );
  if (parsed.malformed > 0) {
    print(
      `⚠️  ${parsed.malformed} entr${parsed.malformed === 1 ? "y" : "ies"} did not parse (layout change?) — ` +
        "the catalog would be incomplete. Nothing written.",
    );
    return 1;
  }
  if (parsed.entries.length === 0) {
    print("⚠️  0 papers. Nothing written.");
    return 1;
  }

  const rows = siteRows(parsed.entries, venue);
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
    source,
    collection,
    collection_url: collectionUrl,
    license: null,
    license_url: null,
    attribution:
      `Titles and authors from ${collection} (${collectionUrl}); copyright retained by the authors. ` +
      "Abstracts are not reproduced — follow the link to read them.",
    abstracts: "omitted",
    abstract_basis: `${basis} Design 51 B5 / 52 §8.6.`,
    paper_count: rows.length,
  });
  print(`✅ ${rows.length} ${venue.toUpperCase()} papers (listing only) -> ${csvPath}`);
  print(`   source/licence -> ${licensePath}`);
  return 0;
}
