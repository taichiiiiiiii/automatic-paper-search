# スキーマ一覧（P1 タスク A）

[`docs/design/39-typescript-cloudflare-migration.md`](../design/39-typescript-cloudflare-migration.md) §3 の P1 成果物:
「出力ごとのスキーマ有無の一覧」「ajv (TS) と jsonschema (Python) の判定一致テスト」。
本書は Python 側のコード（`grep -rn "schema.json" paperpilot/`）と公開ファイルの実体を照合して作成した。

**重要な前提**: 本番の Python コード（`paperpilot/scripts/*.py` 等）は `jsonschema` を一切 import していない。
`schema.json` / `jsonschema.Draft202012Validator` を使っているのは **`paperpilot/tests/` だけ**であり、
書き出し時にスキーマで弾くゲートは今のところ存在しない（設計書 §3 が「書き出し直前の検証は本番に新しく入るゲート」と
明記している通り）。つまり「どのスキーマがどの出力を検証しているか」は実装のゲートではなく、**テストが事後的に
検証している対応関係**であり、below の対応は `grep -rn "schema.json" paperpilot/tests/` と実ファイルの手検証で確定した。

## 1. 公開物（`docs/`、design・research を除く）とスキーマの対応

| 公開物 | スキーマ | 検証元テスト | 備考 |
|---|---|---|---|
| `docs/identity-aliases-v1.json` | `identity-aliases-v1.schema.json` | （`paperpilot/scripts/replay_run.py` が `identity/projector.py` の計算結果 `projection.aliases` を書き出す。直接のスキーマテストは無いが構造は identity-coverage 系と対） | 実データで ajv/Python ともに **OK**（§3 の一致テストで確認済み） |
| `docs/lineage-pilot-index-v1.json` | `lineage-pilot-index-v1.schema.json` | `test_lineage_pilot_bundle.py` | OK |
| `docs/lineage-quality-v1.json` | `lineage-quality-v1.schema.json` | `test_build_lineage_quality_manifest.py` | OK |
| `docs/search-index-v2.json` | `search-index-v2.schema.json` | （`build_search_index.py` 出力。スキーマテストは無いが名称一致） | OK |
| `docs/paper-details-v1/*.json`（256 shards） | `paper-details-v1.schema.json` | （`build_pages.py` 出力） | 256 件全数 OK |
| `docs/search-paper-ids-v1/*.json`（111 shards） | `search-paper-ids-v1.schema.json` | （`build_search_index.py` 出力） | 111 件全数 OK |
| `docs/<conf>/lineage.json`（10 学会: aaai-2026 / acl-2025 / cvpr-2025 / cvpr-2026 / eccv-2024 / emnlp-2025 / iccv-2025 / iclr-2026 / icml-2025 / neurips-2025） | `lineage-artifact-v1.schema.json` | `test_lineage_contract.py` | **13 件全数 NG。§4「発見した不整合」参照** |
| `docs/themes/<slug>/lineage.json`（3 テーマ: flash-attention / mixture-of-experts / vision-transformer） | `lineage-artifact-v1.schema.json` | `test_lineage_contract.py` | 同上（NG） |
| `docs/<conf>/deep-manifest.json`（現状 iclr-2026 のみ） | `deep-manifest-v1.schema.json` | （`generate_deep_manifest.py` 内の `validate_deep_manifest`。JSON Schema ファイルそのものを食わせるテストは無い） | **NG。§4 参照** |
| `docs/<conf>/deep-*.json`（個別 deep tree、14 本） | **無し** | — | `lineage-artifact-v1` と同じ `{root,nodes,edges,meta}` 形だが、23 本のどのスキーマも対応する `$id`/用途を持たない。lineage-artifact-v1 を流用するなら meta 必須化後に要検証（下記§4-1 と同じ欠落が出る） |

## 2. スキーマがあるが「公開ファイルが存在しない」もの（12 本）

次の 12 スキーマは、`paperpilot/tests/` の中で**インメモリで構築した値**だけを検証しており、
`docs/` や `paperpilot/data/` に対応する実ファイルが存在しない（休眠機能 or 未来の契約）。

| スキーマ | 状態 | 根拠 |
|---|---|---|
| `conference-baseline-assessment-v1` | 開発中（`paperpilot/conference_watch/`）。CI で生成される candidate は一時アーティファクトで git に残らない | `test_conference_ratio_assessment.py` のみが参照 |
| `conference-probe-observation-v1` | 同上 | `test_conference_watch_schemas.py` |
| `conference-release-state-v1` | 同上。`conference-probe-observation-v1` を `$ref` で参照する唯一のクロスファイル参照 | `test_conference_watch_schemas.py` |
| `conference-source-snapshot-v1` | 同上 | `test_conference_watch_schemas.py` |
| `lineage-artifact-v2` | **本番未使用**。`paperpilot/scripts/_lineage_contract_v2.py` はどの `build_*.py` からも import されていない（次世代フォーマットの先行実装） | `test_lineage_v2_contract.py` のみ |
| `lineage-audit-fixtures-v2` | 同上 | `test_lineage_v2_contract.py` |
| `lineage-quality-v2` | 同上 | `test_lineage_v2_contract.py` |
| `lineage-blind-review-pack-v1` | `paperpilot/paper_slides/review.py` / レビュー準備パイプラインの中間表現。ディスクに永続化しない | `test_lineage_review_prep.py` |
| `paper-slide-public-index-v1` | Paper Slide 機能自体が休眠scaffold（CLAUDE.md 記載）。`docs/` に出力場所が無い | `test_slide_public_index.py` |
| `paper-slide-public-manifest-v1` | 同上 | `test_slide_public_index.py` |
| `slide-deck-v1` | 同上 | `test_slide_deck_contract.py` |
| `run-manifest-v1` | `paperpilot/replay/manifest.py` の新しい run 契約。**既存の `paperpilot/data/run_history.jsonl` とは別物**（§4-3 参照） | `test_replay_manifest.py` |

これらは今回の ajv 一致テストの対象外（公開ファイルが無いので比較対象が無い）。パイプラインが実際にこれらを
書き出すフェーズ（P4 系、P5 切替）に入った時点で agreement test にケースを追加する。

## 3. 「生成される state files」の対応（`paperpilot/data/`）

| ファイル | スキーマ | 備考 |
|---|---|---|
| `paperpilot/data/identity-coverage-v1.json` | `identity-coverage-v1.schema.json` | OK |
| `paperpilot/data/lineage-audit-fixtures-v1.json` | `lineage-audit-fixtures-v1.schema.json` | OK |
| `paperpilot/data/conference-sources-v1.yaml` | `conference-sources-v1.schema.json` | **ファイルは YAML**。`conference_watch/registry.py` が `yaml.safe_load` してから Python 側で dict をスキーマ検証している。ajv 側は JSON パーサーしか持たず、本タスクの hard limit（npm 依存追加禁止）で YAML parser を追加できないため、**agreement test からは除外**（§5-3、`python-verdicts.json` の `excluded` に記録） |
| `paperpilot/data/run_history.jsonl` | 対応スキーマ無し（`run-manifest-v1` とは構造が全く異なる。§4-3） | JSONL（1行1オブジェクト）。23 本のどのスキーマにも一致しない |
| `paperpilot/data/seen_ids.json` / `seen_ids.daily.json` | 無し | `{id: timestamp}` の単純 dict（CLAUDE.md 絶対ルール§8）。専用スキーマなし |
| `paperpilot/data/theme_aliases.json` / `theme_blacklist.json` / `paper_repos.json` / `lineage_denylist.json` / `lineage_foundational_allowlist.json` / `lineage-quality-policy-v1.json` / `sol-abstract-local-v1.json` | 無し | 内部設定・許可リスト。公開契約ではなく運用設定なので対象外 |
| `paperpilot/data/lineage-cache/*.json`（S2 メタ＋LLM 分類キャッシュ、多数） | 無し | 再開用キャッシュ。書式は内部実装依存で公開契約ではない |

## 4. 発見した不整合（「不一致を取り繕わない」の指示に基づき明記）

### 4-1. `lineage-artifact-v1.schema.json` は現在どの公開 `lineage.json` にも合格しない

スキーマは `required: [schema_version, root, nodes, edges, clusters, meta]` を要求するが:

- **会議版**（`docs/<conf>/lineage.json`、`build_lineage.py` / `build_conference_lineage.py` 製）は
  `{root, nodes, edges, clusters}` のみを持ち、**`schema_version` と `meta` が無い**。
- **テーマ版**（`docs/themes/<slug>/lineage.json`、`build_theme_lineage.py` 製）は
  `{root, nodes, edges, meta}` のみを持ち、**`schema_version` と `clusters` が無い**。

実測（`uv run --extra dev python`、`Draft202012Validator(..., format_checker=FormatChecker())`）:

```
docs/iclr-2026/lineage.json         -> 354 errors（実データ・中身が大きい分エラー数も多い）
docs/eccv-2024/lineage.json         -> 234 errors
docs/themes/vision-transformer/...  -> 572 errors
docs/aaai-2026/lineage.json（空スタブ 291B） -> 3 errors
```

いずれも先頭のエラーは `'schema_version' is a required property`。**ajv・Python とも「無効」で完全に一致する**
（= agreement test が検出すべきなのは判定の不一致ではなく、この現状不整合そのもの）。これは今回の TS 移行で
直す対象ではなく、「本番ゲートを有効化する前に埋めるべき実データ側のギャップ」として記録するに留める
（P1 の役割は一致テストを作ることであり、公開データを書き換えることはスコープ外）。

### 4-2. `docs/<conf>/deep-manifest.json` は配列、スキーマはオブジェクトを要求

現在の `generate_deep_manifest.py`（`generate_manifest()` / `write_manifest()`）は
`{schema_version, conference, generated_at, entries}` の**オブジェクト**を書く実装になっている
（`DEEP_MANIFEST_VERSION` を正しく埋めている）。ところが現在 git にコミットされている
`docs/iclr-2026/deep-manifest.json` は

```json
[{"arxiv_id": "1706.03762", "title": "Attention is All you Need", "filename": "deep-1706.03762.json"}, ...]
```

という**裸の配列**（14 要素）で、新しい生成関数が書く形と一致しない＝**スクリプトが新形式に対応した後、
一度も再生成されていない stale ファイル**。Python/ajv とも「スキーマ違反」で一致するが、
原因は「生成し直せば直る」古いコミット済みデータであることを明記する。

### 4-3. `run-manifest-v1.schema.json` は `run_history.jsonl` の形ではない

`run-manifest-v1` の `required` は
`[schema_version, run_id, pipeline, status, as_of, code, invocation, dependencies, inputs, artifacts, outputs, producers, counts, failures]`
という重厚なプロダクト証跡フォーマットだが、実際にコミットされている `paperpilot/data/run_history.jsonl` の
各行は `{run_id, started_at, finished_at, duration_seconds, stage_counts, sources_status, errors, output_files}`
という全く別の軽量フォーマット（CLAUDE.md 絶対ルール§9 が定義する現行契約）。
`run-manifest-v1` は `paperpilot/replay/manifest.py`（新しい replay/parity 基盤。設計書 §7.2 の比較ツール
`apps/pipeline/parity` に相当する機能の先行実装と見られる）専用の**別物**であり、`run_history.jsonl` を
このスキーマで検証しようとするのは最初から筋が違う。対応する公開ファイルが無いので agreement test には含めない
（§2 の表に記載済み）。

## 5. スキーマが無い主な公開物と方針

設計書 §3 が例示する papers.json / conferences.json / themes-manifest.json を含め、実地踏査で見つかった
「schema 無し」出力:

| 出力 | 中身 | 方針（提案） |
|---|---|---|
| `docs/conferences.json` | 学会一覧（配列、10件） | **スコープ外**。トップレベルの集約 index で、各学会の詳細は `papers.json` 側にある。新規スキーマを作るなら P2 以降、画面契約と合わせて設計 |
| `docs/<conf>/papers.json`（10 学会） | 論文一覧（配列、数千件/学会） | **スキーマ作成を推奨**（P4b）。`build_pages.py` の縮小ゲート・Oral保持ゲート等、既に強い暗黙契約があるのでスキーマ化の価値が高い。ただし件数が多く、1 論文あたりのフィールドも多い（title/authors/abstract/venue/score 等）ため P1 の範囲では手を付けない |
| `docs/daily/papers.json` | daily-watch の古い出力（10件） | **削除予定**（設計書 §9.3 で P5 に削除対象と明記）。新規スキーマは作らない |
| `docs/search-index.json`（v1） | 横断検索インデックス（旧版、28,300件） | **作らない**。v2 に統一済みで v1 は互換アーティファクトとして残っているだけ（CLAUDE.md 記載）。P5 で `search-index-v2` 完全移行後に削除予定 |
| `docs/themes/themes-manifest.json` | テーマ一覧（配列、3件） | **スコープ外 or 軽量スキーマを後で追加**。`generate_themes_manifest.py` 製、件数が少なく壊れても影響が小さい |
| `docs/themes/_quality.json` | テーマ品質監査結果（`compute_theme_quality.py` 製、`{generated_at, summary, themes}`） | **新規スキーマ推奨**（`lineage-quality-v1` と役割が近いが構造は非互換。audit gate の一部なので型を固定する価値がある） |
| `docs/<conf>/deep-*.json`（個別 deep tree） | `{root,nodes,edges,meta}` | `lineage-artifact-v1` を流用する案があるが、§4-1 と同じ `meta`/`schema_version` 欠落が起きるはず（未検証、追って確認） |

## 6. json-schema-to-zod（`zodVersion: 4`）による変換結果

23 本すべてに **jsonSchemaToZod() を実行して例外になったものは無かった**（= 「fail」はゼロ）。
ただし 19 本は **`z.any()` へのフォールバックを含む「部分変換」**で、4 本のみ完全変換（フォールバック無し）。

| 結果 | 対象スキーマ |
|---|---|
| **clean**（z.any() 無し） | `conference-probe-observation-v1`、`paper-slide-public-index-v1`、`paper-slide-public-manifest-v1`、`search-paper-ids-v1` |
| **partial**（z.any() あり） | 残り 19 本（下記で原因を分類） |
| **fail**（例外） | 無し |

z.any() の実測件数（カッコ内）と、確認した主要因:

1. **`prefixItems`（2020-12 のタプル配列キーワード）が丸ごと `z.array(z.any()).min(N).max(N)` に潰れる**。
   設計書 §3 が懸念していた「`$ref`、`patternProperties` 等」の筆頭格はむしろこちら。実測例
   （`paper-details-v1` (1)）:
   ```
   "papers": z.array(z.array(z.any()).min(2).max(2))
   ```
   元の `prefixItems` は `[sha1パターン文字列, 要旨文字列]` と型が違う 2 スロットだったが、
   両方 `z.any()` になり型情報が失われる。同じ現象が `conference-source-snapshot-v1` (2)、
   `deep-manifest-v1` (1)、`identity-aliases-v1` (1)、`lineage-artifact-v1` (7)、`lineage-artifact-v2` (6)、
   `lineage-blind-review-pack-v1` (5)、`search-index-v2` (1) で確認。
2. **ローカル `$ref`（`#/$defs/...`）が解決されず丸ごと `z.any()` になる場合がある**。
   `$defs` の中身が単純な `{"type":"string","pattern":...}` でも再現する。実測例
   （`conference-baseline-assessment-v1`、$defs 定義は単純な string/integer pattern のみ）:
   ```
   "edition_id": z.any()          // 元は {"$ref": "#/$defs/edition"} = string pattern
   "previous_count": z.any()      // 元は {"$ref": "#/$defs/count"} = integer min/max
   ```
   同じ現象が `run-manifest-v1` (9件。$defs 34 箇所参照)、`slide-deck-v1` (24件。$defs 55 箇所参照) 等、
   **ローカル $ref の参照数が多いスキーマほど z.any() も多い**傾向がある。根本原因（ライブラリの
   `$defs` 解決の既知の限界か、`depth` オプションの挙動か）は特定しきれていない
   （`depth: 0/3/10` を試しても件数は変化せず、再帰の深さの問題ではないことは確認済み）。
   ⇒ **zod 生成コードは今回出荷しないため実害は無いが、将来 zod 型を実際に生成コードとして
   採用する場合は、この変換ツールにそのまま頼らず手で $defs を展開するか、別ツール/手書きが必要**。
3. **外部ファイル `$ref`（クロスファイル参照）は未解決**。`conference-release-state-v1` が
   `"$ref": "conference-probe-observation-v1.schema.json"` を持つが、`jsonSchemaToZod()` は単一スキーマしか
   渡していないため解決できず、5 箇所が `z.any()` になる。ajv 側は本タスクで実装した通り全 23 スキーマを
   1 インスタンスに `addSchema` することで正しく解決できる（§7 参照）ので、**ajv が正本、zod 変換は
   参考情報**という位置づけが妥当。
4. **スキーマ自体が緩い（`{"type":"object"}` のような無制約の箱）を正直に `z.any()`/`z.record(.., z.any())`
   に落としているだけで、変換ツールの欠陥ではないケース**もある。例: `identity-coverage-v1` の
   `failures`/`alias_conflict_details`（`items: {"type":"object"}`、プロパティ未定義）。これは情報の
   ロスではなく元のスキーマの緩さを正しく反映している。

**結論**: 23 本中 fail は 0、clean は 4、partial は 19。P1 の方針どおり「変換できないものは ajv による
実行時検証で補う」を採用し、**zod 型は生成・出荷しない**（ajv 検証モジュールのみ実装）。

## 7. ajv 検証モジュール

`packages/core/src/schemas/`:

- `paths.ts` — `packages/core/src/schemas/` から祖先ディレクトリを辿って repo の `schemas/` を自動検出する
  （`import.meta.url` 基点。深さをハードコードしないので、設計書 §7.3 の「P5 で `data/` に 1 回だけ移動する」
  リポジトリ再編があっても `schemas/` の位置自体が変わらない限り動く）。コピーはしない（§3 の指示どおり）。
- `validator.ts` — `ajv/dist/2020`（draft 2020-12）+ `ajv-formats` で 1 つの Ajv インスタンスに 23 本全部を
  `addSchema` し、`$id`（`https://paperpilot.local/schemas/<name>.schema.json`）経由で相互参照を解決する。
  `conference-release-state-v1 -> conference-probe-observation-v1` の唯一のクロスファイル `$ref` もこれで解決
  できることをテストで確認済み（zod 変換ではここが未解決になる、§6-3 と対比）。
  `validateArtifact(schemaName, data) -> {ok, errors}` を公開。`schemaName` は `.schema.json` 拡張子の有無どちらでも可。
- `index.ts` — 上記の re-export（`packages/core/src/index.ts` 本体は今回編集していない。他タスクが
  トップレベル export に統合する想定）。

## 8. agreement test

`packages/core/test/schemas/`:

- `fixtures/generate-python-verdicts.py` — `uv run --extra dev python packages/core/test/schemas/fixtures/generate-python-verdicts.py`
  で一度だけ実行し、`fixtures/python-verdicts.json` を生成・コミットする（スキーマや対象ファイルが変わったら再実行）。
  `Draft202012Validator(schema, format_checker=FormatChecker())` で §1・§3 の全ペアを判定する。ファイル列挙は
  ハードコードではなく実ディレクトリに対する glob（`docs/paper-details-v1/*.json` 等）なので、学会追加やシャード増加に
  自動追従する。
- `fixtures/python-verdicts.json` — 387 ペア（`cases`）+ 1 件の除外（`excluded`、conference-sources-v1 の YAML。
  §3 参照）を記録。
- `agreement.test.ts` — fixture の各 `case` について `validateArtifact()` を呼び、ajv の `ok` が Python の `ok` と
  一致することを検証。不一致時はどちらのエラーメッセージも表示する。加えて:
  - fixture 自体の整合性（`caseCount` 一致、YAML 除外がドキュメント化されているか）
  - 23 スキーマ全てが名前解決できること
  - クロスファイル `$ref` が実際に解決されること
  - 不明なスキーマ名で分かりやすい例外になること
  - `.schema.json` 拡張子の有無どちらでも同じ結果になること

### 実行結果（2026-10-04 時点）

```
npx --yes pnpm@10.34.6 --filter @paperpilot/core exec vitest run test/schemas/agreement.test.ts
 ✓ test/schemas/agreement.test.ts (393 tests) 5.9s
   387 件のファイル×スキーマ一致ケース + 6 件の基盤テスト、全て green
```

387 ケースの内訳: **373 件 OK（ajv/Python 一致で合格）、14 件 NG（ajv/Python 一致で不合格、§4-1・§4-2 の
不整合が原因）**。**ajv と Python の判定が割れたケースは 0 件。**

パフォーマンス上の注記: `docs/identity-aliases-v1.json`（28,300 件、非スカラー要素への `uniqueItems: true`）は
ajv の uniqueItems チェックが非スカラー要素に対して総当たり deep-equal にフォールバックするため O(n²) になり
約 5.6 秒かかる。個別テストに 30 秒の timeout を設定して対応した（バグではなくこの schema/data 形状の実コスト）。

`npx --yes pnpm@10.34.6 --filter @paperpilot/core exec tsc -p tsconfig.json` は本タスクのファイル
（`src/schemas/*`、`test/schemas/*`）由来のエラーは無し。実行結果は
`src/pycompat/jsonDumps.ts(143,33): error TS2538` の 1 件のみで、これは並行して別タスクが作業中の
`packages/core/src/pycompat/`（本タスクのスコープ外。`hard limit` により編集不可）由来。
`vitest run`（フィルタ無し、パッケージ全体）も同様に `test/pycompat/sort.test.ts` の 2 件（`-0`/`0` の符号判定）
のみが失敗し、本タスクの `test/schemas/agreement.test.ts` 393 件は全て green（899 件中 897 passed / 2 failed、
失敗 2 件は pycompat 側）。

## 9. 言語差（設計書 §7.2 に対応する実測）

- **`pattern` の `\d`/`\w`/`\S`**: `lineage-artifact-v1` 等の `id`/`generator` フィールドは `\S`（非空白）を多用する。
  Python の `re` は str パターンに対し既定で Unicode 対応（`\S`/`\s` は全角文字・絵文字も含めて判定）、
  JS の `RegExp` は `\s` の判定対象はほぼ同じだが **`\d`/`\w` は `u` フラグを付けても ASCII のみ**という非対称が
  設計書の指摘通り存在する。23 本の中で実際にこの差が表面化しうるのは `arxiv_id` 系パターン
  （`^\d{4}\.\d{4,5}(v\d+)?$`、`deep-manifest-v1`・`lineage-artifact-v1`・`lineage-quality-v1` 等）だが、
  **実データの arXiv ID は常に ASCII 数字**なので、今回の 387 ケースでは不一致は発生しなかった
  （全角数字などを含む不正データが来た場合のみ露出するリスクとして記録）。
- **`format: date-time`**: 13 本のスキーマが使用。ajv-formats と Python jsonschema の `FormatChecker` は
  いずれも RFC3339 風の `date-time` を受理するが、実装（正規表現 vs `datetime.fromisoformat` 系）が異なる。
  今回の実データ（`paperpilot/data/identity-coverage-v1.json` の `as_of: "2026-08-30T00:00:00Z"` 等）では
  両者一致（§8 の実行結果の通り不一致 0 件）。**`lineage-artifact-v1` の `generated_at` は `format` キーワードでは
  なく独自 `pattern`**（`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`）で検証しており、
  これは Python の `isoformat()` が出すマイクロ秒付き・`+00:00` オフセット表記（設計書 §7.2 が懸念する形）を
  明示的に許容する設計になっている。ただし現状この `generated_at` フィールド自体が公開ファイルに存在しない
  （§4-1）ため、実データでの検証は未実施。
- **Python `isoformat()` のマイクロ秒 + `+00:00`**: `docs/themes/flash-attention/lineage.json` の
  `meta.generated_at: "2026-06-14T08:21:52.372848+00:00"` がまさにこの形。`lineage-artifact-v1` の
  `pattern` はこれを通すが、`meta` 自体を含むオブジェクトが他の required 違反で既に無効なので、
  このフィールド単体の一致/不一致は今回のテストでは意味を持たない（§4-1 参照）。

## 10. 次フェーズへの引継ぎ

- §4 の 3 件の不整合（lineage-artifact-v1 必須項目欠落、deep-manifest.json の stale 配列形式、
  run-manifest-v1 と run_history.jsonl の無関係）は **データ修正であり P1 のスコープ外**。P4b/P4d で
  該当ビルダーを TS に移植する際、Python 版の出力が既にスキーマ違反であることを踏まえて移植する
  （「Python と結果が一致することを確かめる」の比較対象を素の出力にするか、スキーマ適合後の出力にするか
  判断が必要）。
- §5 の「スキーマ無し」出力（特に `papers.json` 系）にスキーマを追加するかは P2/P4b で決める。
- `conference-sources-v1`（YAML）の TS 側検証は、YAML パーサーを依存に追加できるフェーズ（P1 の hard limit
  解除後）で `js-yaml` 等を導入し、agreement test の `excluded` エントリを `cases` に昇格させる。
- json-schema-to-zod の `$defs` 解決が不安定な原因（§6-2）は、実際に zod 型を生成コードとして採用する
  フェーズまでに別途調査するか、変換ツールを使わず手書きする方針を検討する。
