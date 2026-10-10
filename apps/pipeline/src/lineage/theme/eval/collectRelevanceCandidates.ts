/**
 * R2-4 (design doc 41 D4 / 42): collect the candidate pool for the topic-
 * relevance evaluation. NOT part of the generator; a one-off research
 * tool kept so the fixture can be rebuilt.
 *
 * For each of the four published themes it gathers
 *  - every node that ever appeared in `data/published/themes/<slug>/lineage.json`
 *    (all git versions — older drifted versions are good negatives), and
 *  - the depth-1 candidates the generator considers for every seed that
 *    ever appeared in `meta.seeds`: all `referenced_works` (the BFS
 *    parents pass reads up to 200) and the top `--cites` works citing the
 *    seed by `cited_by_count` (the descendants pass reads
 *    `max(width/2,4)*4 = 16` at the CI width of 8),
 * then fetches OpenAlex metadata (abstract, topics, concepts, keywords)
 * for all of them, plus OpenAlex topic/concept/keyword search hits for
 * each theme name, and every candidate's in-pool references
 * (`cites_in_pool`, for offline co-citation support). Responses are cached under `--cache-dir` (never in
 * the repo). Output: one pool JSON (`--out`), from which
 * `relevance-eval-v1.json` was sampled and hand-labelled.
 *
 *   pnpm exec tsx apps/pipeline/src/lineage/theme/eval/collectRelevanceCandidates.ts \
 *     --cache-dir /path/to/cache --mailto you@example.com --out pool.json [--cites 16]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenAlexApiKey } from "../../../collect/http/openalexGate.js";

/** R2-19: the OpenAlex key, when set, as a bearer header (never in the URL). */
function openalexAuthHeader(): Record<string, string> {
  const key = resolveOpenAlexApiKey(process.env);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export const EVAL_THEMES = [
  { slug: "graph-neural-network", theme: "Graph Neural Network" },
  { slug: "flash-attention", theme: "Flash Attention" },
  { slug: "mixture-of-experts", theme: "Mixture of Experts" },
  { slug: "vision-transformer", theme: "Vision Transformer" },
] as const;

const API = "https://api.openalex.org";
const WORK_SELECT = [
  "id",
  "doi",
  "ids",
  "display_name",
  "publication_year",
  "type",
  "cited_by_count",
  "abstract_inverted_index",
  "primary_topic",
  "topics",
  "concepts",
  "keywords",
].join(",");

interface Args {
  cacheDir: string;
  mailto: string;
  out: string;
  cites: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cacheDir = get("--cache-dir");
  const mailto = get("--mailto");
  const out = get("--out");
  if (!cacheDir || !mailto || !out) {
    throw new Error("usage: --cache-dir DIR --mailto EMAIL --out FILE [--cites N]");
  }
  return { cacheDir, mailto, out, cites: Number(get("--cites") ?? 16) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
let cacheHits = 0;

async function cachedGet(url: string, args: Args): Promise<unknown> {
  const key = createHash("sha1").update(url).digest("hex");
  const file = join(args.cacheDir, `${key}.json`);
  if (existsSync(file)) {
    cacheHits += 1;
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const full = `${url}${url.includes("?") ? "&" : "?"}mailto=${encodeURIComponent(args.mailto)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(150); // polite: < 10 req/s
    calls += 1;
    const resp = await fetch(full, {
      headers: { "User-Agent": "PaperPilot-eval/0.1", ...openalexAuthHeader() },
    });
    if (resp.status === 200) {
      const body = await resp.json();
      writeFileSync(file, JSON.stringify(body));
      return body;
    }
    if (resp.status === 404) return null;
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error(`OpenAlex failed: ${url}`);
}

export function shortId(id: string): string {
  return id.replace(/^openalex:/, "").replace(/^https:\/\/openalex\.org\//, "");
}

export function abstractFromInverted(inv: unknown): string {
  if (!inv || typeof inv !== "object") return "";
  const pos: [number, string][] = [];
  for (const [word, idxs] of Object.entries(inv as Record<string, number[]>)) {
    for (const i of idxs) pos.push([i, word]);
  }
  return pos
    .sort((a, b) => a[0] - b[0])
    .map((p) => p[1])
    .join(" ");
}

interface HistoryNode {
  id: string;
  title: string;
  versions: number;
  focus: boolean;
}

function gitHistory(slug: string): { seeds: Set<string>; nodes: Map<string, HistoryNode> } {
  const path = `data/published/themes/${slug}/lineage.json`;
  const shas = execFileSync("git", ["log", "--all", "--format=%H", "--", path])
    .toString()
    .split("\n")
    .filter(Boolean);
  const seeds = new Set<string>();
  const nodes = new Map<string, HistoryNode>();
  for (const sha of shas) {
    let doc: {
      meta?: { seeds?: string[] };
      nodes?: { id: string; title?: string; is_focus?: boolean }[];
    };
    try {
      doc = JSON.parse(
        execFileSync("git", ["show", `${sha}:${path}`], {
          stdio: ["ignore", "pipe", "ignore"],
        }).toString(),
      );
    } catch {
      continue;
    }
    for (const s of doc.meta?.seeds ?? []) seeds.add(s);
    for (const n of doc.nodes ?? []) {
      const prev = nodes.get(n.id);
      if (prev) {
        prev.versions += 1;
        prev.focus ||= n.is_focus === true;
      } else {
        nodes.set(n.id, {
          id: n.id,
          title: n.title ?? "",
          versions: 1,
          focus: n.is_focus === true,
        });
      }
    }
  }
  return { seeds, nodes };
}

async function fetchWorks(
  ids: string[],
  args: Args,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const uniq = [...new Set(ids.map(shortId))].sort();
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    const body = (await cachedGet(
      `${API}/works?filter=openalex_id:${batch.join("|")}&per-page=50&select=${WORK_SELECT}`,
      args,
    )) as { results?: Record<string, unknown>[] } | null;
    for (const w of body?.results ?? []) out.set(shortId(String(w.id)), w);
  }
  return out;
}

async function fetchReferencedWorks(ids: string[], args: Args): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const uniq = [...new Set(ids)].sort();
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    const body = (await cachedGet(
      `${API}/works?filter=openalex_id:${batch.join("|")}&per-page=50&select=id,referenced_works`,
      args,
    )) as { results?: { id: string; referenced_works?: string[] }[] } | null;
    for (const w of body?.results ?? [])
      out.set(shortId(w.id), (w.referenced_works ?? []).map(shortId));
  }
  return out;
}

function slimWork(w: Record<string, unknown>) {
  const topics = (w.topics as Record<string, unknown>[] | undefined) ?? [];
  const concepts = (w.concepts as Record<string, unknown>[] | undefined) ?? [];
  const keywords = (w.keywords as Record<string, unknown>[] | undefined) ?? [];
  const name = (x: unknown) => (x as { display_name?: string } | undefined)?.display_name ?? null;
  return {
    openalex: shortId(String(w.id)),
    doi: (w.doi as string | null) ?? null,
    arxiv: null as string | null,
    title: String(w.display_name ?? ""),
    year: (w.publication_year as number | null) ?? null,
    type: (w.type as string | null) ?? null,
    cited_by_count: Number(w.cited_by_count) || 0,
    abstract: abstractFromInverted(w.abstract_inverted_index),
    topics: topics.map((t) => ({
      id: shortId(String(t.id)),
      name: name(t),
      score: t.score as number,
      subfield: name(t.subfield),
      field: name(t.field),
    })),
    concepts: concepts.map((c) => ({
      id: shortId(String(c.id)),
      name: name(c),
      level: c.level as number,
      score: c.score as number,
    })),
    keywords: keywords.map((k) => ({ name: name(k), score: k.score as number })),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.cacheDir, { recursive: true });
  const pool: Record<string, unknown> = {};
  for (const { slug, theme } of EVAL_THEMES) {
    const { seeds, nodes } = gitHistory(slug);
    const sources = new Map<string, Set<string>>();
    const tag = (id: string, s: string) => {
      const k = shortId(id);
      if (!sources.has(k)) sources.set(k, new Set());
      sources.get(k)!.add(s);
    };
    for (const n of nodes.values()) tag(n.id, n.focus ? "history_focus" : "history");
    for (const seed of [...seeds].sort()) {
      const sid = shortId(seed);
      tag(sid, "seed");
      const work = (await cachedGet(`${API}/works/${sid}?select=id,referenced_works`, args)) as {
        referenced_works?: string[];
      } | null;
      for (const r of (work?.referenced_works ?? []).slice(0, 200)) tag(r, `ref_of:${sid}`);
      const cites = (await cachedGet(
        `${API}/works?filter=cites:${sid}&sort=cited_by_count:desc&per-page=${args.cites}&select=id`,
        args,
      )) as { results?: { id: string }[] } | null;
      for (const c of cites?.results ?? []) tag(c.id, `cites:${sid}`);
    }
    const works = await fetchWorks([...sources.keys()], args);
    // In-pool citation links, so the eval can recompute co-citation
    // support (`TopicScope.admits(paper, support)`) offline.
    const refsOf = await fetchReferencedWorks([...works.keys()], args);
    const inPool = new Set(works.keys());
    const q = encodeURIComponent(theme);
    const topicHits = await cachedGet(`${API}/topics?search=${q}&per-page=10`, args);
    const conceptHits = await cachedGet(`${API}/concepts?search=${q}&per-page=10`, args);
    const keywordHits = await cachedGet(`${API}/keywords?search=${q}&per-page=10`, args);
    const pick = (b: unknown) =>
      ((b as { results?: Record<string, unknown>[] } | null)?.results ?? []).map((r) => ({
        id: shortId(String(r.id)),
        name: r.display_name,
        works_count: r.works_count,
        subfield: (r.subfield as { display_name?: string } | undefined)?.display_name,
        level: r.level,
      }));
    pool[slug] = {
      theme,
      seeds: [...seeds].sort().map(shortId),
      openalex_search: {
        topics: pick(topicHits),
        concepts: pick(conceptHits),
        keywords: pick(keywordHits),
      },
      candidates: [...sources.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, src]) => {
          const w = works.get(id);
          return {
            ...(w
              ? slimWork(w)
              : { openalex: id, title: nodes.get(`openalex:${id}`)?.title ?? "" }),
            sources: [...src].sort(),
            cites_in_pool: (refsOf.get(id) ?? []).filter((r) => inPool.has(r) && r !== id).sort(),
            history_versions: nodes.get(`openalex:${id}`)?.versions ?? 0,
          };
        }),
    };
    process.stderr.write(`${slug}: ${seeds.size} seeds, ${sources.size} candidates\n`);
  }
  writeFileSync(args.out, `${JSON.stringify(pool, null, 1)}\n`);
  process.stderr.write(`openalex calls=${calls} cache_hits=${cacheHits}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`${String(e)}\n`);
    process.exit(1);
  });
}
