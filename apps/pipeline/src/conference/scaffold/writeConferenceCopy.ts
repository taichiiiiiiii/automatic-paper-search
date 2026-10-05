/**
 * Per-slug conference display-copy writer — p5-plan.md §2 A2: "Writes
 * ONE FILE PER SLUG: `<layout.config>/conference-copy/<slug>.json`. A
 * shared manifest would make two concurrent conference promotions fail
 * the CAS 'paths changed on develop' check."
 *
 * Deliberately a DIFFERENT persistence shape from this same directory's
 * `registerConference.ts` (a single shared `catalog-copy.json` manifest
 * with CNF-20's "no overwrite" guarantee): a per-slug file may be
 * overwritten by a later run for the SAME slug — re-running
 * `conference-on-demand` to fix a typo in `--display`/`--lede` is a
 * legitimate operator action — while two DIFFERENT slugs can never
 * collide on this path (each gets its own file), which is the actual
 * promotion-collision problem the per-file design exists to avoid.
 * `registerConference.ts` is left as-is (out of this change's scope to
 * remove); `conference/scaffold/cli.ts` (this module's own CLI) is the
 * one actually wired into `conference-on-demand.yml` (p5-plan.md §4.1's
 * "conference-on-demand.yml" row: "`scaffold/cli.ts` (env
 * `DISPLAY`/`LEDE`)").
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { validateConferenceSlug } from "../shared/index.js";

export interface ConferenceCopyEntry {
  display: string;
  lede: string;
}

/** Mirrors `registerConference.ts`'s own (unexported) `isPlainText`
 * (CNF-21): printable Unicode plus `\n`, no C0/C1 control characters.
 * Duplicated rather than imported — that module doesn't export it, and
 * this task's edit scope is this whole directory, so an independent
 * small copy is cheaper than threading a new export through for one
 * helper neither module needs to share. */
function isPlainText(value: string): boolean {
  if (value.trim() === "") return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const isNewline = ch === "\n";
    const isControl = (code <= 0x1f && !isNewline) || (code >= 0x7f && code <= 0x9f);
    if (isControl) return false;
  }
  return true;
}

/**
 * Writes `<copyDir>/<conference>.json`, creating `copyDir` if needed.
 * Returns the written path.
 *
 * @throws {InvalidConferenceSlugError} on an invalid or reserved slug
 * ({@link validateConferenceSlug} — this already covers
 * `RESERVED_CONFERENCE_SLUGS`, p5-plan.md §2 A2's "Rejects
 * `RESERVED_CONFERENCE_SLUGS`").
 * @throws {RangeError} on non-plain-text display/lede (CNF-21).
 */
export function writeConferenceCopyFile(
  conference: string,
  entry: ConferenceCopyEntry,
  copyDir: string,
): string {
  validateConferenceSlug(conference);
  if (!isPlainText(entry.display)) {
    throw new RangeError("display must be non-empty plain text with no control characters");
  }
  if (!isPlainText(entry.lede)) {
    throw new RangeError("lede must be non-empty plain text with no control characters");
  }
  mkdirSync(copyDir, { recursive: true });
  const path = join(copyDir, `${conference}.json`);
  atomicWriteText(
    path,
    `${JSON.stringify({ display: entry.display, lede: entry.lede }, null, 2)}\n`,
  );
  return path;
}
