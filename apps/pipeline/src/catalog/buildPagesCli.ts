/**
 * CLI entry point for {@link buildPagesMain} — mirrors
 * `paperpilot/scripts/build_pages.py`'s `main()` flags (`--conference`,
 * `--allow-shrink`, `--allow-shrink-for`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";
import { CliUsageError } from "../shared/cli/argparse.js";
import { isMain } from "../shared/cli/isMain.js";
import { buildPagesMain, type CatalogRoots, parseBuildPagesArgs } from "./buildPages.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/catalog -> repo root (4 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

export function defaultRoots(repoRoot: string = DEFAULT_REPO_ROOT): CatalogRoots {
  const layout = layoutFor(repoRoot);
  return {
    outputRoot: layout.inputs,
    docsRoot: layout.published,
  };
}

function extractRootOverrides(argv: readonly string[]): { rest: string[]; roots: CatalogRoots } {
  let root: string | undefined;
  let outputRoot: string | undefined;
  let docsRoot: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--root") {
      root = argv[++i];
    } else if (tok === "--output-root") {
      outputRoot = argv[++i];
    } else if (tok === "--docs-root") {
      docsRoot = argv[++i];
    } else {
      rest.push(tok as string);
    }
  }
  const base = root !== undefined ? defaultRoots(root) : defaultRoots();
  return {
    rest,
    roots: { outputRoot: outputRoot ?? base.outputRoot, docsRoot: docsRoot ?? base.docsRoot },
  };
}

export function runBuildPagesCli(argv: readonly string[], roots?: CatalogRoots): number {
  try {
    if (roots !== undefined) {
      return buildPagesMain(parseBuildPagesArgs(argv), roots).exitCode;
    }
    const extracted = extractRootOverrides(argv);
    const args = parseBuildPagesArgs(extracted.rest);
    return buildPagesMain(args, extracted.roots).exitCode;
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`build_pages: error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = runBuildPagesCli(process.argv.slice(2));
}
