/**
 * P5 tier-A review round 2 (N2): end-to-end proof, through a REAL child
 * process, that `legacy-redirects.yml`'s actual invocation shape --
 * `pnpm --filter @paperpilot/web run legacy-redirects` with `cwd =
 * apps/web` (`pnpm --filter X run <script>` always chdirs into that
 * package's directory before running it) -- works, and that the
 * regressed shape it used to be (`-- --source legacy/gh-pages-site`,
 * a path RELATIVE to that cwd) does not.
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
 * The fixture tree is named `legacy/gh-pages-site` (the p5-era shape,
 * not today's legacy `docs/`) precisely because this is the shape the
 * real workflow's default resolves to once commit B lands; using an
 * absolute path to it here proves cwd-independence without depending on
 * today's `LAYOUT_MODE` or on the real repo's own `docs/` content.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
let sourceDir: string;
let outDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "legacy-redirects-cwd-"));
  sourceDir = join(tmpRoot, "legacy", "gh-pages-site");
  outDir = join(tmpRoot, "out");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "index.html"), "<html>p5-shaped fixture</html>", "utf8");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("legacy-redirects.ts spawned with cwd=apps/web (matches the workflow's pnpm --filter cwd)", () => {
  it("a --source RELATIVE to cwd (the regressed workflow shape) cannot find the p5-shaped tree", () => {
    // Mirrors the exact regressed `run:` line:
    // `pnpm --filter @paperpilot/web run legacy-redirects -- --source legacy/gh-pages-site`
    // resolves to the nonexistent apps/web/legacy/gh-pages-site, not to
    // this fixture's tmpRoot/legacy/gh-pages-site.
    const result = runGenerator(["--source", "legacy/gh-pages-site", "--out", outDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ENOENT/);
  }, 30_000);

  it("an ABSOLUTE --source (or none, relying on the layout-derived default) works regardless of cwd", () => {
    const result = runGenerator(["--source", sourceDir, "--out", outDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/wrote \d+ page\(s\)/);
  }, 30_000);
});
