/**
 * Spawns the REAL `release/derived/identityLiteCli.ts` entry through
 * `tsx`. p5-plan.md §2 A2: "one spawn test per CLI (`--help`, bad flag,
 * env-only free text). No network." (this CLI takes no free-text env
 * input, so the third case here is "a valid run writes nothing outside
 * a temp dir" instead).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// apps/pipeline/test/release/derived -> repo root (5 levels up).
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_PATH = join(
  REPO_ROOT,
  "apps",
  "pipeline",
  "src",
  "release",
  "derived",
  "identityLiteCli.ts",
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

describe("real tsx spawn of release/derived/identityLiteCli.ts", () => {
  it("--help exits 0 and prints usage", () => {
    const { status, stdout } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/usage: build_identity_lite/);
  }, 30_000);

  it("missing required --as-of exits 2", () => {
    const { status, stderr } = runCli([]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/required/i);
  }, 30_000);

  it("an unrecognized flag exits 2", () => {
    const { status, stderr } = runCli(["--bogus"]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/unrecognized/i);
  }, 30_000);
});

describe("real tsx spawn against a fixture docs root", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "identity-lite-cli-spawn-"));
    const docsRoot = join(repoRoot, "docs");
    mkdirSync(join(docsRoot, "iclr-2026"), { recursive: true });
    writeFileSync(
      join(docsRoot, "conferences.json"),
      JSON.stringify([{ name: "iclr-2026" }]),
      "utf-8",
    );
    writeFileSync(
      join(docsRoot, "iclr-2026", "papers.json"),
      JSON.stringify([
        {
          title: "A",
          authors: ["Alice"],
          arxiv_url: "https://arxiv.org/abs/2404.00001",
          abstract: "abs",
          arxiv_id: "2404.00001",
        },
      ]),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("exits 0 and writes identity-aliases-v1.json / the coverage report", () => {
    const docsRoot = join(repoRoot, "docs");
    const coveragePath = join(repoRoot, "coverage.json");
    const { status, stdout } = runCli([
      "--docs-root",
      docsRoot,
      "--coverage-path",
      coveragePath,
      "--as-of",
      "2026-08-30T00:00:00Z",
    ]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/valid: true/);
    expect(readFileSync(join(docsRoot, "identity-aliases-v1.json"), "utf-8")).toContain("arxiv");
    expect(readFileSync(coveragePath, "utf-8")).toContain('"valid": true');
  }, 30_000);
});
