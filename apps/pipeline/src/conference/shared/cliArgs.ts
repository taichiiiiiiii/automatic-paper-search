/**
 * Strict CLI flag parser shared by the openreview/cvf/acl/arxiv
 * collectors — TS analogue of Python's `argparse` for exactly the
 * contract CNF-01's "no --allow-partial escape hatch" test depends on:
 * an unrecognized flag must be a hard failure (argparse: `SystemExit(2)`;
 * here: throws {@link CliUsageError}) BEFORE any output is written, not a
 * silently ignored extra argument.
 *
 * M3 of the P4 review: this used to be its own hand-rolled parser (and
 * the only place `--clear-oral=false` was parsed at all — silently as
 * `true`, since the `boolean` branch ignored any inline `=value`
 * entirely). It is now a thin re-export of the package-wide
 * `shared/cli/argparse.ts` engine (unique-prefix abbreviation,
 * `store_true` rejecting `=value`, `choices`, the same error wording
 * everywhere) so every CLI in this package — not just this package's own
 * four collectors — shares one parser to fix a bug in. The public names
 * (`CliUsageError`, `FlagSpec`, `ParsedFlag`, `parseCliArgs`) are kept
 * identical so none of this file's call sites need to change.
 */

export {
  CliUsageError,
  type FlagSpec,
  type ParsedFlag,
  parseArgs as parseCliArgs,
} from "../../shared/cli/argparse.js";
