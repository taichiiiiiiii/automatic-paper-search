/**
 * M2 of the P4 review: end-to-end proof that the shared `isMain()` guard
 * actually fires correctly for a REAL child process invoked through a
 * symlinked directory and through a path containing a space — the two
 * cases the naive `import.meta.url === \`file://${process.argv[1]}\``
 * string comparison got wrong (see `shared/cli/isMain.ts`'s doc
 * comment). A unit test calling `isMain()` directly (covered by
 * `isMain.test.ts`) cannot catch a regression here: this is the only
 * test that spawns `tsx` for real and checks the CLI's actual observed
 * behaviour (exit code / stderr) rather than the helper's return value.
 *
 * Target: `catalog/buildSummaryCli.ts` — its `parseBuildSummaryCliArgs`
 * call happens before any filesystem/network I/O (confirmed by reading
 * `runBuildSummaryCli`'s body), so a bad flag reaching exit 2 proves the
 * entry guard ran `main()` at all; it can't be explained by some later
 * step coincidentally also failing.
 *
 * Mutant check (manual, not re-run in CI): reverting
 * `shared/cli/isMain.ts`'s body to the naive `import.meta.url ===
 * \`file://${process.argv[1]}\`` comparison makes both cases below
 * regress to exit 0 with empty stderr (the guard says "not main", so
 * `main()` never runs and the bad flag is never even parsed) — i.e. this
 * test goes red under that mutant.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
// apps/pipeline/test/shared/cli -> repo root (5 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_REL = join("apps", "pipeline", "src", "catalog", "buildSummaryCli.ts");

function runNode(scriptPath: string, cwd: string): { status: number; stderr: string } {
  try {
    execFileSync(TSX, [scriptPath, "--totally-bogus-flag"], {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      env: process.env,
    });
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { status: err.status ?? -1, stderr: String(err.stderr ?? "") };
  }
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ismain-spawn-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("real tsx spawn through a symlinked directory", () => {
  it("still runs main() and exits 2 on a bad flag (symlink resolves to the same real file)", () => {
    const link = join(base, "repo-via-symlink");
    symlinkSync(REPO_ROOT, link);
    const scriptPath = join(link, CLI_REL);

    const { status, stderr } = runNode(scriptPath, link);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unrecognized/i);
  }, 30_000);
});

describe("real tsx spawn through a path containing a space", () => {
  it("still runs main() and exits 2 on a bad flag (a raw argv[1] space is not percent-encoded, unlike import.meta.url)", () => {
    // A symlink (not a full copy — cheap) whose NAME contains a space,
    // pointing at the real repo root. `process.argv[1]` is this raw,
    // space-containing path; Node's ESM loader resolves the real module
    // it loads to the (space-free) target when building `import.meta.url`
    // — reproducing the exact textual mismatch the naive
    // `file://${argv[1]}` guard gets wrong, same mechanism as the
    // symlink case above, just via a literal space in argv[1] instead of
    // only a different directory name.
    const link = join(base, "repo with a space");
    symlinkSync(REPO_ROOT, link);
    const scriptPath = join(link, CLI_REL);

    const { status, stderr } = runNode(scriptPath, link);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unrecognized/i);
  }, 30_000);
});
