/**
 * `cli.ts carry-back --since <B>` (p5-plan.md §5.2/§6.2 R-B step 4, review
 * finding M3): the plan's R-B step 4 ("limited to files changed after B …
 * carried back") as its own explicit, separate mode, never folded into
 * `apply --reverse`.
 *
 * `apply --reverse` only ever reconstructs the exact tree `apply` produced
 * from one specific `beforeRef` — it refuses outright the moment `HEAD`
 * has drifted from that (see `apply.ts`'s `applyReverse`). But the real
 * R-B runbook step runs "after Merge B, before C" — up to the §6.2
 * observation week later — by which point ordinary `collect-weekly`/
 * `collect-daily-watch`/`regen-themes`/`conference-on-demand` runs have
 * almost certainly added, modified, or deleted files under `data/**` that
 * did not exist at B at all (a brand-new theme's `lineage.json`, an
 * updated `seen_ids.json`, …). `apply --reverse`'s per-rule-table loop
 * only ever visits the paths `<B>`'s own tree already knew about, so it
 * cannot carry these forward no matter what ref it's given.
 *
 * `carryBack` fills exactly that gap, independently of `apply --reverse`:
 * for every path `git diff <since> HEAD` reports under `data/`, it maps
 * the path back to its legacy equivalent via the *reverse* of the same
 * rule table `rules.ts` encodes (reconstructed structurally here, since
 * the forward table is keyed by legacy-path shape, not p5-path shape —
 * see {@link reverseMapDataPath}), then replays the add/modify/delete
 * onto that legacy path. A path under `data/` this cannot structurally
 * map back to any legacy rule-table entry (for example
 * `data/config/conference-copy/<slug>.json`, which is p5-only and has no
 * legacy equivalent at all) makes the whole call refuse — same
 * fail-closed discipline as every other gate in this package — rather
 * than silently dropping that file's history.
 *
 * Deliberately does **not** touch the `data/**` side, the `LAYOUT_MODE`
 * literal, `.gitignore`/`.lighthouserc.json`, or the workflow directories
 * at all — the real R-B runbook (p5-plan.md §6.2) pairs this with
 * `git revert --no-commit -m 1 <mergeB>` for that structural half, run
 * *after* this (reverting first would already erase the `data/**` content
 * this reads), and then {@link finishRevert} (`cli.ts finish-revert
 * --manifest <file>`), which resolves the revert's conflicts and orphans
 * deterministically from the manifest this step writes (review N4).
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitAdapter, git } from "../git/gitAdapter.js";
import { ConfigEditError, reverseConfigEdits } from "./configEdit.js";
import { buildPlan } from "./plan.js";
import {
  classifyPath,
  isManagedPath,
  type MoveEditEntry,
  type MoveEntry,
  UnmappedPathError,
} from "./rules.js";

export class CarryBackError extends Error {}
export class FinishRevertError extends Error {}

export type CarryBackStatus = "A" | "M" | "D";

export interface CarryBackEntry {
  readonly p5Path: string;
  readonly legacyPath: string;
  readonly status: CarryBackStatus;
}

export interface CarryBackResult {
  readonly entries: readonly CarryBackEntry[];
  /** `HEAD` when carry-back ran (before its own commit) — `finishRevert` asserts the carry-back commit sits directly on it. */
  readonly head: string;
  /** `since`, resolved to a full commit sha. */
  readonly since: string;
  /**
   * Whether anything ended up staged (review round 3, M2). A delete-only
   * carry-back stages nothing: every D legacy path was already removed by
   * B. The carry-back commit must still exist (finish-revert anchors on it),
   * so the runbook always commits with `git commit --no-verify --allow-empty`.
   */
  readonly staged: boolean;
}

export interface CarryBackOptions {
  readonly git: GitAdapter;
  readonly cwd: string;
  /** The cutover commit B (or any ref) — every `data/**` change in `<since>..HEAD` is carried back. */
  readonly since: string;
  /**
   * Persists the manifest (review round 3, L3). Called after every check
   * has passed and before anything is staged, so an unwritable manifest
   * path refuses the call with the index untouched. A throw is reported as
   * a {@link CarryBackError}.
   */
  readonly writeManifest?: (manifest: CarryBackManifest) => void;
}

const DATA_PREFIXES = ["data/published/", "data/state/", "data/inputs/", "data/config/"] as const;

/**
 * The reverse of `rules.ts`'s forward table, implemented by structural
 * reconstruction plus round-trip verification: for a changed path under
 * `data/`, build the small set of *plausible* legacy-path reconstructions
 * (stripping the matching p5 root prefix and re-prepending the
 * corresponding legacy root), then accept the first one whose *forward*
 * {@link classifyPath} result actually produces this exact p5 path back
 * out. This never risks silently mis-mapping a path: either a candidate's
 * forward classification round-trips exactly, or none do and the caller
 * refuses — the forward table (already tested against the real repo in
 * `rules.realRepo.test.ts`) stays the single source of truth for what
 * maps to what.
 */
export function reverseMapDataPath(p5Path: string): MoveEntry | MoveEditEntry | undefined {
  const candidates: string[] = [];
  if (p5Path.startsWith(DATA_PREFIXES[0])) {
    candidates.push(`docs/${p5Path.slice(DATA_PREFIXES[0].length)}`);
  } else if (p5Path.startsWith(DATA_PREFIXES[1])) {
    candidates.push(`paperpilot/data/${p5Path.slice(DATA_PREFIXES[1].length)}`);
  } else if (p5Path.startsWith(DATA_PREFIXES[2])) {
    candidates.push(`paperpilot/output/${p5Path.slice(DATA_PREFIXES[2].length)}`);
  } else if (p5Path.startsWith(DATA_PREFIXES[3])) {
    const rest = p5Path.slice(DATA_PREFIXES[3].length);
    // Two plausible legacy roots share `data/config` as their p5
    // destination (`paperpilot/data/*` config files and the two
    // `paperpilot/*.yaml` collector configs plus `.env.example`) — try
    // both, keyed only by which one's forward classification round-trips.
    candidates.push(`paperpilot/data/${rest}`, `paperpilot/${rest}`);
  } else {
    return undefined;
  }

  for (const candidate of candidates) {
    let entry: ReturnType<typeof classifyPath>;
    try {
      entry = classifyPath(candidate);
    } catch (error) {
      if (error instanceof UnmappedPathError) continue;
      throw error;
    }
    if ((entry.class === "move" || entry.class === "moveEdit") && entry.dest === p5Path) {
      return entry;
    }
  }
  return undefined;
}

interface DiffEntry {
  readonly status: CarryBackStatus;
  readonly path: string;
}

interface IndexEntry {
  readonly mode: string;
  readonly sha: string;
}

/** Runs git and returns its raw (untrimmed) stdout, throwing `ErrorClass` on a non-zero exit. */
function gitRaw(
  adapter: GitAdapter,
  cwd: string,
  args: readonly string[],
  ErrorClass: new (message: string) => Error,
): string {
  const result = adapter.run(cwd, args);
  if (result.exitCode !== 0) {
    throw new ErrorClass(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Parses `git diff --no-renames --name-status -z` output. `-z` is what
 * keeps a non-ASCII path (for example `data/published/themes/café/…`)
 * byte-exact: without it git C-quotes the path (`"…caf\303\251…"`), the
 * quoted form matches no rule-table path, and the whole carry-back is
 * refused as unmapped. Each record is `<status>\0<path>\0`; a rename/copy
 * record (`<RNNN|CNNN>\0<from>\0<to>\0`) can only appear if
 * `--no-renames` was not honoured and is refused, as is every other
 * status that is not a plain A/M/D (for example `T`, a typechange such as
 * a regular file replaced by a symlink) — this tool only knows how to
 * replay plain adds, modifies and deletes.
 */
function parseDataDiff(out: string): DiffEntry[] {
  const tokens = out.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const entries: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i] as string;
    if (status.startsWith("R") || status.startsWith("C")) {
      throw new CarryBackError(
        `carry-back only understands plain add/modify/delete diff statuses, got "${status}" for ` +
          `${tokens[i + 1]} -> ${tokens[i + 2]} (a rename/copy status means --no-renames wasn't honoured)`,
      );
    }
    const path = tokens[i + 1];
    if (path === undefined) {
      throw new CarryBackError(`malformed git diff -z output: status "${status}" with no path`);
    }
    if (status !== "A" && status !== "M" && status !== "D") {
      throw new CarryBackError(
        `carry-back only understands plain add/modify/delete diff statuses, got "${status}" for ${path}`,
      );
    }
    entries.push({ status, path });
    i += 2;
  }
  return entries;
}

/** `git ls-tree -r -z <ref> -- <prefix>` as `path -> {mode, sha}` (blobs only). */
function readTree(
  adapter: GitAdapter,
  cwd: string,
  ref: string,
  prefixes: readonly string[],
  ErrorClass: new (message: string) => Error,
): Map<string, IndexEntry> {
  const out = gitRaw(adapter, cwd, ["ls-tree", "-r", "-z", ref, "--", ...prefixes], ErrorClass);
  const map = new Map<string, IndexEntry>();
  for (const record of out.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const [mode, , sha] = record.slice(0, tab).split(" ");
    if (tab === -1 || mode === undefined || sha === undefined) {
      throw new ErrorClass(`malformed git ls-tree -z record: ${JSON.stringify(record)}`);
    }
    map.set(record.slice(tab + 1), { mode, sha });
  }
  return map;
}

/**
 * Only plain files are carried back. A symlink (`120000`) or submodule
 * (`160000`) under `data/` has no faithful text-file replay; none exists
 * today, so meeting one is refused (fail closed) rather than flattened.
 */
const CARRYABLE_MODES = new Set(["100644", "100755"]);

/** Refuses (review LOW: "no clean-worktree precondition") rather than overwrite or half-move uncommitted/untracked state. */
function assertCleanWorktree(adapter: GitAdapter, cwd: string, label: string): void {
  const status = git(adapter, cwd, ["status", "--porcelain"]);
  if (status.length > 0) {
    throw new CarryBackError(
      `refusing to ${label}: the worktree is not clean (git status --porcelain is non-empty):\n${status}`,
    );
  }
}

/**
 * Carries every `data/**` change in `<since>..HEAD` back onto its legacy
 * path. Resolves every changed path's legacy mapping, its file mode and,
 * for a `moveEdit` config, its reverse-edited text, then writes the
 * manifest, all *before* mutating anything (refusing the whole call,
 * untouched, if any path has no mapping, is not a plain file, or changed a
 * moveEdit key after B, or the manifest cannot be written), same
 * fail-closed-and-atomic discipline as `apply`/`applyReverse`. Refuses a
 * dirty worktree.
 *
 * A plain `move` path is staged by blob id and mode (`git update-index
 * --cacheinfo`), so bytes and the executable bit are carried exactly (a
 * 755 -> 644 change too, which a write-then-`git add` over an existing
 * 755 file would silently keep). A `moveEdit` path (the two collector
 * configs) is rewritten through {@link reverseConfigEdits} first, then
 * staged with its mode set explicitly both ways.
 */
export function carryBack(options: CarryBackOptions): CarryBackResult {
  const { git: adapter, cwd, since } = options;

  assertCleanWorktree(adapter, cwd, "carry back");
  const head = git(adapter, cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const sinceSha = git(adapter, cwd, ["rev-parse", "--verify", `${since}^{commit}`]);

  const diffOut = gitRaw(
    adapter,
    cwd,
    ["diff", "--no-renames", "--name-status", "-z", sinceSha, "HEAD", "--", "data/"],
    CarryBackError,
  );
  const changes = parseDataDiff(diffOut);
  const headTree = readTree(adapter, cwd, "HEAD", ["data/"], CarryBackError);

  const resolved: {
    change: DiffEntry;
    entry: MoveEntry | MoveEditEntry;
    blob: IndexEntry | undefined;
    /** The reverse-edited text of a non-D `moveEdit` path, computed before anything is staged. */
    content: string | undefined;
  }[] = [];
  const problems: string[] = [];
  for (const change of changes) {
    const entry = reverseMapDataPath(change.path);
    if (entry === undefined) {
      problems.push(`  - ${change.path}: no legacy-path equivalent in the rule table`);
      continue;
    }
    const blob = change.status === "D" ? undefined : headTree.get(change.path);
    if (change.status !== "D" && (blob === undefined || !CARRYABLE_MODES.has(blob.mode))) {
      problems.push(
        `  - ${change.path}: mode ${blob?.mode ?? "<missing>"} is not a plain file (100644/100755)`,
      );
      continue;
    }
    let content: string | undefined;
    if (entry.class === "moveEdit" && change.status !== "D") {
      // Review round 3, L3 (a): computed here, not while staging, so a
      // post-B change to one of the edited keys (no exact reverse) refuses
      // the whole call before any earlier entry is staged.
      const raw = gitRaw(adapter, cwd, ["show", `HEAD:${change.path}`], CarryBackError);
      try {
        content = reverseConfigEdits(raw, entry.edits);
      } catch (error) {
        if (!(error instanceof ConfigEditError)) throw error;
        problems.push(
          `  - ${change.path}: its moveEdit keys cannot be reversed onto ${entry.path} ` +
            `(${error.message}); carry this change back by hand`,
        );
        continue;
      }
    }
    resolved.push({ change, entry, blob, content });
  }
  if (problems.length > 0) {
    throw new CarryBackError(
      `refusing to carry back: ${problems.length} path(s) under data/ changed since ${since} that ` +
        "cannot be replayed onto a legacy path (no legacy-path equivalent, not a plain file, or a " +
        `moveEdit key changed after B; never silently dropped):\n${problems.join("\n")}`,
    );
  }

  const entries: CarryBackEntry[] = resolved.map(({ change, entry }) => ({
    p5Path: change.path,
    legacyPath: entry.path,
    status: change.status,
  }));
  if (options.writeManifest !== undefined) {
    // Review round 3, L3 (b): the last check before the first mutation.
    try {
      options.writeManifest({ version: 1, since: sinceSha, head, entries });
    } catch (error) {
      throw new CarryBackError(
        `refusing to carry back: cannot write the manifest (${String(error)}); nothing was staged`,
      );
    }
  }

  for (const { change, entry, blob, content } of resolved) {
    if (change.status === "D" || blob === undefined) {
      // The legacy path was already absent (removed by the original B
      // move) in every real-world case this runs against; --ignore-unmatch
      // makes that a no-op instead of an error.
      git(adapter, cwd, ["rm", "-q", "--ignore-unmatch", "--", entry.path]);
    } else if (entry.class === "move") {
      git(adapter, cwd, [
        "update-index",
        "--add",
        "--cacheinfo",
        `${blob.mode},${blob.sha},${entry.path}`,
      ]);
      git(adapter, cwd, ["checkout", "--", entry.path]);
    } else {
      writeFileSync(join(cwd, entry.path), content as string, {
        mode: blob.mode === "100755" ? 0o755 : 0o644,
      });
      git(adapter, cwd, ["add", "--", entry.path]);
      git(adapter, cwd, [
        "update-index",
        `--chmod=${blob.mode === "100755" ? "+x" : "-x"}`,
        "--",
        entry.path,
      ]);
      git(adapter, cwd, ["checkout", "--", entry.path]);
    }
  }

  const staged = adapter.run(cwd, ["diff", "--cached", "--quiet"]).exitCode !== 0;
  return { entries, head, since: sinceSha, staged };
}

// ---------------------------------------------------------------------------
// The carry-back manifest (`carry-back --manifest <file>`)
// ---------------------------------------------------------------------------

/**
 * What `carry-back --manifest <file>` writes and `finish-revert
 * --manifest <file>` reads: the resolved cutover commit (`since`), the
 * `HEAD` carry-back ran on (its own commit must sit directly on top),
 * and every entry it replayed.
 */
export interface CarryBackManifest {
  readonly version: 1;
  readonly since: string;
  readonly head: string;
  readonly entries: readonly CarryBackEntry[];
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function buildManifest(result: CarryBackResult): CarryBackManifest {
  return { version: 1, since: result.since, head: result.head, entries: result.entries };
}

/**
 * Parses and strictly validates a manifest. Every entry must round-trip
 * through {@link reverseMapDataPath} to the same legacy path, so a
 * hand-edited or truncated manifest is refused instead of steering
 * `finishRevert`'s `git rm`/`git checkout` at arbitrary paths.
 */
export function parseManifest(text: string): CarryBackManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FinishRevertError(`manifest is not valid JSON: ${String(error)}`);
  }
  const m = value as Partial<CarryBackManifest> | null;
  if (typeof m !== "object" || m === null || m.version !== 1) {
    throw new FinishRevertError(
      "manifest: expected an object with version 1 (from carry-back --manifest)",
    );
  }
  if (typeof m.since !== "string" || !SHA_RE.test(m.since)) {
    throw new FinishRevertError(
      `manifest: "since" must be a full commit sha, got ${JSON.stringify(m.since)}`,
    );
  }
  if (typeof m.head !== "string" || !SHA_RE.test(m.head)) {
    throw new FinishRevertError(
      `manifest: "head" must be a full commit sha, got ${JSON.stringify(m.head)}`,
    );
  }
  if (!Array.isArray(m.entries)) {
    throw new FinishRevertError('manifest: "entries" must be an array');
  }
  const entries: CarryBackEntry[] = [];
  for (const raw of m.entries as unknown[]) {
    const e = raw as Partial<CarryBackEntry> | null;
    if (
      typeof e !== "object" ||
      e === null ||
      typeof e.p5Path !== "string" ||
      typeof e.legacyPath !== "string" ||
      (e.status !== "A" && e.status !== "M" && e.status !== "D")
    ) {
      throw new FinishRevertError(`manifest: malformed entry ${JSON.stringify(raw)}`);
    }
    if (reverseMapDataPath(e.p5Path)?.path !== e.legacyPath) {
      throw new FinishRevertError(
        `manifest: entry ${e.p5Path} -> ${e.legacyPath} does not match the rule table's reverse mapping`,
      );
    }
    entries.push({ p5Path: e.p5Path, legacyPath: e.legacyPath, status: e.status });
  }
  return { version: 1, since: m.since, head: m.head, entries };
}

// ---------------------------------------------------------------------------
// finishRevert (p5-plan.md §6.2 R-B step 4c, review finding N4)
// ---------------------------------------------------------------------------

export interface FinishRevertOptions {
  readonly git: GitAdapter;
  readonly cwd: string;
  readonly manifest: CarryBackManifest;
}

export interface FinishRevertResult {
  /** Paths removed from the index and worktree (p5 paths, D legacy paths, resurrected or mis-merged leftovers). */
  readonly removed: readonly string[];
  /** Paths set to their expected blob and mode (A/M legacy paths, and any path the revert merged wrongly). */
  readonly restored: readonly string[];
}

/** The index as `path -> {mode, sha}` for stage 0, plus every path with a conflict stage. */
function readIndex(
  adapter: GitAdapter,
  cwd: string,
): { stage0: Map<string, IndexEntry>; unmerged: Set<string> } {
  const out = gitRaw(adapter, cwd, ["ls-files", "-s", "-z"], FinishRevertError);
  const stage0 = new Map<string, IndexEntry>();
  const unmerged = new Set<string>();
  for (const record of out.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const [mode, sha, stage] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (tab === -1 || mode === undefined || sha === undefined || stage === undefined) {
      throw new FinishRevertError(`malformed git ls-files -s -z record: ${JSON.stringify(record)}`);
    }
    if (stage === "0") stage0.set(path, { mode, sha });
    else unmerged.add(path);
  }
  return { stage0, unmerged };
}

function nameList(adapter: GitAdapter, cwd: string, args: readonly string[]): string[] {
  return gitRaw(adapter, cwd, args, FinishRevertError)
    .split("\0")
    .filter((p) => p.length > 0);
}

function list(paths: Iterable<string>): string {
  return [...paths].map((p) => `  - ${p}`).join("\n");
}

function sameEntry(a: IndexEntry | undefined, b: IndexEntry | undefined): boolean {
  return a?.mode === b?.mode && a?.sha === b?.sha;
}

/** Runs `git <prefix> <paths…>` in bounded argv chunks. */
function gitChunked(
  adapter: GitAdapter,
  cwd: string,
  prefix: readonly string[],
  items: readonly string[],
): void {
  for (let i = 0; i < items.length; i += 200) {
    git(adapter, cwd, [...prefix, ...items.slice(i, i + 200)]);
  }
}

/**
 * The tree `finishRevert` must leave, over the paths it owns:
 *  - nothing under `data/`;
 *  - for a manifest legacy path: the carry-back commit's (`HEAD`'s) entry
 *    for A/M, nothing for D;
 *  - for any other path B touched that has not changed since B (`HEAD`
 *    equals `<mergeB>`): the pre-B (`<mergeB>^1`) entry — a pure revert;
 *  - for any other legacy managed path (`docs/`, `paperpilot/data/`, …):
 *    `HEAD`'s entry (B did not touch it, so the revert must not either).
 * A path B touched that *did* change after B outside `data/` and the
 * legacy roots (for example a workflow edited after the cutover) is left
 * to `git revert`'s own merge: not owned here.
 */
function expectedOwnedEntries(
  adapter: GitAdapter,
  cwd: string,
  manifest: CarryBackManifest,
  indexPaths: Iterable<string>,
): Map<string, IndexEntry | undefined> {
  const base = git(adapter, cwd, ["rev-parse", "--verify", `${manifest.since}^1`]);
  const touchedByB = nameList(adapter, cwd, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    base,
    manifest.since,
  ]);
  const baseTree = readTree(adapter, cwd, base, [], FinishRevertError);
  const bTree = readTree(adapter, cwd, manifest.since, [], FinishRevertError);
  const headTree = readTree(adapter, cwd, "HEAD", [], FinishRevertError);
  const byLegacy = new Map(manifest.entries.map((e) => [e.legacyPath, e]));
  const touched = new Set(touchedByB);

  const expected = new Map<string, IndexEntry | undefined>();
  const candidates = new Set([
    ...touchedByB,
    ...byLegacy.keys(),
    ...manifest.entries.map((e) => e.p5Path),
    ...headTree.keys(),
    ...indexPaths,
  ]);
  for (const path of candidates) {
    const entry = byLegacy.get(path);
    if (path.startsWith("data/")) {
      expected.set(path, undefined);
    } else if (entry !== undefined) {
      expected.set(path, entry.status === "D" ? undefined : headTree.get(path));
    } else if (touched.has(path)) {
      if (isManagedPath(path) || sameEntry(headTree.get(path), bTree.get(path))) {
        expected.set(path, baseTree.get(path));
      }
    } else if (isManagedPath(path)) {
      expected.set(path, headTree.get(path));
    }
  }
  return expected;
}

/** `git rev-parse --verify -q <rev>`, or `undefined` when it does not resolve (for example `HEAD~2` on a short history). */
function tryRevParse(adapter: GitAdapter, cwd: string, rev: string): string | undefined {
  const result = adapter.run(cwd, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function hasDataPaths(adapter: GitAdapter, cwd: string, rev: string): boolean {
  return readTree(adapter, cwd, rev, ["data/"], FinishRevertError).size > 0;
}

/** `rev` holds nothing under `data/` while its first parent does: the shape of a committed revert of B. */
function looksLikeRevertOfB(adapter: GitAdapter, cwd: string, rev: string): boolean {
  return !hasDataPaths(adapter, cwd, rev) && hasDataPaths(adapter, cwd, `${rev}^1`);
}

/**
 * The `[no-carry-back-commit]` remedy when the manifest has an A or M
 * entry (review round 4, H1): `git revert --abort` also discards the
 * staged-but-uncommitted carry-back, so an `--allow-empty` commit made
 * after it holds none of the carried content. The carry-back has to be
 * staged again (or, with no revert in progress, committed as it stands).
 *
 * Every carry-back commit here uses `git commit --no-verify` (review
 * round 5, L4): the repo's pre-commit hooks reject any added file over
 * 500 KB (`check-added-large-files --maxkb=500`, no `exclude`) and rewrite
 * trailing whitespace / a missing final newline (`end-of-file-fixer`,
 * `trailing-whitespace`). A carried-back catalog (for example
 * `docs/<conf>/papers.json`) routinely exceeds 500 KB, so the hooks would
 * either reject the commit outright or rewrite a carried file's bytes —
 * either way making HEAD's content no longer match what `carry-back`
 * staged, exactly the state {@link assertHeadHoldsCarriedContent}'s
 * `[carry-back-incomplete]` check exists to refuse.
 */
function redoCarryBackRemedy(manifest: CarryBackManifest): string {
  return (
    "The manifest has added or modified entries, so an empty commit is NOT the fix: the " +
    "carry-back was staged but never committed. If a revert is in progress, `git revert --abort` " +
    "(this also discards the staged carry-back), then rerun " +
    `\`dataMove carry-back --since ${manifest.since} --manifest <the same file>\`, then ` +
    '`git commit --no-verify --allow-empty -m "rollback: carry back data since B"`. If no revert ' +
    "is in progress and `git diff --cached` still shows the carry-back, " +
    "`git commit --no-verify --allow-empty` commits it. Then redo `git revert --no-commit -m 1` " +
    "and finish-revert"
  );
}

/**
 * Review round 4, H1: `HEAD` (the carry-back commit) must actually hold
 * every manifest entry, before anything is resolved. Without this, an
 * empty carry-back commit made over an A/M manifest made every A/M legacy
 * path's expected entry "absent", so finish-revert deleted the collector
 * config and state and its own final self-check agreed:
 *  - A/M `move`: `HEAD:<legacyPath>` has the blob and mode of
 *    `<manifest.head>:<p5Path>`;
 *  - A/M `moveEdit`: same mode, and the content equals
 *    {@link reverseConfigEdits} of that blob;
 *  - D: `HEAD` has no `<legacyPath>`.
 * Compatible with the `[commits-in-between]` remedy: a rerun carry-back
 * over legacy paths that already hold the content stages nothing, yet
 * `HEAD` still holds the right blobs.
 */
function assertHeadHoldsCarriedContent(
  adapter: GitAdapter,
  cwd: string,
  manifest: CarryBackManifest,
): void {
  // The whole tree, not a pathspec per entry: a large manifest would overflow argv.
  const headTree = readTree(adapter, cwd, "HEAD", [], FinishRevertError);
  const sourceTree = readTree(adapter, cwd, manifest.head, ["data/"], FinishRevertError);
  const show = (e: IndexEntry | undefined) => (e ? `${e.mode} ${e.sha}` : "<absent>");
  const problems: string[] = [];
  for (const entry of manifest.entries) {
    const have = headTree.get(entry.legacyPath);
    if (entry.status === "D") {
      if (have !== undefined) {
        problems.push(`${entry.legacyPath}: a carried-back deletion, but HEAD has ${show(have)}`);
      }
      continue;
    }
    const source = sourceTree.get(entry.p5Path);
    const rule = reverseMapDataPath(entry.p5Path);
    if (source === undefined || rule === undefined) {
      problems.push(`${entry.p5Path}: absent from ${manifest.head}, which carry-back read it from`);
      continue;
    }
    if (rule.class === "move") {
      if (!sameEntry(have, source)) {
        problems.push(
          `${entry.legacyPath}: expected ${show(source)} (from ${entry.p5Path}), HEAD has ${show(have)}`,
        );
      }
      continue;
    }
    if (have === undefined || have.mode !== source.mode) {
      problems.push(
        `${entry.legacyPath}: expected mode ${source.mode} (from ${entry.p5Path}), HEAD has ${show(have)}`,
      );
      continue;
    }
    let want: string;
    try {
      want = reverseConfigEdits(
        gitRaw(adapter, cwd, ["show", `${manifest.head}:${entry.p5Path}`], FinishRevertError),
        rule.edits,
      );
    } catch (error) {
      if (!(error instanceof ConfigEditError)) throw error;
      problems.push(
        `${entry.legacyPath}: ${entry.p5Path} cannot be reverse-edited (${error.message})`,
      );
      continue;
    }
    if (gitRaw(adapter, cwd, ["show", `HEAD:${entry.legacyPath}`], FinishRevertError) !== want) {
      problems.push(`${entry.legacyPath}: content differs from the reverse-edited ${entry.p5Path}`);
    }
  }
  if (problems.length > 0) {
    throw new FinishRevertError(
      "refusing to finish [carry-back-incomplete]: HEAD does not hold the carried-back content, " +
        "so the carry-back commit is incomplete (for example an empty commit made after " +
        "`git revert --abort` discarded the staged carry-back). Nothing was changed. Do not reset: " +
        "run `git revert --abort` if a revert is in progress, then rerun " +
        `\`dataMove carry-back --since ${manifest.since} --manifest <the same file>\` from the ` +
        "current HEAD (a new manifest), commit with `git commit --no-verify --allow-empty -m " +
        '"rollback: carry back data since B"`, then redo `git revert --no-commit -m 1` and ' +
        `finish-revert:\n${list(problems)}`,
    );
  }
}

/**
 * Review round 3, M2: `HEAD` must be the carry-back commit, sitting
 * directly on the manifest's `head`. The three ways it can fail need
 * different remedies, so each gets its own message, keyed by a tag the
 * runbook (p5-plan.md §6.2 R-B step 4c) maps to a remedy:
 *
 *  - `[no-carry-back-commit]`: `HEAD` is still `manifest.head`. Nothing
 *    to reset. If the manifest holds deletions only, the carry-back staged
 *    nothing and a plain `git commit` made no commit: abort the revert,
 *    commit with `--allow-empty`, redo the revert. Otherwise the carry-back
 *    was staged but never committed, and `git revert --abort` discards it,
 *    so it must be rerun before the `--allow-empty` commit (review round
 *    4, H1; see {@link redoCarryBackRemedy}).
 *  - `[revert-auto-committed]`: `HEAD` is a committed revert of B, and
 *    `HEAD^` is the carry-back commit on `manifest.head`. Only then is
 *    dropping `HEAD` safe, and only with `git reset --keep HEAD^`.
 *  - `[commits-in-between]`: anything else. Never reset; abort the revert
 *    and rerun carry-back from the current `HEAD`.
 */
function assertHeadIsCarryBackCommit(
  adapter: GitAdapter,
  cwd: string,
  manifest: CarryBackManifest,
): void {
  const head = git(adapter, cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const deleteOnly = manifest.entries.every((e) => e.status === "D");
  if (head === manifest.head) {
    throw new FinishRevertError(
      `refusing to finish [no-carry-back-commit]: HEAD is still ${manifest.head}, the commit ` +
        "carry-back ran on, so there is no carry-back commit on top of it. Do not reset anything. " +
        (deleteOnly
          ? "The manifest holds deletions only, so the carry-back staged nothing and `git commit` " +
            "without --allow-empty made no commit: run `git revert --abort` (if a revert is in " +
            "progress), then `git commit --no-verify --allow-empty`, then redo " +
            "`git revert --no-commit -m 1` and finish-revert"
          : redoCarryBackRemedy(manifest)),
    );
  }
  const legacyPaths = new Set(manifest.entries.map((e) => e.legacyPath));
  const changedOutsideManifest = (from: string, to: string): string[] =>
    nameList(adapter, cwd, ["diff", "--no-renames", "--name-only", "-z", from, to]).filter(
      (p) => !legacyPaths.has(p),
    );

  const headParent = git(adapter, cwd, ["rev-parse", "--verify", "HEAD^1"]);
  if (headParent !== manifest.head) {
    if (
      tryRevParse(adapter, cwd, "HEAD~2") === manifest.head &&
      changedOutsideManifest(manifest.head, "HEAD~1").length === 0 &&
      looksLikeRevertOfB(adapter, cwd, "HEAD")
    ) {
      throw new FinishRevertError(
        `refusing to finish [revert-auto-committed]: HEAD^ is ${headParent}, but the carry-back ` +
          `ran on ${manifest.head}. HEAD is a committed revert of B (git revert ran without ` +
          "--no-commit) on top of the carry-back commit. Drop only that revert commit with " +
          "`git reset --keep HEAD^`, then redo `git revert --no-commit -m 1` and finish-revert",
      );
    }
    throw new FinishRevertError(
      `refusing to finish [commits-in-between]: HEAD^ is ${headParent}, but the carry-back ran on ` +
        `${manifest.head}; HEAD must be the carry-back commit itself, with nothing in between. ` +
        "Do not reset over these commits: run `git revert --abort` if a revert is in progress, " +
        "then redo carry-back (a new manifest) from the current HEAD",
    );
  }
  const strays = changedOutsideManifest("HEAD^1", "HEAD");
  if (strays.length > 0) {
    const hint = looksLikeRevertOfB(adapter, cwd, "HEAD")
      ? " HEAD looks like a committed revert of B made with no carry-back commit under it: " +
        "`git reset --keep HEAD^`, then " +
        (deleteOnly
          ? "`git commit --no-verify --allow-empty` (the manifest holds deletions only), then redo the revert " +
            "with --no-commit and finish-revert."
          : `rerun \`dataMove carry-back --since ${manifest.since} --manifest <the same file>\` ` +
            "(the manifest has added or modified entries, which an empty commit would not hold), " +
            "commit with `git commit --no-verify --allow-empty`, then redo the revert with --no-commit and " +
            "finish-revert.")
      : "";
    throw new FinishRevertError(
      "refusing to finish: HEAD changes path(s) the manifest does not name, so it is not the " +
        `carry-back commit:\n${list(strays)}${hint === "" ? "" : `\n${hint.trim()}`}`,
    );
  }
}

/**
 * `cli.ts finish-revert --manifest <file>` (p5-plan.md §6.2 R-B step 4c,
 * review finding N4): run after the carry-back commit and
 * `git revert --no-commit -m 1 <mergeB>` (always `--no-commit`, so the
 * index is left staged whether or not the revert conflicted).
 *
 * It does not trust how `git revert` resolved the data paths. The
 * revert's rename detection pairs identical blobs arbitrarily (the
 * cutover moves many byte-identical files, for example `{}` stubs), so it
 * can both conflict (a post-B deletion surfaces as a rename/delete `DU`
 * that resurrects the pre-B file) and silently merge a post-B change
 * into the *wrong* legacy file. Instead, every path it owns (see
 * {@link expectedOwnedEntries}) is set to the entry the manifest and the
 * pre-B tree dictate: post-B deletions stay deleted, post-B additions
 * exist only at their legacy path, nothing remains under `data/`, and
 * B's own deletions (`docs/search-index.json` v1, `docs/daily/papers.json`)
 * come back exactly as at `<mergeB>^1`.
 *
 * Stages only; the caller commits once. Fails closed:
 *  - before touching anything, when `HEAD` is not the carry-back commit
 *    (see {@link assertHeadIsCarryBackCommit}: no carry-back commit at
 *    all, a revert that auto-committed, or commits in between; or `HEAD`
 *    changes a path the manifest does not name), when `HEAD` does not hold
 *    every manifest entry's carried content (`[carry-back-incomplete]`, see
 *    {@link assertHeadHoldsCarriedContent}), or nothing is staged (the
 *    revert has not run);
 *  - after resolving, when a conflicted path remains that it does not own
 *    (an unrelated structural conflict needs a human), anything remains
 *    under `data/` (tracked or untracked), or an owned path still differs
 *    from its expected entry.
 */
export function finishRevert(options: FinishRevertOptions): FinishRevertResult {
  const { git: adapter, cwd, manifest } = options;

  assertHeadIsCarryBackCommit(adapter, cwd, manifest);
  assertHeadHoldsCarriedContent(adapter, cwd, manifest);
  const before = readIndex(adapter, cwd);
  const staged = adapter.run(cwd, ["diff", "--cached", "--quiet"]).exitCode !== 0;
  if (!staged && before.unmerged.size === 0) {
    throw new FinishRevertError(
      `refusing to finish: nothing is staged; run \`git revert --no-commit -m 1 ${manifest.since}\` first`,
    );
  }

  // B also moves files to destinations outside data/ (the three head
  // assets to apps/web/static/assets/, the frozen site to
  // legacy/gh-pages-site/). carry-back only reads data/, so a post-B change
  // to one of those would be silently replaced by its pre-B content below.
  // Refuse instead.
  const base = git(adapter, cwd, ["rev-parse", "--verify", `${manifest.since}^1`]);
  const nonDataDests = new Set(
    buildPlan({ paths: [...readTree(adapter, cwd, base, [], FinishRevertError).keys()] })
      .entries.flatMap((e) => (e.class === "move" || e.class === "moveEdit" ? [e.dest] : []))
      .filter((dest) => !dest.startsWith("data/")),
  );
  const uncarried = nameList(adapter, cwd, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    manifest.since,
    manifest.head,
  ]).filter((p) => nonDataDests.has(p));
  if (uncarried.length > 0) {
    throw new FinishRevertError(
      "refusing to finish: path(s) B moved outside data/ changed after B; carry-back does not " +
        `carry these, so the revert would silently drop the change (resolve by hand):\n${list(uncarried)}`,
    );
  }

  const expected = expectedOwnedEntries(adapter, cwd, manifest, [
    ...before.stage0.keys(),
    ...before.unmerged,
  ]);
  const removed: string[] = [];
  const restored: string[] = [];
  for (const [path, want] of [...expected.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = before.stage0.get(path);
    if (!before.unmerged.has(path) && sameEntry(have, want)) continue;
    if (want === undefined) removed.push(path);
    else restored.push(path);
  }
  const reset = [...removed, ...restored];
  // `git rm --cached` clears every stage (conflicts included); the worktree is fixed below.
  gitChunked(adapter, cwd, ["rm", "-q", "-f", "--cached", "--ignore-unmatch", "--"], reset);
  for (const path of removed) rmSync(join(cwd, path), { force: true });
  for (let i = 0; i < restored.length; i += 200) {
    const cacheinfo = restored.slice(i, i + 200).flatMap((path) => {
      const want = expected.get(path) as IndexEntry;
      return ["--cacheinfo", `${want.mode},${want.sha},${path}`];
    });
    git(adapter, cwd, ["update-index", "--add", ...cacheinfo]);
  }
  gitChunked(adapter, cwd, ["checkout", "--"], restored);

  const after = readIndex(adapter, cwd);
  if (after.unmerged.size > 0) {
    throw new FinishRevertError(
      `refusing to finish: ${after.unmerged.size} conflicted path(s) the carry-back manifest does ` +
        `not explain (resolve by hand, then rerun):\n${list(after.unmerged)}`,
    );
  }
  const dataLeftover = [
    ...[...after.stage0.keys()].filter((p) => p.startsWith("data/")),
    ...nameList(adapter, cwd, ["ls-files", "-z", "--others", "--exclude-standard", "--", "data/"]),
  ];
  if (dataLeftover.length > 0) {
    throw new FinishRevertError(
      "refusing to finish: path(s) remain under data/ after the revert and cleanup (expected none " +
        `once the legacy structural revert is complete):\n${list(dataLeftover)}`,
    );
  }
  const mismatches: string[] = [];
  for (const [path, want] of expected) {
    const have = after.stage0.get(path);
    if (!sameEntry(have, want)) {
      const show = (e: IndexEntry | undefined) => (e ? `${e.mode} ${e.sha}` : "<absent>");
      mismatches.push(`${path}: expected ${show(want)}, index has ${show(have)}`);
    }
  }
  if (mismatches.length > 0) {
    throw new FinishRevertError(
      `refusing to finish: ${mismatches.length} path(s) differ from "pre-B tree + carried-back ` +
        `changes" (nothing committed; inspect with git status):\n${list(mismatches.sort())}`,
    );
  }

  return { removed, restored };
}
