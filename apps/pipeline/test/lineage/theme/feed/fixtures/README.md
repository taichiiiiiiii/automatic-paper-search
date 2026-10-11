# R4-3 feed / badge fixtures (recorded 2026-10-11, no live calls in tests)

| File | Request | Notes |
|---|---|---|
| `hf-paper-2205.14135.json` | `GET https://huggingface.co/api/papers/2205.14135` | FlashAttention. Has `ai_summary` / `ai_keywords` (LLM output): the tests assert they never reach the cache or the published file. No `githubRepo`. |
| `hf-paper-2610.11216.json` | `GET https://huggingface.co/api/papers/2610.11216` | A Daily Papers entry with `githubRepo` / `githubStars`. |
| `hf-paper-404.json` | `GET https://huggingface.co/api/papers/0000.00001` | 404 body ("Paper not found"). |
| `openalex-cites-flash-attention.json` | `GET https://api.openalex.org/works?filter=cites:<14 FlashAttention lineage ids>,from_publication_date:2026-09-11&per-page=200&select=id,title,publication_date,type,referenced_works&cursor=*` | Real page (keyless, 1 credit). Each of the 3 works cites exactly one lineage node, so all fall below `min_lineage_cites=2`. |
| `hf-paper-2101.03961.json` | `GET https://huggingface.co/api/papers/2101.03961` | Switch Transformer: `githubRepo` is an automatic link (`githubRepoAddedBy: "auto"`) to an unrelated mirror (`pwc-1/Paper-10`); the code badge must ignore it. |
