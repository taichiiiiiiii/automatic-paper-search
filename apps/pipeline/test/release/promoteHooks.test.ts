/**
 * p5-plan.md §2 A3 / §3 — promoter hooks. Three layers:
 *   1. The command tables themselves equal an expected ordered list,
 *      pinned against promote-generated.sh's own order (minus the
 *      dropped steps, per §3's table).
 *   2. `createRefreshHook`/`createValidateHook` with a FAKE spawn: `cwd`
 *      is recorded for every call, a non-zero exit short-circuits and
 *      throws `PromotionError` without running later commands.
 *   3. An integration test on the existing bare-remote "world" fixture
 *      (same pattern as promote.test.ts), using the REAL spawn with a
 *      tiny stub command table override — never the real pipeline CLIs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_MODE, layoutFor, relLayout } from "@paperpilot/core/layout";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGitAdapter, git } from "../../src/release/git/gitAdapter.js";
import { PromotionError, promote } from "../../src/release/promote.js";
import {
  type Command,
  createRealSpawn,
  createRefreshHook,
  createValidateHook,
  refreshCommandsFor,
  type SpawnFn,
  validateCommandsFor,
} from "../../src/release/promoteHooks.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TREE = "/tmp/some-promoted-tree";
const AS_OF = "2026-08-30T00:00:00Z";

// ---- 1. command tables pinned to an expected ordered list ----

it("themes refresh table matches §3's ordered list", () => {
  const table = refreshCommandsFor("themes", TREE, AS_OF);
  expect(table).toEqual([
    ["pnpm", "install", "--frozen-lockfile", "--offline"],
    [
      "pnpm",
      "exec",
      "tsx",
      "apps/pipeline/src/lineage/theme/generateThemesManifestCli.ts",
      "--themes-dir",
      join(layoutFor(TREE).published, "themes"),
    ],
    ["pnpm", "exec", "tsx", "apps/pipeline/src/lineage/theme/computeThemeQualityCli.ts"],
    [
      "pnpm",
      "exec",
      "tsx",
      "apps/pipeline/src/lineage/quality/buildLineageQualityCli.ts",
      "--as-of",
      AS_OF,
    ],
  ]);
});

it("conference refresh table matches §3's ordered list", () => {
  const table = refreshCommandsFor("conference", TREE, AS_OF);
  expect(table).toEqual([
    ["pnpm", "install", "--frozen-lockfile", "--offline"],
    ["pnpm", "exec", "tsx", "apps/pipeline/src/catalog/buildPagesCli.ts"],
    [
      "pnpm",
      "exec",
      "tsx",
      "apps/pipeline/src/release/derived/identityLiteCli.ts",
      "--as-of",
      AS_OF,
    ],
    ["pnpm", "exec", "tsx", "apps/pipeline/src/release/derived/searchIndexCli.ts"],
    [
      "pnpm",
      "exec",
      "tsx",
      "apps/pipeline/src/lineage/quality/buildLineageQualityCli.ts",
      "--as-of",
      AS_OF,
    ],
  ]);
});

it("test-only refresh/validate tables are empty (zero-spawn no-op)", () => {
  expect(refreshCommandsFor("test-only", TREE, AS_OF)).toEqual([]);
  expect(validateCommandsFor("test-only", TREE)).toEqual([]);
});

// M5 (P5 tier-A review): the web build must run BEFORE `pnpm -r test`,
// not after (p5-plan.md §3's literal order) -- several apps/web tests
// are `it.skipIf(!existsSync(OUT_DIR))` and would silently report
// "skipped" instead of exercising real build output on a fresh
// worktree, which the no-skip-gate-equivalent in `pnpm -r test` would
// then fail for the wrong reason. See promoteHooks.ts's own doc
// comment on `validateCommandsFor` for the full rationale.
it("validate table (same for both kinds) matches §3's ordered list, built BEFORE tested (M5)", () => {
  const expected: Command[] = [
    ["pnpm", "exec", "biome", "check", "."],
    ["pnpm", "--filter", "@paperpilot/web", "build"],
    ["pnpm", "-r", "test"],
    ["pnpm", "exec", "tsx", "apps/pipeline/src/lineage/theme/auditThemeSeedsCli.ts"],
    ["pnpm", "exec", "tsx", "apps/pipeline/src/lineage/quality/auditLineageQualityCli.ts"],
    ["pnpm", "exec", "tsx", "apps/pipeline/src/release/derived/searchIndexCli.ts", "--check"],
    [
      "pnpm",
      "exec",
      "tsx",
      "apps/pipeline/src/release/cli.ts",
      "validate",
      "bundle",
      "apps/web/out",
    ],
  ];
  expect(validateCommandsFor("themes", TREE)).toEqual(expected);
  expect(validateCommandsFor("conference", TREE)).toEqual(expected);
});

it("the web build step precedes `pnpm -r test` in the validate table (M5, explicit index check)", () => {
  const table = validateCommandsFor("conference", TREE);
  const buildIndex = table.findIndex(
    (cmd) => cmd[0] === "pnpm" && cmd[1] === "--filter" && cmd[2] === "@paperpilot/web",
  );
  const testIndex = table.findIndex(
    (cmd) => cmd[0] === "pnpm" && cmd[1] === "-r" && cmd[2] === "test",
  );
  expect(buildIndex).toBeGreaterThanOrEqual(0);
  expect(testIndex).toBeGreaterThanOrEqual(0);
  expect(buildIndex).toBeLessThan(testIndex);
});

// ---- 2. fake spawn: cwd recorded, non-zero exit short-circuits ----

function fakeSpawn(exitCodes: Record<string, number> = {}): {
  spawn: SpawnFn;
  calls: Array<{ argv: Command; cwd: string }>;
} {
  const calls: Array<{ argv: Command; cwd: string }> = [];
  const spawn: SpawnFn = (argv, options) => {
    calls.push({ argv, cwd: options.cwd });
    const key = argv.join(" ");
    return { exitCode: exitCodes[key] ?? 0 };
  };
  return { spawn, calls };
}

it("createRefreshHook records cwd === tree for every command", async () => {
  const { spawn, calls } = fakeSpawn();
  const hook = createRefreshHook(spawn);
  await hook({ tree: TREE, kind: "themes", asOf: AS_OF });
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.cwd).toBe(TREE);
  }
});

it("createValidateHook records cwd === tree for every command", async () => {
  const { spawn, calls } = fakeSpawn();
  const hook = createValidateHook(spawn);
  await hook({ tree: TREE, kind: "conference" });
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.cwd).toBe(TREE);
  }
});

it("a failing refresh command throws PromotionError and never runs later commands", async () => {
  const table = refreshCommandsFor("themes", TREE, AS_OF);
  const failingKey = table[1]!.join(" "); // generateThemesManifestCli step
  const { spawn, calls } = fakeSpawn({ [failingKey]: 1 });
  const hook = createRefreshHook(spawn);
  await expect(hook({ tree: TREE, kind: "themes", asOf: AS_OF })).rejects.toThrow(PromotionError);
  // Only the install step (index 0) and the failing step (index 1) ran;
  // computeThemeQualityCli / buildLineageQualityCli (indices 2-3) did not.
  expect(calls.length).toBe(2);
});

it("a failing validate command throws PromotionError and never runs later commands", async () => {
  const table = validateCommandsFor("themes", TREE);
  const failingKey = table[0]!.join(" "); // biome check .
  const { spawn, calls } = fakeSpawn({ [failingKey]: 1 });
  const hook = createValidateHook(spawn);
  await expect(hook({ tree: TREE, kind: "themes" })).rejects.toThrow(PromotionError);
  expect(calls.length).toBe(1);
});

it("test-only spawns nothing for either hook", async () => {
  const { spawn, calls } = fakeSpawn();
  await createRefreshHook(spawn)({ tree: TREE, kind: "test-only", asOf: AS_OF });
  await createValidateHook(spawn)({ tree: TREE, kind: "test-only" });
  expect(calls.length).toBe(0);
});

// ---- 3. integration: real spawn, stub table, bare-remote world ----

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const adapter = createGitAdapter();
function gitRun(cwd: string, args: string[]): string {
  return git(adapter, cwd, args, { env: GIT_ENV });
}

interface World {
  base: string;
  remote: string;
  checkout: string;
  candidate: string;
}

let world: World;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "paperpilot-promote-hooks-world-"));
  const remote = join(base, "remote.git");
  mkdirSync(remote);
  gitRun(remote, ["init", "--bare", "--initial-branch=develop"]);

  const checkout = join(base, "checkout");
  mkdirSync(checkout);
  gitRun(checkout, ["init", "--initial-branch=develop"]);
  gitRun(checkout, ["remote", "add", "origin", remote]);
  // Seeds every `themes` SHARED_PATHS entry for the CURRENT LAYOUT_MODE
  // (promote.ts's `sharedPathsForMode`) so the integration test's `git add
  // -A -- <sharedPaths>` step has something to match for each path, even
  // though the stub refresh table below only touches
  // `themes-manifest.json` -- exactly like a real repo after at least one
  // prior promotion. Legacy keeps two extra entries
  // (`assets/versions.json`, `sitemap.xml`) that p5 drops (p5-plan.md §3:
  // "sync_asset_versions"/"build_sitemap" are no longer generated/promoted).
  const publishedDir = layoutFor(checkout).published;
  mkdirSync(join(publishedDir, "themes"), { recursive: true });
  writeFileSync(join(publishedDir, "themes", "themes-manifest.json"), "{}\n");
  writeFileSync(join(publishedDir, "themes", "_quality.json"), "{}\n");
  writeFileSync(join(publishedDir, "lineage-quality-v1.json"), "{}\n");
  if (LAYOUT_MODE === "legacy") {
    mkdirSync(join(publishedDir, "assets"), { recursive: true });
    writeFileSync(join(publishedDir, "assets", "versions.json"), "{}\n");
    writeFileSync(join(publishedDir, "sitemap.xml"), "<urlset></urlset>\n");
  }
  gitRun(checkout, ["add", "."]);
  gitRun(checkout, ["commit", "-m", "seed"]);
  gitRun(checkout, ["push", "-u", "origin", "develop"]);

  const candidate = join(base, "candidate");
  const target = join(candidate, "docs", "themes", "new-theme");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "lineage.json"), '{"nodes":[],"edges":[]}\n');

  world = { base, remote, checkout, candidate };
});

afterEach(() => {
  rmSync(world.base, { recursive: true, force: true });
});

function baseSha(): string {
  return gitRun(world.checkout, ["rev-parse", "HEAD"]);
}

it("integration: a themes promotion with a stub refresh/validate table that writes into a SHARED_PATHS file succeeds and pushes", async () => {
  const spawn = createRealSpawn();
  // The stub table writes into layout.published/themes/themes-manifest.json
  // -- a `themes` SHARED_PATHS entry (promote.ts), so the write is staged
  // and committed alongside the candidate. It only works because `cwd` is
  // really `tree` (a relative path resolves against the process cwd the
  // real spawn was given).
  const themesManifestRel = `${relLayout(LAYOUT_MODE).published}/themes/themes-manifest.json`;
  const stubRefresh = [
    [
      "node",
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(themesManifestRel)}, JSON.stringify({refreshed: true}))`,
    ],
  ] satisfies Command[];
  const stubValidate: Command[] = [["node", "-e", "process.exit(0)"]];

  const result = await promote({
    kind: "themes",
    candidateDir: world.candidate,
    commitMessage: "data(test): promoteHooks integration",
    allowedPaths: ["docs/themes/new-theme"],
    git: adapter,
    cwd: world.checkout,
    promoteBaseSha: baseSha(),
    promoteMaxAttempts: 1,
    promoteNoSleep: true,
    refreshSharedOutputs: createRefreshHook(spawn, { commandsFor: () => stubRefresh }),
    validatePromotedTree: createValidateHook(spawn, { commandsFor: () => stubValidate }),
  });

  expect(result.changed).toBe(true);
  const verify = join(world.base, "verify");
  gitRun(world.base, ["clone", world.remote, verify]);
  expect(
    JSON.parse(
      readFileSync(join(layoutFor(verify).published, "themes", "themes-manifest.json"), "utf-8"),
    ),
  ).toEqual({ refreshed: true });
  expect(
    readFileSync(join(verify, "docs", "themes", "new-theme", "lineage.json"), "utf-8"),
  ).toContain("nodes");
});

it("integration: a stub table command exiting non-zero rejects the promotion, pushing nothing", async () => {
  const before = gitRun(world.remote, ["rev-parse", "develop"]);
  const spawn = createRealSpawn();
  const stubRefresh: Command[] = [["node", "-e", "process.exit(3)"]];

  await expect(
    promote({
      kind: "themes",
      candidateDir: world.candidate,
      commitMessage: "data(test): promoteHooks integration failure",
      allowedPaths: ["docs/themes/new-theme"],
      git: adapter,
      cwd: world.checkout,
      promoteBaseSha: baseSha(),
      promoteMaxAttempts: 1,
      promoteNoSleep: true,
      refreshSharedOutputs: createRefreshHook(spawn, { commandsFor: () => stubRefresh }),
      validatePromotedTree: createValidateHook(spawn, { commandsFor: () => [] }),
    }),
  ).rejects.toThrow(PromotionError);

  expect(gitRun(world.remote, ["rev-parse", "develop"])).toBe(before);
});
