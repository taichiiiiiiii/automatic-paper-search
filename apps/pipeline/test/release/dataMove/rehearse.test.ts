import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rehearseSteps, runRehearsal } from "../../../src/release/dataMove/rehearse.js";

describe("rehearseSteps", () => {
  it("installs offline, applies the move, commits, verifies, then builds and tests, in that order", () => {
    const steps = rehearseSteps("/some/clone/path");
    expect(steps.map((s) => s.join(" "))).toEqual([
      "pnpm install --offline --frozen-lockfile",
      "pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts apply --confirm-delete docs/daily/papers.json",
      "git -C /some/clone/path -c user.name=p5-rehearsal -c user.email=p5-rehearsal@local commit -q -m p5 rehearsal: apply data move (scratch commit, never pushed)",
      "pnpm exec tsx apps/pipeline/src/release/dataMove/cli.ts verify HEAD~1 HEAD",
      "pnpm --filter @paperpilot/web build",
      "pnpm -r --no-bail test",
    ]);
  });

  it("installs before apply (apply needs node_modules resolved to import @paperpilot/core/layout)", () => {
    const steps = rehearseSteps("/x");
    const installIndex = steps.findIndex((s) => s[0] === "pnpm" && s[1] === "install");
    const applyIndex = steps.findIndex((s) => s.includes("apply"));
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(applyIndex).toBeGreaterThan(installIndex);
  });

  it("verifies before building, and builds before testing (apps/web's own tests need apps/web/out already built)", () => {
    const steps = rehearseSteps("/x");
    const verifyIndex = steps.findIndex((s) => s.includes("verify"));
    const buildIndex = steps.findIndex((s) => s.includes("build"));
    const testIndex = steps.findIndex((s) => s[0] === "pnpm" && s[1] === "-r");
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(verifyIndex);
    expect(testIndex).toBeGreaterThan(buildIndex);
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
    expect(calls).toHaveLength(6);
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
});
