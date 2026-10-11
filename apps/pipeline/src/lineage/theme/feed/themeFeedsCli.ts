/**
 * R4-3 CLI: per-theme "new papers" feed (`new-papers.json` + `feed.xml`)
 * and code / Hugging Face badges (`code-links.json`) for the published
 * theme lineages.
 *
 *   pnpm exec tsx apps/pipeline/src/lineage/theme/feed/themeFeedsCli.ts \
 *     [--what all|new-papers|code-links] [--theme <slug> ...] [--days 30] \
 *     [--min-cites 2] [--max-pages 5] [--max-credits 40] [--max-items 50] \
 *     [--hf-max-requests 200] [--hf-ttl-days 7] [--no-topic-embedding] \
 *     [--now <ISO>] [--dry-run] [--repo-root <dir>]
 *
 * Workflow-ready, not scheduled (design 40 R4-3: scheduling is wired later
 * through the Worker cron). Network: OpenAlex (key from
 * `PAPERPILOT_OPENALEX_API_KEY`, budget breaker of `openalexGate.ts`; one
 * list credit per page, at most `--max-credits` pages per run) and the
 * Hugging Face Papers API (no key). No LLM.
 *
 * Writes, per theme in `themes-manifest.json` (or `--theme`):
 *   data/published/themes/<slug>/new-papers.json   (theme-new-papers-v1)
 *   data/published/themes/<slug>/feed.xml          (Atom 1.0)
 *   data/published/themes/<slug>/code-links.json   (theme-code-links-v1)
 *   data/state/hf-papers/papers.json               (HF answer cache)
 * Every document is schema-validated before it is written. A theme whose
 * OpenAlex fetch fails keeps its previous files (exit 4 at the end).
 * `lineage.json` is never touched (its sha256 is bound to the audit).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor, lineageCacheDir, paperRepos, themeAliases } from "@paperpilot/core/layout";
import { validateArtifact } from "@paperpilot/core/schemas";
import { installOpenAlexGate } from "../../../collect/http/openalexGate.js";
import type {
  FetchInit,
  FetchLike,
  HttpResponseLike,
} from "../../../collect/http/requestWithRetry.js";
import { CliUsageError, parseArgs as parseFlags } from "../../../shared/cli/argparse.js";
import { isMain } from "../../../shared/cli/isMain.js";
import {
  CachedTopicEmbedder,
  createTransformersEmbedder,
  type TopicEmbedder,
} from "../topicEmbedding.js";
import { TopicScope } from "../topicScope.js";
import { renderAtomFeed } from "./atom.js";
import {
  buildCodeLinks,
  CODE_LINKS_FILENAME,
  DEFAULT_HF_MAX_REQUESTS,
  DEFAULT_HF_TTL_DAYS,
  type HfCache,
  nodeArxivId,
  parseHfCache,
  refreshHfCache,
  serializeHfCache,
} from "./hfPapers.js";
import {
  buildNewPapers,
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_PAGES,
  DEFAULT_MIN_LINEAGE_CITES,
  DEFAULT_WINDOW_DAYS,
  FEED_FILENAME,
  type LineageArtifactLike,
  NEW_PAPERS_FILENAME,
  NewPapersFetchError,
} from "./newPapers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/theme/feed -> repo root (6 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..", "..");
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
export const EXIT_PARTIAL = 4;
export const DEFAULT_MAX_CREDITS = 40;
export const HF_CACHE_RELPATH = join("hf-papers", "papers.json");

export interface ThemeFeedsArgs {
  what: "all" | "new-papers" | "code-links";
  themes: string[];
  days: number;
  minCites: number;
  maxPages: number;
  maxCredits: number;
  maxItems: number;
  hfMaxRequests: number;
  hfTtlDays: number;
  topicEmbedding: boolean;
  now: string | null;
  dryRun: boolean;
  repoRoot: string;
}

export function parseThemeFeedsArgs(argv: readonly string[]): ThemeFeedsArgs {
  const p = parseFlags(argv, {
    what: { type: "string", default: "all", choices: ["all", "new-papers", "code-links"] },
    theme: { type: "repeated-string", default: [] },
    days: { type: "int", default: DEFAULT_WINDOW_DAYS },
    "min-cites": { type: "int", default: DEFAULT_MIN_LINEAGE_CITES },
    "max-pages": { type: "int", default: DEFAULT_MAX_PAGES },
    "max-credits": { type: "int", default: DEFAULT_MAX_CREDITS },
    "max-items": { type: "int", default: DEFAULT_MAX_ITEMS },
    "hf-max-requests": { type: "int", default: DEFAULT_HF_MAX_REQUESTS },
    "hf-ttl-days": { type: "int", default: DEFAULT_HF_TTL_DAYS },
    "no-topic-embedding": { type: "boolean" },
    now: { type: "string" },
    "dry-run": { type: "boolean" },
    "repo-root": { type: "string" },
  });
  const args: ThemeFeedsArgs = {
    what: p.what as ThemeFeedsArgs["what"],
    themes: (p.theme as string[]) ?? [],
    days: p.days as number,
    minCites: p["min-cites"] as number,
    maxPages: p["max-pages"] as number,
    maxCredits: p["max-credits"] as number,
    maxItems: p["max-items"] as number,
    hfMaxRequests: p["hf-max-requests"] as number,
    hfTtlDays: p["hf-ttl-days"] as number,
    topicEmbedding: !(p["no-topic-embedding"] as boolean),
    now: (p.now as string | undefined) ?? null,
    dryRun: Boolean(p["dry-run"]),
    repoRoot: resolve((p["repo-root"] as string | undefined) ?? DEFAULT_REPO_ROOT),
  };
  if (args.days < 1 || args.days > 366) throw new CliUsageError("--days must be 1..366");
  if (args.minCites < 1) throw new CliUsageError("--min-cites must be >= 1");
  if (args.maxPages < 1 || args.maxCredits < 0) {
    throw new CliUsageError("--max-pages must be >= 1 and --max-credits >= 0");
  }
  if (args.maxItems < 0 || args.maxItems > 200)
    throw new CliUsageError("--max-items must be 0..200");
  for (const t of args.themes) {
    if (!SLUG_RE.test(t)) throw new CliUsageError(`--theme: not a slug: ${JSON.stringify(t)}`);
  }
  if (args.now !== null && !Number.isFinite(Date.parse(args.now))) {
    throw new CliUsageError(`--now: not a date: ${JSON.stringify(args.now)}`);
  }
  return args;
}

/** Real `fetch` adapter (status, headers, lazy JSON with the timeout armed). */
export function nodeFetch(): FetchLike {
  return async (url: string, init: FetchInit): Promise<HttpResponseLike> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    return {
      status: resp.status,
      headers: resp.headers,
      json: async () => {
        try {
          return await resp.json();
        } finally {
          clearTimeout(timer);
        }
      },
    };
  };
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function assertValid(schema: string, doc: unknown, label: string): void {
  const res = validateArtifact(schema, doc);
  if (!res.ok) {
    const first = (res.errors ?? [])
      .slice(0, 3)
      .map((e) => `${e.instancePath} ${e.message}`)
      .join("; ");
    throw new Error(`${label}: ${schema} validation failed: ${first}`);
  }
}

export interface ThemeFeedsDeps {
  fetchImpl: FetchLike;
  /** OpenAlex-wrapped fetch (key + budget breaker). Defaults to `fetchImpl`. */
  openalexFetchImpl?: FetchLike;
  embedder: TopicEmbedder | null;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Themes to process: `--theme` values, else every manifest slug, that have a lineage file. */
export function resolveThemes(publishedDir: string, requested: readonly string[]): string[] {
  const manifestPath = join(publishedDir, "themes", "themes-manifest.json");
  let slugs: string[] = [];
  if (requested.length > 0) {
    slugs = [...requested];
  } else if (existsSync(manifestPath)) {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      slugs = raw
        .map((e) => (e && typeof e === "object" ? (e as { slug?: unknown }).slug : undefined))
        .filter((s): s is string => typeof s === "string" && SLUG_RE.test(s));
    }
  }
  return [...new Set(slugs)]
    .sort()
    .filter((s) => existsSync(join(publishedDir, "themes", s, "lineage.json")));
}

export async function runThemeFeeds(args: ThemeFeedsArgs, deps: ThemeFeedsDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const layout = layoutFor(args.repoRoot);
  const nowMs = args.now !== null ? Date.parse(args.now) : Date.now();
  const themes = resolveThemes(layout.published, args.themes);
  if (themes.length === 0) {
    log("theme-feeds: no theme with a lineage.json; nothing to do");
    return 0;
  }
  const doNew = args.what === "all" || args.what === "new-papers";
  const doCode = args.what === "all" || args.what === "code-links";
  let failed = 0;
  let creditsLeft = args.maxCredits;

  const hfCachePath = join(layout.state, HF_CACHE_RELPATH);
  let hfCache: HfCache | null = null;
  if (doCode) {
    hfCache = parseHfCache(
      existsSync(hfCachePath) ? (JSON.parse(readFileSync(hfCachePath, "utf8")) as unknown) : null,
    );
  }
  const reposPath = paperRepos(layout);
  const repos = existsSync(reposPath)
    ? (JSON.parse(readFileSync(reposPath, "utf8")) as Record<string, unknown>)
    : {};

  for (const slug of themes) {
    const themeDir = join(layout.published, "themes", slug);
    const artifact = JSON.parse(
      readFileSync(join(themeDir, "lineage.json"), "utf8"),
    ) as LineageArtifactLike;
    const theme = typeof artifact.meta?.theme === "string" ? artifact.meta.theme : slug;

    if (doNew) {
      const maxPages = Math.min(args.maxPages, creditsLeft);
      if (maxPages < 1) {
        log(`theme-feeds: ${slug}: new-papers skipped (run credit cap --max-credits reached)`);
        failed += 1;
      } else {
        try {
          const scope = TopicScope.forTheme(theme, {}, themeAliases(layout));
          const doc = await buildNewPapers(
            artifact,
            scope,
            args.topicEmbedding ? deps.embedder : null,
            {
              slug,
              nowMs,
              days: args.days,
              minLineageCites: args.minCites,
              maxPages,
              maxItems: args.maxItems,
            },
            {
              fetchImpl: deps.openalexFetchImpl ?? deps.fetchImpl,
              sleep: deps.sleep,
              logger: { warn: (m) => log(`  warn: ${m}`) },
            },
          );
          creditsLeft -= doc.stats.pages;
          assertValid("theme-new-papers-v1", doc, slug);
          const titles = new Map(
            artifact.nodes.map((n) => [n.id, typeof n.title === "string" ? n.title : ""]),
          );
          const atom = renderAtomFeed(doc, { titleOf: (id) => titles.get(id) || undefined });
          const s = doc.stats;
          log(
            `theme-feeds: ${slug}: new-papers window=${doc.window.from}..${doc.window.to} anchors=${doc.anchor_count} ` +
              `pages=${s.pages}${s.truncated ? " (truncated)" : ""} fetched=${s.fetched} ` +
              `below_min_cites=${s.below_min_cites} off_topic=${s.off_topic} kept=${s.kept} ` +
              `gate=${doc.topic_gate.method}`,
          );
          if (!args.dryRun) {
            writeAtomic(join(themeDir, NEW_PAPERS_FILENAME), `${JSON.stringify(doc, null, 2)}\n`);
            writeAtomic(join(themeDir, FEED_FILENAME), atom);
          }
        } catch (exc) {
          failed += 1;
          const why = exc instanceof NewPapersFetchError ? exc.message : String(exc);
          log(`theme-feeds: ${slug}: new-papers FAILED, previous files kept: ${why}`);
        }
      }
    }

    if (doCode && hfCache !== null) {
      const ids = artifact.nodes
        .map((n) => nodeArxivId(n as { id: string; arxiv_id?: unknown }))
        .filter((x): x is string => x !== null);
      const stats = await refreshHfCache(
        hfCache,
        ids,
        { nowMs, ttlDays: args.hfTtlDays, maxRequests: args.hfMaxRequests },
        {
          fetchImpl: deps.fetchImpl,
          sleep: deps.sleep,
          logger: { warn: (m) => log(`  warn: ${m}`) },
        },
      );
      const doc = buildCodeLinks(slug, artifact.nodes as never, hfCache, repos, nowMs);
      try {
        assertValid("theme-code-links-v1", doc, slug);
      } catch (exc) {
        failed += 1;
        log(`theme-feeds: ${slug}: code-links FAILED: ${String(exc)}`);
        continue;
      }
      const values = Object.values(doc.nodes);
      log(
        `theme-feeds: ${slug}: code-links arxiv=${ids.length} hf_requests=${stats.requested} ` +
          `(fresh=${stats.fresh} absent=${stats.absent} failed=${stats.failed}) ` +
          `code=${values.filter((v) => v.code).length} hf=${values.filter((v) => v.hf).length}`,
      );
      if (stats.failed > 0) failed += 1;
      if (!args.dryRun) {
        writeAtomic(join(themeDir, CODE_LINKS_FILENAME), `${JSON.stringify(doc, null, 2)}\n`);
      }
    }
  }
  if (doCode && hfCache !== null && !args.dryRun)
    writeAtomic(hfCachePath, serializeHfCache(hfCache));
  return failed > 0 ? EXIT_PARTIAL : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: ThemeFeedsArgs;
  try {
    args = parseThemeFeedsArgs(argv);
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const raw = nodeFetch();
  const { fetchImpl: openalexFetchImpl } = installOpenAlexGate(raw, { env: process.env });
  const layout = layoutFor(args.repoRoot);
  const embedder = args.topicEmbedding
    ? new CachedTopicEmbedder(
        createTransformersEmbedder({ modelCacheDir: join(lineageCacheDir(layout), "models") }),
        join(lineageCacheDir(layout), "embeddings"),
      )
    : null;
  return runThemeFeeds(args, { fetchImpl: raw, openalexFetchImpl, embedder });
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
