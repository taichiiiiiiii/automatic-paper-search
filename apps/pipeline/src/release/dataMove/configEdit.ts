/**
 * The `moveEdit` text transform (p5-plan.md §5.1/§5.2): rewrites only the
 * value of specific, dotted-path YAML keys — a targeted line replace, never
 * a YAML-library round trip, so every comment and every other line is
 * preserved byte-for-byte. Used by both `apply` (forward: oldValue ->
 * newValue) and `apply --reverse` (backward: the same edits with
 * old/new swapped), and by `verify` (recomputes the forward transform from
 * the `<before>` blob and requires byte-equality with the `<after>` blob —
 * the proof that *only* `edits` changed).
 */

import type { ConfigEdit } from "./rules.js";

export class ConfigEditError extends Error {}

interface KeyLine {
  readonly lineIndex: number;
  readonly indent: number;
  readonly keyPath: string;
  readonly value: string;
}

/**
 * A minimal YAML key/value line scanner: tracks nesting purely via
 * indentation (a stack of `{indent, key}`), exactly the subset of YAML the
 * two collector config files use (2-space indented mappings, scalar
 * values, no lists at the keys this module touches). List items (`- foo`)
 * and blank/comment lines are skipped for nesting purposes but still
 * preserved verbatim in the output, since this module only ever replaces
 * the exact substring of a matched line.
 */
function scanKeyLines(lines: readonly string[]): KeyLine[] {
  const stack: { indent: number; key: string }[] = [];
  const result: KeyLine[] = [];
  const keyLineRe = /^(\s*)([A-Za-z0-9_.-]+):(?:\s(.*))?$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const m = keyLineRe.exec(line);
    if (!m) continue;
    const indent = (m[1] as string).length;
    const key = m[2] as string;
    const value = (m[3] ?? "").trim();

    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) {
      stack.pop();
    }
    const keyPath = [...stack.map((s) => s.key), key].join(".");
    result.push({ lineIndex: i, indent, keyPath, value });
    stack.push({ indent, key });
  }
  return result;
}

/**
 * Applies `edits` to `text`. For each edit, requires exactly one line whose
 * dotted key path equals `edit.key` and whose trimmed value equals
 * `edit.oldValue` — zero matches or more than one is a loud
 * {@link ConfigEditError} (drift or ambiguity must never silently no-op or
 * pick an arbitrary line), mirroring the "fail if not exactly one match"
 * discipline `apply` also uses for the `LAYOUT_MODE` literal flip.
 */
export function applyConfigEdits(text: string, edits: readonly ConfigEdit[]): string {
  const hasTrailingNewline = text.endsWith("\n");
  const lines = (hasTrailingNewline ? text.slice(0, -1) : text).split("\n");
  const keyLines = scanKeyLines(lines);

  for (const edit of edits) {
    const matches = keyLines.filter((kl) => kl.keyPath === edit.key && kl.value === edit.oldValue);
    if (matches.length === 0) {
      throw new ConfigEditError(
        `expected exactly one line "${edit.key}: ${edit.oldValue}", found none`,
      );
    }
    if (matches.length > 1) {
      throw new ConfigEditError(
        `expected exactly one line "${edit.key}: ${edit.oldValue}", found ${matches.length}`,
      );
    }
    const match = matches[0] as KeyLine;
    const line = lines[match.lineIndex] as string;
    // Rebuild the line from its own prefix (indent + "key:" + spacing) up to
    // where the old value started, so the key's exact original
    // spacing/formatting survives; only the value token itself is replaced.
    const prefixMatch = /^(\s*[A-Za-z0-9_.-]+:\s*)/.exec(line);
    if (!prefixMatch) {
      throw new ConfigEditError(`could not re-locate key line for "${edit.key}" to edit it`);
    }
    const prefix = prefixMatch[1] as string;
    const rest = line.slice(prefix.length);
    if (rest !== edit.oldValue) {
      throw new ConfigEditError(
        `line for "${edit.key}" did not end in exactly "${edit.oldValue}" (found ${JSON.stringify(rest)}); refusing to touch anything beyond the value`,
      );
    }
    lines[match.lineIndex] = `${prefix}${edit.newValue}`;
  }

  return lines.join("\n") + (hasTrailingNewline ? "\n" : "");
}

/** The exact inverse of {@link applyConfigEdits}: swaps `oldValue`/`newValue` on every edit. */
export function reverseConfigEdits(text: string, edits: readonly ConfigEdit[]): string {
  const swapped = edits.map((e) => ({ key: e.key, oldValue: e.newValue, newValue: e.oldValue }));
  return applyConfigEdits(text, swapped);
}
