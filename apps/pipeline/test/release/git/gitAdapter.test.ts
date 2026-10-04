/**
 * LOW: `GIT_TERMINAL_PROMPT=0` (so a failed-auth fetch/push fails fast
 * instead of blocking on an interactive credential prompt with no
 * operator attached) + a bounded subprocess timeout (so a wedged `git`
 * process can never block the promoter forever).
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createGitAdapter } from "../../../src/release/git/gitAdapter.js";

let fakeBinDir: string | undefined;

afterEach(() => {
  fakeBinDir = undefined;
});

function installFakeGit(script: string): string {
  fakeBinDir = mkdtempSync(join(tmpdir(), "paperpilot-fake-git-"));
  const binPath = join(fakeBinDir, "git");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  return fakeBinDir;
}

function pathWithFakeGitFirst(dir: string): string {
  return `${dir}:${process.env.PATH ?? ""}`;
}

it("sets GIT_TERMINAL_PROMPT=0 by default, so a credential prompt cannot hang", () => {
  const dir = installFakeGit('#!/bin/sh\necho "prompt=$GIT_TERMINAL_PROMPT"\n');
  const adapter = createGitAdapter();
  const result = adapter.run(process.cwd(), ["whatever"], {
    env: { PATH: pathWithFakeGitFirst(dir) },
  });
  expect(result.stdout.trim()).toBe("prompt=0");
});

it("GIT_TERMINAL_PROMPT=0 can still be overridden explicitly via options.env", () => {
  const dir = installFakeGit('#!/bin/sh\necho "prompt=$GIT_TERMINAL_PROMPT"\n');
  const adapter = createGitAdapter();
  const result = adapter.run(process.cwd(), ["whatever"], {
    env: { PATH: pathWithFakeGitFirst(dir), GIT_TERMINAL_PROMPT: "1" },
  });
  expect(result.stdout.trim()).toBe("prompt=1");
});

it("a hung git subprocess is killed by the timeout instead of blocking forever", () => {
  const dir = installFakeGit("#!/bin/sh\nsleep 300\n");
  const adapter = createGitAdapter(200); // 200ms timeout, not the 120s default
  const start = Date.now();
  expect(() =>
    adapter.run(process.cwd(), ["whatever"], { env: { PATH: pathWithFakeGitFirst(dir) } }),
  ).toThrow();
  expect(Date.now() - start).toBeLessThan(10_000); // nowhere near the 300s sleep
});
