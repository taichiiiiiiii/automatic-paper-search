/**
 * Builds and validates the data-move plan (p5-plan.md §5.2 `cli.ts plan`):
 * classify every path, then check the three invariants the plan requires
 * before any `git mv`/`git rm` is allowed to run — no unmapped path, no
 * two sources mapping to the same destination, no destination that already
 * exists. Pure (no `node:fs`/`git` calls) except for the injectable
 * `destinationExists` callback, so this is unit-testable against a plain
 * string array and also exercised directly against the real repository's
 * `git ls-files` output (read-only) in tests.
 */

import { classifyPath, type RuleEntry, UnmappedPathError } from "./rules.js";

export interface PlanProblem {
  readonly kind: "unmapped" | "collision" | "destination-exists";
  readonly message: string;
}

export interface DataMovePlan {
  readonly entries: readonly RuleEntry[];
  readonly problems: readonly PlanProblem[];
}

export interface PlanOptions {
  readonly paths: readonly string[];
  /** Defaults to "is `dest` one of the input `paths`" (a pre-existing tracked file at that location). */
  readonly destinationExists?: (dest: string) => boolean;
}

/** Classifies every path and checks the plan invariants. Never throws — problems are collected, not raised, so `plan` can report all of them at once. */
export function buildPlan(options: PlanOptions): DataMovePlan {
  const pathSet = new Set(options.paths);
  const destinationExists = options.destinationExists ?? ((dest: string) => pathSet.has(dest));

  const entries: RuleEntry[] = [];
  const problems: PlanProblem[] = [];
  const destToSources = new Map<string, string[]>();

  for (const path of options.paths) {
    try {
      const entry = classifyPath(path);
      entries.push(entry);
      if (entry.class === "move" || entry.class === "moveEdit") {
        const existing = destToSources.get(entry.dest) ?? [];
        existing.push(entry.path);
        destToSources.set(entry.dest, existing);
      }
    } catch (error) {
      if (error instanceof UnmappedPathError) {
        problems.push({ kind: "unmapped", message: error.message });
      } else {
        throw error;
      }
    }
  }

  for (const [dest, sources] of destToSources) {
    if (sources.length > 1) {
      problems.push({
        kind: "collision",
        message: `${sources.length} sources map to the same destination ${dest}: ${sources.join(", ")}`,
      });
    }
    if (destinationExists(dest)) {
      problems.push({ kind: "destination-exists", message: `destination already exists: ${dest}` });
    }
  }

  return { entries, problems };
}

export function planIsClean(plan: DataMovePlan): boolean {
  return plan.problems.length === 0;
}
