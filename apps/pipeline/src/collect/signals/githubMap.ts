/**
 * Curated arXiv-id -> GitHub-repo map loader — TS port of
 * `paperpilot/utils/github.py::load_curated_map` (OUT-25 of
 * docs/migration/safety-contracts.md).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ghRepoSlug } from "./payload.js";

// apps/pipeline/src/collect/signals/githubMap.ts -> repo root is 5 levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PAPER_REPOS_FILE = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "paperpilot",
  "data",
  "paper_repos.json",
);

/**
 * Reads `paper_repos.json` and returns `arxivId -> "owner/repo"`. The
 * `_meta` key is documentation and is filtered out. Malformed entries
 * (non-string values, missing slash, or an owner/name failing the slug
 * regex) are dropped silently so a typo never breaks the build. A missing
 * or corrupt file yields `{}`.
 */
export function loadCuratedMap(path: string = DEFAULT_PAPER_REPOS_FILE): Record<string, string> {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [ax, repo] of Object.entries(raw as Record<string, unknown>)) {
    if (ax.startsWith("_")) continue;
    if (ghRepoSlug(repo) === null) continue;
    out[ax] = repo as string;
  }
  return out;
}
