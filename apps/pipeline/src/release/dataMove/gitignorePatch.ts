/**
 * The root `.gitignore` patch (p5-plan.md §5.1 "Code and other files
 * changed in the same commit B"):
 *
 *  - `paperpilot/data/lineage-cache/*` (+ its `classifications.json`
 *    negation) -> `data/state/lineage-cache/*` (+ negation).
 *  - `paperpilot/data/unarxive/` -> `data/state/unarxive/`.
 *  - Add `logs/` (new — `logging.file` now points at a top-level,
 *    gitignored `logs/` directory per the config-edit allowlist).
 *
 * Three exact substring replacements, never a regenerated file, so every
 * other line (including the long explanatory comments) survives
 * byte-for-byte. Each replacement requires exactly one match, same
 * discipline as {@link import("./layoutFlip.js")}.
 */

export class GitignorePatchError extends Error {}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Like a plain "replace this exact substring, exactly once" check, but
 * anchored to whole lines (`from` must start right after a `\n` or the
 * start of the text, and end right before a `\n` or the end of the text).
 * Without that anchoring, `paperpilot/data/unarxive/` also matches inside
 * this very file's own explanatory *comment* ("produces a ~7GB
 * unarxive.duckdb under paperpilot/data/unarxive/; the release artefact
 * ..."), which would make a plain substring search see two occurrences of
 * what is conceptually "the one ignore rule".
 */
function replaceExactlyOnce(text: string, from: string, to: string, label: string): string {
  const pattern = new RegExp(`(^|\\n)${escapeRegExp(from)}(?=\\n|$)`, "g");
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    throw new GitignorePatchError(`expected exactly one occurrence of ${label}, found none`);
  }
  if (matches.length > 1) {
    throw new GitignorePatchError(
      `expected exactly one occurrence of ${label}, found more than one`,
    );
  }
  const match = matches[0] as RegExpMatchArray & { index: number };
  const boundary = match[1] as string;
  const start = match.index + boundary.length;
  const end = start + from.length;
  return text.slice(0, start) + to + text.slice(end);
}

const LEGACY_CACHE_BLOCK =
  "paperpilot/data/lineage-cache/*\n!paperpilot/data/lineage-cache/classifications.json";
const P5_CACHE_BLOCK = "data/state/lineage-cache/*\n!data/state/lineage-cache/classifications.json";

const LEGACY_UNARXIVE_LINE = "paperpilot/data/unarxive/";
const P5_UNARXIVE_LINE = "data/state/unarxive/";

const LOGS_BLOCK =
  "\n# P5 operator logs (apply, docs/migration/p5-plan.md §5.1) — never committed.\nlogs/\n";

/** Forward: legacy paths -> p5 paths, plus appending the new `logs/` block. */
export function applyGitignorePatch(text: string): string {
  let out = replaceExactlyOnce(text, LEGACY_CACHE_BLOCK, P5_CACHE_BLOCK, "the lineage-cache block");
  out = replaceExactlyOnce(out, LEGACY_UNARXIVE_LINE, P5_UNARXIVE_LINE, "the unarxive line");
  if (out.includes(LOGS_BLOCK)) {
    throw new GitignorePatchError("logs/ block already present — refusing to append it twice");
  }
  return out + LOGS_BLOCK;
}

/** The exact inverse of {@link applyGitignorePatch}. */
export function reverseGitignorePatch(text: string): string {
  if (!text.endsWith(LOGS_BLOCK)) {
    throw new GitignorePatchError("expected the text to end with the appended logs/ block");
  }
  let out = text.slice(0, text.length - LOGS_BLOCK.length);
  out = replaceExactlyOnce(out, P5_CACHE_BLOCK, LEGACY_CACHE_BLOCK, "the lineage-cache block");
  out = replaceExactlyOnce(out, P5_UNARXIVE_LINE, LEGACY_UNARXIVE_LINE, "the unarxive line");
  return out;
}
