/**
 * Review round 2, N4 (p5-plan.md §6.2 R-B step 4): `carry-back --since B`
 * followed by `git revert -m 1 B` used to resurrect post-B-deleted data
 * (rename/delete conflict, `DU`) and leave every post-B-added file tracked
 * as an orphan under `data/`. `finishRevert` resolves that revert from the
 * carry-back manifest, so the final tree is exactly "pre-B tree + every
 * post-B change mapped to its legacy path".
 *
 * These tests run the real runbook sequence in a throwaway repository:
 * B is a real `--no-ff` merge commit, so `git revert --no-commit -m 1 <B>`
 * is the exact runbook invocation.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../../../src/release/dataMove/apply.js";
import {
  buildManifest,
  type CarryBackManifest,
  carryBack,
  FinishRevertError,
  finishRevert,
  parseManifest,
} from "../../../src/release/dataMove/carryBack.js";
import type { GitAdapter } from "../../../src/release/git/gitAdapter.js";
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

/** The reviewer's probe: one modify, one delete, one add under data/, plus a non-data edit. */
function postBProbeCommit(repo: string): void {
  write(repo, "data/state/seen_ids.json", '{"2601.00001":"2026-10-01"}\n');
  gitRun(repo, ["rm", "-q", "data/published/themes/flash-attention/lineage.json"]);
  write(repo, "data/published/themes/new-theme/lineage.json", '{"nodes":["new"]}\n');
  write(repo, "apps/web/README.md", "# web (edited after B)\n");
  gitRun(repo, ["add", "-A"]);
  gitRun(repo, ["commit", "-q", "-m", "post-B: weekly + theme changes"]);
}

/** carry-back -> manifest round-trip through JSON -> commit, exactly as runbook step 4a says (`--allow-empty`). */
function carryBackAndCommit(repo: string, mergeB: string): CarryBackManifest {
  const result = carryBack({ git: adapter, cwd: repo, since: mergeB });
  const manifest = parseManifest(JSON.stringify(buildManifest(result)));
  gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);
  return manifest;
}

/** `git revert --no-commit -m 1 <B>`; a conflict exit (1) is expected, anything else is not. */
function revertNoCommit(repo: string, mergeB: string): number {
  const result = adapter.run(repo, ["revert", "--no-commit", "-m", "1", mergeB], { env: GIT_ENV });
  expect([0, 1]).toContain(result.exitCode);
  return result.exitCode;
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

describe("finishRevert: N4 probe (carry-back -> git revert -m 1 B -> finish-revert)", () => {
  it(
    "RED/GREEN: the final tree is exactly the pre-B tree plus the post-B changes at their legacy paths",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { base, mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      expect(manifest.since).toBe(mergeB);
      expect(manifest.entries).toEqual([
        {
          p5Path: "data/published/themes/flash-attention/lineage.json",
          legacyPath: "docs/themes/flash-attention/lineage.json",
          status: "D",
        },
        {
          p5Path: "data/published/themes/new-theme/lineage.json",
          legacyPath: "docs/themes/new-theme/lineage.json",
          status: "A",
        },
        {
          p5Path: "data/state/seen_ids.json",
          legacyPath: "paperpilot/data/seen_ids.json",
          status: "M",
        },
      ]);

      // The revert itself conflicts on the D entry (rename/delete), as the review found.
      expect(revertNoCommit(repo, mergeB)).toBe(1);
      expect(gitRun(repo, ["diff", "--name-only", "--diff-filter=U"]).split("\n")).toContain(
        "docs/themes/flash-attention/lineage.json",
      );

      const result = finishRevert({ git: adapter, cwd: repo, manifest });
      expect(result.removed).toContain("docs/themes/flash-attention/lineage.json");
      expect(result.removed).toContain("data/published/themes/new-theme/lineage.json");
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
      // B's own two deletions come back exactly as at B^1 (pre-B legacy tree).
      expect(expected.get("docs/search-index.json")?.content).toBe("{}");
      expect(expected.get("docs/daily/papers.json")?.content).toBe("[]");

      const actual = treeOf(repo, "HEAD");
      expect(sorted(actual)).toEqual(sorted(expected));
      expect([...actual.keys()].filter((p) => p.startsWith("data/"))).toEqual([]);
      expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    },
    TIMEOUT,
  );

  it(
    "carries a post-B moveEdit config change and an executable file through the revert",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { base, mergeB } = cutoverMerge(repo);
      const editedP5 = readFileSync(join(repo, "data/config/config.yaml"), "utf-8").replace(
        "max_age_days: 14",
        "max_age_days: 21",
      );
      write(repo, "data/config/config.yaml", editedP5);
      write(repo, "data/inputs/daily/run.sh", "#!/bin/sh\necho hi\n");
      chmodSync(join(repo, "data/inputs/daily/run.sh"), 0o755);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: config + script"]);

      const manifest = carryBackAndCommit(repo, mergeB);
      revertNoCommit(repo, mergeB);
      finishRevert({ git: adapter, cwd: repo, manifest });
      gitRun(repo, ["commit", "-q", "-m", "Revert B (finish-revert)"]);

      const expected = treeOf(repo, base);
      expected.set("paperpilot/config.yaml", {
        mode: "100644",
        content: CONFIG_YAML_FIXTURE.replace("max_age_days: 14", "max_age_days: 21").trimEnd(),
      });
      expected.set("paperpilot/output/daily/run.sh", {
        mode: "100755",
        content: "#!/bin/sh\necho hi",
      });
      expect(sorted(treeOf(repo, "HEAD"))).toEqual(sorted(expected));
    },
    TIMEOUT,
  );
});

describe("finishRevert: fail-closed paths", () => {
  it(
    "RED/GREEN: refuses when HEAD is not the carry-back commit (HEAD^ != manifest.head)",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      write(repo, "apps/web/README.md", "# something in between\n");
      gitRun(repo, ["commit", "-q", "-am", "unrelated commit between carry-back and revert"]);
      revertNoCommit(repo, mergeB);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[commits-in-between\][^\n]*Do not reset over these commits/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: refuses when nothing is staged (the revert has not been run)",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /nothing is staged/,
      );
      expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: refuses on a conflicted path the manifest does not explain",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      // A post-B edit to a line B's .gitignore patch rewrote: the revert must conflict there.
      const gitignore = readFileSync(join(repo, ".gitignore"), "utf-8");
      const edited = gitignore.replace(
        "data/state/lineage-cache/*",
        "data/state/lineage-cache/*\n# edited after B",
      );
      expect(edited).not.toBe(gitignore);
      write(repo, ".gitignore", edited.replace("data/state/unarxive/", "data/state/unarxive/ # x"));
      gitRun(repo, ["commit", "-q", "-am", "post-B .gitignore edit"]);
      const manifest = carryBackAndCommit(repo, mergeB);
      revertNoCommit(repo, mergeB);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /conflicted path\(s\) the carry-back manifest does not explain[^\n]*\n {2}- \.gitignore$/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: refuses when a path is left under data/ (an untracked file the revert cannot see)",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      revertNoCommit(repo, mergeB);
      write(repo, "data/state/stray.json", "{}\n");
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /remain under data\/[\s\S]*data\/state\/stray\.json/,
      );
    },
    TIMEOUT,
  );

  it(
    "refuses a manifest whose HEAD changes are not all named (a truncated manifest)",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      const truncated: CarryBackManifest = {
        ...manifest,
        entries: manifest.entries.filter((e) => e.status !== "A"),
      };
      revertNoCommit(repo, mergeB);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest: truncated })).toThrow(
        /not the carry-back commit:\n {2}- docs\/themes\/new-theme\/lineage\.json/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: refuses when a file B moved outside data/ changed after B (carry-back cannot carry it)",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      write(repo, "apps/web/static/assets/favicon.svg", "<svg>edited after B</svg>\n");
      gitRun(repo, ["commit", "-q", "-am", "post-B: favicon edit"]);
      const manifest = carryBackAndCommit(repo, mergeB);
      revertNoCommit(repo, mergeB);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /changed after B[\s\S]*apps\/web\/static\/assets\/favicon\.svg/,
      );
    },
    TIMEOUT,
  );

  it(
    "overwrites a stray staged edit on a path it owns, and reports it",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { base, mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      revertNoCommit(repo, mergeB);
      write(repo, "docs/conferences.json", '["hand edit"]\n');
      gitRun(repo, ["add", "docs/conferences.json"]);
      const result = finishRevert({ git: adapter, cwd: repo, manifest });
      expect(result.restored).toContain("docs/conferences.json");
      expect(readFileSync(join(repo, "docs/conferences.json"), "utf-8")).toBe(
        `${gitRun(repo, ["show", `${base}:docs/conferences.json`])}\n`,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: the final self-check refuses when the resolution did not land (update-index dropped)",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      revertNoCommit(repo, mergeB);
      const lossy: GitAdapter = {
        run: (cwd, args, options) =>
          args[0] === "update-index" || args[0] === "checkout"
            ? { exitCode: 0, stdout: "", stderr: "" }
            : adapter.run(cwd, args, options),
      };
      expect(() => finishRevert({ git: lossy, cwd: repo, manifest })).toThrow(
        /differ from "pre-B tree \+ carried-back changes"[\s\S]*paperpilot\/data\/seen_ids\.json/,
      );
    },
    TIMEOUT,
  );
});

describe("finishRevert: delete-only carry-back and the HEAD refusals (review round 3, M2)", () => {
  /** The reviewer's r3rb2 probe: the only post-B data change is a deletion, then a post-B workflow + layout commit. */
  function deleteOnlyThenNonDataCommit(repo: string): void {
    gitRun(repo, ["rm", "-q", "data/published/themes/flash-attention/lineage.json"]);
    gitRun(repo, ["commit", "-q", "-m", "post-B: delete a theme"]);
    // Edits away from the lines B itself rewrote, so the revert merges them without a conflict (as in the probe).
    const appendTo = (rel: string, line: string) =>
      write(repo, rel, `${readFileSync(join(repo, rel), "utf-8")}${line}\n`);
    appendTo(".github/workflows/tests.yml", "# tweaked after B");
    const layoutPath = "packages/core/src/layout/index.ts";
    write(repo, layoutPath, `// edited after B\n${readFileSync(join(repo, layoutPath), "utf-8")}`);
    gitRun(repo, ["commit", "-q", "-am", "post-B: workflow + layout edit"]);
  }

  it(
    "RED/GREEN: the documented sequence (commit --allow-empty) finishes a delete-only rollback",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { base, mergeB } = cutoverMerge(repo);
      deleteOnlyThenNonDataCommit(repo);

      const result = carryBack({ git: adapter, cwd: repo, since: mergeB });
      expect(result.staged).toBe(false);
      const manifest = parseManifest(JSON.stringify(buildManifest(result)));
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);
      revertNoCommit(repo, mergeB);
      finishRevert({ git: adapter, cwd: repo, manifest });
      gitRun(repo, ["commit", "-q", "-m", "Revert B (finish-revert)"]);

      const expected = treeOf(repo, base);
      expected.delete("docs/themes/flash-attention/lineage.json");
      const tests = expected.get(".github/workflows/tests.yml") as TreeFile;
      expected.set(".github/workflows/tests.yml", {
        ...tests,
        content: `${tests.content}\n# tweaked after B`,
      });
      const layout = expected.get("packages/core/src/layout/index.ts") as TreeFile;
      expected.set("packages/core/src/layout/index.ts", {
        ...layout,
        content: `// edited after B\n${layout.content}`,
      });
      expect(sorted(treeOf(repo, "HEAD"))).toEqual(sorted(expected));
      expect(gitRun(repo, ["status", "--porcelain"])).toBe("");
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: without the empty commit it refuses as [no-carry-back-commit], and the documented remedy converges",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      deleteOnlyThenNonDataCommit(repo);
      const postB = gitRun(repo, ["rev-parse", "HEAD"]);

      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      // Plain `git commit` refuses: nothing is staged.
      expect(
        adapter.run(repo, ["commit", "-q", "-m", "carry-back"], { env: GIT_ENV }).exitCode,
      ).not.toBe(0);
      revertNoCommit(repo, mergeB);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[no-carry-back-commit\][\s\S]*Do not reset anything[\s\S]*git revert --abort[\s\S]*--allow-empty/,
      );
      // Not the "HEAD^ is …" refusal the old runbook mapped to `git reset --hard HEAD^`.
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).not.toThrow(/HEAD\^ is/);
      // Manifest is delete-only, so this must NOT get review round 4 H1's "redo carry-back" text
      // (an empty commit genuinely is the fix here).
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).not.toThrow(
        /is NOT the fix/,
      );
      expect(gitRun(repo, ["rev-parse", "HEAD"])).toBe(postB);

      // The remedy: abort the revert, commit empty, redo b and c.
      gitRun(repo, ["revert", "--abort"]);
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);
      revertNoCommit(repo, mergeB);
      finishRevert({ git: adapter, cwd: repo, manifest });
      gitRun(repo, ["commit", "-q", "-m", "Revert B (finish-revert)"]);
      expect(gitRun(repo, ["rev-parse", "HEAD~2"])).toBe(postB);
      expect(gitRun(repo, ["ls-tree", "-r", "--name-only", "HEAD", "--", "data/"])).toBe("");
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: a revert that auto-committed refuses as [revert-auto-committed]; git reset --keep HEAD^ converges",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      write(repo, "apps/web/README.md", "# web (edited after B)\n");
      gitRun(repo, ["commit", "-q", "-am", "post-B: non-data edit"]);
      const manifest = carryBackAndCommit(repo, mergeB);
      expect(manifest.entries).toEqual([]);
      const carryBackCommit = gitRun(repo, ["rev-parse", "HEAD"]);
      expect(gitRun(repo, ["rev-parse", "HEAD^"])).toBe(manifest.head);

      // The mistake: revert without --no-commit, which commits cleanly here.
      gitRun(repo, ["revert", "--no-edit", "-m", "1", mergeB]);
      expect(gitRun(repo, ["rev-parse", "HEAD^"])).toBe(carryBackCommit);
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[revert-auto-committed\][\s\S]*git reset --keep HEAD\^/,
      );

      gitRun(repo, ["reset", "-q", "--keep", "HEAD^"]);
      expect(gitRun(repo, ["rev-parse", "HEAD"])).toBe(carryBackCommit);
      revertNoCommit(repo, mergeB);
      finishRevert({ git: adapter, cwd: repo, manifest });
      gitRun(repo, ["commit", "-q", "-m", "Revert B (finish-revert)"]);
      expect(gitRun(repo, ["ls-tree", "-r", "--name-only", "HEAD", "--", "data/"])).toBe("");
      expect(gitRun(repo, ["show", "HEAD:apps/web/README.md"])).toBe("# web (edited after B)");
    },
    TIMEOUT,
  );
});

describe("finishRevert: ownership branches (review round 3, L4)", () => {
  it(
    "RED/GREEN: pins an untouched managed path to HEAD (a hand edit staged after the revert is undone)",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifest = carryBackAndCommit(repo, mergeB);
      revertNoCommit(repo, mergeB);
      // docs/design/ stays in place under B (never touched), but is a managed root.
      write(repo, "docs/design/39-x.md", "# hand edit during the rollback\n");
      gitRun(repo, ["add", "docs/design/39-x.md"]);
      const result = finishRevert({ git: adapter, cwd: repo, manifest });
      expect(result.restored).toContain("docs/design/39-x.md");
      expect(readFileSync(join(repo, "docs/design/39-x.md"), "utf-8")).toBe("# design\n");
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: a legacy path B moved away and a post-B commit re-created outside carry-back gets its pre-B entry",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { base, mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      write(repo, "docs/conferences.json", '["re-created after B"]\n');
      gitRun(repo, ["add", "docs/conferences.json"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: something re-creates a legacy path"]);
      const manifest = carryBackAndCommit(repo, mergeB);
      revertNoCommit(repo, mergeB);
      const result = finishRevert({ git: adapter, cwd: repo, manifest });
      expect(result.restored).toContain("docs/conferences.json");
      gitRun(repo, ["commit", "-q", "-m", "Revert B (finish-revert)"]);
      expect(gitRun(repo, ["show", "HEAD:docs/conferences.json"])).toBe(
        gitRun(repo, ["show", `${base}:docs/conferences.json`]),
      );
    },
    TIMEOUT,
  );
});

describe("parseManifest", () => {
  const good = {
    version: 1,
    since: "a".repeat(40),
    head: "b".repeat(40),
    entries: [
      {
        p5Path: "data/state/seen_ids.json",
        legacyPath: "paperpilot/data/seen_ids.json",
        status: "M",
      },
    ],
  };

  it("accepts a well-formed manifest", () => {
    expect(parseManifest(JSON.stringify(good)).entries).toHaveLength(1);
  });

  it("refuses an entry whose legacy path is not the rule table's reverse mapping", () => {
    const bad = {
      ...good,
      entries: [{ ...good.entries[0], legacyPath: "paperpilot/config.yaml" }],
    };
    expect(() => parseManifest(JSON.stringify(bad))).toThrow(FinishRevertError);
  });

  it("refuses a non-sha since/head, an unknown status, and a wrong version", () => {
    expect(() => parseManifest(JSON.stringify({ ...good, since: "HEAD~1" }))).toThrow(/since/);
    expect(() => parseManifest(JSON.stringify({ ...good, head: "" }))).toThrow(/head/);
    expect(() =>
      parseManifest(JSON.stringify({ ...good, entries: [{ ...good.entries[0], status: "T" }] })),
    ).toThrow(/malformed entry/);
    expect(() => parseManifest(JSON.stringify({ ...good, version: 2 }))).toThrow(/version 1/);
    expect(() => parseManifest("not json")).toThrow(/not valid JSON/);
  });
});

describe("real tsx spawn: carry-back --manifest, then finish-revert --manifest", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..", "..", "..");
  const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
  const cli = join(repoRoot, "apps", "pipeline", "src", "release", "dataMove", "cli.ts");

  it(
    "runs the runbook sequence end to end through the CLI",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { base, mergeB } = cutoverMerge(repo);
      postBProbeCommit(repo);
      const manifestPath = join(tmpdir(), `carry-back-manifest-${process.pid}-${Date.now()}.json`);
      try {
        execFileSync(tsx, [cli, "carry-back", "--since", mergeB, "--manifest", manifestPath], {
          cwd: repo,
          encoding: "utf-8",
        });
        gitRun(repo, ["commit", "-q", "-m", "carry-back"]);
        revertNoCommit(repo, mergeB);
        const out = execFileSync(tsx, [cli, "finish-revert", "--manifest", manifestPath], {
          cwd: repo,
          encoding: "utf-8",
        });
        expect(out).toMatch(/commit once to finish/);
        gitRun(repo, ["commit", "-q", "-m", "Revert B"]);
        const actual = treeOf(repo, "HEAD");
        expect(actual.has("docs/themes/flash-attention/lineage.json")).toBe(false);
        expect(actual.get("docs/themes/new-theme/lineage.json")?.content).toBe('{"nodes":["new"]}');
        expect([...actual.keys()].filter((p) => p.startsWith("data/"))).toEqual([]);
        expect(actual.get("docs/search-index.json")).toEqual(
          treeOf(repo, base).get("docs/search-index.json"),
        );
      } finally {
        rmSync(manifestPath, { force: true });
      }
    },
    TIMEOUT,
  );
});
