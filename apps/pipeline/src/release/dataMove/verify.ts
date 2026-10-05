/**
 * `cli.ts verify <before> <after>` (p5-plan.md §5.2): proves, from two
 * commits alone (never from a live working tree), that the move happened
 * exactly as the rule table says and nothing else changed.
 *
 * The authoritative proof is per-rule `git ls-tree` blob-SHA equality
 * (§5.2 bullet 2) — *not* `git diff`'s rename pairing, which is a
 * similarity heuristic: several of the moved files are byte-identical
 * (the six empty conference `lineage.json` stubs, every `.gitkeep`), so
 * git is free to pair e.g. `docs/cvpr-2025/lineage.json`'s deletion with
 * `data/published/icml-2025/lineage.json`'s addition and still report
 * "100% similar, zero differences" truthfully while disagreeing with this
 * table's *specific* pairing. `git diff --name-status -M` is used only as
 * a second, set-based check ("did anything outside the expected change
 * set move/change at all"), never as the source of the manifest.
 */

import type { GitAdapter } from "../git/gitAdapter.js";
import { git } from "../git/gitAdapter.js";
import { applyConfigEdits, ConfigEditError } from "./configEdit.js";
import { applyGitignorePatch, GitignorePatchError } from "./gitignorePatch.js";
import { flipLayoutModeToP5, LayoutFlipError } from "./layoutFlip.js";
import { buildPlan, planIsClean } from "./plan.js";
import { isManagedPath, type RuleClass, type RuleEntry } from "./rules.js";

export interface ManifestEntry {
  readonly path: string;
  readonly dest: string | null;
  readonly class: RuleClass;
  readonly blobSha: string | null;
}

export interface VerifyCounts {
  readonly beforeManagedTotal: number;
  readonly moved: number;
  readonly moveEdited: number;
  readonly stayed: number;
  readonly deleted: number;
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly manifest: readonly ManifestEntry[];
  readonly counts: VerifyCounts;
}

export interface VerifyOptions {
  readonly git: GitAdapter;
  readonly cwd: string;
  readonly before: string;
  readonly after: string;
}

function lsTree(adapter: GitAdapter, cwd: string, ref: string): Map<string, string> {
  const out = git(adapter, cwd, ["ls-tree", "-r", "--full-tree", ref]);
  const map = new Map<string, string>();
  if (out.length === 0) return map;
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    const sha = meta[2];
    const path = line.slice(tab + 1);
    if (sha) map.set(path, sha);
  }
  return map;
}

function showRaw(adapter: GitAdapter, cwd: string, ref: string): string {
  const result = adapter.run(cwd, ["show", ref]);
  if (result.exitCode !== 0) {
    throw new Error(`git show ${ref} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const GITIGNORE_REL = ".gitignore";
const LAYOUT_REL = "packages/core/src/layout/index.ts";
const WORKFLOWS_P5_PREFIX = ".github/workflows-p5/";
const WORKFLOWS_PREFIX = ".github/workflows/";
const DELETED_WORKFLOW_NAMES = ["ts-ci.yml", "publish.yml", "paper-slides-on-demand.yml"];

interface DiffLine {
  readonly status: string;
  readonly src: string;
  readonly dst: string;
}

function parseNameStatus(out: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of out.split("\n")) {
    if (raw.length === 0) continue;
    const cols = raw.split("\t");
    const status = cols[0] as string;
    if (status.startsWith("R") || status.startsWith("C")) {
      lines.push({ status, src: cols[1] as string, dst: cols[2] as string });
    } else {
      lines.push({ status, src: cols[1] as string, dst: cols[1] as string });
    }
  }
  return lines;
}

/** Verifies `<before>` -> `<after>` against the rule table reclassified from `<before>`'s own tree (never the live working tree). */
export function verifyMove(options: VerifyOptions): VerifyReport {
  const { git: adapter, cwd, before, after } = options;
  const problems: string[] = [];

  const beforeTree = lsTree(adapter, cwd, before);
  const afterTree = lsTree(adapter, cwd, after);

  const beforeManagedPaths = [...beforeTree.keys()].filter(isManagedPath);
  const plan = buildPlan({ paths: beforeManagedPaths });
  if (!planIsClean(plan)) {
    for (const p of plan.problems) problems.push(`plan: [${p.kind}] ${p.message}`);
    return {
      ok: false,
      problems,
      manifest: [],
      counts: {
        beforeManagedTotal: beforeManagedPaths.length,
        moved: 0,
        moveEdited: 0,
        stayed: 0,
        deleted: 0,
      },
    };
  }

  const manifest: ManifestEntry[] = [];
  let moved = 0;
  let moveEdited = 0;
  let stayed = 0;
  let deleted = 0;

  for (const entry of plan.entries) {
    if (entry.class === "move") {
      const srcSha = beforeTree.get(entry.path) ?? null;
      const destSha = afterTree.get(entry.dest) ?? null;
      if (afterTree.has(entry.path)) {
        problems.push(`move ${entry.path}: source still present in <after>`);
      }
      if (destSha === null) {
        problems.push(`move ${entry.path}: destination ${entry.dest} missing from <after>`);
      } else if (destSha !== srcSha) {
        problems.push(
          `move ${entry.path}: blob SHA changed (${srcSha} -> ${destSha}) — content was not preserved`,
        );
      }
      manifest.push({ path: entry.path, dest: entry.dest, class: entry.class, blobSha: srcSha });
      moved++;
    } else if (entry.class === "stay") {
      const beforeSha = beforeTree.get(entry.path) ?? null;
      const afterSha = afterTree.get(entry.path) ?? null;
      if (afterSha === null) {
        problems.push(`stay ${entry.path}: missing from <after>`);
      } else if (afterSha !== beforeSha) {
        problems.push(`stay ${entry.path}: changed unexpectedly (${beforeSha} -> ${afterSha})`);
      }
      manifest.push({ path: entry.path, dest: null, class: entry.class, blobSha: beforeSha });
      stayed++;
    } else if (entry.class === "delete") {
      if (afterTree.has(entry.path)) {
        problems.push(`delete ${entry.path}: still present in <after>`);
      }
      manifest.push({
        path: entry.path,
        dest: null,
        class: entry.class,
        blobSha: beforeTree.get(entry.path) ?? null,
      });
      deleted++;
    } else {
      // moveEdit
      if (afterTree.has(entry.path)) {
        problems.push(`moveEdit ${entry.path}: source still present in <after>`);
      }
      const destSha = afterTree.get(entry.dest) ?? null;
      if (destSha === null) {
        problems.push(`moveEdit ${entry.path}: destination ${entry.dest} missing from <after>`);
      } else {
        try {
          const beforeContent = showRaw(adapter, cwd, `${before}:${entry.path}`);
          const afterContent = showRaw(adapter, cwd, `${after}:${entry.dest}`);
          const recomputed = applyConfigEdits(beforeContent, entry.edits);
          if (recomputed !== afterContent) {
            problems.push(
              `moveEdit ${entry.path}: <after> content does not equal the allowed-key transform of ` +
                "<before> (something outside allowedKeys changed, or an edit didn't apply as expected)",
            );
          }
        } catch (error) {
          if (error instanceof ConfigEditError) {
            problems.push(`moveEdit ${entry.path}: ${error.message}`);
          } else {
            throw error;
          }
        }
      }
      manifest.push({
        path: entry.path,
        dest: entry.dest,
        class: entry.class,
        blobSha: beforeTree.get(entry.path) ?? null,
      });
      moveEdited++;
    }
  }

  // The LAYOUT_MODE flip.
  try {
    const beforeLayout = showRaw(adapter, cwd, `${before}:${LAYOUT_REL}`);
    const afterLayout = showRaw(adapter, cwd, `${after}:${LAYOUT_REL}`);
    if (flipLayoutModeToP5(beforeLayout) !== afterLayout) {
      problems.push(
        `${LAYOUT_REL}: <after> does not equal the single-literal LAYOUT_MODE flip of <before>`,
      );
    }
  } catch (error) {
    if (error instanceof LayoutFlipError) {
      problems.push(`${LAYOUT_REL}: ${error.message}`);
    } else {
      throw error;
    }
  }

  // .gitignore.
  try {
    const beforeGitignore = showRaw(adapter, cwd, `${before}:${GITIGNORE_REL}`);
    const afterGitignore = showRaw(adapter, cwd, `${after}:${GITIGNORE_REL}`);
    if (applyGitignorePatch(beforeGitignore) !== afterGitignore) {
      problems.push(`${GITIGNORE_REL}: <after> does not equal the expected patch of <before>`);
    }
  } catch (error) {
    if (error instanceof GitignorePatchError) {
      problems.push(`${GITIGNORE_REL}: ${error.message}`);
    } else {
      throw error;
    }
  }

  // Workflow staging swap.
  const stagedBefore = [...beforeTree.keys()].filter((p) => p.startsWith(WORKFLOWS_P5_PREFIX));
  if (stagedBefore.length > 0) {
    for (const p of stagedBefore) {
      const name = p.slice(WORKFLOWS_P5_PREFIX.length);
      const dest = `${WORKFLOWS_PREFIX}${name}`;
      if (afterTree.has(p)) {
        problems.push(
          `workflow swap: ${p} should have moved out of workflows-p5 but is still in <after>`,
        );
      }
      const destSha = afterTree.get(dest);
      if (destSha === undefined) {
        problems.push(`workflow swap: expected ${dest} in <after>`);
      } else if (destSha !== beforeTree.get(p)) {
        problems.push(`workflow swap: ${dest} content does not match staged ${p}`);
      }
    }
    for (const name of DELETED_WORKFLOW_NAMES) {
      if (afterTree.has(`${WORKFLOWS_PREFIX}${name}`)) {
        problems.push(`workflow swap: ${WORKFLOWS_PREFIX}${name} should have been deleted`);
      }
    }
  } else {
    for (const name of DELETED_WORKFLOW_NAMES) {
      const p = `${WORKFLOWS_PREFIX}${name}`;
      if (beforeTree.has(p) && beforeTree.get(p) !== afterTree.get(p)) {
        problems.push(`workflow swap: ${p} changed even though the swap should have been skipped`);
      }
    }
  }

  // Set-based completeness/no-extra-changes check via `git diff`.
  const allowedTouched = new Set<string>();
  for (const entry of plan.entries as readonly RuleEntry[]) {
    if (entry.class === "move" || entry.class === "moveEdit") {
      allowedTouched.add(entry.path);
      allowedTouched.add(entry.dest);
    } else if (entry.class === "delete") {
      allowedTouched.add(entry.path);
    }
  }
  allowedTouched.add(GITIGNORE_REL);
  allowedTouched.add(LAYOUT_REL);
  for (const p of stagedBefore) {
    allowedTouched.add(p);
    allowedTouched.add(`${WORKFLOWS_PREFIX}${p.slice(WORKFLOWS_P5_PREFIX.length)}`);
  }
  if (stagedBefore.length > 0) {
    for (const name of DELETED_WORKFLOW_NAMES) allowedTouched.add(`${WORKFLOWS_PREFIX}${name}`);
  }

  const diffOut = git(adapter, cwd, ["diff", "--name-status", "-M", "-l0", before, after]);
  const diffLines = parseNameStatus(diffOut);
  const touched = new Set<string>();
  for (const line of diffLines) {
    touched.add(line.src);
    touched.add(line.dst);
    if (!allowedTouched.has(line.src) || !allowedTouched.has(line.dst)) {
      problems.push(
        `unexpected change outside the allowlist: ${line.status}\t${line.src}\t${line.dst}`,
      );
    }
  }
  for (const expected of allowedTouched) {
    if (!touched.has(expected)) {
      problems.push(`expected ${expected} to change between <before> and <after>, but it did not`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    manifest,
    counts: { beforeManagedTotal: beforeManagedPaths.length, moved, moveEdited, stayed, deleted },
  };
}
