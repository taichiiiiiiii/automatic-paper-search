# 12. 実装計画 — Unified Paper Discovery

- **状態:** 実装開始可能
- **作成日:** 2026-08-30
- **基準設計:** [`11-target-architecture.md`](11-target-architecture.md)
- **現況の正本:** [`09-implementation-status.md`](09-implementation-status.md)

この文書は目標設計を、変更ファイル、公開データ契約、実装順、失敗条件、受入テストまで
落とし込んだ実装用の正本である。実装中に契約を変える場合は、先に本書と JSON Schema、fixture を更新する。

---

## 1. 実装する結果

ユーザー向けの完成形は一つの GitHub Pages サイトである。

1. `/` で title / author / tag を横断検索する。
2. 検索結果は完全タイトル、タイトル、著者、タグの順に安定して順位付けし、上位 20 件と
   paging 可能な全結果を表示する。
3. 結果を選ぶと `/<conference>/?paper=<paper_id>` で同じ論文カードを必ず復元する。
4. カードは一覧時の要旨 preview を維持し、選択時だけ全文要旨 sidecar を遅延取得する。
5. 監査済みの関係データがあるときだけ、直接関係、conference lineage、deep lineage へ進める。
6. 狭い画面では graph ではなく読み上げ可能な関係リストを既定にする。
7. 公開は protected `develop` の exact SHA から作った一つの Pages artifact に限定する。

モード選択専用ページ、第二の公開サイト、全面 SPA、title-only join は作らない。

---

## 2. 今回固定する追加判断

### 2.1 `papers.json` は additive evolution とする

`docs/<conference>/papers.json` は top-level array と既存 key/value を維持し、各 row に次だけを追加する。

```json
{
  "paper_id": "40 lowercase hex",
  "source": "arxiv | openreview | acl_anthology | cvf",
  "source_id": "native source id"
}
```

既存 JavaScript は未知 key を無視するため後方互換である。移行 gate はファイルの byte identity ではなく、
追加 3 key を除いた全 row の順序と key/value が変更前と一致することとする。これにより conference page は
global search index の再読込や title fallback なしで `paper_id` を直接解決できる。

### 2.2 全文要旨は 256 shard の sidecar とする

現行 `papers.json` は転送量を抑えるため abstract を 320 文字へ切っている。これを解除して全 catalog を
重くせず、選択カードだけ全文を表示するため、次を新設する。

```text
docs/paper-details-v1/00.json
...
docs/paper-details-v1/ff.json
```

`paper_id` の先頭 2 hex を shard とし、各ファイルは次の形にする。

```json
{
  "schema_version": "paper-details-v1",
  "prefix": "7a",
  "papers": [["7a...40hex", "full abstract as stored in summary.csv"]]
}
```

- `papers` は `paper_id` 昇順。
- 同じ ID の本文が異なれば build を fail する。
- 空 abstract は空文字のまま保持し、外部ページから実行時取得しない。
- browser は選択後に該当 shard だけを fetch する。
- fetch 失敗時もカードと preview、原文リンクは残し、status region に失敗を表示する。
- shard は生成スクリプトだけが書き、未使用になった旧 shard も同じ実行で整合させる。

### 2.3 lineage quality read model を固定する

`docs/lineage-quality-v1.json` は次の envelope を使う。

```json
{
  "schema_version": "lineage-quality-v1",
  "as_of": "2026-08-30T00:00:00Z",
  "audit_version": "audit-v1",
  "collections": [
    {
      "collection_id": "conference:iclr-2026",
      "kind": "conference",
      "slug": "iclr-2026",
      "label": "ICLR 2026",
      "path": "iclr-2026/lineage.json",
      "availability": "ready",
      "audit_status": "failed",
      "freshness": "stale",
      "generated_at": null,
      "snapshot_date": "2026-06-28",
      "node_count": 158,
      "edge_count": 63,
      "artifact_schema_version": null,
      "input_sha256": "64 lowercase hex",
      "audit": {
        "fixture_sha256": "64 lowercase hex",
        "evaluated_at": "2026-08-30T00:00:00Z",
        "actor": "ci:audit-v1",
        "checks": []
      }
    }
  ]
}
```

- `collections` は `collection_id`、`checks` は `name` で昇順にする。
- `path` は project base 内の same-origin relative path だけを許可する。
- 通常の「系譜あり」棚は `availability=ready && audit_status=passed` だけを表示する。
- `freshness=stale` は日付と警告付きで表示できる。
- schema 不明、manifest fetch 失敗、unknown、failed は fail closed とする。
- UI は `audit.checks` から独自に合否を再計算しない。

### 2.4 リリース境界

リポジトリ内では workflow と検証スクリプトまで実装する。次はユーザーの明示承認なしに行わない。

- workflow dispatch
- GitHub / Cloudflare の設定・secret・branch protection の変更
- Pages / Worker / PyPI への公開
- `develop` への merge または push

Cloudflare の全 `develop` push auto-deploy を停止または Worker path 限定にしたことの確認は、production merge の
外部 gate として残す。リポジトリ内の実装だけで確認済み扱いにしない。

---

## 3. 依存関係と実装単位

```text
S1 exact-SHA release ───────────────────────────────────────────────┐
                                                                  │
D1a schema/identity → D1b shadow gate → D1c public projections     ├→ 最終統合検証
                                  ├→ P1 search/card context        │
                                  └→ D1d quality → P2 lineage/UI ──┤
                                                                  │
R0 deterministic replay core → R1 projector replay → R2 snapshots ┘

S2 collect/PyPI hygiene は S1・D1 と並行可能
```

| 単位 | 内容 | 前提 |
|---|---|---|
| S1 | exact-SHA Pages release、same-run handoff、rollback | なし |
| R0 | `uv.lock`、canonical hash/gzip、run manifest schema | なし |
| D1a | source ID normalizer、collector/internal CSV | R0 は並行可 |
| D1b | 28,300 row shadow coverage | D1a |
| D1c | papers additive IDs、search v2、alias、detail shards | D1b gate success |
| D1d | lineage quality producer | D1a |
| P1 | unified top、共有可能な論文カード | D1c、D1d |
| P2a | seed ID / provenance producer、exact migration | D1c、D1d |
| P2b | CTA、quality gate、relation list/mobile | P2a |
| S2 | weekly collection、PyPI build-only、Replay Lite wiring | S1/R0 と並行可 |

実装差分は上記の論理単位で検証する。実際の commit / PR 作成はユーザー承認後に行う。

---

## 4. S1 — exact-SHA Pages release

### 4.1 変更ファイル

新規:

- `.github/workflows/pages-release.yml`
- `.github/workflows/pages-rollback.yml`
- `.github/scripts/validate-pages-release.sh`
- `.github/scripts/promote-generated.sh`
- `paperpilot/tests/test_pages_release_workflow.py`
- `paperpilot/tests/test_promote_generated_sh.py`

変更:

- `.github/workflows/pages.yml`
- `.github/workflows/theme-on-demand.yml`
- `.github/workflows/regen-themes.yml`
- `.github/workflows/conference-on-demand.yml`

### 4.2 reusable release 契約

`pages-release.yml` は `workflow_call` 専用とし、直接 push / manual trigger を持たない。

- input `source_sha`: required、`^[0-9a-f]{40}$`
- input `release_kind`: required、`normal | rollback`
- input `request_id`: optional、安全な文字集合と長さを検証
- output: `source_sha`, `artifact_name`, `page_url`
- DAG: `validate → build → deploy → smoke`
- top-level `permissions: {}`
- validate/build: `contents: read`、secret なし
- deploy: `contents: read`, `pages: write`, `id-token: write`
- checkout は input exact SHA とし、checkout 後の HEAD 一致も検証
- `uv sync --frozen --extra dev`、ruff、full pytest、asset parse、Node suite skip 0
- `docs/` だけを一度 package し、`_paperpilot-deployment.json` に source SHA を記録
- smoke は bounded timeout で root、conferences、search v2、代表 catalog、公開 lineage、marker を GET/parse
- third-party action は commit SHA pin

`pages.yml` は protected `develop` push の薄い wrapper とする。bot workflow は
`generate → validate → promote → release` に分け、PAT fallback、`actions:write`、独立 `gh workflow run` を削除する。
`promote.outputs.sha` を同じ run の reusable release へ渡す。

### 4.3 promotion CAS

`promote-generated.sh` は candidate artifact を受け、有限回だけ次を行う。

1. remote `develop` の最新 SHA から clean tree を作る。
2. candidate の許可 path だけを適用する。
3. shared manifest、search、quality、asset versions を再生成する。
4. secret なしの validation を再実行する。
5. expected old SHA を確認して fast-forward push する。
6. non-fast-forward なら作業 tree を破棄し、新しい tip から再試行する。

許可 path 外、symlink、absolute path、`..`、競合、上限超過は変更を push せず fail する。

### 4.4 rollback

`pages-rollback.yml` だけが `workflow_dispatch` を持つ。

- 40 hex target と確認文字列を必須にする。
- target が `develop` ancestor かつ既知の成功 deployment marker を持つことを検証する。
- target 内の古い workflow code を実行せず、現在 branch の reusable workflow へ target SHA を渡す。
- source branch/data は巻き戻さず、Pages artifact だけを再公開する。
- smoke 失敗を成功扱いにしない。

---

## 5. R0 / Replay Lite core

新規:

- `paperpilot/replay/{__init__,canonical,manifest,artifacts}.py`
- `paperpilot/scripts/replay_run.py`
- `schemas/run-manifest-v1.schema.json`
- `paperpilot/tests/test_replay_{canonical,manifest,run}.py`

`.gitignore` から `uv.lock` を外し、解決済み lockfile を追跡する。

- canonical JSON: UTF-8、sorted keys、compact separator、末尾 LF 一つ。
- gzip: `mtime=0` と固定圧縮 level。
- SHA-256 は保存/upload する実 byte 列へ付ける。
- repository-relative POSIX path のみ。absolute、`..`、symlink escape を拒否する。
- manifest 必須 field:
  `run_id/pipeline/status/as_of/code/invocation/dependencies/inputs/artifacts/outputs/producers/counts/failures`。
- secret、Authorization、token 付き URL を保存しない。
- hash mismatch、missing、expired、dependency mismatch は別 error code で拒否する。

---

## 6. D1 — Identity / Search / Quality producer

### 6.1 変更ファイル

新規:

- `paperpilot/identity/{__init__,source_ids,projector}.py`
- `paperpilot/scripts/build_identity_lite.py`
- `paperpilot/scripts/build_lineage_quality.py`
- `schemas/{identity-aliases-v1,identity-coverage-v1,search-index-v2,search-paper-ids-v1,paper-details-v1,lineage-quality-v1,lineage-audit-fixtures-v1}.schema.json`
- `paperpilot/data/identity-coverage-v1.json`
- `paperpilot/data/lineage-audit-fixtures-v1.json`
- `paperpilot/data/lineage-quality-policy-v1.json`

変更:

- collector の中央 writer と OpenReview / CVF / ACL adapter
- `build_summary_csv.py`
- `build_pages.py`
- `build_search_index.py`
- lineage audit scripts と generation workflows

### 6.2 source ID pure API

```python
@dataclass(frozen=True)
class PaperIdentity:
    source: Literal["arxiv", "openreview", "acl_anthology", "cvf"]
    source_id: str
    paper_id: str

def identity_from_url(url: str) -> PaperIdentity: ...
def make_paper_id(source: str, source_id: str) -> str: ...
def normalize_alias(namespace: str, value: str) -> tuple[str, str]: ...
```

共通規則:

- `http|https`、known host のみ。
- percent decode は一度だけ。decode 後の slash、backslash、NUL、control character を拒否。
- fragment は無視し、空・複数候補・曖昧 parse を fail。
- title、authors、現在年を fallback ID に使わない。
- hash input は `paperpilot:v1:<source>:<source_id>` の UTF-8 byte 列。

Source 規則:

- arXiv: known 3 hosts、`/abs/` と `/pdf/*.pdf`、version suffix 除去、modern/legacy ID。
- OpenReview: `/forum?id=` が正確に一つ、case-sensitive。
- ACL: path ID から末尾 slash / `.pdf` だけ除去。
- CVF: `/content/<collection>/html/<filename>.html`、stem は case-sensitive。path 競合は fail。
- DOI は canonical source ではなく strong alias としてだけ正規化。

Python と browser で HTTP/HTTPS、host alias、version、PDF、percent encoding、case、duplicate query、
encoded slash、unknown host の同じ golden fixture を読む。

### 6.3 公開 projection

- `papers.json`: 既存 field + additive identity 3 field。
- legacy `search-index.json`: `[title, conference]`、byte-identical。
- `search-index-v2.json`: `[title, conference, paper_ref, authors, tags, year, paper_type]`。
- `search-paper-ids-v1/<block>.json`: 256 row 単位で `paper_ref` を canonical `paper_id` へ解決する。
- `identity-aliases-v1.json`: `[namespace, normalized_id, paper_id]` の昇順配列。
- `paper-details-v1/<prefix>.json`: §2.2。
- `lineage-quality-v1.json`: §2.3。

新規収集 CSV と `summary.csv` は `source,source_id` を保持し、legacy CSV は URL から補完する。
alias 同一 key / 同一 ID は dedup、同一 key / 異なる ID は全 build を fail する。生成物は temp tree で
全件検証してから置換し、途中まで更新しない。

### 6.4 28,300 row gate

- input は `conferences.json` の 10 catalog。`daily` は除外。
- rows = resolved = search v2 rows = unique `paper_id` = 28,300。
- coverage 100%、unknown host / parse failure / empty ID / collision / alias conflict = 0。
- source baseline: OpenReview 13,894、CVF 9,640、ACL 3,508、arXiv 1,258。
- identity 3 key を除いた paper row order と既存 key/value は不変。
- v2 title/authors/tags/type は catalog と完全一致。
- `paper_ref` は 0 からの連番で、ID block の同じ ordinal が catalog の canonical `paper_id` と一致する。
- year は source、次に conference slug、どちらもなければ `null`。
- raw 8.5 MB 以下、gzip 2.5 MB 以下。
- 同じ input で 2 回生成し全成果物が byte-identical。

### 6.5 quality 判定

- missing / 0 node: `unavailable / unknown`
- invalid JSON/schema: `failed / failed`
- node > 0、edge = 0: `sparse / unknown`
- node >= 2、edge >= 1: `ready`、その後 audit
- required check 失敗: `failed`
- fixture / producer provenance 不足: `unknown` または明示 check failure
- 全 required check 成功だけ `passed`
- `generated_at` 欠損は `stale`、未来時刻は audit failure。mtime は使わない。

必須 check は unique node、dangling edge、root/focus、orphan、confidence、rationale、provenance、catalog seed ID。
golden fixture check は focus mismatch と off-topic sample を持つ。

---

## 7. P1 — Unified Top / Paper Context

変更:

- `docs/index.html`
- `docs/assets/{search,landing,utils,app}.js`
- `docs/assets/style.css`
- search/catalog の Node test と pytest wrapper

共通 asset の変更後にだけ `sync_asset_versions.py` を実行し、HTML の `?v=` を手編集しない。

### 7.1 search

- 2 文字以上の意味のある入力まで v2 を fetch しない。focus warm fetch は削除。
- 全 row を score し、exact title > title substring > author > tag。
- 同順位は year 降順、元 ordinal 昇順。
- combobox は上位 20 件、総件数、match reason。
- full result は同一ページ 20 件/page、21 件目以降も到達可能。
- 現在 page に必要な ID block だけを取得し、canonical ID 解決後に `?paper=` link を描画する。
- untrusted field は `textContent` / attribute API のみ。
- invalid row が一つでもあれば index 全体を error/retry とする。

Top URL:

- `?q=x`: query/suggestions。
- `?q=x&page=N`: full result。
- 入力: `replaceState` して page 除去。
- more/pager: link + `pushState`。
- `popstate`: query/page/result 復元。

### 7.2 catalog card

- state: `paperById`, `selectedPaperId`, `quality`, `deepManifest`, `fullAbstract`。
- direct `?paper=` は scroll のみで focus を奪わない。
- in-page select は trigger/scroll を保存し `pushState`、heading へ focus。
- filter 外 selected paper も先頭へ一度だけ固定表示。
- close は in-page 起点なら Back、direct 起点なら paper だけ `replaceState` で除去。
- unknown ID は通常一覧と live status を残し、別 paper/title へ fallback しない。
- filter 変更は paper を保持。旧 `?q=` を維持。
- title equality による lineage join を削除。
- selected 時だけ該当 detail shard を取得。失敗時は preview と原文リンクを残す。

lineage shelf は quality read model の `ready && passed` だけを出し、stale は日付と警告を付ける。

---

## 8. P2 — Honest Connections / Mobile

### 8.1 producer

- `build_conference_lineage.py`: catalog `paper_id` を focus/root の `seed_paper_id` に保持。
- `build_deep_lineage.py`: `seed_paper_id` を必須入力にし root/meta へ保持。
- `generate_deep_manifest.py`: `{paper_id, aliases, arxiv_id, title, filename}`。
- root/focus 不明時の first-node fallback を削除。
- edge に relation、confidence、rationale、provenance。
- cache key に evidence hash、producer/model/prompt/schema version。legacy key を v2 hit にしない。

既存 artifact は exact alias で一意なものだけ migration mapping を生成・監査する。曖昧なものは quality failed とし、
再生成対象へ出す。外部 API / LLM を使う bulk regeneration は今回実行しない。

### 8.2 consumer / relation list

- relation/CTA は exact ID または一意な exact alias だけで解決。
- global quality を先に読み、未合格 artifact を通常 graph として描かない。
- canonical parameter を優先し、既知の旧 graph-local focus / arxiv / theme node を受理。
- raw parameter から filename を作らず、検証済み manifest entryだけを使う。
- root 不明時に first node へ fallback しない。
- relation row は start/end/relation/confidence/rationale/provenance を可視テキストにする。
- `view=list|graph` は URL > localStorage > responsive。720px 以下は list。
- view/filter/layout は `replaceState`、paper/focus は `pushState`。
- graph/list の active edge 集合を一致させる。

---

## 9. S2 — workflow / Replay hygiene

### 9.1 weekly collection

各 conference の収集と summary 生成を loop し、完了後に global `build_pages.py`、identity/search/quality を
一度だけ実行する。conference 限定 build で global `conferences.json` を上書きしない。

既存の合格 lineage は generator 部分失敗で空へ置換しない。失敗は collection quality と job summary に残し、
blanket `continue-on-error` で成功に見せない。

### 9.2 PyPI build-only

- release trigger、`id-token:write`、production environment、publish action を除去。
- PR/path と manual build triggerだけ。
- build、twine check、clean wheel install、CLI smoke、dist artifact upload。
- 実 publish は別の承認済み設計まで存在させない。

### 9.3 snapshots

retention は 14 日。Stage 0 dedup 後、signal/score 後 top-N 前、lineage evidence、LLM response を
deterministic gzip JSONL で保存する。

`collector.py` は `--as-of/--run-id/--artifact-dir` を受け、入力範囲、出力名、generated timestamp を固定する。
signal は `observed | missing | failed` を分ける。成功/promotion済み manifest だけを
`paperpilot/data/runs/` に commit し、payload は Actions artifact に置く。

---

## 10. RED → GREEN の受入テスト

各単位は先に失敗する contract test を置き、最小実装後に regression を通す。

### S1

- reusable release に direct trigger がなく、exact SHA/job permission/single deploy/smoke dependency を満たす。
- PAT / `actions:write` / independent dispatch が bot workflow に残らない。
- promotion の traversal、symlink、non-FF retry、retry exhaustion、candidate conflict。
- rollback の non-ancestor、unknown deployment、confirm mismatch。

### D1

- source golden normalization、known hash、title fallback/unknown/ambiguous/encoded slash failure。
- alias dedup/conflict、28,300 row、100% coverage、source baseline。
- legacy projection と既存 paper field 不変、v2/detail/quality reference integrity。
- raw/gzip budget、2-run determinism。
- corrupt lineage、duplicate node、dangling edge、root、confidence、rationale、provenance failure。

### P1/P2

- 4 rank、stable tie、null、total、21件目、paging、fetch delay、error/retry、hostile text。
- direct/in-page select、close/Back、filter-out pin、unknown ID、title fallbackなし、detail fallback。
- seed/root/deep ID 一致、first-node fallbackなし、quality fail closed。
- graph/list parity、evidence、URL > saved > responsive、320px default list。

### Replay/S2

- canonical JSON/gzip byte identity、manifest schema/secret scan。
- missing/hash/expired/dependency mismatch の別 error。
- frozen run を network 禁止で再投影し output hash 一致。
- weekly global index parity、lineage partial failure、build-only package。

---

## 11. 検証コマンド

```bash
uv sync --frozen --extra dev
uv run ruff check paperpilot
uv run pytest -q
uv run python -m paperpilot.scripts.audit_theme_seeds
uv run python -m paperpilot.scripts.audit_lineage_quality
uv run python -m paperpilot.scripts.build_identity_lite --check --as-of 2026-08-30T00:00:00Z
uv run python -m paperpilot.scripts.build_lineage_quality --check --as-of 2026-08-30T00:00:00Z
uv run python -m paperpilot.scripts.build_search_index --check
git diff --check
```

Node が利用できる CI では全 `.mjs` suite を必須とし、pytest wrapper の skip を release gate で fail にする。
この環境に Node がない場合は Python/static tests を先に完了し、最終完了とはせず CI 相当環境で確認する。

---

## 12. 完了判定

- S1、D1、P1、P2、S2、Replay Lite の contract test が通る。
- 28,300 catalog rows の ID coverage が 100%。
- legacy search と既存 paper field の互換性が保たれる。
- title-only join と first-node fallback が実行 path に残らない。
- 監査不合格 lineage が通常導線へ出ない。
- search/data/page budget と accessibility contract が通る。
- full ruff / pytest / Node / asset parse / workflow validation が通る。
- dispatch、publish、external setting change、merge を実行していない。
- Cloudflare auto-deploy 未確認なら production merge blocker と明記する。
