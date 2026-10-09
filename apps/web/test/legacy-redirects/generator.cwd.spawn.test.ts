/**
 * P5 tier-A review round 2 (N2): end-to-end proof, through a REAL child
 * process, that `legacy-redirects.yml`'s actual invocation shape --
 * `pnpm --filter @paperpilot/web run legacy-redirects` with `cwd =
 * apps/web` (`pnpm --filter X run <script>` always chdirs into that
 * package's directory before running it) -- works, and that a
 * cwd-relative path argument (the shape that regressed once, as
 * `--source legacy/gh-pages-site`; today `--paths
 * legacy/redirect/paths.json`) does not.
 *
 * A unit test calling `generateLegacyRedirectSite()` directly (see
 * `generator.test.ts`) cannot catch this: it never goes through
 * `parseArgs`'s `resolve(value)`, which resolves against `cwd`, not
 * against `apps/web/scripts/legacy-redirects.ts`'s own script-relative
 * `REPO_ROOT`. This is the only test that spawns `tsx` for real with
 * `cwd: apps/web` and checks the CLI's actual observed behaviour (exit
 * code / stderr), the same technique `isMainEntry.spawn.test.ts` uses
 * for the same reason.
 *
 * The fixture list lives at `<tmp>/legacy/redirect/paths.json` (the
 * real file's repo-relative shape), so an absolute path to it proves
 * cwd-independence without depending on the real repo's own list.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file runs real subprocesses (tsx/node/git). Each spawn is
// sub-second alone but can take seconds under `pnpm -r test`'s parallel
// load (or a loaded CI runner), so vitest's 5 s test / 10 s hook defaults
// flake. Raised for this file only; explicit per-test timeouts still win.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/web/test/legacy-redirects -> repo root (4 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SCRIPT_PATH = join(REPO_ROOT, "apps", "web", "scripts", "legacy-redirects.ts");
const CWD = join(REPO_ROOT, "apps", "web");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGenerator(args: string[]): RunResult {
  try {
    const stdout = execFileSync(TSX, [SCRIPT_PATH, ...args], {
      cwd: CWD,
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

let tmpRoot: string;
let pathsFile: string;
let outDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "legacy-redirects-cwd-"));
  const listDir = join(tmpRoot, "legacy", "redirect");
  pathsFile = join(listDir, "paths.json");
  outDir = join(tmpRoot, "out");
  mkdirSync(listDir, { recursive: true });
  writeFileSync(pathsFile, JSON.stringify({ paths: ["index.html"] }), "utf8");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("legacy-redirects.ts spawned with cwd=apps/web (matches the workflow's pnpm --filter cwd)", () => {
  it("a --paths RELATIVE to cwd (the regressed workflow shape) cannot find the list", () => {
    // `pnpm --filter @paperpilot/web run legacy-redirects -- --paths legacy/redirect/paths.json`
    // would resolve to the nonexistent apps/web/legacy/redirect/paths.json.
    const result = runGenerator(["--paths", "legacy/redirect/paths.json", "--out", outDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ENOENT/);
  }, 30_000);

  it("an ABSOLUTE --paths works regardless of cwd", () => {
    const result = runGenerator(["--paths", pathsFile, "--out", outDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/wrote 2 page\(s\)/);
  }, 30_000);

  it("no --paths (the workflow's real shape) uses the script-relative frozen list", () => {
    const result = runGenerator(["--out", outDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(join(REPO_ROOT, "legacy", "redirect", "paths.json"));
  }, 30_000);
});
