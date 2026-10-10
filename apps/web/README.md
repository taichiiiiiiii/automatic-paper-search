# apps/web

Next.js app (static export) served from Cloudflare Pages (see
`docs/design/40-post-cutover-roadmap.md` and `docs/design/41-lineage-publication-and-reliability.md`).

## `tsconfig.json` notes

- **`target`/`lib`: `ES2022`, not Next's template default `ES2017`.**
  `apps/web` imports `@paperpilot/core` (`lib/config.ts`, `lib/data.ts`),
  whose `package.json` `exports` points straight at its TS source, so `tsc`
  type-checks that source under *this* file's `target`/`lib`. `core`'s own
  `pycompat/round.ts` uses BigInt literals (ES2020+), so anything lower
  than `tsconfig.base.json`'s `ES2022` fails here even though Next's SWC
  build is unaffected (it does its own downleveling).

  (Moved out of `tsconfig.json` itself: `paperpilot/tests/test_published_assets_are_parseable.py`
  parses every `*.json` file in the repo with `json.loads` — including
  `tsconfig.json`, which has no provision for JSONC comments — so a `//`
  comment there fails that test. Keep `tsconfig.json` comment-free; put
  explanations here instead.)
