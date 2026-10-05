/**
 * Curated arXiv-id -> GitHub-repo map loader — TS port of
 * `paperpilot/utils/github.py::load_curated_map` (OUT-25 of
 * docs/migration/safety-contracts.md).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor, paperRepos } from "@paperpilot/core/layout";
import { ghRepoSlug } from "./payload.js";

// apps/pipeline/src/collect/signals/githubMap.ts -> repo root is 5 levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const DEFAULT_PAPER_REPOS_FILE = paperRepos(layoutFor(DEFAULT_REPO_ROOT));

/**
 * Reads `paper_repos.json` and returns `arxivId -> "owner/repo"`. The
 * `_meta` key is documentation and is filtered out. Malformed entries
 * (non-string values, missing slash, or an owner/name failing the slug
 * regex) are dropped silently so a typo never breaks the build. A missing
 * file yields `{}` silently; an EXISTING but unreadable file (bad JSON,
 * an OSError reading it) also yields `{}` but WARNS first (collect LOW:
 * was silently ignored) — mirrors Python's `load_curated_map`, which logs
 * `"paper_repos.json unreadable (...); skipping curated layer"` on the
 * same two exception classes (`OSError`/`JSONDecodeError`).
 */
export function loadCuratedMap(
  path: string = DEFAULT_PAPER_REPOS_FILE,
  logger?: { warn: (msg: string) => void },
): Record<string, string> {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    logger?.warn(`paper_repos.json unreadable (${(e as Error).message}); skipping curated layer`);
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    logger?.warn(`paper_repos.json unreadable (${(e as Error).message}); skipping curated layer`);
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
