/**
 * CLI entry point for {@link buildManifest} — mirrors
 * `paperpilot/scripts/build_lineage_quality.py`'s `main()` flags
 * (`--docs-root`, `--fixtures`, `--policy`, `--output`, `--as-of` (required),
 * `--check`). LIN-52.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteBytes } from "../../collect/state/atomic.js";
import { buildManifest, manifestPayload, type QualityPolicy } from "./buildLineageQuality.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/quality -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface BuildLineageQualityCliArgs {
  docsRoot: string;
  fixtures: string;
  policy: string;
  output: string;
  asOf: string;
  check: boolean;
}

export function defaultArgs(
  repoRoot: string = DEFAULT_REPO_ROOT,
): Omit<BuildLineageQualityCliArgs, "asOf" | "check"> {
  const docsRoot = join(repoRoot, "docs");
  return {
    docsRoot,
    fixtures: join(repoRoot, "paperpilot", "data", "lineage-audit-fixtures-v1.json"),
    policy: join(repoRoot, "paperpilot", "data", "lineage-quality-policy-v1.json"),
    output: join(docsRoot, "lineage-quality-v1.json"),
  };
}

export class CliArgError extends Error {}

export function parseArgs(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): BuildLineageQualityCliArgs {
  const base = defaultArgs(repoRoot);
  let docsRoot = base.docsRoot;
  let fixtures = base.fixtures;
  let policy = base.policy;
  let output = base.output;
  let asOf: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--docs-root":
        docsRoot = argv[++i] as string;
        break;
      case "--fixtures":
        fixtures = argv[++i] as string;
        break;
      case "--policy":
        policy = argv[++i] as string;
        break;
      case "--output":
        output = argv[++i] as string;
        break;
      case "--as-of":
        asOf = argv[++i];
        break;
      case "--check":
        check = true;
        break;
      default:
        throw new CliArgError(`unrecognized argument: ${tok}`);
    }
  }
  if (asOf === undefined) {
    throw new CliArgError("--as-of is required");
  }
  return { docsRoot, fixtures, policy, output, asOf, check };
}

export interface BuildLineageQualityCliResult {
  exitCode: number;
  summary?: string;
}

export function runBuildLineageQualityCli(
  args: BuildLineageQualityCliArgs,
): BuildLineageQualityCliResult {
  const fixtures = JSON.parse(readFileSync(args.fixtures, "utf8")) as { collections?: unknown };
  const policy = JSON.parse(readFileSync(args.policy, "utf8")) as QualityPolicy;
  const manifest = buildManifest({ docsRoot: args.docsRoot, asOf: args.asOf, fixtures, policy });
  const payload = manifestPayload(manifest);
  if (args.check) {
    const existing = readFileSync(args.output);
    if (!existing.equals(payload)) {
      return { exitCode: 1 };
    }
  } else {
    atomicWriteBytes(args.output, payload);
  }
  const counts = new Map<string, number>();
  for (const row of manifest.collections) {
    const key = `${row.availability}/${row.audit_status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = `Lineage quality: ${Array.from(counts.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ")}`;
  return { exitCode: 0, summary };
}

export function runCli(argv: readonly string[]): number {
  let args: BuildLineageQualityCliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliArgError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const result = runBuildLineageQualityCli(args);
  if (result.summary) process.stdout.write(`${result.summary}\n`);
  if (result.exitCode !== 0 && args.check) {
    process.stderr.write("lineage quality manifest is stale\n");
  }
  return result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runCli(process.argv.slice(2));
}
