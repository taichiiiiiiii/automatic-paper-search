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
import { describe, expect, it } from "vitest";
import { reverseMapDataPath } from "../../src/release/dataMove/carryBack.js";
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

function mapsBack(path: string): boolean {
  const last = path.split("/").pop() ?? "";
  if (last.includes(".")) return reverseMapDataPath(path) !== undefined;
  return DIRECTORY_PROBES.some((child) => reverseMapDataPath(`${path}/${child}`) !== undefined);
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
