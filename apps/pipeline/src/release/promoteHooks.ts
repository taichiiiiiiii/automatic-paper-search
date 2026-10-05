/**
 * Promoter hooks (p5-plan.md §2 A3, detailed in §3) — follow-up #3 of
 * docs/migration/p4-followups.md: `promote.ts`'s `refreshSharedOutputs` /
 * `validatePromotedTree` had no real implementation, only throwing
 * defaults (see that file's module doc comment). This module is the real
 * implementation: per-kind ordered command tables that spawn the
 * PROMOTED TREE'S OWN CLIs (never the job checkout's) with `cwd` set to
 * that tree, after `pnpm install --frozen-lockfile --offline` runs there
 * first — matching the shell original's `cd "$tree" && uv run …` (§3
 * "Principle"): refresh and validate must run the fresh tip's code and
 * tests, not whatever this process happened to be built from.
 *
 * **Path-resolution correction (reported in this changeset's handback,
 * not a silent deviation):** §3's refresh table literally reads `pnpm
 * --filter @paperpilot/pipeline exec tsx <file>` with file paths relative
 * to `apps/pipeline/`, while step 7 of the validate table
 * (`tsx src/release/cli.ts validate bundle apps/web/out`) has an argument
 * (`apps/web/out`) that lives OUTSIDE `apps/pipeline/`. `pnpm --filter
 * @paperpilot/pipeline exec` chdirs the spawned process into
 * `apps/pipeline/` before running it, so under that literal form step 7's
 * `apps/web/out` argument would resolve to the nonexistent
 * `apps/pipeline/apps/web/out`. This module instead spawns every pipeline
 * CLI as `pnpm exec tsx apps/pipeline/src/<file>` (no `--filter`, so pnpm
 * does not chdir) with the spawn's own `cwd` always set to `tree` — the
 * repo root — so every path argument (`apps/web/out` included) resolves
 * the same way a human reading the table would expect, and matches §4's
 * own convention for the Node workflow `run:` steps ("pnpm exec tsx
 * apps/pipeline/src/..."). This keeps the single invariant the tests
 * pin — every spawned command's `cwd` is exactly `tree` — true for every
 * row, themes/conference/validate alike, with no special case.
 *
 * `apps/pipeline/src/release/derived/identityLiteCli.ts` (§3 conference
 * refresh row 2, `--as-of $AS_OF`) is referenced here BY PATH ONLY: a
 * sibling P5 changeset (A2) is adding that file, which does not exist yet
 * as of this module's own test run. It is intentionally not carved out
 * with `it.skip` (this repo's own `no-skip-gate` would flag that) —
 * `promoteHooks.test.ts` documents the gap in a plain comment instead.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { layoutFor } from "@paperpilot/core/layout";
import {
  PromotionError,
  type PromotionKind,
  type RefreshContext,
  type RefreshSharedOutputsFn,
  type ValidateContext,
  type ValidatePromotedTreeFn,
} from "./promote.js";

/** One command, as an argv array (never a shell string — see gitAdapter.ts's own rationale, PUB-22 analogue). */
export type Command = readonly string[];

export interface SpawnResult {
  readonly exitCode: number;
}

/** Injectable process spawner. Real implementation: {@link createRealSpawn}. */
export type SpawnFn = (argv: Command, options: { cwd: string }) => SpawnResult;

/**
 * Real spawner: shells out with `stdio: "inherit"` (these commands —
 * install, build, test, lint, the pipeline CLIs — are never handed a
 * secret, unlike A4's network commands, so their output can stream
 * straight to the promoter job's own log) and NO timeout. The gitAdapter
 * module bounds single `git` subcommands to 120s because a wedged
 * network call has no legitimate reason to run that long; `pnpm -r test`
 * and the `apps/web` build do not share that property (A11 expects tens
 * of minutes), so this spawner relies on the *job's own* `timeout-minutes`
 * (set from A11's measurements) rather than imposing a second, shorter
 * one here that could not know in advance how long real work takes.
 */
export function createRealSpawn(): SpawnFn {
  return (argv, options) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      throw new PromotionError("promoteHooks: empty command");
    }
    const proc = spawnSync(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: process.env,
    });
    if (proc.error) {
      throw proc.error;
    }
    return { exitCode: proc.status ?? 1 };
  };
}

/** `pnpm exec tsx <relFromRepoRoot> <...args>` — see the module doc comment's path-resolution correction. */
function pnpmExecTsx(relFromRepoRoot: string, args: readonly string[] = []): Command {
  return ["pnpm", "exec", "tsx", relFromRepoRoot, ...args];
}

const PNPM_INSTALL: Command = ["pnpm", "install", "--frozen-lockfile", "--offline"];

/**
 * §3 refresh table, themes/conference. `tree` is used only to compute
 * default *argument values* via {@link layoutFor} (e.g. `--themes-dir`) —
 * every command is still spawned with `cwd: tree` by the caller, never by
 * baking a cwd into the argv itself.
 */
export function refreshCommandsFor(kind: PromotionKind, tree: string, asOf: string): Command[] {
  if (kind === "test-only") return [];
  const layout = layoutFor(tree);
  if (kind === "themes") {
    const themesDir = join(layout.published, "themes");
    return [
      PNPM_INSTALL,
      pnpmExecTsx("apps/pipeline/src/lineage/theme/generateThemesManifestCli.ts", [
        "--themes-dir",
        themesDir,
      ]),
      pnpmExecTsx("apps/pipeline/src/lineage/theme/computeThemeQualityCli.ts"),
      pnpmExecTsx("apps/pipeline/src/lineage/quality/buildLineageQualityCli.ts", ["--as-of", asOf]),
    ];
  }
  // kind === "conference"
  return [
    PNPM_INSTALL,
    pnpmExecTsx("apps/pipeline/src/catalog/buildPagesCli.ts"),
    // apps/pipeline/src/release/derived/identityLiteCli.ts -- added by a
    // sibling P5 changeset (A2). Referenced by path only; see module doc.
    pnpmExecTsx("apps/pipeline/src/release/derived/identityLiteCli.ts", ["--as-of", asOf]),
    pnpmExecTsx("apps/pipeline/src/release/derived/searchIndexCli.ts"),
    pnpmExecTsx("apps/pipeline/src/lineage/quality/buildLineageQualityCli.ts", ["--as-of", asOf]),
  ];
}

/**
 * §3 validate table — identical steps for both `themes` and `conference`.
 *
 * **Order correction (reported in this changeset's handback, not a
 * silent deviation — same pattern as this module's path-resolution
 * correction above):** p5-plan.md §3 literally lists `pnpm -r test`
 * (step 2) BEFORE `pnpm --filter @paperpilot/web build` (step 6). The
 * P5 tier-A review (H2/M5) found that ordering fail-closed: several
 * `apps/web` tests (csp, head-metadata, sitemap, redirects, paper-links
 * build safety, …) are `it.skipIf(!existsSync(OUT_DIR/…))`, so on a
 * fresh worktree with no prior `apps/web/out` they report `skipped`,
 * and this validate table's own `no-skip-gate` equivalent inside `pnpm
 * -r test`'s reporter would then fail every promotion for a reason
 * that has nothing to do with the promoted data. This table instead
 * runs the web build right after `biome check .` and before `pnpm -r
 * test`, so every build-output-dependent test actually exercises real
 * output on every validate run, matching `tests.yml`'s own order
 * (`ts-ci.yml`'s replacement, per the same review) instead of the
 * plan's literal text.
 */
export function validateCommandsFor(kind: PromotionKind, _tree: string): Command[] {
  if (kind === "test-only") return [];
  return [
    ["pnpm", "exec", "biome", "check", "."],
    ["pnpm", "--filter", "@paperpilot/web", "build"],
    ["pnpm", "-r", "test"],
    pnpmExecTsx("apps/pipeline/src/lineage/theme/auditThemeSeedsCli.ts"),
    pnpmExecTsx("apps/pipeline/src/lineage/quality/auditLineageQualityCli.ts"),
    pnpmExecTsx("apps/pipeline/src/release/derived/searchIndexCli.ts", ["--check"]),
    pnpmExecTsx("apps/pipeline/src/release/cli.ts", ["validate", "bundle", "apps/web/out"]),
  ];
}

export type RefreshCommandsFor = typeof refreshCommandsFor;
export type ValidateCommandsFor = typeof validateCommandsFor;

/**
 * `async` so a command failure ALWAYS surfaces as a rejected promise,
 * never a synchronous throw from calling the hook itself. `promote.ts`
 * is itself `async` and would convert either shape into the same
 * rejection, but a plain (non-`async`) function that throws synchronously
 * is a sharp edge for any OTHER caller that does `expect(hook(ctx)).rejects
 * .toThrow(...)` or otherwise expects a thenable back immediately — the
 * exception would fire before `hook(ctx)` ever returns a value to wrap.
 */
async function runTable(spawn: SpawnFn, tree: string, commands: readonly Command[]): Promise<void> {
  for (const argv of commands) {
    const result = spawn(argv, { cwd: tree });
    if (result.exitCode !== 0) {
      throw new PromotionError(
        `promoteHooks: \`${argv.join(" ")}\` exited ${result.exitCode} (cwd ${tree})`,
      );
    }
  }
}

/**
 * Builds the real `refreshSharedOutputs` hook for `promote()`.
 * `commandsFor` is overridable so tests (and the A3 integration test's
 * stub table) never have to run the real pipeline CLIs end to end.
 */
export function createRefreshHook(
  spawn: SpawnFn,
  options: { commandsFor?: RefreshCommandsFor } = {},
): RefreshSharedOutputsFn {
  const commandsFor = options.commandsFor ?? refreshCommandsFor;
  return async (ctx: RefreshContext): Promise<void> => {
    await runTable(spawn, ctx.tree, commandsFor(ctx.kind, ctx.tree, ctx.asOf));
  };
}

/** Builds the real `validatePromotedTree` hook for `promote()`. */
export function createValidateHook(
  spawn: SpawnFn,
  options: { commandsFor?: ValidateCommandsFor } = {},
): ValidatePromotedTreeFn {
  const commandsFor = options.commandsFor ?? validateCommandsFor;
  return async (ctx: ValidateContext): Promise<void> => {
    await runTable(spawn, ctx.tree, commandsFor(ctx.kind, ctx.tree));
  };
}
