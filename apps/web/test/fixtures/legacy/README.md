# Frozen legacy fixtures

Byte-identical snapshots of files the old Python-generated site
(`docs/`) publishes today, committed so the tests in `apps/web/test/misc/`
and `apps/web/test/catalog/` stop reading `docs/` at test time
(docs/migration/p5-plan.md §2 A1).

`docs/` is read-write from the pipeline's perspective and will move
under P5 (§5.1 of the same plan); a test that reads it directly would
either break the moment that happens or — worse — pass/fail based on
whatever the pipeline last wrote there, rather than on a fixed contract.
Each file here is a plain `cp` of the corresponding `docs/` file, taken
2026-10-05 on `feat/ts-migration` at the commit these fixtures were
added in. No content was edited by hand.

| Fixture | Copied from | Used by |
|---|---|---|
| `how-it-works/index.html` | `docs/how-it-works/index.html` | `apps/web/test/misc/how-it-works.test.ts` |
| `sitemap.xml` | `docs/sitemap.xml` | `apps/web/test/misc/sitemap.test.ts` |
| `eccv-2024/paper-links.html` | `docs/eccv-2024/paper-links.html` | `apps/web/test/catalog/paper-links-parity.test.ts` |
| `aaai-2026/paper-links.html` | `docs/aaai-2026/paper-links.html` | `apps/web/test/catalog/paper-links-parity.test.ts` |
| `assets/utils.js`, `assets/lineage.js`, `assets/deep.js` | `legacy/gh-pages-site/assets/*` (= old `docs/assets/*`) | `apps/web/test/lineage/graph/oracle.ts` |

The parity test originally also covered `cvpr-2026` (2.1 MB of HTML);
it was swapped for `aaai-2026` (316 KB) because both conferences
exercise identical per-row parsing logic (every row has an anchor in
both legacy files — verified by inspection) and the smaller one halves
the fixture footprint added to the repo without losing coverage.

The three `assets/*.js` files were copied byte-identically (`git
cat-file blob`) from `legacy/gh-pages-site/assets/` just before Tier C
deleted that folder (§6.3); the list of the old site's HTML pages lives
on in `legacy/redirect/paths.json`. The old site no longer exists in
the repo, so these fixtures are frozen for good: never refresh them.

`biome.json`'s `files.includes` already excludes `**/fixtures/**`, so
these files are never reformatted or linted.
