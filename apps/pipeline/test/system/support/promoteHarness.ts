/**
 * Drives `release/promote.ts` (the real compare-and-swap promoter) against
 * a {@link Sandbox}'s bare `origin`, with the real `refreshCommandsFor`
 * table. Two deliberate differences from CI, both about cost, not logic:
 *
 *  - `pnpm install` is dropped and `pnpm exec tsx <cli>` runs as
 *    `node <tree>/<cli>` with tsx preloaded (same CLI file, same cwd);
 *  - the validate table runs the data audits only (auditThemeSeeds,
 *    auditLineageQuality, searchIndex --check for conferences), not
 *    biome / the web build / `pnpm -r test`, which the normal `tests`
 *    job already covers for the code under test.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createGitAdapter } from "../../../src/release/git/gitAdapter.js";
import { type PromoteResult, type PromotionKind, promote } from "../../../src/release/promote.js";
import {
  type Command,
  createRefreshHook,
  createValidateHook,
  refreshCommandsFor,
  type SpawnFn,
} from "../../../src/release/promoteHooks.js";
import { PRELOAD, toolchainEnv } from "./runCli.js";
import type { Sandbox } from "./sandbox.js";

export interface SpawnRecord {
  argv: readonly string[];
  cwd: string;
  exitCode: number;
  output: string;
}

/** `pnpm exec tsx <rel> …` -> `node <cwd>/<rel> …` (tsx + no-network fixture layer preloaded). */
export function nodeTsxSpawn(log: SpawnRecord[]): SpawnFn {
  return (argv, { cwd }) => {
    let cmd = argv;
    if (argv[0] === "pnpm" && argv[1] === "exec" && argv[2] === "tsx") {
      cmd = [process.execPath, ...argv.slice(3)];
    }
    const [bin, ...args] = cmd as [string, ...string[]];
    const r = spawnSync(bin, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...toolchainEnv(),
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        TZ: "UTC",
        // Refresh/validate never need the network: no fixture dirs = every
        // request is a recorded miss that rejects.
        NODE_OPTIONS: `--max-old-space-size=1024 --import tsx --import ${pathToFileURL(PRELOAD).href}`,
        PAPERPILOT_FIXTURE_DIRS: "",
      },
    });
    const exitCode = r.status ?? 1;
    log.push({ argv, cwd, exitCode, output: `${r.stdout ?? ""}${r.stderr ?? ""}` });
    return { exitCode };
  };
}

export function refreshWithoutInstall(kind: PromotionKind, tree: string, asOf: string): Command[] {
  return refreshCommandsFor(kind, tree, asOf).filter(
    (c) => !(c[0] === "pnpm" && c[1] === "install"),
  );
}

export function dataAuditCommands(kind: PromotionKind): Command[] {
  const tsx = (rel: string, args: string[] = []): Command => ["pnpm", "exec", "tsx", rel, ...args];
  if (kind === "themes") {
    return [
      tsx("apps/pipeline/src/lineage/theme/auditThemeSeedsCli.ts"),
      tsx("apps/pipeline/src/lineage/quality/auditLineageQualityCli.ts", ["--themes-only"]),
    ];
  }
  return [
    tsx("apps/pipeline/src/lineage/quality/auditLineageQualityCli.ts"),
    tsx("apps/pipeline/src/release/derived/searchIndexCli.ts", ["--check"]),
  ];
}

export async function promoteInSandbox(
  sb: Sandbox,
  opts: {
    kind: PromotionKind;
    candidateDir: string;
    allowedPaths: string[];
    baseSha: string;
    asOf: string;
    log: SpawnRecord[];
  },
): Promise<PromoteResult> {
  const spawn = nodeTsxSpawn(opts.log);
  return promote({
    kind: opts.kind,
    candidateDir: opts.candidateDir,
    commitMessage: `data(${opts.kind}): system test`,
    allowedPaths: opts.allowedPaths,
    git: createGitAdapter(),
    cwd: sb.root,
    promoteAsOf: opts.asOf,
    promoteBaseSha: opts.baseSha,
    promoteMaxAttempts: 1,
    promoteNoSleep: true,
    refreshSharedOutputs: createRefreshHook(spawn, { commandsFor: refreshWithoutInstall }),
    validatePromotedTree: createValidateHook(spawn, {
      commandsFor: (kind) => dataAuditCommands(kind),
    }),
    tmpDir: sb.path(".."),
  });
}

/** Read a file as committed on the sandbox origin's `develop`. */
export function originFile(sb: Sandbox, rel: string): string {
  const r = spawnSync("git", ["--git-dir", sb.origin, "show", `develop:${rel}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git show develop:${rel}: ${r.stderr}`);
  return r.stdout;
}
