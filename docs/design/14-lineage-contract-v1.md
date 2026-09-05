# 14. Lineage Artifact v1 Contract

- **更新日:** 2026-08-30
- **対象:** P2 producer / quality gate / conference・deep consumer
- **上位設計:** [`11-target-architecture.md`](11-target-architecture.md)、
  [`12-implementation-plan.md`](12-implementation-plan.md)

この文書は P2 の実装時に producer、監査、viewer が同じ wire contract を使うための補助仕様である。
既存 artifact を推測変換する根拠にはしない。

## 1. `lineage-artifact-v1`

公開 artifact は top-level object とし、`schema_version`、`root`、`nodes`、`edges`、`clusters`、
`meta` を持つ。

- `root` は graph-local node ID。非空 graph では一意に node へ解決し、その node は
  `is_focus: true` かつ canonical `seed_paper_id`（小文字 40 hex）を持つ。
- catalog 起点の全 focus node は `seed_paper_id` を保持する。OpenAlex / Semantic Scholar ID で
  上書きしない。
- root 選択は focus node の degree 降順、同数なら graph-local ID 昇順。first-node fallback は禁止。
- node ID と edge は一意、edge endpoint は必ず解決する。node は graph-local ID 昇順、edge は
  `(src, dst, relation)` 昇順にする。
- viewer 移行中は `rel == relation`、`conf == confidence` を必須とする。
- relation は `supersedes | successor | extends | ablation | baseline_only | contrasts`。
- confidence は 0〜1、rationale は非空。

edge provenance は次の閉じた形を使う。

```json
{
  "producer": {"name": "paperpilot.scripts.build_conference_lineage", "version": "1"},
  "evidence": {"source": "openalex", "kind": "citation", "sha256": "<64 hex>"},
  "classification": {
    "method": "citation_heuristic",
    "provider": null,
    "model": null,
    "prompt_version": null,
    "schema_version": "citation-successor-v1"
  }
}
```

LLM 分類では provider、model、prompt/schema version を非空にする。非 LLM 分類だけ
provider/model/prompt_version を `null` にできる。evidence hash は分類へ渡した正規化入力と
edge endpoint を canonical JSON（UTF-8、key sort、空白なし）にした SHA-256 とする。

## 2. `deep-manifest-v1`

`docs/<conference>/deep-manifest.json` は array ではなく次の wrapper object とする。

```json
{
  "schema_version": "deep-manifest-v1",
  "conference": "iclr-2026",
  "generated_at": "2026-08-30T00:00:00Z",
  "entries": [
    {
      "paper_id": "<40 hex>",
      "aliases": [
        ["arxiv", "2602.18473"],
        ["semantic_scholar", "<graph root id>"]
      ],
      "arxiv_id": "2602.18473",
      "title": "...",
      "filename": "deep-2602.18473.json"
    }
  ]
}
```

- entry の `paper_id` は対象 conference の `papers.json` に存在し、対応 deep artifact の
  `meta.seed_paper_id` と root focus node の `seed_paper_id` に一致する。
- `paper_id` と `arxiv_id` は catalog の同じ一意な row で explicit に対応していなければならない。
  catalog 全体から別々に拾った値、title join、別 row の組合せは禁止する。
- `arxiv_id`、arXiv alias、filename は完全一致する。
- `semantic_scholar` alias は artifact の root に完全一致する。
- Semantic Scholar の focus 応答にある `externalIds.ArXiv` は要求 arXiv ID と正規化後に完全一致する。
- duplicate paper ID、duplicate alias、曖昧な mapping は manifest 全体を失敗させる。
- meta、filename、先頭 node、title から ID を推測する fallback は禁止する。

## 3. cache v2

deep / conference の分類 cache key は `src`、`dst`、evidence SHA-256、producer version、provider、
model、prompt version、schema version を含む canonical hash とする。旧 `src->dst` entry は v2 hit として
扱わない。分類失敗、期限切れ、provider 不一致も成功 hit として扱わない。

## 4. fail-closed migration

既存 conference/deep artifact は schema、seed、structured provenance が不足している。
exact alias で一意に監査できないものは書き換えず `audit_status=failed` または `unknown` のまま通常棚から外す。
2026-08-30 時点の既存 deep 14件は catalog の exact arXiv alias で結べるものが 0 件のため、すべて再生成対象とする。
title-only join と外部 API / LLM を使う bulk regeneration はこの実装作業では行わない。

## 5. 出荷 gate

- Python の共有 validator と JSON Schema の両方を追加する。
- producer unit test、quality failure test、manifest ambiguity test を先に固定する。
- consumer は quality `ready + passed` と v1 contract の両方を満たし、quality row の `path` と
  `input_sha256` が取得した artifact bytes に一致する場合だけ通常表示する。deep manifest と各 deep
  artifact も別々に hash binding する。
- catalog / URL との canonical join は検証済み focus node の `seed_paper_id` だけを使う。
  graph-local ID や任意 node の `paper_id` を canonical ID とみなさない。
- legacy reader を残す場合も通常導線では選択せず、root/focus を first node に fallback しない。
