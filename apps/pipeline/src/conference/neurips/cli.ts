#!/usr/bin/env node
/**
 * Reconcile a published NeurIPS catalog with the official proceedings
 * listing (one request). Read-only: prints a JSON report, writes nothing
 * unless `--out` is given. See `./listing.ts` for scope.
 *
 *   pnpm exec tsx apps/pipeline/src/conference/neurips/cli.ts \
 *     --year 2024 --catalog data/published/neurips-2025/papers.json [--track conference] [--out report.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isMain } from "../../shared/cli/isMain.js";
import { CliUsageError, parseCliArgs } from "../shared/cliArgs.js";
import { listingUrl, parseNeuripsListing, reconcileWithCatalog } from "./listing.js";

const USER_AGENT = "PaperPilot/1.0 (+https://paperpilot.pages.dev; catalog reconciliation)";

export interface NeuripsReconcileDeps {
  fetchText: (url: string) => Promise<{ status: number; text(): Promise<string> }>;
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  print?: (line: string) => void;
}

const ARG_SPEC = {
  year: { type: "int", required: true } as const,
  catalog: { type: "string", required: true } as const,
  track: { type: "repeated-string" } as const,
  out: { type: "string" } as const,
};

/** 0 = report produced, 1 = listing unavailable/unparseable or empty for the chosen tracks. */
export async function runNeuripsReconcile(
  argv: readonly string[],
  deps: NeuripsReconcileDeps,
): Promise<number> {
  const args = parseCliArgs(argv, ARG_SPEC);
  const year = args.year as number;
  const tracks = new Set((args.track as string[] | undefined) ?? ["conference"]);
  const print = deps.print ?? ((l: string) => console.log(l));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));

  const resp = await deps.fetchText(listingUrl(year));
  if (resp.status !== 200) {
    print(`⚠️  ${listingUrl(year)} answered ${resp.status}. No report.`);
    return 1;
  }
  const { entries, malformed } = parseNeuripsListing(await resp.text(), year);
  if (malformed > 0) {
    print(`⚠️  ${malformed} listing entries did not parse (layout change?). No report.`);
    return 1;
  }
  const catalog = JSON.parse(readFile(args.catalog as string)) as unknown;
  const papers = Array.isArray(catalog)
    ? catalog
    : ((catalog as { papers?: unknown[] }).papers ?? []);
  const titles = papers
    .map((p) => (p as { title?: unknown }).title)
    .filter((t): t is string => typeof t === "string");
  const report = reconcileWithCatalog(entries, titles, year, tracks);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) (deps.writeFile ?? ((p, t) => writeFileSync(p, t)))(args.out as string, text);
  print(text.trimEnd());
  if (report.proceedings_count === 0) {
    print(
      `⚠️  no ${[...tracks].join("/")} papers on the ${year} listing yet (tracks seen: ${Object.keys(report.tracks).join(", ") || "none"}).`,
    );
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) {
  runNeuripsReconcile(process.argv.slice(2), {
    fetchText: (url) =>
      fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) }),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      if (e instanceof CliUsageError) {
        console.error(e.message);
        process.exitCode = 2;
        return;
      }
      throw e;
    });
}
