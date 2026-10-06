/**
 * P5 tier-A review round 3, M1: the staged `collect-daily-watch.yml`
 * commits `data/state/run_history.daily.jsonl`, which had no rule-table
 * mapping, so an R-B `carry-back` after any daily-watch run refused the
 * whole call. A workflow can only ever add data the rollback can carry
 * back if every `data/` path it commits, packages, promotes or uploads
 * maps back to a legacy path through the reverse rule table.
 *
 * This parses every staged workflow and checks each `data/…` token in
 * the `run:` text and `env:` values of every step that invokes
 * `release/cli.ts commit-push|package|promote`, plus every
 * `actions/upload-artifact` step's `with.path`. Shell variables and
 * globs are replaced by a sample slug. A token whose last segment has no
 * extension is a directory and must have at least one mappable child.
 * Only `data/config/conference-copy/` is exempt: it is p5-only, and the
 * runbook (p5-plan.md §6.2 R-B step 4a) tells the operator to resolve it
 * by hand.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT_MODE, relLayout } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import { reverseMapDataPath } from "../../src/release/dataMove/carryBack.js";
import { buildPlan } from "../../src/release/dataMove/plan.js";
import { EXPECTED_WORKFLOW_FILES, jobsOf, readAllWorkflows, type YamlDoc } from "./helpers.js";

const P5_ONLY_PREFIXES = ["data/config/conference-copy/"];
const WRITER_RE = /release\/cli\.ts\s+(commit-push|package|promote)\b/;
const SLUG = "sample-slug";
/** Children tried under a directory token: any file under inputs/state, a conference's files, a theme's lineage. */
const DIRECTORY_PROBES = [
  "probe.csv",
  "papers.json",
  "lineage.json",
  `${SLUG}/lineage.json`,
  `${SLUG}/papers.json`,
];

interface DataToken {
  file: string;
  step: string;
  raw: string;
  path: string;
}

/** `data/…` tokens not preceded by a path character (so `$CANDIDATE_DIR/data/…` is skipped). */
function dataTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w/.$-])data\/[^\s"'()<>|;,\]\\[]*/g)) {
    out.push(m[0]);
  }
  return out;
}

function normalize(raw: string): string {
  return raw
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, SLUG)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, SLUG)
    .replace(/\*/g, SLUG)
    .replace(/\/+$/, "");
}

function collectTokens(): DataToken[] {
  const docs = readAllWorkflows();
  const tokens: DataToken[] = [];
  for (const file of EXPECTED_WORKFLOW_FILES) {
    for (const [jobId, job] of jobsOf(docs.get(file))) {
      const steps: YamlDoc[] = Array.isArray(job?.steps) ? job.steps : [];
      for (const step of steps) {
        const label = `${jobId} / ${typeof step.name === "string" ? step.name : "(unnamed)"}`;
        const texts: string[] = [];
        const run = typeof step.run === "string" ? step.run : "";
        if (WRITER_RE.test(run)) {
          texts.push(run);
          for (const value of Object.values((step.env ?? {}) as Record<string, unknown>)) {
            if (typeof value === "string") texts.push(value);
          }
        }
        const uses = typeof step.uses === "string" ? step.uses : "";
        if (uses.startsWith("actions/upload-artifact@") && typeof step.with?.path === "string") {
          texts.push(step.with.path);
        }
        for (const text of texts) {
          for (const raw of dataTokens(text)) {
            tokens.push({ file, step: label, raw, path: normalize(raw) });
          }
        }
      }
    }
  }
  return tokens;
}

/**
 * LOW (P5 tier-A review round 4): every real `data/…` path B's rule table
 * would actually produce, derived from `git ls-files` on the real repo
 * forward-classified through the same {@link buildPlan} `rules.realRepo`
 * trusts — not a synthetic sample. A directory token's *real* children
 * (see {@link allChildrenMap}) are checked against this list first; the
 * small {@link DIRECTORY_PROBES} sample is only a fallback for a token
 * whose directory has no real children yet (a brand-new, not-yet-created
 * conference/theme slug).
 */
function realP5Dests(): string[] {
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
  const out = execFileSync("git", ["ls-files"], { cwd, encoding: "utf-8" });
  const paths = out.trim().length === 0 ? [] : out.trim().split("\n");
  // After commit B (p5 layout, e.g. inside `dataMove rehearse`'s clone,
  // which runs `apply` before the test suite), every tracked `data/…`
  // path IS already its own real p5 destination — `rules.realRepo.test.ts`
  // pins that every managed path classifies as `stay`, never `move`/
  // `moveEdit`, once `LAYOUT_MODE` is `"p5"` — so `buildPlan`'s forward
  // `dest` field (which only "move"/"moveEdit" entries carry) would be
  // empty here and must not be relied on.
  if (LAYOUT_MODE === "p5") return paths.filter((p) => p.startsWith("data/"));
  return buildPlan({ paths })
    .entries.flatMap((e) => (e.class === "move" || e.class === "moveEdit" ? [e.dest] : []))
    .filter((dest) => dest.startsWith("data/"));
}

/**
 * Review round 4, L2: the old check accepted a directory token the moment
 * *any one* probe child mapped — so a collector writing a brand-new,
 * never-rule-tabled file under an already-probed directory (for example
 * `data/state/<new-file>`) passed here and only failed later, at
 * `carry-back` time. Every real child under `prefix` (from `realDests`)
 * must map; `DIRECTORY_PROBES` is only consulted when there are no real
 * children to check yet.
 */
export function allChildrenMap(
  prefix: string,
  realDests: readonly string[],
  mapOne: (path: string) => boolean = (p) => reverseMapDataPath(p) !== undefined,
): boolean {
  const realChildren = realDests.filter((d) => d.startsWith(`${prefix}/`));
  if (realChildren.length > 0) return realChildren.every(mapOne);
  return DIRECTORY_PROBES.some((child) => mapOne(`${prefix}/${child}`));
}

const REAL_P5_DESTS = realP5Dests();

function mapsBack(path: string): boolean {
  const last = path.split("/").pop() ?? "";
  if (last.includes(".")) return reverseMapDataPath(path) !== undefined;
  return allChildrenMap(path, REAL_P5_DESTS);
}

describe("every data/ path a staged workflow commits, packages, promotes or uploads maps back to a legacy path (M1)", () => {
  const tokens = collectTokens();

  it("sanity: the extractor finds the daily-watch run history and the weekly upload", () => {
    const paths = tokens.map((t) => t.path);
    expect(paths).toContain("data/state/run_history.daily.jsonl");
    expect(paths).toContain("data/state/run_history.jsonl");
    expect(paths).toContain("data/published/themes");
    expect(tokens.length).toBeGreaterThan(15);
  });

  for (const token of tokens) {
    if (P5_ONLY_PREFIXES.some((prefix) => token.path.startsWith(prefix))) continue;
    it(`${token.file} / ${token.step}: ${token.raw}`, () => {
      expect(
        mapsBack(token.path),
        `${token.path} has no legacy-path equivalent in the rule table; R-B carry-back would refuse after this workflow runs`,
      ).toBe(true);
    });
  }
});

describe("allChildrenMap: a directory token requires EVERY real child to map, not just one (review round 4, L2)", () => {
  it("sanity: the real repo has today's known children for data/state and data/published/themes", () => {
    expect(REAL_P5_DESTS).toContain("data/state/seen_ids.json");
    expect(REAL_P5_DESTS.some((d) => d.startsWith("data/published/themes/"))).toBe(true);
  });

  it("RED/GREEN: passes when every real child under the prefix maps", () => {
    const realDests = ["data/state/seen_ids.json", "data/state/run_history.jsonl"];
    expect(allChildrenMap("data/state", realDests)).toBe(true);
  });

  it("RED/GREEN: fails when even one real child under the prefix has no mapping (fail-closed)", () => {
    // Mirrors the gap the review found: a collector writes a brand-new,
    // never-rule-tabled file next to an already-mapped one under the same
    // directory. A `.some(...)` check would still pass; `.every(...)` must not.
    const realDests = ["data/state/seen_ids.json", "data/state/a-brand-new-unmapped-file.json"];
    expect(allChildrenMap("data/state", realDests)).toBe(false);
  });

  it("falls back to the DIRECTORY_PROBES sample when the prefix has no real children yet", () => {
    // A not-yet-created conference/theme slug directory: no real children
    // in the current tree, so the probe sample is all there is to check.
    expect(allChildrenMap("data/published/themes", [])).toBe(true);
  });
});

/**
 * Extracts every `` `${rel.published}/…}` ``/`` `${rel.state}/…}` ``
 * literal from promote.ts's `sharedPathsForMode`'s own `if (mode ===
 * "p5")` branch, by reading and lightly parsing its *source text*
 * (never executed: `sharedPathsForMode` itself is not exported, and this
 * test must not add an export promote.ts doesn't already have — out of
 * this changeset's ownership). This is what makes the comparison below
 * catch real drift: a hand-copied literal list can silently diverge from
 * promote.ts without any test noticing.
 */
function extractP5SharedPathsFromPromoteSource(): string[] {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();
  const src = readFileSync(join(repoRoot, "apps/pipeline/src/release/promote.ts"), "utf-8");
  const fnStart = src.indexOf("function sharedPathsForMode");
  if (fnStart === -1)
    throw new Error("promote.ts: sharedPathsForMode not found (did it move/rename?)");
  const p5If = src.indexOf('if (mode === "p5")', fnStart);
  if (p5If === -1)
    throw new Error('promote.ts: sharedPathsForMode\'s if (mode === "p5") branch not found');
  const braceStart = src.indexOf("{", p5If);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  const block = src.slice(braceStart, i + 1);
  const rel = relLayout("p5");
  const paths: string[] = [];
  for (const m of block.matchAll(/`\$\{rel\.(published|state)\}([^`]*)`/g)) {
    paths.push(`${m[1] === "published" ? rel.published : rel.state}${m[2]}`);
  }
  return paths;
}

describe("p5 SHARED_PATHS (promote.ts) all map back to a legacy path (review round 4, L2)", () => {
  const P5_SHARED_PATHS = [...new Set(extractP5SharedPathsFromPromoteSource())];

  it("sanity: this list is non-empty and includes both a file and a directory entry", () => {
    expect(P5_SHARED_PATHS.length).toBeGreaterThanOrEqual(9);
    expect(P5_SHARED_PATHS).toContain("data/published/paper-details-v1");
  });

  for (const path of P5_SHARED_PATHS) {
    it(`${path} maps back to a legacy path`, () => {
      expect(
        mapsBack(path),
        `${path} (promote.ts p5 SHARED_PATHS) has no legacy-path equivalent; R-B carry-back ` +
          "would refuse after a promotion writes it",
      ).toBe(true);
    });
  }
});
