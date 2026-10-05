# Frozen fixtures for the `*.parity.test.ts` tests in this directory

Why (docs/migration/p5-plan.md §2 A1, risk R9): two of the three tests in
this directory are (b)-class -- they compare an audit of published data
against a *frozen expectation* (hardcoded per-line report text). Pointing
that kind of test at live `docs/` means a legitimate data update (a new
conference run, a new theme, a denylist edit) can flip the comparison and
fail CI for a reason that has nothing to do with a code regression --
exactly the failure mode P5's promoter `validate` step must not hit. So
the INPUTS these two auditors read are frozen here, byte-identical copies,
and those two tests read from this directory instead of the live repo
tree.

`buildLineageQuality.parity.test.ts` is NOT one of these two -- see "Why
`buildLineageQuality.parity.test.ts` has no fixtures" below.

## Trimmed, not mirrored (coordinator follow-up, 2026-10-05)

An earlier version of this fixture set mirrored the ~28 MB subtree of
`docs/` that `buildLineageQuality.parity.test.ts` used to read as a frozen
comparison (10 conferences' `papers.json` + `lineage.json`, iclr-2026's 14
deep artifacts, `conferences.json`, `themes-manifest.json`, the quality
policy/audit fixtures, and the expected `lineage-quality-v1.json` output)
-- too heavy to commit, and it duplicated published data already in git
history. Reworking `buildLineageQuality.parity.test.ts` into a live-data
invariant (below) removed its need for any of that entirely. The two
remaining (b)-class tests here, `auditLineageQuality.parity.test.ts` and
`auditLineageClassificationBreakdown.parity.test.ts`, never needed most of
it either -- their code paths (`collectTargets`/`auditLineage`,
`auditPublishedThemes`/`auditClassificationsCache`) read only each
conference's/theme's `lineage.json` and the classifications cache file.
Confirmed by deleting every file these two tests' code paths don't
reference and re-running both tests (still green) before deleting the
full copies -- not merely asserted. Current fixture size: **700 KB**
(`du -sh .` in this directory), well under the 1 MB target.

## Source, date and commit

Every file below is an unmodified `cp` of the named source path, taken from
the repo tree on **2026-10-05**, at commit `a2642020bbfc39f040384693641cc5d10050e99e`
(`git rev-parse HEAD` at the time this fixture set was last trimmed --
design doc §7.2's parity convention of recording the SHA a snapshot was
frozen from). If the source file is intentionally edited (new theme,
re-run conference lineage, denylist update, etc.) and one of these two
tests should track that change, re-copy the specific file(s) below and
update this date/SHA.

| Fixture path (relative to this dir) | Source path | Used by |
|---|---|---|
| `docs/<slug>/lineage.json` (10 conferences) | `docs/<slug>/lineage.json` | `auditLineageQuality.parity.test.ts` |
| `docs/themes/<slug>/lineage.json` (flash-attention, mixture-of-experts, vision-transformer -- the 3 published themes per CLAUDE.md) | `docs/themes/<slug>/lineage.json` | `auditLineageQuality.parity.test.ts`, `auditLineageClassificationBreakdown.parity.test.ts` |
| `paperpilot-data/classifications.json` | `paperpilot/data/lineage-cache/classifications.json` | `auditLineageClassificationBreakdown.parity.test.ts` |

Deliberately NOT present (confirmed unread by either test's code path, see
above): `docs/<slug>/papers.json`, `docs/conferences.json`,
`docs/themes/themes-manifest.json`, `docs/iclr-2026/deep-*.json` /
`deep-manifest.json`, and the `paperpilot/data/lineage-*-v1.json`
policy/audit-fixtures files.

## Why `buildLineageQuality.parity.test.ts` has no fixtures

It was reworked into an (a)-class invariant: "the committed published
`lineage-quality-v1.json` equals what this builder produces from the LIVE
published inputs." That holds after the P5 data move and after every
legitimate promotion, because `promote.ts` regenerates this exact manifest
with this exact builder and commits it as part of every promotion -- so
"rebuild from current live inputs reproduces the current committed
artifact" is an invariant of the promoter, not a frozen snapshot that can
drift. It now reads everything live through `layoutFor(getRepoRoot())`
plus the `auditFixtures`/`qualityPolicy` named helpers (see the test
file's own header comment), so it needs no fixture copies at all and
follows the P5 data move automatically.

## Known residual live dependencies (out of scope for A1)

A1's ownership is test files only (no `src/` changes), and neither helper
below accepts an injected path override, so these two inputs cannot be
frozen without a source change. Flagged here rather than silently left as
a gap; in practice neither currently flips the pinned lines in
`auditLineageQuality.parity.test.ts`, but a future edit to either file
could.

- **Denylist.** `auditLineageQuality.parity.test.ts` calls `auditLineage()`,
  which calls `loadDenylist()` with no argument -- that function's default
  path resolves through `layoutFor(getRepoRoot())` to the LIVE
  `paperpilot/data/lineage_denylist.json` (p5 plan: `data/config/` after
  the move).
- **Foundational allowlist.** The same `auditLineage()` call also reaches
  `auditOfftopicNonfocus()` → `isFoundationalAncestor()`
  (`apps/pipeline/src/lineage/classify/classify.ts:452`), whose
  `FOUNDATIONAL_ALLOWLIST_PATH` module-level constant is likewise computed
  from `layoutFor(getRepoRoot())` at import time, reading the LIVE
  `paperpilot/data/lineage_foundational_allowlist.json`. This one is a
  module-level constant (not a per-call default parameter like
  `loadDenylist`), so it cannot even be overridden by a test-local call
  with an explicit path -- the whole module would need a source change.
