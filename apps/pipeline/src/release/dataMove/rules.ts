/**
 * The data-move rule table — docs/migration/p5-plan.md §5.1/§5.2 (changeset
 * A9). Classifies every path `git ls-files` reports today into exactly one
 * of four classes:
 *
 *  - `move`: `git mv <path> <dest>` as-is, byte-identical.
 *  - `stay`: untouched (outside the three roots the cutover commit B
 *    restructures, or explicitly a Python-only/doc file the plan keeps in
 *    place until tier C).
 *  - `delete`: `git rm <path>`. `docs/daily/papers.json` additionally
 *    requires the caller to pass `--confirm-delete docs/daily/papers.json`
 *    (§9.3: "previous deletion was blocked by an automatic check, so a
 *    human must confirm every time").
 *  - `moveEdit`: move AND rewrite a bounded set of `allowedKeys` (dotted
 *    YAML paths) in the file's text — never a wholesale regeneration, so
 *    every other byte (including comments) is preserved.
 *
 * Only `docs/`, `paperpilot/data/`, `paperpilot/output/` and the two
 * collector config files + `.env.example` are "managed": every path under
 * those roots MUST match one of the specific rules below, or
 * {@link classifyPath} throws {@link UnmappedPathError} — a new/unexpected
 * file under a managed root is a loud planning failure, never a silent
 * `stay`. Everything else in the repository (apps/, packages/, schemas/,
 * .github/, the rest of paperpilot/) is outside those roots and defaults to
 * `stay`, which is what lets `plan` run against the whole repo's
 * `git ls-files` instead of a pre-filtered subset.
 *
 * Destinations are built from {@link relLayout}("p5") — never a literal
 * `"data/published"` etc. — so this table only has to change if the plan's
 * target layout itself changes, not if `@paperpilot/core/layout` does.
 */

import { relLayout } from "@paperpilot/core/layout";

export type RuleClass = "move" | "stay" | "delete" | "moveEdit";

/** One textual substitution inside a `moveEdit` file: `key` is a dotted YAML path, matched against an exact `oldValue` so drift is caught loudly instead of silently no-op'd. */
export interface ConfigEdit {
  readonly key: string;
  readonly oldValue: string;
  readonly newValue: string;
}

export interface MoveEntry {
  readonly path: string;
  readonly class: "move";
  readonly dest: string;
}
export interface StayEntry {
  readonly path: string;
  readonly class: "stay";
}
export interface DeleteEntry {
  readonly path: string;
  readonly class: "delete";
  /** Set only for `docs/daily/papers.json` — `apply` refuses this entry unless `--confirm-delete` names this exact path. */
  readonly requiresConfirmDelete?: string;
}
export interface MoveEditEntry {
  readonly path: string;
  readonly class: "moveEdit";
  readonly dest: string;
  readonly allowedKeys: readonly string[];
  readonly edits: readonly ConfigEdit[];
}

export type RuleEntry = MoveEntry | StayEntry | DeleteEntry | MoveEditEntry;

export class UnmappedPathError extends Error {
  constructor(public readonly path: string) {
    super(`unmapped path under a managed root: ${path}`);
  }
}

function parts(path: string): string[] {
  return path.split("/");
}

// ---------------------------------------------------------------------------
// docs/
// ---------------------------------------------------------------------------

const DOCS_STAY_DIRS = new Set(["design", "research", "migration"]);
const DOCS_EXCLUDED_CONF_DIRS = new Set([
  "assets",
  "how-it-works",
  "lineage",
  "themes",
  "design",
  "research",
  "migration",
  "daily",
]);
const HEAD_ASSETS = new Set(["favicon.svg", "favicon-32.png", "og-image.png"]);
const TOP_LEVEL_LEGACY_FILES = new Set(["index.html", "404.html", "sitemap.xml"]);
const TOP_LEVEL_PUBLISHED_FILES = new Set([
  "conferences.json",
  "identity-aliases-v1.json",
  "lineage-quality-v1.json",
  "search-index-v2.json",
  "lineage-pilot-index-v1.json",
]);
const LEGACY_CONF_BASENAMES = new Set([
  "index.html",
  "paper-links.html",
  "lineage.html",
  "deep.html",
]);
const PUBLISHED_CONF_BASENAMES = new Set(["papers.json", "lineage.json"]);
const DEEP_JSON_RE = /^deep-.*\.json$/;

function classifyDocs(p: readonly string[], full: string): RuleEntry | undefined {
  const rel = relLayout("p5");

  if (full === "docs/daily/papers.json") {
    return { path: full, class: "delete", requiresConfirmDelete: "docs/daily/papers.json" };
  }
  if (full === "docs/search-index.json") {
    return { path: full, class: "delete" };
  }
  if (p.length >= 2 && DOCS_STAY_DIRS.has(p[1] as string)) {
    return { path: full, class: "stay" };
  }
  if (full === "docs/QWEN_IMPLEMENTER.md") {
    return { path: full, class: "stay" };
  }
  if (p.length === 3 && p[1] === "assets" && HEAD_ASSETS.has(p[2] as string)) {
    return { path: full, class: "move", dest: `apps/web/static/assets/${p[2]}` };
  }
  if (p.length >= 2 && p[1] === "assets" && p.length >= 3) {
    return { path: full, class: "move", dest: `${rel.legacySite}/assets/${p.slice(2).join("/")}` };
  }
  if (p.length === 2 && TOP_LEVEL_LEGACY_FILES.has(p[1] as string)) {
    return { path: full, class: "move", dest: `${rel.legacySite}/${p[1]}` };
  }
  if (full === "docs/how-it-works/index.html") {
    return { path: full, class: "move", dest: `${rel.legacySite}/how-it-works/index.html` };
  }
  if (full === "docs/lineage/index.html") {
    return { path: full, class: "move", dest: `${rel.legacySite}/lineage/index.html` };
  }
  if (full === "docs/themes/index.html") {
    return { path: full, class: "move", dest: `${rel.legacySite}/themes/index.html` };
  }
  if (full === "docs/themes/themes-manifest.json" || full === "docs/themes/_quality.json") {
    return { path: full, class: "move", dest: `${rel.published}/themes/${p[2]}` };
  }
  if (p.length === 4 && p[1] === "themes" && p[3] === "lineage.json") {
    return { path: full, class: "move", dest: `${rel.published}/themes/${p[2]}/lineage.json` };
  }
  if (p.length === 2 && TOP_LEVEL_PUBLISHED_FILES.has(p[1] as string)) {
    return { path: full, class: "move", dest: `${rel.published}/${p[1]}` };
  }
  if (p.length >= 2 && p[1] === "paper-details-v1" && p.length >= 3) {
    return {
      path: full,
      class: "move",
      dest: `${rel.published}/paper-details-v1/${p.slice(2).join("/")}`,
    };
  }
  if (p.length >= 2 && p[1] === "search-paper-ids-v1" && p.length >= 3) {
    return {
      path: full,
      class: "move",
      dest: `${rel.published}/search-paper-ids-v1/${p.slice(2).join("/")}`,
    };
  }
  if (p.length === 3 && !DOCS_EXCLUDED_CONF_DIRS.has(p[1] as string)) {
    const conf = p[1] as string;
    const basename = p[2] as string;
    if (LEGACY_CONF_BASENAMES.has(basename)) {
      return { path: full, class: "move", dest: `${rel.legacySite}/${conf}/${basename}` };
    }
    if (PUBLISHED_CONF_BASENAMES.has(basename) || DEEP_JSON_RE.test(basename)) {
      return { path: full, class: "move", dest: `${rel.published}/${conf}/${basename}` };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// paperpilot/data/
// ---------------------------------------------------------------------------

const DATA_STAY_FILES = new Set([
  "paperpilot/data/.gitkeep",
  "paperpilot/data/sol-abstract-local-v1.json",
]);
const DATA_STATE_FILES = new Set([
  "seen_ids.json",
  "seen_ids.daily.json",
  "run_history.jsonl",
  // Review round 3, M1: the daily-watch run history (config.daily-watch.yaml's
  // `incremental.run_history_file`, committed by collect-daily-watch). Without
  // it, R-B carry-back refuses after any daily-watch run.
  "run_history.daily.jsonl",
  "identity-coverage-v1.json",
]);
const DATA_CONFIG_FILES = new Set([
  "conference-sources-v1.yaml",
  "lineage_denylist.json",
  "lineage_foundational_allowlist.json",
  "lineage-audit-fixtures-v1.json",
  "lineage-quality-policy-v1.json",
  "paper_repos.json",
  "theme_aliases.json",
  "theme_blacklist.json",
]);

function classifyPaperpilotData(p: readonly string[], full: string): RuleEntry | undefined {
  const rel = relLayout("p5");
  if (DATA_STAY_FILES.has(full)) {
    return { path: full, class: "stay" };
  }
  if (p.length >= 3 && p[2] === "lineage-cache") {
    return {
      path: full,
      class: "move",
      dest: `${rel.state}/lineage-cache/${p.slice(3).join("/")}`,
    };
  }
  if (p.length === 3 && DATA_STATE_FILES.has(p[2] as string)) {
    return { path: full, class: "move", dest: `${rel.state}/${p[2]}` };
  }
  if (p.length === 3 && DATA_CONFIG_FILES.has(p[2] as string)) {
    return { path: full, class: "move", dest: `${rel.config}/${p[2]}` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// paperpilot/output/
// ---------------------------------------------------------------------------

function classifyPaperpilotOutput(p: readonly string[], full: string): RuleEntry {
  const rel = relLayout("p5");
  if (full === "paperpilot/output/.gitkeep") {
    return { path: full, class: "stay" };
  }
  return { path: full, class: "move", dest: `${rel.inputs}/${p.slice(2).join("/")}` };
}

// ---------------------------------------------------------------------------
// paperpilot/{config.yaml,config.daily-watch.yaml,.env.example}
// ---------------------------------------------------------------------------

/** p5-plan.md §5.1's edit allowlist: `output.*.dir`, `incremental.seen_ids_file`, `incremental.run_history_file`, `logging.file` — and no other key. */
export const CONFIG_WEEKLY_ALLOWED_KEYS = [
  "output.csv.dir",
  "output.json.dir",
  "incremental.seen_ids_file",
  "logging.file",
] as const;
export const CONFIG_DAILY_WATCH_ALLOWED_KEYS = [
  "output.csv.dir",
  "incremental.seen_ids_file",
  "incremental.run_history_file",
  "logging.file",
] as const;

function configWeeklyEntry(): MoveEditEntry {
  const rel = relLayout("p5");
  return {
    path: "paperpilot/config.yaml",
    class: "moveEdit",
    dest: `${rel.config}/config.yaml`,
    allowedKeys: CONFIG_WEEKLY_ALLOWED_KEYS,
    edits: [
      { key: "output.csv.dir", oldValue: "paperpilot/output", newValue: rel.inputs },
      { key: "output.json.dir", oldValue: "paperpilot/output", newValue: rel.inputs },
      {
        key: "incremental.seen_ids_file",
        oldValue: "paperpilot/data/seen_ids.json",
        newValue: `${rel.state}/seen_ids.json`,
      },
      {
        key: "logging.file",
        oldValue: "paperpilot/logs/paperpilot.log",
        newValue: "logs/paperpilot.log",
      },
    ],
  };
}

function configDailyWatchEntry(): MoveEditEntry {
  const rel = relLayout("p5");
  return {
    path: "paperpilot/config.daily-watch.yaml",
    class: "moveEdit",
    dest: `${rel.config}/config.daily-watch.yaml`,
    allowedKeys: CONFIG_DAILY_WATCH_ALLOWED_KEYS,
    edits: [
      {
        key: "output.csv.dir",
        oldValue: "paperpilot/output/daily",
        newValue: `${rel.inputs}/daily`,
      },
      {
        key: "incremental.seen_ids_file",
        oldValue: "paperpilot/data/seen_ids.daily.json",
        newValue: `${rel.state}/seen_ids.daily.json`,
      },
      {
        key: "incremental.run_history_file",
        oldValue: "paperpilot/data/run_history.daily.jsonl",
        newValue: `${rel.state}/run_history.daily.jsonl`,
      },
      {
        key: "logging.file",
        oldValue: "paperpilot/logs/paperpilot-daily.log",
        newValue: "logs/paperpilot-daily.log",
      },
    ],
  };
}

function envExampleEntry(): MoveEntry {
  const rel = relLayout("p5");
  return { path: "paperpilot/.env.example", class: "move", dest: `${rel.config}/.env.example` };
}

/**
 * Classify one `git ls-files` path. Throws {@link UnmappedPathError} for a
 * path under a managed root (`docs/`, `paperpilot/data/`,
 * `paperpilot/output/`) that no specific rule recognizes — never silently
 * falls back to `stay` there. Everything else defaults to `stay`.
 */
export function classifyPath(path: string): RuleEntry {
  const p = parts(path);
  const root = p[0];

  if (root === "docs") {
    const result = classifyDocs(p, path);
    if (!result) throw new UnmappedPathError(path);
    return result;
  }
  if (root === "paperpilot" && p[1] === "data") {
    const result = classifyPaperpilotData(p, path);
    if (!result) throw new UnmappedPathError(path);
    return result;
  }
  if (root === "paperpilot" && p[1] === "output") {
    return classifyPaperpilotOutput(p, path);
  }
  if (path === "paperpilot/config.yaml") return configWeeklyEntry();
  if (path === "paperpilot/config.daily-watch.yaml") return configDailyWatchEntry();
  if (path === "paperpilot/.env.example") return envExampleEntry();

  return { path, class: "stay" };
}

/** `true` for any path this module treats as "managed" (must be exhaustively classified, never silently defaulted). */
export function isManagedPath(path: string): boolean {
  return (
    path.startsWith("docs/") ||
    path === "docs" ||
    path.startsWith("paperpilot/data/") ||
    path.startsWith("paperpilot/output/") ||
    path === "paperpilot/config.yaml" ||
    path === "paperpilot/config.daily-watch.yaml" ||
    path === "paperpilot/.env.example"
  );
}
