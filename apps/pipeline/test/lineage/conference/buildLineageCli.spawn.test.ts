/**
 * Spawns the REAL `lineage/conference/buildLineageCli.ts` entry through
 * `tsx` (no mocked deps, no import-level interception) — proves
 * `isMain()` actually fires for this CLI and that `--help` / a bad flag
 * are handled before any `.env`/network I/O. Same `execFileSync(tsx, …)`
 * shape as `test/collect/cli.spawn.test.ts` / `test/shared/cli/
 * isMainEntry.spawn.test.ts`. p5-plan.md §2 A2 follow-up #19: "Add spawn
 * tests like `collect/cli.spawn.test.ts`."
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/test/lineage/conference -> repo root (5 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_PATH = join(
  REPO_ROOT,
  "apps",
  "pipeline",
  "src",
  "lineage",
  "conference",
  "buildLineageCli.ts",
);

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

describe("real tsx spawn of lineage/conference/buildLineageCli.ts", () => {
  it("--help exits 0 and prints usage, before any build/.env/network I/O", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: build_lineage/);
  }, 30_000);

  it("-h exits 0 and prints usage (short alias)", () => {
    const { status, stdout } = runCli(["-h"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: build_lineage/);
  }, 30_000);

  it("an unrecognized flag exits 2 with an error message on stderr", () => {
    const { status, stderr } = runCli(["--totally-bogus-flag"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unrecognized/i);
  }, 30_000);

  it("a non-integer --limit exits 2 (CliUsageError, not a silent NaN)", () => {
    const { status, stderr } = runCli(["--limit", "not-a-number"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/invalid int value/i);
  }, 30_000);
});
