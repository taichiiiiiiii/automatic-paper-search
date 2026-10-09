/**
 * Review round 5, L1: mutant survivors in `assertHeadHoldsCarriedContent`
 * (apps/pipeline/src/release/dataMove/carryBack.ts:627-693). Split into its
 * own file, same reason as `finishRevert.round4.test.ts` — one worker
 * shouldn't hold a single file's real-git-subprocess runtime for too long
 * (this package's tests spawn real `git` child processes; keeping each
 * file's wall-clock time down reduces contention under `pnpm -r test`'s
 * full parallel run, which previously hit a vitest worker RPC timeout when
 * one file grew too large).
 *
 * None of these need an actual `git revert --no-commit` in progress:
 * `finishRevert` calls `assertHeadIsCarryBackCommit` and then
 * `assertHeadHoldsCarriedContent` *before* it ever checks whether anything
 * is staged, so a "carry-back commit" that sits directly on `manifest.head`
 * with no stray paths is enough to reach the content/mode checks under
 * test — exactly as the review's `r5rbH`/`r5rbM` probes exercise, minus
 * the unrelated revert machinery.
 *
 * - H1c: the move-class branch must compare mode, not just blob sha.
 * - H1d: the moveEdit branch's mode check.
 * - H1e: the moveEdit branch's content comparison (the most valuable one —
 *   without it, a carry-back commit altered by, for example, a pre-commit
 *   `end-of-file-fixer` would be accepted).
 * - H1b: the D-branch ("HEAD still has the legacy path").
 * - H1g: a `ConfigEditError` from reverse-editing must be listed as a
 *   problem, not rethrown raw (which would skip the `[carry-back-incomplete]`
 *   wrapping and the fail-closed listing of every other problem).
 * - H1j: the strays refusal's hint text must say "rerun … carry-back" (not
 *   the delete-only wording) when the manifest holds added/modified
 *   entries, not deletions only.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../../../src/release/dataMove/apply.js";
import {
  buildManifest,
  carryBack,
  finishRevert,
  parseManifest,
} from "../../../src/release/dataMove/carryBack.js";
import {
  adapter,
  buildFixtureRepo,
  cleanupFixtureRepo,
  type FixtureRepo,
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

describe("finishRevert: mutant survivors in assertHeadHoldsCarriedContent (review round 5, L1)", () => {
  it(
    "RED/GREEN (H1c): a move-class legacy path with the right content but the wrong mode is refused",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      // Mode-only change after B: no content change, so only a mode comparison catches this.
      chmodSync(join(repo, "data/state/seen_ids.json"), 0o755);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: seen_ids mode change"]);

      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      expect(manifest.entries).toEqual([
        {
          p5Path: "data/state/seen_ids.json",
          legacyPath: "paperpilot/data/seen_ids.json",
          status: "M",
        },
      ]);

      // Sabotage: the carry-back commit slips the mode back to 644 (e.g. a tool that
      // normalizes permissions), leaving the (unchanged) content byte-identical. A sha-only
      // comparison would miss this entirely.
      gitRun(repo, ["update-index", "--chmod=-x", "--", "paperpilot/data/seen_ids.json"]);
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[carry-back-incomplete\][\s\S]*paperpilot\/data\/seen_ids\.json: expected 100755 \S+ \(from data\/state\/seen_ids\.json\), HEAD has 100644/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN (H1d): a moveEdit legacy path with the right (reverse-edited) content but the wrong mode is refused",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      const editedP5 = readFileSync(join(repo, "data/config/config.yaml"), "utf-8").replace(
        "max_age_days: 14",
        "max_age_days: 21",
      );
      write(repo, "data/config/config.yaml", editedP5);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: config edit"]);

      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      expect(manifest.entries).toEqual([
        { p5Path: "data/config/config.yaml", legacyPath: "paperpilot/config.yaml", status: "M" },
      ]);

      // Sabotage: mode slips to +x in the carry-back commit; the correctly reverse-edited
      // content is untouched, so only a mode comparison (not just content) catches this.
      gitRun(repo, ["update-index", "--chmod=+x", "--", "paperpilot/config.yaml"]);
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[carry-back-incomplete\][\s\S]*paperpilot\/config\.yaml: expected mode 100644 \(from data\/config\/config\.yaml\), HEAD has 100755/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN (H1e): a moveEdit legacy path altered after carry-back (e.g. by a hook) is refused for its content, not just accepted on mode",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      const editedP5 = readFileSync(join(repo, "data/config/config.yaml"), "utf-8").replace(
        "max_age_days: 14",
        "max_age_days: 21",
      );
      write(repo, "data/config/config.yaml", editedP5);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: config edit"]);

      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );

      // Sabotage: a byte appended to the carry-back commit's content (simulating, for example,
      // a pre-commit end-of-file-fixer rewriting the carried file); mode is left untouched.
      const carried = readFileSync(join(repo, "paperpilot/config.yaml"), "utf-8");
      write(repo, "paperpilot/config.yaml", `${carried}# appended by a hook\n`);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "carry-back data since B"]);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[carry-back-incomplete\][\s\S]*paperpilot\/config\.yaml: content differs from the reverse-edited data\/config\/config\.yaml/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN (H1b): a legacy path the manifest says is deleted, but which the carry-back commit resurrects, is refused",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      gitRun(repo, ["rm", "-q", "data/published/themes/flash-attention/lineage.json"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: delete a theme"]);

      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      expect(manifest.entries).toEqual([
        {
          p5Path: "data/published/themes/flash-attention/lineage.json",
          legacyPath: "docs/themes/flash-attention/lineage.json",
          status: "D",
        },
      ]);

      // Sabotage: the legacy path is resurrected in the carry-back commit. It should stay
      // deleted — B already removed it, and carry-back's `git rm --ignore-unmatch` is
      // correctly a no-op here (nothing was staged by the real carryBack() call above).
      write(repo, "docs/themes/flash-attention/lineage.json", '{"nodes":["resurrected"]}\n');
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "carry-back data since B"]);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[carry-back-incomplete\][\s\S]*docs\/themes\/flash-attention\/lineage\.json: a carried-back deletion, but HEAD has/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN (H1g): a ConfigEditError from reverse-editing is listed as a problem, not rethrown raw",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      // Corrupt the forward-edited value directly: the exact text `reverseConfigEdits` must
      // find ("seen_ids_file: data/state/seen_ids.json") is gone, so reversing this file throws
      // ConfigEditError. A real `carryBack()` call over this diff would itself refuse outright
      // (the same check carryBack makes while staging), so the manifest here is hand-built —
      // `parseManifest` accepts any manifest whose entries round-trip through the reverse rule
      // table, not only ones a fresh `carryBack()` call just staged (see parseManifest's own
      // contract in carryBack.ts).
      const corrupted = readFileSync(join(repo, "data/config/config.yaml"), "utf-8").replace(
        "seen_ids_file: data/state/seen_ids.json",
        "seen_ids_file: data/state/WRONG.json",
      );
      write(repo, "data/config/config.yaml", corrupted);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: corrupt the moveEdit key (simulated drift)"]);
      const corruptSha = gitRun(repo, ["rev-parse", "HEAD"]);

      const manifest = parseManifest(
        JSON.stringify({
          version: 1,
          since: mergeB,
          head: corruptSha,
          entries: [
            {
              p5Path: "data/config/config.yaml",
              legacyPath: "paperpilot/config.yaml",
              status: "M",
            },
          ],
        }),
      );

      // A "carry-back" commit directly on top, with the right legacy path and mode (so the
      // mode check passes and the reverse-edit is actually attempted) but placeholder content.
      write(repo, "paperpilot/config.yaml", "placeholder: true\n");
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "carry-back data since B"]);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[carry-back-incomplete\][\s\S]*paperpilot\/config\.yaml: data\/config\/config\.yaml cannot be reverse-edited/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN (H1j): the strays refusal's hint says to rerun carry-back, not the delete-only wording, when the manifest holds added/modified entries",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      const editedP5 = readFileSync(join(repo, "data/config/config.yaml"), "utf-8").replace(
        "max_age_days: 14",
        "max_age_days: 21",
      );
      write(repo, "data/config/config.yaml", editedP5);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: config edit"]);

      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      expect(manifest.entries.every((e) => e.status === "D")).toBe(false); // sanity: not delete-only
      gitRun(repo, ["reset", "-q", "--hard", "HEAD"]); // discard the staged (uncommitted) real carry-back

      // Fabricate a commit, directly on manifest.head, that is NOT the real carry-back commit:
      // it wipes all of data/ (so it looks like a committed revert of B) and also touches a
      // stray path outside the manifest.
      gitRun(repo, ["rm", "-r", "-q", "data"]);
      write(repo, "apps/web/OTHER2.md", "# stray edit riding along with a fake carry-back\n");
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "not a real carry-back commit"]);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /HEAD looks like a committed revert of B[\s\S]*rerun `dataMove carry-back --since[\s\S]*added or modified entries/,
      );
      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).not.toThrow(
        /deletions only/,
      );
    },
    TIMEOUT,
  );
});

describe("finishRevert: carry-back-commit remedies use `git commit --no-verify` (review round 5, L4)", () => {
  it(
    "RED/GREEN: [no-carry-back-commit] (delete-only) tells the operator to use --no-verify --allow-empty",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      // No post-B data/ change at all: the manifest is (vacuously) delete-only, and carryBack()
      // stages nothing, so HEAD is still manifest.head — the [no-carry-back-commit] shape.
      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      expect(manifest.entries).toEqual([]);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[no-carry-back-commit\][\s\S]*git commit --no-verify --allow-empty/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: [no-carry-back-commit] (add/modify, redoCarryBackRemedy) tells the operator to use --no-verify --allow-empty",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      const editedP5 = readFileSync(join(repo, "data/config/config.yaml"), "utf-8").replace(
        "max_age_days: 14",
        "max_age_days: 21",
      );
      write(repo, "data/config/config.yaml", editedP5);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: config edit"]);

      // carry-back stages the change but is never committed, so HEAD is still manifest.head.
      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      expect(manifest.entries.length).toBeGreaterThan(0);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[no-carry-back-commit\][\s\S]*git commit --no-verify --allow-empty -m "rollback: carry back data since B"/,
      );
    },
    TIMEOUT,
  );

  it(
    "RED/GREEN: [carry-back-incomplete] tells the operator to use --no-verify --allow-empty",
    () => {
      fixture = buildFixtureRepo();
      const repo = fixture.repo;
      const { mergeB } = cutoverMerge(repo);

      const editedP5 = readFileSync(join(repo, "data/config/config.yaml"), "utf-8").replace(
        "max_age_days: 14",
        "max_age_days: 21",
      );
      write(repo, "data/config/config.yaml", editedP5);
      gitRun(repo, ["add", "-A"]);
      gitRun(repo, ["commit", "-q", "-m", "post-B: config edit"]);

      const manifest = parseManifest(
        JSON.stringify(buildManifest(carryBack({ git: adapter, cwd: repo, since: mergeB }))),
      );
      // Discard the staged carry-back and commit empty, the classic [carry-back-incomplete] shape.
      gitRun(repo, ["reset", "-q", "--hard", "HEAD"]);
      gitRun(repo, ["commit", "-q", "--allow-empty", "-m", "carry-back data since B"]);

      expect(() => finishRevert({ git: adapter, cwd: repo, manifest })).toThrow(
        /\[carry-back-incomplete\][\s\S]*git commit --no-verify --allow-empty -m "rollback: carry back data since B"/,
      );
    },
    TIMEOUT,
  );
});
