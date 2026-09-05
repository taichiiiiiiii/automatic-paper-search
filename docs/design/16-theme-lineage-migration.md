# 16. Theme Lineage P2T 移行契約

- **更新日:** 2026-08-30
- **状態:** ローカル実装・統合検証済み（外部再生成・fixture 承認・公開は未実施）
- **上位契約:** [`14-lineage-contract-v1.md`](14-lineage-contract-v1.md)

テーマ探索は unified site の一つのモードであり、conference/deep と同じ lineage quality gate を通す。
現行 `theme.js` は legacy artifact を直接表示できるため、producer と consumer を同時に fail-closed へ移行する。

## 1. Identity と dedup

- focus の canonical `seed_paper_id` は arXiv / OpenReview / ACL Anthology / CVF の strong alias だけから得る。
- `identity-aliases-v1.json` の exact unique match を優先し、未登録の canonical source alias は
  `make_paper_id(source, source_id)` で決定する。
- DOI は sidecar lookup / exact dedup aliasには使えるが、DOI 単独から canonical ID を新規生成しない。
- Semantic Scholar/OpenAlex ID、title、year は canonical identity にしない。
- 複数 alias が異なる canonical ID に解決したら artifact 全体を失敗させる。
- canonical alias を持たない候補を focus にしない。全候補が解決不能なら valid empty artifact とする。
- dedup は graph-local ID または exact normalized strong aliasだけ。同じ title/year の別 alias は merge しない。
- survivor は citation desc、graph-local ID asc で決定し、conflicting seed ID は失敗させる。
- theme node の `aliases` は正規化済み arXiv / OpenReview / ACL Anthology / CVF / DOI の
  `[namespace, source_id]` だけを許し、node 内・graph 全体で一意にする。conference/deep の既存
  `semantic_scholar` alias は migration 互換の shape としてだけ許すが、URL exact alias 解決には使わない。

title は検索・topic relevance・relation heuristic には使えるが、identity/join/dedup には使わない。

## 2. Provenance と cache v2

全 edge は `make_provenance()` の closed structured provenance を持つ。evidence hash は endpoint と、
classifier が実際に読んだ title/year/citations/intents/contexts または LLM system/user だけを
canonical JSON 化して作る。

LLM cache identity は次を含む。

```text
version, src, dst, evidence_sha256,
producer.name, producer.version,
provider, model, prompt_version, schema_version
```

- key は `v2:<canonical sha256>`
- success entry は status、expires_at、cache_identity、classification、structured provenance を持つ
- legacy `src->dst`、expired、failure、provider/model/version/evidence 不一致は miss
- LLM failure は success cacheへ保存しない

## 3. Theme artifact v1

`build_theme_lineage()` は write 前に次を満たし、共有 validator へ `kind="theme"` で渡す。

- `schema_version: lineage-artifact-v1`
- `clusters: []`
- 全 node に boolean `is_focus`、全 focus に canonical `seed_paper_id`
- `rel == relation`、`conf == confidence`
- node は graph-local ID asc、edge は `(src,dst,relation)` asc
- duplicate edge は同 tuple で決定的に除去
- root は focus degree desc、同数 graph-local ID asc。first-node fallback 禁止
- `meta.kind="theme"`、generator、generated_at
- validation failure 時は既存 artifact を上書きしない

JSON Schema と Python/JS validator は theme focus にも `seed_paper_id` を必須にする。
quality audit は theme seed の形式を検査するが、catalog membership は conference/deep にだけ要求する。

## 4. Quality read model / JS parity

`LineageCore.parseQualityManifest()` は JSON Schema と同じ closed shape を検査する。

- base row、audit、check は required key と extra key を厳密検査
- deep-only field を non-deep row で拒否
- kind別 collection ID と path、timestamp、integer count、hash、actor/status を検査
- collection ID/path と check name の順序・一意性を検査
- `resolveQualityCollection()` は `kind=theme`、slug、`themes/<slug>/lineage.json` の一意一致を返す
- `audit_status=passed` は nonempty checks が全て passed の場合だけ受理する。`ready + passed` はさらに
  artifact schema v1、artifact/fixture の valid SHA-256、passed の `artifact_contract_v1` と
  `golden_fixture` を必須にする。failed/unknown row は明示的な非認可 row として保持できる。

## 5. Theme consumer

- `lineage-core.js` を `theme.js` より先に読む
- global `../lineage-quality-v1.json` を strict parse
- theme row が `ready + passed` でなければ artifact を取得・表示しない
- fetch URL は検証済み row.path から組み立てる
- artifact bytes の SHA-256 が `input_sha256` と一致した後だけ
  `LineageCore.parseArtifact(data, {kind:"theme"})` を使う
- artifact response は 8 MiB を上限とし、`Content-Length` と streaming 実読込の両方で超過を拒否する。
  audited SHA-256 不一致時は UTF-8 decode / JSON parse 前に失敗させる。
- missing/failed/hash mismatch/parse failure は `state.data=null` の監査未合格表示
- `lineage-core.js` が欠落または必要 API 不足でも throw せず同じ監査未合格表示へ fail closed にする。
- `themes/_quality.json` は badge telemetry にだけ使い、表示認可には使わない
- relation/confidence の canonical field を描画し、first-focus fallback を削除
- URL node は strict artifact 上の canonical seed、exact alias、graph-local ID だけから解決する
- 小文字 40 hex の URL node は canonical `seed_paper_id` namespace の予約値とする。canonical focus に
  一意一致しなければ、Semantic Scholar 型 graph-local ID や alias へ fallback しない。

## 6. 既存 artifact

2026-08-30 時点の公開 theme 3件は全て `ready/failed` かつ legacy schema である。string provenance、
canonical seed 欠落、title/year dedup の過去判断は安全に逆算できないため、推測 migration はしない。

新 producer で再生成しただけでは表示しない。matching frozen audit fixture を人手レビューし、
quality read model が `ready + passed` になった artifact だけ通常導線へ戻す。

## 7. 受入 gate

- title/year が同じ別 strong alias を merge しない
- alias conflict、seed欠落、legacy provenance、alias field不一致を拒否
- cache v2 exact hit と全 mismatch/expired/failure miss
- root/node/edge order は入力順非依存
- theme focus seed欠落を Python/Schema/JS 全てで拒否
- quality missing/failed/unknown/hash mismatch時に artifact fetch/renderしない
- valid row + exact SHA + strict v1だけ表示する
- `theme.js` に legacy `.rel/.conf` consumer と first-focus fallback がない
- asset version sync、Python/Node focused tests、full suite を通す

外部 API/LLM を使う実 artifact 再生成、fixture の人手承認、workflow dispatch、公開は別承認とする。
