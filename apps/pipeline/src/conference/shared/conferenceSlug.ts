/**
 * Conference `--conference` slug validation — TS port of
 * `paperpilot/scripts/_common.py::validate_conference_slug` (CNF-17 of
 * docs/migration/safety-contracts.md).
 *
 * A conference slug is supplied directly by the operator/workflow
 * (`--conference cvpr-2026`) and is path-joined as-is into output
 * directories. It must be REJECTED outright if it isn't already
 * slug-shaped, not silently coerced — both to close path traversal
 * (`../../etc`) and because coercing would mask an operator typo.
 *
 * JS `$` (without the `m` flag) anchors to the absolute end of the string
 * and — unlike Python's `re.match`/`re.search` `$`, which also matches just
 * before a trailing "\n" — does NOT accept a trailing newline. A plain
 * `RegExp.test()` with `^...$` is therefore already Python-`fullmatch`
 * equivalent here; no extra trailing-newline guard is needed.
 */

const SLUG_MAX_LEN = 64;
const CONFERENCE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * "daily" is `paperpilot/output/daily/` (config.daily-watch.yaml's own
 * output dir, not a conference) — kept as a local literal, mirroring the
 * Python module's own documented layering choice.
 */
const RESERVED_CONFERENCE_SLUGS = new Set(["daily"]);

export class InvalidConferenceSlugError extends Error {}

/** Throws {@link InvalidConferenceSlugError} unless `conference` is already a safe slug. */
export function validateConferenceSlug(conference: string): string {
  if (
    !conference ||
    conference.length > SLUG_MAX_LEN ||
    !CONFERENCE_SLUG_RE.test(conference) ||
    RESERVED_CONFERENCE_SLUGS.has(conference)
  ) {
    throw new InvalidConferenceSlugError(
      `invalid --conference value: ${JSON.stringify(conference)} ` +
        "(must match [a-z0-9]+(-[a-z0-9]+)*, e.g. 'cvpr-2026', " +
        `max ${SLUG_MAX_LEN} chars, and not a reserved name ` +
        `${JSON.stringify([...RESERVED_CONFERENCE_SLUGS].sort())})`,
    );
  }
  return conference;
}
