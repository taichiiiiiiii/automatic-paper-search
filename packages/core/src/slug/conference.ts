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
 *
 * Consolidated into `packages/core` per docs/migration/p4-followups.md
 * #2/#9/#20: this validator used to exist twice —
 * `apps/pipeline/src/catalog/slug.ts` (threw a plain `RangeError`) and
 * `apps/pipeline/src/conference/shared/conferenceSlug.ts` (threw its own
 * `InvalidConferenceSlugError`) — written independently during P4b/P4d
 * because each task's edit scope excluded `packages/core`. The ONE error
 * type kept here, {@link InvalidConferenceSlugError}, extends `RangeError`
 * so every existing `.toThrow(RangeError)` assertion (e.g. LIN-11) keeps
 * passing unchanged, while callers that want the more specific class can
 * still catch it by name.
 */

const SLUG_MAX_LEN = 64;
const CONFERENCE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Reserved top-level routes/paths a `--conference` value must never
 * collide with. This is now the ONE canonical list (L6 of the P5
 * tier-A review): it used to exist twice — this narrower `{daily,
 * lineage}` set here, plus a separate, broader local `Set` in
 * `apps/pipeline/src/conference/scaffold/registerConference.ts` — so
 * `writeConferenceCopyFile` (which only ever called THIS module's
 * `validateConferenceSlug`) rejected far fewer reserved names than
 * `registerConference` did for what is conceptually the same "don't
 * let a new conference shadow a real site path" check.
 * `registerConference.ts` now imports this set instead of defining its
 * own; `writeConferenceCopyFile` gets the same protection for free
 * through `validateConferenceSlug`.
 *
 * - "daily" is `paperpilot/output/daily/` (config.daily-watch.yaml's own
 *   output dir, not a conference).
 * - "lineage", "themes", "how-it-works" are real top-level site routes
 *   (`apps/web/lib/catalog-constants.ts::RESERVED_CATALOG_SLUGS`;
 *   "lineage" per docs/migration/p5-plan.md §4.1).
 * - "assets", "design", "paper-details-v1", "paper-slides-v1",
 *   "research", "search-paper-ids-v1" are the legacy static-site
 *   reserved paths `scaffold_conference_page.py` guarded — several no
 *   longer correspond to a real route in the new site, but rejecting
 *   them too costs nothing and guards against the old `docs/` tree
 *   still being served during the migration's co-existence period
 *   (design doc §7.3).
 *
 * **Deliberately NOT included: `"cvpr-2026"`.** `validateConferenceSlug`
 * is the GENERAL `--conference` validator used by every pipeline CLI
 * that operates on an EXISTING conference (`buildPagesCli`,
 * `buildSummaryCli`, `buildLineageCli`, `buildConferenceLineageCli`,
 * …) — `cvpr-2026` is a real, already-published conference those CLIs
 * are routinely re-run against, so reserving it here would reject
 * every one of those calls (see `packages/core/test/slug/
 * conference.test.ts`'s pinned "still accepts 'cvpr-2026'" case).
 * `.github/workflows-p5/conference-on-demand.yml`'s own `RESERVED_SLUGS`
 * guard (a SEPARATE, scaffold-time-only check against creating a NEW
 * conference with that name) is expected to equal
 * `[...RESERVED_CONFERENCE_SLUGS] + ["cvpr-2026"]` — that one extra
 * entry has to stay a workflow-local addition, not part of this shared
 * set. (Note for whoever next edits that workflow: this module's
 * export is the source of truth for the other ten; only `cvpr-2026` is
 * workflow-only. This changeset does not edit any workflow file
 * itself.)
 */
export const RESERVED_CONFERENCE_SLUGS: ReadonlySet<string> = new Set([
  "daily",
  "themes",
  "lineage",
  "how-it-works",
  "assets",
  "design",
  "paper-details-v1",
  "paper-slides-v1",
  "research",
  "search-paper-ids-v1",
]);

export class InvalidConferenceSlugError extends RangeError {}

/**
 * Validate that a `--conference` CLI value is already a safe slug. Unlike
 * a transform-free-text-into-a-slug function, a conference slug is
 * provided directly by the operator/workflow and is path-joined as-is
 * into output directories, so it must be REJECTED outright if it isn't
 * already slug-shaped (closing path traversal, and failing loudly on a
 * typo instead of silently coercing it).
 *
 * @throws {InvalidConferenceSlugError} (a `RangeError`) unless `conference`
 * is already a safe slug.
 */
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
