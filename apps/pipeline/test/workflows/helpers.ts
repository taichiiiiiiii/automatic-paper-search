/**
 * Shared loading/parsing helpers for the P5 staged-workflow contract
 * tests (docs/migration/p5-plan.md §2 A7). All tests resolve the staged
 * directory via `layoutFor(getRepoRoot()).workflowsDir` (legacy mode:
 * `.github/workflows-p5`) rather than a hard-coded path, so they keep
 * working unchanged once commit B flips `LAYOUT_MODE` and the directory
 * becomes `.github/workflows`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { layoutFor } from "@paperpilot/core/layout";
import { parse } from "yaml";

/** The exact staged workflow file names (p5-plan.md §2 A7, + R2-6 regen-retry.yml), sorted. */
export const EXPECTED_WORKFLOW_FILES = [
  "collect-daily-watch.yml",
  "collect-weekly.yml",
  "conference-on-demand.yml",
  "data-audit.yml",
  "legacy-redirects.yml",
  "lighthouse.yml",
  "pages-release.yml",
  "pages-rollback.yml",
  "pages.yml",
  "regen-retry.yml",
  "regen-themes.yml",
  "tests.yml",
  "theme-on-demand.yml",
].sort();

export function workflowsDir(): string {
  return layoutFor(getRepoRoot()).workflowsDir;
}

export function compositeActionPath(): string {
  return join(getRepoRoot(), ".github", "actions", "setup-pnpm", "action.yml");
}

export function listWorkflowFiles(): string[] {
  return readdirSync(workflowsDir())
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

/**
 * Generic bag-of-properties shape for a parsed workflow/action document —
 * deliberately loose (`unknown`/index signature) because these tests
 * walk arbitrary, evolving YAML structures rather than modelling the
 * full GitHub Actions schema.
 */
// biome-ignore lint/suspicious/noExplicitAny: parsed YAML is untyped by nature; every accessor below narrows explicitly before use.
export type YamlDoc = any;

/**
 * Raw YAML source text, unparsed. Needed wherever a check must not run
 * against `JSON.stringify(parsedDoc)`: `JSON.stringify` escapes real
 * newlines inside multi-line `run:` blocks as the two literal characters
 * `\` + `n`, which can glue the end of one line onto the start of the
 * next (e.g. `...pipefail\npython...`) and defeat a `\b` word-boundary
 * regex looking for a bare `python` token.
 */
export function readWorkflowRawText(fileName: string): string {
  return readFileSync(join(workflowsDir(), fileName), "utf-8");
}

export function readWorkflow(fileName: string): YamlDoc {
  return parse(readWorkflowRawText(fileName));
}

export function readCompositeAction(): YamlDoc {
  const text = readFileSync(compositeActionPath(), "utf-8");
  return parse(text);
}

export function readAllWorkflows(): Map<string, YamlDoc> {
  const map = new Map<string, YamlDoc>();
  for (const file of listWorkflowFiles()) {
    map.set(file, readWorkflow(file));
  }
  return map;
}

/** Every `jobs.*` entry as `[jobId, jobDoc]`, in declaration order. */
export function jobsOf(doc: YamlDoc): Array<[string, YamlDoc]> {
  const jobs = doc.jobs ?? {};
  return Object.entries(jobs) as Array<[string, YamlDoc]>;
}

/**
 * Every `run:` string in the document, found by walking the whole
 * parsed structure rather than assuming a fixed shape — composite
 * actions nest steps one level shallower (`runs.steps`) than a
 * workflow's jobs (`jobs.<id>.steps`), and this must catch both without
 * two separate hand-written walks drifting apart.
 */
export function allRunStrings(doc: YamlDoc): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.run === "string") found.push(obj.run);
    for (const value of Object.values(obj)) walk(value);
  }
  walk(doc);
  return found;
}

/** Every `uses:` string in the document (steps, reusable-workflow jobs). */
export function allUsesStrings(doc: YamlDoc): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.uses === "string") found.push(obj.uses);
    for (const value of Object.values(obj)) walk(value);
  }
  walk(doc);
  return found;
}

/**
 * Third-party `uses:` refs that are known not to be pinned to a 40-hex
 * SHA, with the reason. p5-plan.md §2 A7 assertion 2 requires every
 * `uses:` to be pinned (or the local composite action); this is the
 * one documented, reported exception rather than a silent gap. Empty since
 * treosh/lighthouse-ci-action was pinned to its v12 commit (2026-10-07).
 */
export const PENDING_UNPINNED_ACTIONS: ReadonlySet<string> = new Set<string>([]);

/**
 * `apps/pipeline/src/.../*Cli.ts` (or any `.ts`) paths referenced as
 * `tsx <path>` inside any `run:` string, repo-root-relative.
 */
export function tsxPathsIn(runText: string): string[] {
  const found: string[] = [];
  const re = /\btsx\s+((?:apps|packages)\/[^\s"']+\.ts)/g;
  for (const m of runText.matchAll(re)) {
    found.push(m[1] as string);
  }
  return found;
}
