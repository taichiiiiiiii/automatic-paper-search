/**
 * The `.lighthouserc.json` rewrite for p5 (p5-plan.md §4.1 `lighthouse.yml`
 * row): under p5 lhci crawls the Next.js static export at `apps/web/out`
 * instead of the legacy `docs/` tree, and that export serves
 * directory-style routes (`/iclr-2026/lineage/`) rather than the old
 * `.html` files (`/iclr-2026/lineage.html`) `docs/` serves today. Like
 * {@link "./layoutFlip.js"}, this is a handful of exact-substring
 * replacements — never a JSON round trip through `JSON.parse`/
 * `JSON.stringify`, which would reformat/reorder the whole file — so every
 * other byte (comments, the `_comment`/`_disable_comment` keys, key order,
 * the unrelated assertions) survives untouched.
 *
 * `apply` wires this in as its own step, alongside the `.gitignore` patch
 * and the `LAYOUT_MODE` flip; `verify` recomputes the forward transform
 * from `<before>`'s blob and requires byte-equality with `<after>`'s.
 * `.lighthouserc.json` itself is not under any of the three moved roots
 * (`docs/`, `paperpilot/data/`, `paperpilot/output/`), so `rules.ts`
 * classifies it `stay` — this module only changes *its contents* in
 * place, the same way the `LAYOUT_MODE` flip changes
 * `packages/core/src/layout/index.ts`'s contents in place without moving
 * the file.
 */

export class LighthouseEditError extends Error {}

interface LiteralEdit {
  readonly legacy: string;
  readonly p5: string;
}

/** Ordered legacy -> p5 substring replacements (order matters only for readability; each is matched independently). */
const EDITS: readonly LiteralEdit[] = [
  { legacy: '"staticDistDir": "./docs"', p5: '"staticDistDir": "./apps/web/out"' },
  { legacy: '"http://localhost/index.html"', p5: '"http://localhost/"' },
  {
    legacy: '"http://localhost/iclr-2026/index.html"',
    p5: '"http://localhost/iclr-2026/"',
  },
  {
    legacy: '"http://localhost/iclr-2026/lineage.html"',
    p5: '"http://localhost/iclr-2026/lineage/"',
  },
  { legacy: '"http://localhost/themes/index.html"', p5: '"http://localhost/themes/"' },
];

function replaceExactlyOnce(text: string, from: string, to: string): string {
  const first = text.indexOf(from);
  if (first === -1) {
    throw new LighthouseEditError(
      `expected exactly one occurrence of ${JSON.stringify(from)}, found none`,
    );
  }
  const second = text.indexOf(from, first + from.length);
  if (second !== -1) {
    throw new LighthouseEditError(
      `expected exactly one occurrence of ${JSON.stringify(from)}, found more than one`,
    );
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
}

/** legacy -> p5. Throws unless every legacy literal appears exactly once (loud drift detection, never a silent no-op). */
export function applyLighthouseEdit(text: string): string {
  let out = text;
  for (const edit of EDITS) {
    out = replaceExactlyOnce(out, edit.legacy, edit.p5);
  }
  return out;
}

/** The exact inverse of {@link applyLighthouseEdit}. */
export function reverseLighthouseEdit(text: string): string {
  let out = text;
  for (const edit of [...EDITS].reverse()) {
    out = replaceExactlyOnce(out, edit.p5, edit.legacy);
  }
  return out;
}
