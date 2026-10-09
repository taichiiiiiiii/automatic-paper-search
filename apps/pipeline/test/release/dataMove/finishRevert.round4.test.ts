/**
 * Review round 4 findings (p5-plan.md §6.2 R-B step 4c), split out of
 * `finishRevert.test.ts` into its own file so one worker doesn't hold a
 * single file's real-git-subprocess runtime for as long (this package's
 * tests spawn real `git`/`tsx` child processes; keeping each file's
 * wall-clock time down reduces contention under `pnpm -r test`'s full
 * parallel run).
 *
 * - H1: `finishRevert` must verify `HEAD` actually holds every manifest
 *   entry's carried-back content before resolving anything — an empty
 *   carry-back commit made after `git revert --abort` discarded a
 *   staged-but-uncommitted carry-back used to report success while
 *   silently deleting the collector config and state.
 * - M2e/M2g: mutant survivors from round 3's M2 (the `[no-carry-back-commit]`
 *   / `[revert-auto-committed]` / `[commits-in-between]` HEAD checks).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../../../src/release/dataMove/apply.js";
import {
  buildManifest,
  type CarryBackManifest,
  carryBack,
  finishRevert,
  parseManifest,
} from "../../../src/release/dataMove/carryBack.js";
import {
  adapter,
  buildFixtureRepo,
  CONFIG_YAML_FIXTURE,
  cleanupFixtureRepo,
  type FixtureRepo,
  GIT_ENV,
  gitRun,
} from "./fixtures.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let fixture: FixtureRepo | undefined;

afterEach(() => {
  if (fixture) cleanupFixtureRepo(fixture);
  fixture = undefined;
});

const TIMEOUT = 60_000;

/** Applies the move on a branch and merges it into develop with a real merge commit; returns `{ base, mergeB }`. */
function cutoverMerge(repo: string): { base: string; mergeB: string } {
  const base = gitRun(repo, ["rev-parse", "HEAD"]);
  gitRun(repo, ["checkout", "-q", "-b", "p5/cutover"]);
  apply({ git: adapter, cwd: repo, confirmDelete: "docs/daily/papers.json" });
  gitRun(repo, ["commit", "-q", "-m", "data(p5): cutover"]);
  gitRun(repo, ["checkout", "-q", "develop"]);
  gitRun(repo, ["merge", "-q", "--no-ff", "p5/cutover", "-m", "Merge B"]);
  return { base, mergeB: gitRun(repo, ["rev-parse", "HEAD"]) };
}

function write(repo: string, rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

/** carry-back -> manifest round-trip through JSON -> commit, exactly as runbook step 4a says (`--allow-empty`). */
function carryBackAndCommit(repo: string, mergeB: string): CarryBackManifest {
  const result = carryBack({ git: adapter, cwd: repo, since: mergeB });
  const manifest = parseManifest(JSON.stringify(buildManifest(result)));
  gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);
  return manifest;
}

/** `git revert --no-commit -m 1 <mergeB>`; a conflict exit (1) is expected, anything else is not. */
function revertNoCommit(repo: string, mergeB: string): number {
  const result = adapter.run(repo, ["revert", "--no-commit", "-m", "1", mergeB], { env: GIT_ENV });
  expect([0, 1]).toContain(result.exitCode);
  return result.exitCode;
}

/** The reviewer's probe: one modify, one delete, one add under data/, plus a non-data edit. */
function postBProbeCommit(repo: string): void {
  write(repo, "data/state/seen_ids.json", '{"2601.00001":"2026-10-01"}\n');
  gitRun(repo, ["rm", "-q", "data/published/themes/flash-attention/lineage.json"]);
  write(repo, "data/published/themes/new-theme/lineage.json", '{"nodes":["new"]}\n');
  write(repo, "apps/web/README.md", "# web (edited after B)\n");
  gitRun(repo, ["add", "-A"]);
  gitRun(repo, ["commit", "-q", "-m", "post-B: weekly + theme changes"]);
}

interface TreeFile {
  mode: string;
  content: string;
}

function treeOf(repo: string, ref: string): Map<string, TreeFile> {
  const map = new Map<string, TreeFile>();
  for (const line of gitRun(repo, ["ls-tree", "-r", ref]).split("\n")) {
    if (line.length === 0) continue;
    const tab = line.indexOf("\t");
    const [mode] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    map.set(path, { mode: mode as string, content: gitRun(repo, ["show", `${ref}:${path}`]) });
  }
  return map;
}

function sorted(map: Map<string, TreeFile>): [string, TreeFile][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("finishRevert: H1 — HEAD must actually hold the carried-back content (review round 4)", () => {
  it(
    "RED/GREEN: a minimal unit case — an empty carry-back commit over an A/M manifest refuses as [carry-back-incomplete]",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      // Simulates `git revert --abort` discarding the staged (but never committed) carry-back.
      gitRun(repo, ["reset", "-q", "--hard", "HEAD"]);
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);
      revertNoCommit(repo, mergeB);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[carry-back-incomplete\][\s\S]*paperpilot\/data\/seen_ids\.json/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: the reviewer's r4rbF sequence — staged-but-uncommitted carry-back, `revert --abort` " +
      "discards it, the OLD remedy text's empty commit leaves [carry-back-incomplete]; the FIXED remedy converges",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { base, mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      // A moveEdit entry too (the reviewer's probe had code + .gitignore edits; a config edit
      // exercises the branch H1 actually broke — reverseConfigEdits content, not just a blob).
      const editedP5 = readFileSync(join(repo, "data/config/config.yaml"), "utf-8").replace(
        "max_age_days: 14",
        "max_age_days: 21",
      );
      write(repo, "data/config/config.yaml", editedP5);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: config edit"]);
      const postB = gitRun(repo, ["rev-parse", "HEAD"]);

      // Step a: carry-back stages the change, but the operator's commit never happens
      // (forgotten, or rejected by a pre-commit hook).
      const result = carryBack({ git: adapter, cwd: repo, since: mergeB });
      expect(result.staged).toBe(true);
      const manifest = parseManifest(JSON.stringify(buildManifest(result)));
      expect(manifest.head).toBe(postB);

      // Step b: `git revert --no-commit -m 1 B` proceeds over the dirty (staged) index.
      revertNoCommit(repo, mergeB);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[no-carry-back-commit\][\s\S]*is NOT the fix[\s\S]*git revert --abort[\s\S]*rerun[\s\S]*carry-back --since/,
      );
      // Not the old generic "delete-only" wording — this manifest has A/M entries.
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).not.toThrow(
        /delete-only carry-back stages nothing/,
      );
      expect(gitRun(repo, ["rev-parse", "HEAD"])).toBe(postB);

      // Following the OLD runbook text verbatim: `git revert --abort` discards the staged
      // carry-back entirely, then `git commit --allow-empty` makes an empty commit.
      gitRun(repo, ["revert", "--abort"]);
      expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);
      revertNoCommit(repo, mergeB);
      // H1: this must refuse — the empty commit holds none of the carried content — not "succeed"
      // while silently deleting `paperpilot/config.yaml` and `paperpilot/data/seen_ids.json`.
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[carry-back-incomplete\][\s\S]*paperpilot\/config\.yaml[\s\S]*paperpilot\/data\/seen_ids\.json/,
      );
      // Nothing was changed by the refused call: still mid-revert, with conflicts.
      expect(gitRun(repo, ["diff", "--name-only", "--diff-filter=U"]).length).toBeGreaterThan(0);

      // The FIXED remedy: abort, rerun carry-back (same `since`, so the same manifest shape),
      // commit --allow-empty, redo the revert, finish.
      gitRun(repo, ["revert", "--abort"]);
      const redo = carryBack({ git: adapter, cwd: repo, since: mergeB });
      expect(redo.staged).toBe(true);
      // A new manifest: carry-back's `head` is the current HEAD (the empty commit from step above),
      // not the original `postB` — exactly as the remedy text says ("a new manifest").
      const manifest2 = parseManifest(JSON.stringify(buildManifest(redo)));
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B (redo)"]);
      revertNoCommit(repo, mergeB);
      finishRevert({ git: adapter, cwd: repo, manifest: manifest2 });
      gitRun(repo, ["commit", "-q", "-m", "Revert B (finish-revert)"]);

      const expected = treeOf(repo, base);
      expected.delete("docs/themes/flash-attention/lineage.json");
      expected.set("docs/themes/new-theme/lineage.json", {
        mode: "100644",
        content: '{"nodes":["new"]}',
      });
      expected.set("paperpilot/data/seen_ids.json", {
        mode: "100644",
        content: '{"2601.00001":"2026-10-01"}',
      });
      expected.set("apps/web/README.md", { mode: "100644", content: "# web (edited after B)" });
      expected.set("paperpilot/config.yaml", {
        mode: "100644",
        content: CONFIG_YAML_FIXTURE.replace("max_age_days: 14", "max_age_days: 21").trimEnd(),
      });
      const actual = treeOf(repo, "HEAD");
      expect(sorted(actual)).toEqual(sorted(expected));
      expect([...actual.keys()].filter((p) => p.startsWith("data/"))).toEqual([]);
      expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: [commits-in-between]'s own remedy (redo carry-back from the current HEAD) converges " +
      "even when it stages nothing because the legacy paths already hold the content",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { base, mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      write(repo, "apps/web/README.md", "# something in between\n");
      gitRun(repo, ["commit", "-q", "-am", "unrelated commit between carry-back and revert"]);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[commits-in-between\]/,
      );

      // The remedy: redo carry-back from the current HEAD (a new manifest). The legacy paths
      // already hold the content from the first carry-back commit, so this stages nothing — but
      // a fresh --allow-empty commit is still required (same rule as the delete-only case), and
      // HEAD then still holds the right blobs, so assertHeadHoldsCarriedContent passes.
      const redo = carryBack({ git: adapter, cwd: repo, since: mergeB });
      expect(redo.staged).toBe(false);
      const manifest2 = parseManifest(JSON.stringify(buildManifest(redo)));
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B (redo)"]);
      revertNoCommit(repo, mergeB);
      finishRevert({ git: adapter, cwd: repo, manifest: manifest2 });
      gitRun(repo, ["commit", "-q", "-m", "Revert B (finish-revert)"]);

      const expected = treeOf(repo, base);
      expected.delete("docs/themes/flash-attention/lineage.json");
      expected.set("docs/themes/new-theme/lineage.json", {
        mode: "100644",
        content: '{"nodes":["new"]}',
      });
      expected.set("paperpilot/data/seen_ids.json", {
        mode: "100644",
        content: '{"2601.00001":"2026-10-01"}',
      });
      // apps/web/README.md is outside every legacy root B touches, so finish-revert does not own
      // it; it's left exactly as the "unrelated commit" set it, not reverted to base.
      expected.set("apps/web/README.md", { mode: "100644", content: "# something in between" });
      expect(sorted(treeOf(repo, "HEAD"))).toEqual(sorted(expected));
      expect([...treeOf(repo, "HEAD").keys()].filter((p) => p.startsWith("data/"))).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("finishRevert: mutant survivors from review round 4 (M2e, M2g)", () => {
  it(
    "RED/GREEN (M2e): a stray edit riding along with the carry-back commit blocks `git reset --keep HEAD^`",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      expect(manifest.entries).toEqual([]);
      expect(manifest.head).toBe(mergeB);
      // Not a real carry-back commit: it also touches a path outside the manifest, so dropping it
      // with `git reset --keep HEAD^` would silently discard that edit too.
      write(repo, "apps/web/OTHER.md", "# stray edit riding along with carry-back\n");
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);

      // The mistake: revert without --no-commit, which commits cleanly here.
      gitRun(repo, ["revert", "--no-edit", "-m", "1", mergeB]);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[commits-in-between\]/,
      );
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).not.toThrow(
        /revert-auto-committed/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN (M2g): the strays refusal hints at a committed revert of B with no carry-back commit under it",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      // No carry-back run at all: revert B directly, auto-committing (no --no-commit).
      gitRun(repo, ["revert", "--no-edit", "-m", "1", mergeB]);
      const manifest: CarryBackManifest = { version: 1, since: mergeB, head: mergeB, entries: [] };
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /HEAD looks like a committed revert of B[\s\S]*git reset --keep HEAD\^/,
      );
    },
    TIMEOUT,
  );
});
