/**
 * pycompat — small, dependency-free TS reproductions of Python 3 runtime
 * behaviour that the PaperPilot pipeline relies on, so TS ports of Python
 * code produce byte-identical output. See
 * docs/design/39-typescript-cloudflare-migration.md §7.2 for the design
 * rationale, and each module's own doc comment for the exact semantics,
 * verification method, and any documented parity gaps.
 *
 * This barrel is local to packages/core/src/pycompat/ and is not wired into
 * packages/core/src/index.ts (the package's public entry point) by this
 * change; a later task re-exports the pieces it needs from there.
 */

export { pyFloatRepr } from "./floatRepr.js";
export { pyIsoformat } from "./isoformat.js";
export { PyFloat, type PyJsonDumpsOptions, pyFloat, pyJsonDumps } from "./jsonDumps.js";
export { pyRound } from "./round.js";
export { codepointCompare, pySortedStrings } from "./sort.js";
export { nfkc, pyCasefold, pyLower } from "./text.js";
export { isPyWordChar, PY_WORD_CLASS_SOURCE, pyWordCharRegex } from "./wordRegex.js";
