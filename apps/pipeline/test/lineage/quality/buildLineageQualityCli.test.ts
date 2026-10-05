/**
 * CLI-level tests for `runBuildLineageQualityCli`/`runCli` — mirrors
 * `paperpilot/scripts/build_lineage_quality.py`'s `main()` (LIN-52).
 * No prior test exercised this CLI at all (the Python contract row
 * itself lists NONE for this gate).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditFixtures, layoutFor, qualityPolicy } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import {
  CliArgError,
  parseArgs,
  runBuildLineageQualityCli,
  runCli,
} from "../../../src/lineage/quality/buildLineageQualityCli.js";

function setupRepo(): { repoRoot: string; docsRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "quality-cli-"));
  const layout = layoutFor(repoRoot);
  const docsRoot = layout.published;
  mkdirSync(join(docsRoot, "themes"), { recursive: true });
  writeFileSync(join(docsRoot, "conferences.json"), "[]");
  writeFileSync(join(docsRoot, "themes", "themes-manifest.json"), "[]");
  mkdirSync(layout.config, { recursive: true });
  writeFileSync(auditFixtures(layout), JSON.stringify({ collections: [] }));
  writeFileSync(
    qualityPolicy(layout),
    JSON.stringify({ conference_max_age_days: 365, theme_max_age_days: 365 }),
  );
  return { repoRoot, docsRoot };
}

describe("runBuildLineageQualityCli / runCli (LIN-52)", () => {
  it("a normal run (no --check) writes the manifest atomically and exits 0", () => {
    const { repoRoot } = setupRepo();
    const args = parseArgs(["--as-of", "2026-09-01T00:00:00Z"], repoRoot);
    const result = runBuildLineageQualityCli(args);
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(args.output, "utf8"));
    expect(written.as_of).toBe("2026-09-01T00:00:00Z");
  });

  it("--check on an UP-TO-DATE manifest exits 0 and does not rewrite the file", () => {
    const { repoRoot } = setupRepo();
    const args = parseArgs(["--as-of", "2026-09-01T00:00:00Z"], repoRoot);
    runBuildLineageQualityCli(args); // first write
    const before = readFileSync(args.output);

    const checkArgs = parseArgs(["--as-of", "2026-09-01T00:00:00Z", "--check"], repoRoot);
    const result = runBuildLineageQualityCli(checkArgs);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(args.output).equals(before)).toBe(true);
  });

  // LIN-52: `--check` against a STALE on-disk manifest (one that no
  // longer matches what a fresh build would produce — e.g. `--as-of`
  // advanced) must exit non-zero WITHOUT overwriting the file. Nothing
  // in the test suite exercised this CLI at all before this file.
  it("--check on a STALE manifest exits non-zero and leaves the file byte-unchanged", () => {
    const { repoRoot } = setupRepo();
    const firstArgs = parseArgs(["--as-of", "2026-09-01T00:00:00Z"], repoRoot);
    runBuildLineageQualityCli(firstArgs); // publishes with as_of = 2026-09-01
    const stale = readFileSync(firstArgs.output);

    // A later --as-of would produce a DIFFERENT manifest (different
    // as_of field) — --check must catch that without writing it.
    const checkArgs = parseArgs(["--as-of", "2026-09-02T00:00:00Z", "--check"], repoRoot);
    const result = runBuildLineageQualityCli(checkArgs);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(firstArgs.output).equals(stale)).toBe(true);
  });

  it("runCli prints 'lineage quality manifest is stale' and returns 1 for a stale --check", () => {
    const { repoRoot } = setupRepo();
    const layout = layoutFor(repoRoot);
    const fixtures = auditFixtures(layout);
    const policy = qualityPolicy(layout);
    const output = join(layout.published, "lineage-quality-v1.json");
    const docsRoot = layout.published;
    const common = [
      "--docs-root",
      docsRoot,
      "--fixtures",
      fixtures,
      "--policy",
      policy,
      "--output",
      output,
    ];
    runCli(["--as-of", "2026-09-01T00:00:00Z", ...common]);
    const rc = runCli(["--as-of", "2026-09-02T00:00:00Z", "--check", ...common]);
    expect(rc).toBe(1);
  });

  it("parseArgs requires --as-of", () => {
    expect(() => parseArgs([])).toThrow(CliArgError);
  });
});
