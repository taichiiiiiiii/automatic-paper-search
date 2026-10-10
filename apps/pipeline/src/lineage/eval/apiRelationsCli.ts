/**
 * R2-9 evaluation CLI: can public citation APIs replace the LLM relation
 * classifier? Harvests theme-lineage edges from the git history of
 * `data/published/themes/*\/lineage.json` and `docs/themes/*\/lineage.json`,
 * fetches the Semantic Scholar reference record (intents / contexts /
 * isInfluential) for every citing->cited pair, applies the API-only rules
 * of `apiRelations.ts` and prints coverage + agreement with the LLM labels.
 *
 *   pnpm exec tsx apps/pipeline/src/lineage/eval/apiRelationsCli.ts \
 *     [--cache DIR] [--broad N] [--out FILE] [--mailto ADDR]
 *
 * Network: api.semanticscholar.org (unauthenticated, <=1 req/s, exponential
 * backoff on 429) and api.openalex.org (citation confirmation only). Every
 * response is cached under --cache (default $R2_9_CACHE or
 * ~/.hermes/cache/scratch/r2-9-cache) so a re-run is offline. Evaluation
 * only: generation does not import this module.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMain } from "../../shared/cli/isMain.js";
import {
  type ApiClassification,
  classifyApiRelation,
  classifyApiRelationV2,
  coarse,
  confusion,
  llmToSimplified,
  type PairSignals,
} from "./apiRelations.js";

const FOCUS_THEMES = [
  "graph-neural-network",
  "mixture-of-experts",
  "vision-transformer",
  "flash-attention",
];
const S2 = "https://api.semanticscholar.org/graph/v1";
const OA = "https://api.openalex.org";

interface NodeLite {
  id: string;
  title: string;
  year: number | null;
  doi: string | null;
  arxiv: string | null;
  authors: string[];
  citationCount: number | null;
}
interface Label {
  relation: string;
  method: string | null;
  model: string | null;
  sha: string;
  date: string;
  rationale: string;
}
export interface HarvestedEdge {
  theme: string;
  src: string; // cited (older)
  dst: string; // citing (newer)
  labels: Label[];
  current: boolean;
  srcNode: NodeLite | null;
  dstNode: NodeLite | null;
}

// ---------------------------------------------------------------- harvest

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function nodeLite(n: Record<string, unknown>): NodeLite {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    id: String(n.id),
    title: String(n.title ?? ""),
    year: typeof n.year === "number" ? n.year : null,
    doi: str(n.doi),
    arxiv: str(n.arxiv_id) ?? str(n.arxiv),
    authors: Array.isArray(n.authors) ? n.authors.map(String) : [],
    citationCount: typeof n.citation_count === "number" ? n.citation_count : null,
  };
}

export function harvestEdges(): HarvestedEdge[] {
  const paths = [
    ...new Set(
      git(["log", "--all", "--name-only", "--format="])
        .split("\n")
        .filter((p) => /(data\/published|docs)\/themes\/[^/]+\/lineage\.json$/.test(p)),
    ),
  ].sort();
  const rows = new Map<string, HarvestedEdge>();
  const currentKeys = new Set<string>();
  for (const t of FOCUS_THEMES) {
    const a = JSON.parse(readFileSync(`data/published/themes/${t}/lineage.json`, "utf-8"));
    for (const e of a.edges) currentKeys.add(`${t}\u0000${e.src}\u0000${e.dst}`);
  }
  for (const p of paths) {
    const theme = p.split("/").at(-2) as string;
    const commits = git(["log", "--all", "--format=%h %ad", "--date=short", "--", p])
      .split("\n")
      .filter(Boolean);
    for (const line of commits) {
      const [sha, date] = line.split(" ") as [string, string];
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(git(["show", `${sha}:${p}`]));
      } catch {
        continue;
      }
      const nodes = new Map<string, NodeLite>();
      for (const n of (doc.nodes as Record<string, unknown>[]) ?? []) {
        nodes.set(String(n.id), nodeLite(n));
      }
      for (const e of (doc.edges as Record<string, unknown>[]) ?? []) {
        const src = String(e.src ?? e.source);
        const dst = String(e.dst ?? e.target);
        const key = `${theme}\u0000${src}\u0000${dst}`;
        let row = rows.get(key);
        if (!row) {
          row = {
            theme,
            src,
            dst,
            labels: [],
            current: currentKeys.has(key),
            srcNode: null,
            dstNode: null,
          };
          rows.set(key, row);
        }
        const prov = e.provenance as Record<string, unknown> | string | undefined;
        const cls =
          prov && typeof prov === "object"
            ? ((prov.classification as Record<string, unknown>) ?? {})
            : {};
        const label: Label = {
          relation: String(e.relation ?? e.rel),
          method: typeof prov === "string" ? prov : ((cls.method as string) ?? null),
          model: (cls.model as string) ?? null,
          sha,
          date,
          rationale: String(e.rationale ?? "").slice(0, 400),
        };
        if (
          !row.labels.some(
            (l) =>
              l.relation === label.relation &&
              l.method === label.method &&
              l.rationale === label.rationale,
          )
        ) {
          row.labels.push(label);
        }
        row.srcNode ??= nodes.get(src) ?? null;
        row.dstNode ??= nodes.get(dst) ?? null;
      }
    }
  }
  return [...rows.values()];
}

/** Newest LLM label of an edge (git log order is newest first). */
export function llmLabel(e: HarvestedEdge): Label | null {
  const llm = e.labels.filter((l) => l.method === "llm");
  return llm.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

// ---------------------------------------------------------------- http

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastS2 = 0;

async function cachedJson(
  cacheDir: string,
  url: string,
  init: { method?: string; body?: string; mailto?: string } = {},
): Promise<unknown> {
  const key = createHash("sha256")
    .update(`${init.method ?? "GET"} ${url} ${init.body ?? ""}`)
    .digest("hex");
  const file = join(cacheDir, "http", `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")).body;
  const isS2 = url.startsWith(S2);
  for (let attempt = 0; attempt < 10; attempt++) {
    if (isS2) {
      const wait = lastS2 + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      lastS2 = Date.now();
    }
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "user-agent": `paperpilot-r2-9-eval (mailto:${init.mailto ?? "paperpilot@example.com"})`,
      },
      body: init.body,
    });
    if (res.status === 429 || res.status >= 500) {
      const back = Math.min(2000 * 2 ** attempt, 60_000);
      process.stderr.write(`  ${res.status} on ${url.slice(0, 90)} — backoff ${back} ms\n`);
      await sleep(back);
      continue;
    }
    const body = res.status === 404 ? null : await res.json();
    if (res.status !== 200 && res.status !== 404) {
      throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(body).slice(0, 200)}`);
    }
    mkdirSync(join(cacheDir, "http"), { recursive: true });
    writeFileSync(file, JSON.stringify({ url, status: res.status, body }));
    return body;
  }
  throw new Error(`gave up after retries: ${url}`);
}

// ---------------------------------------------------------------- S2 resolution

const normTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

interface S2Paper {
  paperId: string;
  title?: string;
  year?: number;
  externalIds?: Record<string, string>;
  authors?: { authorId: string | null; name: string }[];
}

async function resolveS2(
  nodes: NodeLite[],
  cacheDir: string,
  mailto: string,
  titleMatchIds: ReadonlySet<string>,
): Promise<Map<string, S2Paper>> {
  const out = new Map<string, S2Paper>();
  const fields = "paperId,title,year,externalIds,authors";
  const tryBatch = async (pairs: [NodeLite, string][]) => {
    for (let i = 0; i < pairs.length; i += 400) {
      const chunk = pairs.slice(i, i + 400);
      const body = JSON.stringify({ ids: chunk.map(([, id]) => id) });
      const res = (await cachedJson(cacheDir, `${S2}/paper/batch?fields=${fields}`, {
        method: "POST",
        body,
        mailto,
      })) as (S2Paper | null)[];
      chunk.forEach(([n], k) => {
        const p = res?.[k];
        if (p?.paperId) out.set(n.id, p);
      });
    }
  };
  const sha = /^[0-9a-f]{40}$/;
  await tryBatch(nodes.filter((n) => sha.test(n.id)).map((n) => [n, n.id]));
  await tryBatch(
    nodes.filter((n) => !out.has(n.id) && n.arxiv).map((n) => [n, `ARXIV:${n.arxiv}`]),
  );
  await tryBatch(nodes.filter((n) => !out.has(n.id) && n.doi).map((n) => [n, `DOI:${n.doi}`]));
  // Title match costs one request per node under the shared
  // unauthenticated pool; only CITING papers need an S2 id (the cited side
  // is matched by title inside the citing paper's reference list).
  for (const n of nodes.filter((x) => !out.has(x.id) && x.title && titleMatchIds.has(x.id))) {
    const r = (await cachedJson(
      cacheDir,
      `${S2}/paper/search/match?query=${encodeURIComponent(n.title)}&fields=${fields}`,
      { mailto },
    )) as { data?: S2Paper[] } | null;
    const p = r?.data?.[0];
    if (p?.paperId && normTitle(p.title ?? "") === normTitle(n.title)) out.set(n.id, p);
  }
  return out;
}

interface S2Ref {
  intents?: string[] | null;
  contexts?: string[] | null;
  isInfluential?: boolean | null;
  citedPaper: S2Paper;
}

async function referencesOf(s2Id: string, cacheDir: string, mailto: string): Promise<S2Ref[]> {
  const fields = "paperId,title,year,externalIds,authors,intents,contexts,isInfluential";
  const all: S2Ref[] = [];
  let offset = 0;
  for (;;) {
    const r = (await cachedJson(
      cacheDir,
      `${S2}/paper/${s2Id}/references?fields=${fields}&limit=1000&offset=${offset}`,
      { mailto },
    )) as { data?: S2Ref[]; next?: number } | null;
    all.push(...(r?.data ?? []));
    if (!r?.next) break;
    offset = r.next;
  }
  return all;
}

async function openalexReferenced(
  ids: string[],
  cacheDir: string,
  mailto: string,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const shorts = ids.filter((i) => i.startsWith("openalex:")).map((i) => i.slice(9));
  for (let i = 0; i < shorts.length; i += 50) {
    const chunk = shorts.slice(i, i + 50);
    const r = (await cachedJson(
      cacheDir,
      `${OA}/works?filter=openalex_id:${chunk.join("|")}&select=id,referenced_works&per_page=50&mailto=${encodeURIComponent(mailto)}`,
    )) as { results?: { id: string; referenced_works?: string[] }[] } | null;
    for (const w of r?.results ?? []) {
      out.set(
        `openalex:${w.id.split("/").at(-1)}`,
        new Set((w.referenced_works ?? []).map((x) => `openalex:${x.split("/").at(-1)}`)),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- main

export interface EdgeResult {
  theme: string;
  src: string;
  dst: string;
  srcTitle: string;
  dstTitle: string;
  srcYear: number | null;
  dstYear: number | null;
  scope: "focus" | "broad";
  current: boolean;
  currentLabel: { relation: string; method: string | null } | null;
  llm: { relation: string; date: string; rationale: string } | null;
  s2Resolved: { citing: boolean; cited: boolean };
  openalexConfirms: boolean | null;
  signals: PairSignals;
  /** v1 rule set (first design, before the hand check). */
  api: ApiClassification;
  /** v2 rule set (recommended; revised after the hand check). */
  apiV2: ApiClassification;
}

function seededShuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

function pct(n: number, d: number): string {
  return d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`;
}

function parseArgs(argv: string[]) {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    cacheDir:
      get("--cache") ??
      process.env.R2_9_CACHE ??
      join(homedir(), ".hermes/cache/scratch/r2-9-cache"),
    broad: Number(get("--broad") ?? 300),
    out: get("--out"),
    mailto: get("--mailto") ?? "paperpilot-eval@users.noreply.github.com",
  };
}

export async function main(argv: string[]): Promise<number> {
  const opt = parseArgs(argv);
  mkdirSync(opt.cacheDir, { recursive: true });
  const all = harvestEdges().filter((e) => e.srcNode && e.dstNode);
  const focus = all.filter((e) => e.current || llmLabel(e) !== null);
  const rest = all.filter((e) => !(e.current || llmLabel(e) !== null));
  const broad = seededShuffle(rest, 20261010).slice(0, opt.broad);
  const edges = [
    ...focus.map((e) => ({ e, scope: "focus" as const })),
    ...broad.map((e) => ({ e, scope: "broad" as const })),
  ];
  process.stderr.write(
    `harvested ${all.length} edges; focus ${focus.length}, broad ${broad.length}\n`,
  );

  const nodeMap = new Map<string, NodeLite>();
  for (const { e } of edges) {
    nodeMap.set(e.src, e.srcNode as NodeLite);
    nodeMap.set(e.dst, e.dstNode as NodeLite);
  }
  const s2 = await resolveS2(
    [...nodeMap.values()],
    opt.cacheDir,
    opt.mailto,
    new Set(edges.map(({ e }) => e.dst)),
  );
  process.stderr.write(`S2 resolved ${s2.size}/${nodeMap.size} nodes\n`);
  const oaRefs = await openalexReferenced(
    [...new Set(edges.map(({ e }) => e.dst))],
    opt.cacheDir,
    opt.mailto,
  );

  const refCache = new Map<string, S2Ref[]>();
  const results: EdgeResult[] = [];
  let n = 0;
  for (const { e, scope } of edges) {
    n++;
    const citing = s2.get(e.dst);
    const cited = s2.get(e.src);
    let ref: S2Ref | undefined;
    if (citing) {
      if (!refCache.has(citing.paperId)) {
        let refs: S2Ref[] = [];
        try {
          refs = await referencesOf(citing.paperId, opt.cacheDir, opt.mailto);
        } catch (err) {
          process.stderr.write(`  references failed for ${citing.paperId}: ${String(err)}\n`);
        }
        refCache.set(citing.paperId, refs);
        if (refCache.size % 25 === 0)
          process.stderr.write(
            `  refs fetched for ${refCache.size} citing papers (${n}/${edges.length})\n`,
          );
      }
      const refs = refCache.get(citing.paperId) ?? [];
      const srcTitle = normTitle((e.srcNode as NodeLite).title);
      ref =
        refs.find((r) => cited && r.citedPaper?.paperId === cited.paperId) ??
        refs.find((r) => r.citedPaper?.title && normTitle(r.citedPaper.title) === srcTitle);
    }
    const citingAuthors = new Set(
      (citing?.authors ?? []).map((a) => a.authorId).filter((x): x is string => !!x),
    );
    const sharedAuthors = (ref?.citedPaper?.authors ?? cited?.authors ?? []).some(
      (a) => a.authorId && citingAuthors.has(a.authorId),
    );
    const signals: PairSignals = {
      found: ref !== undefined,
      intents: ref?.intents ?? [],
      contexts: ref?.contexts ?? [],
      isInfluential: ref ? (ref.isInfluential ?? null) : null,
      sharedAuthors,
      citingTitle: (e.dstNode as NodeLite).title,
    };
    const oa = oaRefs.get(e.dst);
    const llm = llmLabel(e);
    const cur = e.current ? (e.labels.find((l) => l.sha) ?? null) : null;
    results.push({
      theme: e.theme,
      src: e.src,
      dst: e.dst,
      srcTitle: (e.srcNode as NodeLite).title,
      dstTitle: (e.dstNode as NodeLite).title,
      srcYear: (e.srcNode as NodeLite).year,
      dstYear: (e.dstNode as NodeLite).year,
      scope,
      current: e.current,
      currentLabel: cur ? { relation: cur.relation, method: cur.method } : null,
      llm: llm ? { relation: llm.relation, date: llm.date, rationale: llm.rationale } : null,
      s2Resolved: { citing: !!citing, cited: !!cited },
      openalexConfirms: oa ? oa.has(e.src) : null,
      signals,
      api: classifyApiRelation(signals),
      apiV2: classifyApiRelationV2(signals),
    });
  }
  const outFile = opt.out ?? join(opt.cacheDir, "results.json");
  writeFileSync(outFile, JSON.stringify(results, null, 1));
  printReport(results);
  process.stderr.write(`wrote ${outFile}\n`);
  return 0;
}

export function printReport(results: EdgeResult[]): void {
  printCoverage(results);
  for (const v of ["api", "apiV2"] as const) printRules(results, v);
}

function printCoverage(results: EdgeResult[]): void {
  const log = (s = "") => process.stdout.write(`${s}\n`);
  for (const scope of ["focus", "broad", "all"] as const) {
    const rs = scope === "all" ? results : results.filter((r) => r.scope === scope);
    const found = rs.filter((r) => r.signals.found);
    const anyIntent = found.filter((r) => r.signals.intents.length > 0);
    const ctx = found.filter((r) => r.signals.contexts.length > 0);
    const infl = found.filter((r) => r.signals.isInfluential === true);
    log(`## coverage (${scope}, n=${rs.length})`);
    log(
      `  citing resolved in S2   ${pct(rs.filter((r) => r.s2Resolved.citing).length, rs.length)}`,
    );
    log(`  pair found in S2 refs   ${pct(found.length, rs.length)}`);
    log(
      `  any intent              ${pct(anyIntent.length, rs.length)} (of found ${pct(anyIntent.length, found.length)})`,
    );
    log(
      `  contexts present        ${pct(ctx.length, rs.length)} (of found ${pct(ctx.length, found.length)})`,
    );
    log(
      `  isInfluential           ${pct(infl.length, rs.length)} (of found ${pct(infl.length, found.length)})`,
    );
    log(
      `  shared authors          ${pct(rs.filter((r) => r.signals.sharedAuthors).length, rs.length)}`,
    );
    const oa = rs.filter((r) => r.openalexConfirms !== null);
    log(
      `  OpenAlex confirms cite  ${pct(oa.filter((r) => r.openalexConfirms).length, oa.length)} (n=${oa.length})`,
    );
    const intentDist: Record<string, number> = {};
    for (const r of found) {
      const k = [...r.signals.intents].sort().join("+") || "(none)";
      intentDist[k] = (intentDist[k] ?? 0) + 1;
    }
    log(`  intent combos           ${JSON.stringify(intentDist)}`);
  }
}

function printRules(results: EdgeResult[], v: "api" | "apiV2"): void {
  const log = (s = "") => process.stdout.write(`${s}\n`);
  log(`# rule set ${v === "api" ? "v1" : "v2"}`);
  for (const scope of ["focus", "broad", "all"] as const) {
    const rs = scope === "all" ? results : results.filter((r) => r.scope === scope);
    const ruleDist: Record<string, number> = {};
    for (const r of rs) ruleDist[r[v].rule] = (ruleDist[r[v].rule] ?? 0) + 1;
    log(`  ${scope} api rules               ${JSON.stringify(ruleDist)}`);
    const relDist: Record<string, number> = {};
    for (const r of rs) relDist[r[v].relation] = (relDist[r[v].relation] ?? 0) + 1;
    log(`  ${scope} api relations           ${JSON.stringify(relDist)}`);
  }
  const withLlm = results.filter((r) => r.llm);
  log(`## LLM label (rows) x API relation (cols), n=${withLlm.length}`);
  log(
    JSON.stringify(
      confusion(
        withLlm,
        (r) => r.llm?.relation ?? "",
        (r) => r[v].relation,
      ),
    ),
  );
  const both = withLlm.filter(
    (r) =>
      coarse(r[v].relation) !== "unknown" &&
      coarse(llmToSimplified(r.llm?.relation ?? "")) !== "unknown",
  );
  const agree = both.filter(
    (r) => coarse(r[v].relation) === coarse(llmToSimplified(r.llm?.relation ?? "")),
  );
  log(
    `## coarse inherit/not-inherit agreement where API has a typed signal: ${agree.length}/${both.length} = ${pct(agree.length, both.length)}`,
  );
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    },
  );
}
