/**
 * Spawns the REAL `collect/cli.ts` entry through `tsx` (no mocked
 * `createRunner`, no import-level interception) — proves `isMain()`
 * actually fires for this CLI and that `--help` / a bad flag are handled
 * before any config/network I/O, through the real `if (isMain(...))`
 * block added for #26/#29 of docs/migration/p4-followups.md. Same
 * `execFileSync(tsx, …)` shape as
 * `test/shared/cli/isMainEntry.spawn.test.ts`.
 *
 * Both cases below resolve/reject before `loadConfig` ever runs (`--help`
 * short-circuits at the very top of `main()`; an unrecognized flag throws
 * `CliUsageError` out of `parseArgs`, also before `loadConfig`) — reading
 * `main()`'s body confirms this ordering, so neither spawn needs a real
 * `paperpilot/config.yaml`/`.env` to exist for the assertion to be
 * meaningful.
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
// apps/pipeline/test/collect -> repo root (4 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_PATH = join(REPO_ROOT, "apps", "pipeline", "src", "collect", "cli.ts");

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

describe("real tsx spawn of collect/cli.ts", () => {
  it("--help exits 0 and prints usage, before any config/network I/O", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: collector/);
    expect(stdout).toContain("--config");
    expect(stdout).toContain("expand-keywords");
  }, 30_000);

  it("-h exits 0 and prints usage (short alias)", () => {
    const { status, stdout } = runCli(["-h"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: collector/);
  }, 30_000);

  // NOTE: `main()`'s `CliUsageError` path reports via `deps.logger.error`,
  // and the real entry's logger (`createLogger`, matching Python's own
  // `logging.StreamHandler(sys.stdout)` — see `collect/logger.ts`'s doc
  // comment) writes EVERY level to stdout, not stderr. So — unlike
  // `isMainEntry.spawn.test.ts`'s target, which writes directly to
  // `process.stderr` — the message below lands on stdout. Verified
  // empirically before writing this assertion (`2>/dev/null` still shows
  // the message; `1>/dev/null` shows nothing).
  it("an unrecognized flag exits 2 with an 'unrecognized' message (on stdout, via the logger)", () => {
    const { status, stdout } = runCli(["--totally-bogus-flag"]);
    expect(status).toBe(2);
    expect(stdout).toMatch(/unrecognized/i);
  }, 30_000);

  it("a non-integer --days exits 2 (CliUsageError, not a silent NaN)", () => {
    const { status, stdout } = runCli(["--days", "not-a-number"]);
    expect(status).toBe(2);
    expect(stdout).toMatch(/invalid int value/i);
  }, 30_000);

  // MEDIUM-14 (P4 review round 2): `runRealCli`'s top-level try/catch
  // (cli.ts, mapping any thrown error to `return 1`) was never exercised —
  // a mutant changing that `return 1` to `return 0` would survive. A
  // nonexistent `--config` path makes `loadConfig` throw
  // `ConfigNotFoundError`, which `main()` does not catch (only
  // `CliUsageError` is), so it reaches `runRealCli`'s catch.
  it("--config pointing at a nonexistent file exits 1 via runRealCli's catch (MEDIUM-14)", () => {
    const { status, stdout } = runCli(["--config", "/definitely/does/not/exist-xyz.yaml"]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/fatal/i);
    expect(stdout).toMatch(/Config file not found/i);
  }, 30_000);
});
