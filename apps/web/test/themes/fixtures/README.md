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
- **Generator**: `gen-worker-regex-expected.mjs` (deleted in Tier C together with `worker/`,
  p5-plan.md §6.3 — it needed the real `worker/slug.js` to run). The
  output is now a permanently frozen contract; recover the generator
  from git history if its logic is ever needed.

Same pattern as `packages/core/test/slug/fixtures/gen-worker-expected.mjs`
/ `worker-slug-expected.json`, and
`apps/api/test/fixtures/gen-worker-slug-expected.mjs` /
`worker-slug-expected.json`.
