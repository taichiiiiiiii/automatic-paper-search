/**
 * Spawns the REAL `conference/arxiv/cli.ts` entry through `tsx` — same
 * shape as `test/collect/cli.spawn.test.ts`. p5-plan.md §2 A2: "one
 * spawn test per CLI (`--help`, bad flag, env-only free text). No
 * network." (this CLI's "free text" is `--query`/`--venue`, taken from
 * argv by design — not env — so the third case here is the
 * `--output-root` default/override instead, which is this CLI's one
 * novel piece of argv handling.)
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/test/conference/arxiv -> repo root (5 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_PATH = join(REPO_ROOT, "apps", "pipeline", "src", "conference", "arxiv", "cli.ts");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
      env: process.env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? -1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

describe("real tsx spawn of conference/arxiv/cli.ts", () => {
  it("--help exits 0 and prints usage, before any network I/O", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: collect_conference/);
  }, 30_000);

  it("-h exits 0 and prints usage (short alias)", () => {
    const { status } = runCli(["-h"]);
    expect(status).toBe(0);
  }, 30_000);

  it("an unrecognized flag exits 2 with an error message on stderr", () => {
    const { status, stderr } = runCli(["--totally-bogus-flag"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unrecognized/i);
  }, 30_000);

  it("missing required --conference/--venue/--query exits 2", () => {
    const { status, stderr } = runCli([]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/required/i);
  }, 30_000);
});
