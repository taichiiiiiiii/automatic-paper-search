# System-test fixtures

Recorded answers of the external APIs the pipeline CLIs call, replayed by
`../support/fixtureFetch.ts` (a `node --import` preload that replaces
`globalThis.fetch`). Every directory has an `index.json`: a list of
`{ method?, url | urlPattern, bodyIncludes?, status, headers?, body | bodyFile | json | batch }`
entries; the first match wins. A request with no matching entry rejects like a
dead network, so a test can never reach a real API.

Never re-record in CI. Re-record only when a CLI starts asking for different
URLs (the test then fails with the missing requests listed), once, politely:
set `record: true` in a scratch `runCli(...)` call — the preload then forwards
misses to the real API with per-host pacing (arXiv >= 3.2 s, S2 >= 1.2 s),
never freezes 429/5xx answers, and appends to the first fixture dir.

## theme-http

`lineage/theme/cli.ts --theme "Flash Attention" --depth 1 --seeds 5 --width 8
--since-year 2018 --primary-source openalex --no-topic-embedding` (the
production regen parameters, term topic gate), recorded live on 2026-10-12 with
an empty lineage cache: 33 OpenAlex, 13 Semantic Scholar, 18 GitHub requests
(4 GitHub answers are real 403 rate-limit pages). Produces 14 nodes / 36 edges
with the same five seeds as the published theme.

Trimmed for size, then verified to replay to a byte-identical `lineage.json`
(except `generated_at`): OpenAlex works keep only the fields the pipeline reads
(authorships reduced to names/ids; concepts, topics, related_works, counts,
best_oa_location, … dropped; abstracts of works that are not graph nodes cut to
their first 80 words), S2 reference abstracts cut to 500 characters, GitHub
repos reduced to name/owner/stars/description. Bodies are gzip'd (`*.body.gz`).

## theme-feeds-http

`lineage/theme/feed/themeFeedsCli.ts --now 2026-10-12T00:00:00Z --days 200
--max-pages 2 --min-cites 1 --no-topic-embedding` for the published
flash-attention lineage, recorded live on 2026-10-12: one OpenAlex `cites:`
page (49 works) and 14 Hugging Face Papers lookups (5 are real 404s).
**One edit:** the title of `W7166307650` ("MKA: Memory-Keyed Attention …") is
suffixed with ` (FlashAttention)` so the term-only topic gate keeps exactly one
paper; everything else is verbatim. (The page also showed that OpenAlex types
proceedings papers `conference-paper` — 14 of 49 — which the feed used to drop;
fixed in `feed/newPapers.ts`.)

## conference-iclr-2025

A 20-paper slice of ICLR 2025 rebuilt from the committed
`data/inputs/iclr-2025/` files (no live request): the
`proceedings.iclr.cc/paper_files/paper/2025` listing markup (same structure as
`test/conference/fixtures/proceedings/iclr_2025_proceedings_listing_excerpt.html`)
for 20 listing rows, the DBLP SPARQL bindings from `external_ids.json`, an arXiv
Atom feed for the 13 rows `abstract_replacements.json` resolved by arXiv title
search (title, authors, abstract as resolved), and the S2 bulk listing + TLDR
batch answers for the 4 rows it resolved by S2 TLDR. The other 3 rows stay
title-only. `expected.json` holds the expected abstract source and OpenReview
id per title. Abstract texts are arXiv (CC0) and S2 TLDR (ODC-BY) — the same
licences the published catalog already carries.
