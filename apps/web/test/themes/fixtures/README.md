# `worker-slug-regex-expected.json`

Frozen record of what the real `worker/slug.js`'s `SLUG_RE` /
`THEME_INPUT_PATTERN` regex literals match/reject for the probe battery
`../slug-parity.test.ts` checks (p5-plan.md §2 A1, risk R9: that test must
not read/eval `worker/slug.js`'s source at test time, since it is
production code left untouched until P5 and the suite must not depend on
its live content to pass or fail).

- **Source**: `worker/slug.js`, as of **2026-10-05**, at commit
  `a2642020bbfc39f040384693641cc5d10050e99e` (`git rev-parse HEAD` at the
  time this fixture was added).
- **Generator**: `gen-worker-regex-expected.mjs` in this directory. Run
  with `node apps/web/test/themes/fixtures/gen-worker-regex-expected.mjs`
  from the repo root. Not a vitest test file and not run in CI.
- **Re-generate** (and commit the new output) only if `worker/slug.js`'s
  `SLUG_RE` or `THEME_INPUT_PATTERN` is intentionally changed.

Same pattern as `packages/core/test/slug/fixtures/gen-worker-expected.mjs`
/ `worker-slug-expected.json`, and
`apps/api/test/fixtures/gen-worker-slug-expected.mjs` /
`worker-slug-expected.json`.
