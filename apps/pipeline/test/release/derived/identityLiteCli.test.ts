/**
 * CLI-level tests for `identityLiteCli.ts` — p5-plan.md §2 A2: "no CLI
 * [for identity-lite] at all" before this change. Flags mirror
 * `build_identity_lite.py`'s `main()`: `--docs-root`, `--coverage-path`,
 * `--as-of` (required), `--check`, `--report-only`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityCoverage, layoutFor } from "@paperpilot/core/layout";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultCoveragePath,
  defaultDocsRoot,
  parseIdentityLiteCliArgs,
  runIdentityLiteCli,
  runIdentityLiteCliArgs,
} from "../../../src/release/derived/identityLiteCli.js";
import { CliUsageError } from "../../../src/shared/cli/argparse.js";

let repoRoot: string;
let docsRoot: string;
let coveragePath: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "identity-lite-cli-"));
  docsRoot = join(repoRoot, "docs");
  mkdirSync(docsRoot, { recursive: true });
  coveragePath = join(repoRoot, "coverage.json");
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writeConferences(names: string[]): void {
  writeFileSync(
    join(docsRoot, "conferences.json"),
    JSON.stringify(names.map((name) => ({ name }))),
    "utf-8",
  );
}

function writeCatalog(slug: string, rows: unknown[]): void {
  const dir = join(docsRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "papers.json"), JSON.stringify(rows), "utf-8");
}

describe("defaultDocsRoot / defaultCoveragePath (layout-derived defaults)", () => {
  it("docsRoot is layout.published", () => {
    expect(defaultDocsRoot(repoRoot)).toBe(layoutFor(repoRoot).published);
  });

  it("coveragePath is layout.state/identity-coverage-v1.json", () => {
    expect(defaultCoveragePath(repoRoot)).toBe(identityCoverage(layoutFor(repoRoot)));
  });
});

describe("parseIdentityLiteCliArgs", () => {
  it("requires --as-of", () => {
    expect(() => parseIdentityLiteCliArgs([], repoRoot)).toThrow(CliUsageError);
  });

  it("accepts --as-of and defaults the other paths from layout", () => {
    const args = parseIdentityLiteCliArgs(["--as-of", "2026-08-30T00:00:00Z"], repoRoot);
    expect(args.asOf).toBe("2026-08-30T00:00:00Z");
    expect(args.docsRoot).toBe(defaultDocsRoot(repoRoot));
    expect(args.coveragePath).toBe(defaultCoveragePath(repoRoot));
    expect(args.check).toBe(false);
    expect(args.reportOnly).toBe(false);
  });

  it("an unrecognized flag throws CliUsageError", () => {
    expect(() => parseIdentityLiteCliArgs(["--bogus"], repoRoot)).toThrow(CliUsageError);
  });
});

describe("runIdentityLiteCliArgs", () => {
  it("writes aliases + coverage and exits 0 for a valid catalog", () => {
    writeConferences(["iclr-2026"]);
    writeCatalog("iclr-2026", [
      {
        title: "A",
        authors: ["Alice"],
        arxiv_url: "https://arxiv.org/abs/2404.00001",
        abstract: "abs",
        arxiv_id: "2404.00001",
      },
    ]);
    const result = runIdentityLiteCliArgs({
      docsRoot,
      coveragePath,
      asOf: "2026-08-30T00:00:00Z",
      check: false,
      reportOnly: false,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(coveragePath, "utf-8")).toContain('"valid": true');
    expect(readFileSync(join(docsRoot, "identity-aliases-v1.json"), "utf-8")).toContain("arxiv");
  });

  it("exits 1 (and writes nothing) when as-of is not a valid ISO-8601 timestamp", () => {
    writeConferences(["iclr-2026"]);
    writeCatalog("iclr-2026", []);
    const result = runIdentityLiteCliArgs({
      docsRoot,
      coveragePath,
      asOf: "not-a-date",
      check: false,
      reportOnly: false,
    });
    expect(result.exitCode).toBe(1);
  });
});

describe("runIdentityLiteCli (argv -> exit code)", () => {
  it("--help exits 0 and prints usage", () => {
    expect(runIdentityLiteCli(["--help"], repoRoot)).toBe(0);
  });

  it("missing --as-of exits 2", () => {
    expect(runIdentityLiteCli([], repoRoot)).toBe(2);
  });

  it("an unrecognized flag exits 2", () => {
    expect(runIdentityLiteCli(["--bogus"], repoRoot)).toBe(2);
  });
});
