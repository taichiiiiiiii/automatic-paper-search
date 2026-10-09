import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findTestPackageDirs,
  rehearseSteps,
  runRehearsal,
} from "../../../src/release/dataMove/rehearse.js";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PACKAGES = ["apps/api", "apps/pipeline", "apps/web", "packages/core"];

describe("rehearseSteps", () => {
  it("installs offline, applies the move, commits, verifies, builds, tests with the JSON reporter, then runs the no-skip gate", () => {
    const steps = rehearseSteps("/some/clone/path", PACKAGES);
    expect(steps.map((s) => s.join(" "))).toEqual([
      "pnpm install --offline --frozen-lockfile",
      "pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts apply --confirm-delete docs/daily/papers.json",
      "git -C /some/clone/path -c user.name=p5-rehearsal -c user.email=p5-rehearsal@local commit -q -m p5 rehearsal: apply data move (scratch commit, never pushed)",
      "pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts verify HEAD~1 HEAD",
      "pnpm --filter @paperpilot/web build",
      "pnpm -r --if-present test --reporter=default --reporter=json --outputFile.json=.vitest-release-report.json",
      "pnpm exec tsx apps/pipeline/src/release/cli.ts no-skip-gate " +
        "apps/api/.vitest-release-report.json apps/pipeline/.vitest-release-report.json " +
        "apps/web/.vitest-release-report.json packages/core/.vitest-release-report.json",
    ]);
  });

  it("RED/GREEN (review N1): never forwards a literal `--` to pnpm (vitest would ignore the reporter flags)", () => {
    for (const step of rehearseSteps("/x", PACKAGES)) {
      if (step[0] === "pnpm") expect(step).not.toContain("--");
    }
  });

  it("refuses an empty package list (the gate would check nothing)", () => {
    expect(() => rehearseSteps("/x", [])).toThrow(/no workspace package/);
  });

  it("installs before apply (apply needs node_modules resolved to import @paperpilot/core/layout)", () => {
    const steps = rehearseSteps("/x", PACKAGES);
    const installIndex = steps.findIndex((s) => s[0] === "pnpm" && s[1] === "install");
    const applyIndex = steps.findIndex((s) => s.includes("apply"));
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(applyIndex).toBeGreaterThan(installIndex);
  });

  it("verifies before building, and builds before testing (apps/web's own tests need apps/web/out already built)", () => {
    const steps = rehearseSteps("/x", PACKAGES);
    const verifyIndex = steps.findIndex((s) => s.includes("verify"));
    const buildIndex = steps.findIndex((s) => s.includes("build"));
    const testIndex = steps.findIndex((s) => s[0] === "pnpm" && s[1] === "-r");
    const gateIndex = steps.findIndex((s) => s.includes("no-skip-gate"));
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(verifyIndex);
    expect(testIndex).toBeGreaterThan(buildIndex);
    expect(gateIndex).toBe(steps.length - 1);
    expect(gateIndex).toBeGreaterThan(testIndex);
  });
});

describe("findTestPackageDirs", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rehearse-ws-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function pkg(dir: string, scripts: Record<string, string>): void {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir, scripts }));
  }

  it("lists exactly the apps/* and packages/* packages with a test script, sorted", () => {
    pkg("apps/web", { test: "vitest run" });
    pkg("apps/api", { test: "vitest run" });
    pkg("apps/docs", { build: "x" });
    pkg("packages/core", { test: "vitest run" });
    mkdirSync(join(root, "apps/not-a-package"));
    expect(findTestPackageDirs(root)).toEqual(["apps/api", "apps/web", "packages/core"]);
  });

  it("matches the real workspace (the four packages release validate tests)", () => {
    expect(findTestPackageDirs(getRepoRoot())).toEqual(PACKAGES);
  });
});

describe("runRehearsal", () => {
  let tmpRepo: string;

  beforeEach(() => {
    // A tiny real git repo to clone from -- proves the clone step itself
    // (git clone --no-hardlinks) works against a real repository, without
    // this test ever running pnpm/tsx (the injected `spawn` below stands
    // in for every rehearseSteps command).
    tmpRepo = mkdtempSync(join(tmpdir(), "rehearse-src-"));
    spawnSync("git", ["init", "--quiet", "-b", "main", tmpRepo]);
    spawnSync("git", ["-C", tmpRepo, "config", "user.email", "t@example.com"]);
    spawnSync("git", ["-C", tmpRepo, "config", "user.name", "t"]);
    spawnSync("sh", ["-c", `echo hi > ${join(tmpRepo, "f.txt")}`]);
    mkdirSync(join(tmpRepo, "apps/a"), { recursive: true });
    writeFileSync(join(tmpRepo, "apps/a/package.json"), '{"scripts":{"test":"vitest run"}}\n');
    spawnSync("git", ["-C", tmpRepo, "add", "-A"]);
    spawnSync("git", ["-C", tmpRepo, "commit", "--quiet", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("clones the repo, runs every step with cwd set to the clone, and cleans up on success", () => {
    const calls: { argv: readonly string[]; cwd: string }[] = [];
    const tempDirs: string[] = [];
    const code = runRehearsal({
      repo: tmpRepo,
      keep: false,
      makeTempDir: () => {
        const dir = mkdtempSync(join(tmpdir(), "rehearse-work-"));
        tempDirs.push(dir);
        return dir;
      },
      spawn: (argv, options) => {
        calls.push({ argv, cwd: options.cwd });
        return { exitCode: 0 };
      },
      log: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(7);
    expect(calls[6]?.argv.at(-1)).toBe("apps/a/.vitest-release-report.json");
    for (const call of calls) {
      expect(call.cwd).toBe(join(tempDirs[0]!, "clone"));
    }
    // Cleaned up: the temp work dir must not survive a successful run.
    expect(existsSync(tempDirs[0]!)).toBe(false);
  });

  it("stops at the first failing step and still reports non-zero", () => {
    const calls: string[] = [];
    const code = runRehearsal({
      repo: tmpRepo,
      keep: false,
      makeTempDir: () => mkdtempSync(join(tmpdir(), "rehearse-work-")),
      spawn: (argv) => {
        calls.push(argv.join(" "));
        // Fail on the second step (the `apply` invocation).
        return { exitCode: calls.length === 2 ? 1 : 0 };
      },
      log: () => {},
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("returns non-zero (never throws) when the clone itself fails", () => {
    const code = runRehearsal({
      repo: "/definitely/not/a/git/repo/path/xyz",
      keep: false,
      makeTempDir: () => mkdtempSync(join(tmpdir(), "rehearse-work-")),
      spawn: () => ({ exitCode: 0 }),
      log: () => {},
    });
    expect(code).toBe(1);
  });

  it("RED/GREEN: reports non-zero when every step passes but cleanup fails (previously reported success)", () => {
    const workDirs: string[] = [];
    const calls: string[] = [];
    const code = runRehearsal({
      repo: tmpRepo,
      keep: false,
      makeTempDir: () => {
        const dir = mkdtempSync(join(tmpdir(), "rehearse-work-"));
        workDirs.push(dir);
        return dir;
      },
      spawn: (argv) => {
        calls.push(argv.join(" "));
        return { exitCode: 0 };
      },
      removeDir: () => {
        throw new Error("simulated cleanup failure (e.g. a locked file under the clone)");
      },
      log: () => {},
    });
    for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
    expect(calls).toHaveLength(7); // every step passed
    expect(code).toBe(1);
  });

  it("fails (never throws) when the clone has no package with a test script", () => {
    rmSync(join(tmpRepo, "apps"), { recursive: true, force: true });
    spawnSync("git", ["-C", tmpRepo, "add", "-A"]);
    spawnSync("git", ["-C", tmpRepo, "commit", "--quiet", "-m", "drop packages"]);
    const calls: string[] = [];
    const code = runRehearsal({
      repo: tmpRepo,
      keep: false,
      makeTempDir: () => mkdtempSync(join(tmpdir(), "rehearse-work-")),
      spawn: (argv) => {
        calls.push(argv.join(" "));
        return { exitCode: 0 };
      },
      log: () => {},
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it("still reports the step failure (not masked by a successful cleanup)", () => {
    const code = runRehearsal({
      repo: tmpRepo,
      keep: false,
      makeTempDir: () => mkdtempSync(join(tmpdir(), "rehearse-work-")),
      spawn: () => ({ exitCode: 1 }),
      removeDir: () => {},
      log: () => {},
    });
    expect(code).toBe(1);
  });
});
