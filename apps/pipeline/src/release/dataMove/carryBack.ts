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
 * at all — the real R-B runbook (p5-plan.md §6.2) pairs this with a plain
 * `git revert -m 1 <mergeB>` for that structural half, run *after* this
 * (reverting first would already erase the `data/**` content this reads).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GitAdapter, git } from "../git/gitAdapter.js";
import { reverseConfigEdits } from "./configEdit.js";
import { classifyPath, type MoveEditEntry, type MoveEntry, UnmappedPathError } from "./rules.js";

export class CarryBackError extends Error {}

export type CarryBackStatus = "A" | "M" | "D";

export interface CarryBackEntry {
  readonly p5Path: string;
  readonly legacyPath: string;
  readonly status: CarryBackStatus;
}

export interface CarryBackResult {
  readonly entries: readonly CarryBackEntry[];
}

export interface CarryBackOptions {
  readonly git: GitAdapter;
  readonly cwd: string;
  /** The cutover commit B (or any ref) — every `data/**` change in `<since>..HEAD` is carried back. */
  readonly since: string;
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

function parseDataDiff(out: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const raw of out.split("\n")) {
    if (raw.length === 0) continue;
    const tab = raw.indexOf("\t");
    if (tab === -1) continue;
    const status = raw.slice(0, tab);
    const path = raw.slice(tab + 1);
    if (status !== "A" && status !== "M" && status !== "D") {
      throw new CarryBackError(
        `carry-back only understands plain add/modify/delete diff statuses, got "${status}" for ${path} ` +
          "(a rename/copy status would mean --no-renames wasn't honoured)",
      );
    }
    entries.push({ status, path });
  }
  return entries;
}

function readRepoFile(cwd: string, rel: string, content: string): void {
  const full = join(cwd, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function showRaw(adapter: GitAdapter, cwd: string, ref: string): string {
  const result = adapter.run(cwd, ["show", ref]);
  if (result.exitCode !== 0) {
    throw new CarryBackError(`git show ${ref} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Carries every `data/**` change in `<since>..HEAD` back onto its legacy
 * path. Resolves every changed path's legacy mapping *before* mutating
 * anything (refusing the whole call, untouched, if any path has none),
 * same fail-closed-and-atomic discipline as `apply`/`applyReverse`.
 */
export function carryBack(options: CarryBackOptions): CarryBackResult {
  const { git: adapter, cwd, since } = options;

  const diffOut = git(adapter, cwd, [
    "diff",
    "--no-renames",
    "--name-status",
    since,
    "HEAD",
    "--",
    "data/",
  ]);
  const changes = parseDataDiff(diffOut);

  const resolved: { change: DiffEntry; entry: MoveEntry | MoveEditEntry }[] = [];
  const unmapped: string[] = [];
  for (const change of changes) {
    const entry = reverseMapDataPath(change.path);
    if (entry === undefined) {
      unmapped.push(change.path);
    } else {
      resolved.push({ change, entry });
    }
  }
  if (unmapped.length > 0) {
    throw new CarryBackError(
      `refusing to carry back: ${unmapped.length} path(s) under data/ changed since ${since} with ` +
        "no legacy-path equivalent in the rule table (never silently dropped):\n" +
        unmapped.map((p) => `  - ${p}`).join("\n"),
    );
  }

  const entries: CarryBackEntry[] = [];
  for (const { change, entry } of resolved) {
    if (change.status === "D") {
      // The legacy path was already absent (removed by the original B
      // move) in every real-world case this runs against; --ignore-unmatch
      // makes that a no-op instead of an error.
      git(adapter, cwd, ["rm", "--ignore-unmatch", "--", entry.path]);
    } else {
      const raw = showRaw(adapter, cwd, `HEAD:${change.path}`);
      const content = entry.class === "moveEdit" ? reverseConfigEdits(raw, entry.edits) : raw;
      readRepoFile(cwd, entry.path, content);
      git(adapter, cwd, ["add", "--", entry.path]);
    }
    entries.push({ p5Path: change.path, legacyPath: entry.path, status: change.status });
  }

  return { entries };
}
