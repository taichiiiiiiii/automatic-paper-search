/**
 * Spawns the REAL `release/dataMove/cli.ts` entry through `tsx` for the
 * pure usage-error paths (p5-review1.md M3): `apply --reverse` with no
 * `--before`, and `carry-back` with no `--since`, must fail loudly at the
 * CLI layer, not silently default to something unsafe.
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
// apps/pipeline/test/release/dataMove -> repo root (5 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_PATH = join(REPO_ROOT, "apps", "pipeline", "src", "release", "dataMove", "cli.ts");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TSX, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
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

describe("real tsx spawn of release/dataMove/cli.ts", () => {
  it("apply --reverse with no --before fails loudly (no implicit default)", () => {
    const { status, stderr } = runCli(["apply", "--reverse"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/--before/);
  }, 30_000);

  it("carry-back with no --since fails loudly", () => {
    const { status, stderr } = runCli(["carry-back"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/--since/);
  }, 30_000);

  it("an unknown subcommand prints usage mentioning carry-back", () => {
    const { status, stderr } = runCli(["bogus"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/carry-back/);
  }, 30_000);
});
