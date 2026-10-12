/**
 * R4-3 (design 48 P1-1 / P1-2): the theme page's optional side files.
 *
 *   /themes/<slug>/new-papers.json  -- "新着" list (theme-new-papers-v1)
 *   /themes/<slug>/feed.xml         -- the same list as an Atom feed
 *   /themes/<slug>/code-links.json  -- "コード" / "HF" badges (theme-code-links-v1)
 *
 * Both JSON files are telemetry-like extras, not part of the audited
 * lineage: a missing or malformed file hides the section (never an
 * error page), and every field is re-checked here before rendering (URLs
 * must be https and on the expected host, so a bad file cannot inject a
 * `javascript:` link). The slug is the already-validated theme slug.
 */
import { BASE_PATH } from "@paperpilot/core/site";
import { SLUG_RE } from "./themes-slug";

export interface NewPaperItem {
  id: string;
  title: string;
  publicationDate: string;
  authors: string[];
  authorsTruncated: boolean;
  venue: string;
  url: string;
  citesLineage: string[];
}

export interface ThemeNewPapers {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  minLineageCites: number;
  items: NewPaperItem[];
}

export interface CodeLink {
  arxivId: string;
  code: { url: string; stars: number | null; source: "huggingface-papers" | "paper_repos" } | null;
  hf: { url: string; upvotes: number; models: number; datasets: number; spaces: number } | null;
}

export type ThemeCodeLinks = Record<string, CodeLink>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GITHUB_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HF_RE = /^https:\/\/huggingface\.co\/papers\/\d{4}\.\d{4,5}$/;
const ITEM_URL_HOSTS = new Set(["doi.org", "arxiv.org", "openalex.org"]);

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function nonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** https URL on doi.org / arxiv.org / openalex.org, else null. */
export function safeItemUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && ITEM_URL_HOSTS.has(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseThemeNewPapers(raw: unknown): ThemeNewPapers | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== "theme-new-papers-v1" || !Array.isArray(o.items)) return null;
  const w = (o.window && typeof o.window === "object" ? o.window : {}) as Record<string, unknown>;
  const from = str(w.from);
  const to = str(w.to);
  const days = nonNegInt(w.days);
  const generatedAt = str(o.generated_at);
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || days === null || !generatedAt) {
    return null;
  }
  const items: NewPaperItem[] = [];
  for (const it of o.items) {
    if (!it || typeof it !== "object") continue;
    const x = it as Record<string, unknown>;
    const id = str(x.id);
    const title = str(x.title);
    const date = str(x.publication_date);
    const url = safeItemUrl(x.url);
    const cites = Array.isArray(x.cites_lineage)
      ? x.cites_lineage.filter((c): c is string => typeof c === "string")
      : [];
    if (!id || !title || !date || !DATE_RE.test(date) || !url || cites.length === 0) continue;
    items.push({
      id,
      title,
      publicationDate: date,
      authors: Array.isArray(x.authors)
        ? x.authors.filter((a): a is string => typeof a === "string").slice(0, 10)
        : [],
      authorsTruncated: x.authors_truncated === true,
      venue: str(x.venue) ?? "",
      url,
      citesLineage: cites,
    });
  }
  return {
    generatedAt,
    window: { from, to, days },
    minLineageCites: nonNegInt(o.min_lineage_cites) ?? 2,
    items,
  };
}

export function parseThemeCodeLinks(raw: unknown): ThemeCodeLinks | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== "theme-code-links-v1" || !o.nodes || typeof o.nodes !== "object") {
    return null;
  }
  const out: ThemeCodeLinks = {};
  for (const [id, v] of Object.entries(o.nodes as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const x = v as Record<string, unknown>;
    const arxivId = str(x.arxiv_id);
    if (!arxivId) continue;
    let code: CodeLink["code"] = null;
    if (x.code && typeof x.code === "object") {
      const c = x.code as Record<string, unknown>;
      const url = str(c.url);
      const source = c.source === "paper_repos" ? "paper_repos" : "huggingface-papers";
      if (url && GITHUB_RE.test(url)) code = { url, stars: nonNegInt(c.stars), source };
    }
    let hf: CodeLink["hf"] = null;
    if (x.hf && typeof x.hf === "object") {
      const h = x.hf as Record<string, unknown>;
      const url = str(h.url);
      if (url && HF_RE.test(url)) {
        hf = {
          url,
          upvotes: nonNegInt(h.upvotes) ?? 0,
          models: nonNegInt(h.models) ?? 0,
          datasets: nonNegInt(h.datasets) ?? 0,
          spaces: nonNegInt(h.spaces) ?? 0,
        };
      }
    }
    if (code || hf) out[id] = { arxivId, code, hf };
  }
  return out;
}

export function themeFeedPath(slug: string): string {
  return `${BASE_PATH}/themes/${slug}/feed.xml`;
}

async function fetchOptionalJson(path: string): Promise<unknown> {
  try {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** `null` when the file is missing/malformed or the slug is not valid. */
export async function fetchThemeNewPapers(slug: string): Promise<ThemeNewPapers | null> {
  if (!SLUG_RE.test(slug)) return null;
  return parseThemeNewPapers(
    await fetchOptionalJson(`${BASE_PATH}/themes/${slug}/new-papers.json`),
  );
}

export async function fetchThemeCodeLinks(slug: string): Promise<ThemeCodeLinks | null> {
  if (!SLUG_RE.test(slug)) return null;
  return parseThemeCodeLinks(
    await fetchOptionalJson(`${BASE_PATH}/themes/${slug}/code-links.json`),
  );
}

/** `1234` -> `1.2k`, `999` -> `999`. */
export function compactCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Which optional side files a manifest entry declares. Only a literal
 * `true` counts: missing / malformed flags mean "absent", so the page never
 * requests a file that is not there (a caught 404 still logs a console
 * error in browsers). */
export function sideFilesFromManifest(
  entry: { has_new_papers?: unknown; has_code_links?: unknown } | null | undefined,
): { newPapers: boolean; codeLinks: boolean } {
  return {
    newPapers: entry?.has_new_papers === true,
    codeLinks: entry?.has_code_links === true,
  };
}
