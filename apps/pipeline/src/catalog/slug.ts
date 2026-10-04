/**
 * Conference slug validation — TS port of `validate_conference_slug` in
 * `paperpilot/scripts/_common.py` (OUT-52 / CAT-14 of
 * docs/migration/safety-contracts.md). Belongs in a shared
 * `packages/core/slug/conference.ts` per that table's "移植先" column, but
 * this task's edit scope is limited to `apps/pipeline/src/catalog/**` —
 * see the scope note in `identity.ts`.
 */

const SLUG_MAX_LEN = 64;
const CONFERENCE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * "daily" is `paperpilot/output/daily/` (config.daily-watch.yaml's own
 * output dir, not a conference).
 */
export const RESERVED_CONFERENCE_SLUGS: ReadonlySet<string> = new Set(["daily"]);

/**
 * Validate that a `--conference` CLI value is already a safe slug. Unlike
 * a transform-free-text-into-a-slug function, a conference slug is
 * provided directly by the operator/workflow and is path-joined as-is
 * into output directories, so it must be REJECTED outright if it isn't
 * already slug-shaped (closing path traversal, and failing loudly on a
 * typo instead of silently coercing it).
 */
export function validateConferenceSlug(conference: string): string {
  if (
    !conference ||
    conference.length > SLUG_MAX_LEN ||
    // `fullmatch` (JS: anchored regex tested against the whole string via
    // `.test()` with `^...$`), not `.match()`/`.exec()` with a `$`-only
    // anchor: `$` alone would also match just before a trailing newline,
    // letting "cvpr-2026\n" through. `^...$` with no `m` flag in JS already
    // behaves like Python's `fullmatch` here since `$` without `m` anchors
    // to the absolute end of the string, NOT before a trailing "\n" the way
    // Python's `re.match`/`$` does — so this check is strict by construction.
    !CONFERENCE_SLUG_RE.test(conference) ||
    RESERVED_CONFERENCE_SLUGS.has(conference)
  ) {
    throw new RangeError(
      `invalid --conference value: ${JSON.stringify(conference)} ` +
        "(must match [a-z0-9]+(-[a-z0-9]+)*, e.g. 'cvpr-2026', " +
        `max ${SLUG_MAX_LEN} chars, and not a reserved name ` +
        `${JSON.stringify([...RESERVED_CONFERENCE_SLUGS].sort())})`,
    );
  }
  return conference;
}
