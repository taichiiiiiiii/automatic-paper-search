# 38. 統合設計文書 — 現行設計の一覧

- **作成日:** 2026-09-20
- **状態:** 08〜37番の内容を要約・再構成した参照用の単一文書
- **対象読者:** PaperPilotの現行設計・実装状況を短時間で把握したい実装者・レビュアー

## 0. この文書の位置づけと読み方

`docs/design/` には01〜37番の設計文書とREADME.md（目次）がある。README.mdの警告どおり、
**01〜07番は陳腐化済み**（実装から乖離、33件の食い違い、2026-08-20実測・#360）であり、本書には取り込まない。
**08〜37番が現行の設計・実装契約・開発計画・実装記録**であり、本書はそれらを1本にまとめた要約である。

- 本書は01〜37番を置き換えるものではない。個別の受入テスト条件、JSON Schemaの一字一句、
  詳細な実装手順が必要な場合は、各セクション末に示す元文書番号（例: `[11]`, `[18]`）を参照すること。
- 後続文書が前の文書の決定を上書き・更新している箇所は、後続（日付が新しい方）を正としてまとめてある。
  矛盾する古い記述は「〜は後続の決定により置き換えられた」等、一言だけ注記する。
- 完了済みの実装記録（Paper Slideの20〜27番など）は要点（何が実装され、何が未完了か）だけをまとめ、
  詳細な契約全文は転記していない。
- **13-agent-workboard.md**（Codex/Qwen運用のタスクボード）は設計文書というより運用のオペレーション記録である。
  現在は並列実装（Qwen Flash/MAX routing、GPT-5.6 Sol等）の運用方針が随時更新される形で存在する、という点にだけ触れ、
  詳細は転記しない。同ファイル自体はAGENTS.md・pytestが直接参照する別ファイルとして現地に残る。
- **14番（Lineage Artifact v1 Contract）・15番（Replay Lite R0 Contract）** は `paperpilot/scripts/README.md` から
  直接リンクされる独立契約書であり、本書では概要のみを§8で紹介し、詳細は元文書を参照する形にしている。

### CLAUDE.mdとの役割分担

`CLAUDE.md`（リポジトリルート）は、Claude Codeがこのプロジェクトを実装する際の**運用実装の正本**であり、
絶対ルール（§API keyの扱い、Stageインターフェース不変、スコアリング正規化式など）、スコアリング式、
Stage契約、フォルダ構成、CI一覧（13ワークフローのトリガ表）を保持している。
**本書はそれらを丸ごと転記しない。** 「詳細はCLAUDE.mdの該当節を参照」とだけ記し、内容の二重管理・乖離を避ける。
本書が扱うのは、CLAUDE.mdには収まらない**サイト全体・機能単位の目標設計と実装状況**の要約である。

### 章構成についての注記（判断を要した箇所）

依頼時に示された章立て例では第4章（リネージ）の対象に34番を含めていたが、34番
（学会の前年度baseline/ratioローカル評価）の内容は学会自動更新（Conference release watch）に属し、
リネージとは別テーマである。そのため本書では34番を第6章（学会自動更新）側にまとめ、
第4章は08・16・18・30番＋31・32番のうちリネージ関連部分（L2a/L2b）に絞った。
また31・32番はリネージ（L）と学会更新（C）の両方の限定実装を同一文書内に含んでいるため、
本書では該当部分をそれぞれ第4章・第6章に分けて要約している。判断の詳細は末尾の報告を参照。

---

## 1. 目標アーキテクチャ

*（出典: [11-target-architecture.md](11-target-architecture.md)、決定日2026-08-30）*

### 1.1 結論

PaperPilotは次の構成を目標とする。

1. **ユーザー向けには1サイト**とする。探索サイトと系譜サイトを分離しない。
2. **モード選択専用サイトは作らない**。トップページから検索を開始し、対象を選んだ後に文脈依存のビュー
   （一覧・関係・系譜）を提示する。
3. **論文を中心オブジェクトにする**。学会、テーマ、検索、系譜は論文集合の入口または表現であり、別製品ではない。
4. **静的MPAを維持**する。読み取りはGitHub Pagesの生成済みJSON、変更操作だけをCloudflare Worker APIが受け持つ。
5. **リポジトリは分割しない**（Python パイプライン、静的UI、Worker、workflowsを同じ変更単位で契約テストする）。
6. **生成と公開を分離**する。自動生成物はスキーマ検証・データ監査・テストを通過してから公開する。
7. **実行と統合検証はDockerを正本にする**（`uv`はlock更新・依存解決と補助checkに限定）。

プロダクトの一本の導線は **「探す → 内容をつかむ → つながりがあれば辿る」**。系譜は全論文の主導線ではなく、
監査済みデータがある論文だけに付く高価値な追加ビューである。

### 1.2 判断の根拠（2026-08-30時点の実データ）

| 項目 | 現況 | 設計への影響 |
|---|---:|---|
| 学会カタログ | 10学会 / 28,300 catalog rows | 検索と一覧は主導線にできる |
| 学会系譜 | 非空2学会、空スタブ8学会 | 系譜を全体の入口にはできない |
| テーマ系譜 | 3テーマ | 差別化機能だが探索全体の背骨にはまだ薄い |
| Deep tree | 14本 | 論文詳細から到達できる価値がある |
| 横断検索 | 28,300件、gzip約0.72MB | 静的サイトのまま横断探索できる |

更新workflowが監視付きで動くまでは「学会スナップショットと監査済み系譜の探索サイト」と説明し、
各collectionにsnapshot dateを表示して鮮度の約束と実運用を一致させる。

### 1.3 情報設計

| URL | 主目的 | 主操作 |
|---|---|---|
| `/` | 全体から探す | 横断検索、例示クエリ、学会・公開済み系譜への入口 |
| `/<conference>/` | 学会内で選ぶ | 検索、タグ・採択種別フィルタ、論文詳細の展開 |
| `/<conference>/?paper=<paper_id>` | 論文を共有する | 対象論文へフォーカス、概要・系譜・スライド生成の状態と操作 |
| `/<conference>/lineage.html?focus=<paper_id>` | 実データのある系譜を辿る | 祖先・後継・関係種別の探索 |
| `/themes/` | 監査済み系譜を探す・生成する | 品質監査通過済みテーマ・学会系譜のハブ、生成依頼、生成状態確認 |
| `/themes/?theme=<slug>&node=<node_id>` | テーマ内の系譜を辿る | 現行permalinkを維持 |
| `/how-it-works/` | 信頼性を理解する | データ源、関係分類、更新日、制約の確認 |

サイト全体を「検索モード」「学会モード」「系譜モード」に分けず、同じ論文を探すための**ビューの違い**として扱う。
MVPの横断検索対象は`title + authors + tags`。順位は `完全タイトル一致 > タイトル一致 > 著者一致 > タグ一致`。
状態の優先順位は `URL > 保存済み設定 > responsive default`。論文選択は`pushState`、フィルタ表示は`replaceState`。

### 1.4 システム境界

```text
Conference collectors ──> normalized CSV / catalog snapshots ─┐
Discovery Stage 0–4 ─────> recommendation outputs              ├─> Identity Lite
Lineage generators ──────> relation / deep artifacts ──────────┘        │
                                                                         ▼
                                                          Static projectors → データ監査 → GitHub Pages（read plane）
Browser ── POST ──> Worker API ── dispatch ──> GitHub Actions（生成・検証・昇格） ──────────┘
```

境界ルール: ブラウザは外部論文APIやGitHub Actionsを直接呼ばない。Workerは`/api/*`だけを所有する。
Worker/生成側の認証情報はそれぞれCloudflare Secret/GitHub Secretsに分離する。

### 1.5 データ契約の要点

- **Identity Lite**: `paper_id = sha256("paperpilot:v1:" + normalized_source + ":" + source_id)[:40]`。
  `normalized_source`は`arxiv | openreview | acl_anthology | cvf`。titleを識別子に使わない。
  strong aliasの運搬先は`docs/identity-aliases-v1.json`。
- **長期論理モデル**（`SourceObservation`/`PaperEntity`/`FieldProvenance`/`CollectionMembership`/
  `SignalObservation`/`DerivedAnnotation`/`RankingRun`/`RelationAssertion`）は将来の複数source統合用であり、
  MVPの実装前提ではない。
- **公開成果物一覧**（主なもの）: `papers.json`（additive進化）、`search-index-v2.json`＋
  `search-paper-ids-v1/<block>.json`（256 row block）、`identity-aliases-v1.json`、
  `paper-details-v1/<prefix>.json`（256 shard全文要旨）、`lineage-quality-v1.json`、run manifest。
- **lineage品質状態**: `availability = unavailable|sparse|ready|failed`、`audit_status = unknown|passed|failed`、
  `freshness = fresh|stale`。通常の「系譜あり」棚は`ready + passed`だけを表示する。
- **Replay Lite**: run manifestに`run_id/as_of/code/config/input/output hash/dependency lock digest/
  provider/model/prompt/schema/件数/失敗`を記録。詳細契約は[15](15-replay-lite-contract.md)（§8参照）。

### 1.6 リポジトリ構成（責務固定）

`paperpilot/models` → `identity`（段階導入）→ `sources`/`signals` → `pipeline` → `scripts` → `data`、
`schemas/`（新設・版付き契約）、`docs/assets`・`docs/**.json`（生成専用）、`worker/`、`.github/workflows/`。
別リポジトリへの分割は「独立した所有者とリリース周期」「共通JSON契約のversioned package化」
「Worker/UIの独立検証」「monorepoでは実現できない権限分離」の全条件が揃うまで行わない。

### 1.7 生成・公開フローとロードマップ

- **S1（production merge blocker）**: Pagesをexact-SHAの`validate/build → deploy(needs)`一つのworkflowにする、
  bot二重deployの廃止、Cloudflare auto-deploy停止/Worker path限定、post-deploy smoke＋検証付きmanual rollback。
- **S2（安全性/Replay hygiene）**: `collect-weekly.yml`の`conferences.json`上書きバグ修正、rollback自動化、
  `uv.lock`commit、run manifest導入。
- **D1（Identity/Search/Quality producer）**: 28,300 rowsのID coverage 100%、`search-index-v2.json`/
  `identity-aliases-v1.json`のdual-publish、`lineage-quality-v1.json`生成。
- **P1（Unified Top/Paper Context）**: 横断検索の4段階順位付け、`?paper=<paper_id>`によるカード選択・共有。
- **P2（Honest Connections/Mobile）**: lineage generatorのseed ID保持、狭画面での関係リスト既定化。

品質ゲートは`python-quality`/`contract-quality`/`site-quality`/`data-quality`/`worker-quality`/`package-quality`の
6 statusに分かれる（詳細は[11]§8）。**不採用とする案**: 探索/系譜サイトの分離、モード選択専用サイト、
全面SPA化、タイトルのみをID化、空lineageの実データ扱い、現段階でのリポジトリ分割、R2/CASへの早期移行。

---

## 2. 実装計画・実装ステータス

*（出典: [09-implementation-status.md](09-implementation-status.md)、[10-site-redesign.md](10-site-redesign.md)、
[12-implementation-plan.md](12-implementation-plan.md)、[28-next-delivery-plan.md](28-next-delivery-plan.md)、
[37-sequential-delivery-status.md](37-sequential-delivery-status.md)）*

### 2.1 サイト再設計の決定（10番、2026-08-19決定）

3方向の案（A: 系譜背骨、B: カタログ背骨、C: トピック背骨）を4観点でレビューした結果、
**「B案（カタログが背骨）を base に、A案の系譜前面化を接ぎ、横断検索インデックスを足す。C案は不採用」**と決定した。
レビュー主張の一部（GitHub PagesでSPAルーティング不可、横断検索に50-70MB必要、C案の14トピック存在）は
実データ検算で誤りと判明し訂正済み（詳細は[10]§3）。ホスティングはGitHub Pagesを維持。
フェーズ1（横断検索・グローバルナビ・アセット版数管理）は2026-08-19に出荷・本番公開済み。

### 2.2 実装ステータスの基準線（09番、実測は2026-08-20時点）

CLAUDE.mdの実装ステータス節が指す基準線。要点（実測値）:

- カタログ = 10学会 / 28,300本、会議家系図の実データは2学会のみ（iclr-2026 / eccv-2024）、残り8学会は空スタブ。
- テーマ家系図は3本公開（flash-attention / mixture-of-experts / vision-transformer）。
- deep tree 14本はビューアへの導線が無くorphan。
- CSPの`frame-ancestors 'none'`はGitHub Pagesの制約で全17ページ無効（仕様上の制約、実装不可能）。
- テストは1,103 passed / 1 skipped（2026-08-23実測、`uv run --extra dev`必須）。lintはclean、mypyは環境側の
  INTERNAL ERRORで未検証。

**注記**: この1,103件という数値は09番・CLAUDE.md記載の基準時点のものであり、後続の30〜37番の記録では
ローカルhost補助回帰が段階的に増加し2026-09-11時点で3,133 passed / 1 skippedまで積み上がっている
（詳細は§4・§7）。両者は矛盾ではなく、実装が進んだことによる時系列の違いである。最新の実行結果は
その都度`uv run --extra dev pytest`で確認すること。

### 2.3 実装計画の要点（12番、2026-08-30時点で実装開始可能と判定）

目標設計（11番）を、変更ファイル・公開データ契約・実装順・失敗条件・受入テストまで落とし込んだ実装用の正本。

- **papers.json**はadditive evolution（`paper_id`/`source`/`source_id`を追加するだけ、既存key/valueは不変）。
- 全文要旨は256 shardの`paper-details-v1/<prefix>.json`に分離。
- `lineage-quality-v1.json`のenvelopeを固定（`availability`/`audit_status`/`freshness`等、§1.5参照）。
- リリース境界: workflow dispatch、GitHub/Cloudflareの設定変更、Pages/Worker/PyPI公開、`develop`へのmerge/push は
  ユーザーの明示承認なしに行わない。
- 実装単位の依存関係: `S1(exact-SHA release)` → `R0(replay core)` → `D1a→D1b→D1c/D1d` → `P1`→`P2`、
  `S2`はS1・D1と並行可能（詳細な依存グラフは[12]§3）。

### 2.4 次期開発計画（28番、2026-09-05作成）とレーン構成

既存基盤を使い、「利用者が一つの目的を最後まで達成できること」を出荷単位にする方針へ転換。
4レーンを並行して進める。

| レーン | 最初の成果 | 完了を判断する実例 |
|---|---|---|
| **L: 家系図**（最優先） | 1起点の新per-paper系譜をFocus Viewで確認 | 検索→線を選ぶと根拠箇所へ移れる |
| **S: スライド**（並行） | 1論文の要旨版をローカル生成し確認 | 命令→生成→レビュー→公開→再閲覧が一巡する |
| **C: 学会更新**（並行） | 1学会の公式一覧を完全取得し候補作成 | 同じ一覧は不変、公開後の変更だけ反映 |
| **X: 実行・検証**（横断） | Dockerで同じfixture/testを実行 | Linuxと開発機で検証・成果物hashが一致 |

2026-09-05時点で、検索facet、L0/L1、一論文L3/L4とlocal bundle、L2a非公開資料・L2b回答取込pure API、
S0/S1ローカル生成経路、C0〜C2/C3a候補・C3b/C4a限定dry-runをローカル実装済み。実source・通常表示・公開とは
明確に区別されている。詳細な担当分割・受入条件は[28]§3〜§7を参照。

### 2.5 順次改善の実行記録（37番、2026-09-12時点）

37番はCSV識別子保持の小改善（36番、後述§8.3）と、Focus Viewのキーボード操作時のnull参照防止修正の
採用記録である。いずれも低リスクな1モジュールの改善候補として採用され、既存の科学的判定・公開ゲートには
触れていない。以降の残作業として次が明記されている（ユーザー指定順）。

1. 家系図UI: 関係線の追いやすさ・大規模狭幅表示・全キーボード経路（未完了、詳細は§7）
2. 原典と人手による関係確認（未着手、科学的承認はエージェントが代行しない）
3. 固定クエリの検索評価（未着手）
4. スライド依頼→生成→レビュー→再閲覧の一巡（未着手）
5. 学会の実データ確認と承認済みDocker環境検証（未着手、公開・image取得の承認は別途必要）

37番にはFlash/MAXのモデルroutingに関する運用上の試行錯誤（起動失敗の原因調査等）が多く記録されているが、
これは13番と同種の運用記録であり、本書では要約に含めない。現行の運用方針はAGENTS.mdを正本とする。

---

## 3. 実行環境（Docker-first）の方針

*（出典: [26-docker-first-execution.md](26-docker-first-execution.md)、決定日2026-09-01）*

PaperPilotのproduction実行と統合検証をDockerへ移す方針が正本。`uv`は削除せず、`uv.lock`の依存解決・更新と
補助checkに限定する。approved imageのruntimeとCI shadow gateが通るまでは、既存workflowがhost `uv`を使う
移行期間であり、**ホストの`uv run`成功だけをproduction完了根拠にしない**。

- target分離: `collector`（Stage 0〜4収集）/ `ops`（site/search/lineage/replay projector、network none）/
  `test`（Python contract/lint）/ `node-test`（Worker/viewer contract）/ `site-preview`（ローカル目視）/
  `paper-slide-worker`（untrusted PDF解析、独立境界）。
- immutable build inputs: Dockerfile frontend/Python base/uv image/Node baseは`repository@sha256:...`だけ。
  Python 3.12、uv 0.12.7、Node 20に固定。
- 状態（2026-09-01時点）: phase 1 static contractをローカル実装済み（28 passed）。**approved image pull/build/
  runtime、CI shadow gate、workflow移行は未実施**。

Migration order（[26]§8）: `uv.lock`固定 → Dockerfile/Compose契約テスト → local digest smoke → 既存uv CIとの
同値比較 → tests workflowのDocker移行 → collector/ops workflow移行 → offline release build → 運用文書更新。

---

## 4. リネージ機能

*（出典: [08-lineage-roadmap.md](08-lineage-roadmap.md)、[16-theme-lineage-migration.md](16-theme-lineage-migration.md)、
[18-lineage-trust-and-focus-view.md](18-lineage-trust-and-focus-view.md)、
[30-lineage-pilot-viewer-delivery.md](30-lineage-pilot-viewer-delivery.md)、
[31](31-private-review-and-conference-candidates.md)・[32](32-local-update-and-review-intake.md)のL部分）*

### 4.1 08番のロードマップは大部分が18番・11番で置き換えられた

08番（2026-05-25時点の記録）はconference/theme lineageのPhase 1〜4計画と、関係分類の判定品質改善履歴
（LLM provider比較、gold set評価等）を記録している。Phase 4（週次自動配信）の前提だった
`collect-weekly.yml`の週次cronは#245で廃止済みであり、08番自身がその旨を追記して自己訂正している。
**08番の実測データ（macro-F1 0.237等）は、18番が「semantic trustの実測」として引き継ぎ、v2契約設計の
失敗baselineとして再利用している**。08番のPhase別ロードマップそのものは11番・18番の決定に置き換えられた。

### 4.2 v2契約 — 引用事実と系譜判断の分離（18番、2026-08-30決定、中心設計）

**問題**: 既存`lineage-artifact-v1`のedgeは構造provenanceしか保証せず、「引用した」という観測事実と
「後継・拡張である」という研究系譜の判断を区別できない。2026-08-30時点で`ready + passed`のcollectionは
**0件**（edgeを持つcollectionは19、edge合計475）。

**解決策**: `lineage-artifact-v2`で`links[]`（生citation、semantic relationを主張しない）と
`claims[]`（genealogy/comparisonの判断ledger）を分離する。

```text
lineage-artifact-v2
  nodes[] / links[]（引用等の観測） / evidence[]（locator付き証拠） / claims[]（判断ledger） / root / clusters / meta
```

claimは`claim_family`（`genealogy`=supersedes|successor|extends、`comparison`=ablation|baseline_only|contrasts）、
`decision`（`accepted|unknown|abstained|rejected`）、`trust_tier`（`verified|corroborated|tentative`）、
`raw_score`（自己申告score）と`calibrated_probability`（較正済み確率、`calibration_id`と不可分）を持つ。

**Trust tier要件**（[18]§3.3）:

| tier | 要件 | 通常表示 |
|---|---|---|
| `verified` | claim-specificな二重人手reviewでaccepted、または一次資料で決定的に確認 | する |
| `corroborated` | 独立2種類以上のevidence、method/relation slice較正合格、DAG/temporal gate合格 | する |
| `tentative` | LLM単独・regex単独・year/citation単独・title/allowlist prior、または標本不足 | 初期非表示 |

`outperform`一語だけでの`supersedes`判定、1〜5年差だけの`successor`判定、foundational allowlistだけの
`extends`判定は、いずれも単独では`tentative`未満に格下げする（従来実装の過剰分類を是正）。

**Release profile**は2種類のみ（[18]§4.4）:

- **`claim-verified-pilot-v1`**: 全候補を独立した二人が model 予測を見ずに確認し、全edgeを異なる第三者が
  final review する凍結小規模pilot向け。`accepted + verified`のみ表示。較正は`not_applicable`と明記。
- **`automated-calibrated-v1`**: 機械分類を通常棚へ出すcollection向け。Wilson lower bound（accepted genealogy
  全体≥0.80、`supersedes`≥0.90）、ECE≤0.10、Brier≤0.15、accepted coverage≥20%等の閾値をすべて実測する。

### 4.3 Focus Viewの決定的projection

初期表示は選択論文を中心に**1-hop・7 nodes・18 claims**（2026-09-08 UI改善で従来の2-hop/15-nodeから縮小）、
各nodeの追加枝は2本まで。祖先1・後継1のfocus spineを先に確保し、決定的な比較順（trust tier → calibrated
probability → relation rank → 対向degree → ID昇順）で残りを追加する。720px以下は関係リストを既定にする。
`min_conf=0.70`は`corroborated`のcalibrated probabilityにのみ適用（`verified`は除外しない）。

URLパラメータ（`view`/`hops`/`limit`/`min_conf`/`trust`/`families`/`relations`/`evidence`/`expanded`）は
既存の`focus`/`node`/`arxiv`パラメータに対しadditiveに追加する。

### 4.4 テーマ系譜（P2T）移行契約（16番）

`theme.js`はlegacy artifactを直接表示できるため、producerとconsumerを同時にfail-closedへ移行する。
canonical `seed_paper_id`はarXiv/OpenReview/ACL Anthology/CVFのstrong aliasだけから得て、Semantic
Scholar/OpenAlex ID・title・yearはcanonical identityにしない。2026-08-30時点の公開theme 3件は全て
`ready/failed`かつlegacy schemaであり、**新producerで再生成しただけでは表示せず、frozen audit fixtureの
人手レビューを経てquality read modelが`ready + passed`になったものだけ通常導線へ戻す**。

### 4.5 一論文pilot viewerの初回接続（30番、2026-09-05）

既存サイト内の`lineage/?paper=<canonical ID>`をv2一論文viewerの共通入口にした。既存のconference/theme/deep
v1 URLやreaderは置換せず、v2は別moduleで閉じて検証する。固定URL`lineage-pilot-index-v1.json`（初期値は
entries空）でpilot対象を管理し、**合格pilotがない間はindexを空に保ち、選択カードに系譜リンクを出さない**。
2026-09-05時点で2,649 passed / 1 skipped、39 Node test files、実ブラウザでの動作確認済み（ローカルbundle
組立まで）。実論文の人手監査・live収集・公開はL2/L5の後続gateとして残る。

### 4.6 非公開レビュー準備（L2a/L2b、31・32番より）

- **L2a**（31番）: 未監査のv2候補と原典snapshotから、確認者A/B向けの独立した確認資料（`coordinator.json` /
  `reviewer-a.json` / `reviewer-b.json`）を作るCLI（`prepare_lineage_review`）をローカル実装。
  機械のrelation/family/decision/score/rationaleや他確認者の回答は資料から除外し、blind review条件を満たす。
- **L2b**（32番）: `ingest_blind_review_answers`で配布原本と実際の回答コピーをhash・slot・全候補IDで照合し、
  未回答・回答済み・二者不一致を整理するpure module。両側が全候補回答し4判断項目が一致したときだけ
  `complete`とするが、**`complete`はintake上の回答一致であって実在の本人・独立性・原典確認・第三者裁定の
  認証ではない**。全edgeに第三者final reviewを要求する現行v2 fixture validatorの条件は維持される。
  実回答の非公開保存CLIは33番（[33-private-review-intake-cli.md](33-private-review-intake-cli.md)）で
  後続実装された（詳細は§6.4）。

いずれも**人手回答の代作・公開認可・live収集・LLM課金・Docker image取得・workflow dispatch・commit/pushは
対象外**であり、L5（pilot監査・quality/artifactの同時公開）の完了条件を代替しない。

---

## 5. Paper Slide機能

*（出典: [17-paper-slide-deck-contract.md](17-paper-slide-deck-contract.md)（親契約）、
20〜27番（実装記録）、[29-slide-sol-local-execution.md](29-slide-sol-local-execution.md)）*

### 5.1 全体像

選択済み論文カードまたはagent commandから、NotebookLMに似た「内容をつかむためのスライド」を生成する。

```text
選択済み論文カード / agent command
  → Worker が request を検証・重複排除・予算確認
  → GitHub Actions の非同期 job
  → trusted OA PDF 解決・bounded fetch
  → ページ番号付き text extraction
  → page-cited slide-deck-v1 生成
  → secrets なしの strict validation
  → provisional candidate（非公開）
  → human review record
  → HTML deck を exact promoted SHA から Pages 公開
```

MVPの主成果物はsame-originの静的HTML deck。PDF upload、任意URL取得、論文全件のbulk precomputeは非スコープ。

### 5.2 実装単位別ステータス

| 単位 | 契約/実装ファイル | 状態 |
|---|---|---|
| SD0 Contract | `schemas/slide-deck-v1.schema.json`、runtime validator | ローカル実装済み |
| SD1 Source（[20]） | resolver / SSRF-safe fetch / Linux isolation | ローカル実装済み。**production full-textはvisibility verifier待ちでfail closed** |
| SD2 Generator（[21][24]） | closed contract / budget・cache / prompt plan / coordinator | offline backendはローカル実装・adversarial repair済み。live providerは別gate |
| VT0〜VT4 visible-text verifier（[22]） | VT0のみ実装 | **VT1〜VT4（実rasterize+OCR、image digest承認、Linux/Docker Desktop E2E）は未実装。full-textはblocked** |
| SD3 Projection（[23]） | renderer / public index projection | ローカル実装済み。browser visual QA・review/publish/deployは未実施 |
| SD4 offline review boundary（[25]） | review.py 等 | ローカル実装済み（candidate→reviewed投影） |
| S4A〜S4D（[25]） | public index / selected-card / Worker fixture API / offline review / integration | read-only部分はローカル実装済み |
| SD5/SD5P Worker・Preview（[27]） | coordinator/dispatch/callback/HMAC claimant | **休眠**足場のみ実装。production entrypoint・binding未接続 |
| S0/S1a（[29]） | Sol API接続の固定profile | ローカル実装・mock HTTPで縦断確認済み。live APIは未実施 |

### 5.3 なぜfull-textが止まっているか（VT0〜VT4、22番）

`pypdf`のtext layerだけでは、その文字列が実際に画面に見える形で存在するかを証明できない（crop外・alpha
0・白地の白文字・後から塗り潰された文字等が偽陽性になりうる）。そのため**採用方式は「最終描画pixelから得た
OCR text」**とし、pypdfは暗号化・page count・構造上限のpreflightにのみ使う。VT0（契約）はローカル実装済みだが、
VT1（renderer/OCR core）〜VT4（承認済みimage）は未実装であり、**SD1は現在すべての非空PDF textを
`page_text_visibility_unverifiable`でfail closedにしている**。この結果、現状で安全に使える生成経路は
`abstract_only`だけである。

### 5.4 wire contract（slide-deck-v1）の要点

closed schemaで`schema_version/deck_id/paper_id/language/deck_profile/coverage/source/generator/slides/
citations/limitations/review/generated_at/input_sha256`を持つ。必須不変条件（詳細[17]§7.1）:

- title slideを除く全bullet/factual noteは1件以上のcitationを持つ。
- `coverage.kind`は`full_text | abstract_only`のみ。abstract-onlyは固定警告文言を必須表示。
- `deck_id`はtrusted envelope hashから決定し、`paper_id/coverage/source/generator/input_sha256/generated_at`が
  一致しなければ拒否する。

### 5.5 review・公開の3段階と状態機械

`provisional`（strict validation済み機械生成candidate、Actions短期artifactのみ）→ `reviewed`（reviewer確認済み、
closed review record）→ `published`（fresh `develop` tipへ適用・再検証・promoted exact SHA→Pages release、
post-deploy smoke成功）。API `status`のclosed enum: `queued|running|validating|awaiting_review|publishing|
published|failed|rejected|expired`。選択カード表示は`running|validating|publishing`→`generating`、
`failed|rejected|expired`→`failed`へ写像する。

### 5.6 コスト・予算境界

cache keyは`paper_id + PDF/abstract SHA-256 + coverage + language + deck_profile + extractor version +
provider + model + prompt version + schema version + license-policy version`のcanonical hash。既定request
limitは2件/時/IP、global 20件/日、同一paper/keyは1件だけactive。job単位のinput/output token hard cap、
provider call count、timeout、daily token/cost budgetをconfig必須化する。

### 5.7 ローカルSol pilot（29番）

初回live canary候補は固定論文1件（"Transformers without Normalization", CVPR 2025）。
profile名`sol-abstract-local-v1`、`gpt-5.6-sol`使用、`abstract_only`/`ja`固定、generation calls上限2、
合計input 120,000 tokens / output 6,000 tokens、1 job上限1 USD、pilot実行回数当初1件/日、自動retry/
fallback 0。2026-09-05時点でmock HTTPによる縦断・実ブラウザ表示確認済み。**live API・review/publication・
本番設定は未実施**（APIキー未設定）。

### 5.8 本番接続の活性化条件（27番）

`worker/index.ts`はruntime adapterを注入せず、`wrangler.jsonc`にもDurable Object binding/migrationはなく、
browserの`PAPER_SLIDE_API_BASE`も`null`である。この3点を同じactivation gateで変更するまでproduction routeは
404のまま。活性化には少なくとも次が必要（詳細[27]§5）: providerアダプタ・価格snapshotのregistry承認、
approved catalog snapshotのbinding配置、Durable Object namespace/migration設定、各種Secretsの設定、
E2E検証、Docker approved image、SD4 human review record供給、最後にproduction runtime adapterの注入。

---

## 6. 学会自動更新・非公開レビュー

*（出典: [19-conference-release-watch-contract.md](19-conference-release-watch-contract.md)、
[31](31-private-review-and-conference-candidates.md)・[32](32-local-update-and-review-intake.md)のC部分、
[33-private-review-intake-cli.md](33-private-review-intake-cli.md)、
[34-conference-baseline-assessment.md](34-conference-baseline-assessment.md)）*

### 6.1 Top Conference Release Watch契約（19番）

許可済みトップ学会（curated allowlist）の新年度検出・公式proceedingsの安定確認・全件収集・検証・昇格・公開の
契約。「トップ学会」を検索から自動選定する機能ではなく、`paperpilot/data/conference-sources-v1.yaml`に
人が明示登録したvenueだけを対象とする。初期adapterはOpenReview（ICLR/NeurIPS/ICML）。

**状態遷移**: `unavailable`（404/0件）→`partial`（count gate未満）→`stabilizing`（fingerprint観測）→
異なるscheduled runで**同一fingerprintを2回**、間隔条件内で観測して初めて`ready`→生成→検証→
fresh-tip promotion→`published`。**2回固定**は実装定数であり、registryや手動実行で緩和できない。
count gateは`effective_minimum = max(minimum_absolute, floor(previous_count * min_ratio))`、
`effective_maximum = ceil(previous_count * max_ratio)`。count縮小・既存ID消失は`anomaly`として人手確認。

**Workflow**: `.github/workflows/conference-release-watch.yml`（実装対象名）。scheduled probe→
state-candidate→state-promote→generate→promote→releaseにjob権限を分離。実装直後は
`apply_enabled: false`固定のdry-run-firstとし、registry validation・probe・candidate生成までをActions
artifactとして確認する。state commit・catalog commit・push・Pages release・通知は行わない。

初回rolloutはOpenReviewのICLR/NeurIPS/ICMLに限定。CVF・ACL Anthologyは別段階、ECCVはECVA adapter
がないため対象外のまま。

**状態（2026-09-06時点）**: C0–C2、C3a pure候補、C3b/C4a限定pure差分確認をローカル実装（fixture検証のみ）。
**前年度baseline、trusted state/CAS、workflow、live dry-run、applyは未完了。**

### 6.2 C3a: 安定確認済み一覧からの候補作成（31番）

OpenReviewの正規化済みsnapshotを再検証し、既存catalogの入力形式へ決定論的に投影するpure module
（`build_catalog_candidate`）。callerが指定した`ready`やpaper IDを無条件に信用せず、identityとfingerprintを
再計算する。重複ID・source URL不一致・公開済みID消失/件数縮小は候補全体を拒否する。返すのはimmutableな
ローカル候補であり、state変更・共有projection再生成・既存catalog上書き・定期実行は行わない。

`source_quality.status=local_checks_passed`はローカル候補の検査結果のみを意味し、`trusted_persistent_state_
proof`/`promotion_authorized`/`publication_authorized`は常にfalse。前年度件数の入力がまだないため、
`minimum_absolute`だけを合格とし`previous_edition_ratio`と`first_edition_human_dry_run`は`not_checked`のまま。

### 6.3 C3b/C4a: 限定dry-run差分確認（32番）

`paperpilot/conference_watch/dry_run.py`。既存catalogの実byteと候補を比較し、paper IDベースで
追加・削除・変更・不変を判定する。結果は`blocked`（削除あり）/`changes_detected`/`indeterminate`
（差分なし・全文未確認）/`no_change`（完全一致確認済み）の4区分。dry-run profileはcatalog 16 MiB/25,000件、
title 2,048文字、author 512文字の限定。前年度比率・staging・公開接続は未接続のまま。

2026-09-06時点でこの2機能（学会側dry-run + リネージ側review intake pure API、§4.6）を「qwenなしでSolで
進めてください」というユーザー指定に基づき実装・独立レビュー済み。新規直接/接続テスト89 passed
（学会93%・回答取込90%カバレッジ）、全体host補助回帰2,843 passed / 1 skipped。

### 6.4 私家版レビュー回答の非公開取込CLI（33番）

`python -m paperpilot.scripts.ingest_lineage_review`を実装。既存準備CLIと同じartifact/catalog/candidate/
sourceバイトに加え、配布した3原本のdirectory・返却されたA/B回答コピー・取込日時・新規private出力先を指定する。
保存原本を直接復元せず、元入力から同一process内で`prepare_blind_review`を再実行し、生成された
coordinator/A/Bの3ファイルと保存原本を全byte比較してから取込む。出力は新規0700 directoryの`intake.json`
（0600）一つだけ。stdoutは`status/候補数/両者回答数/pending数/不一致数/結果hash`の6項目に限定。

実装はQwen Cloud（`qwen3.7-plus`）への反復委譲で進め、親（Sol）が独立レビューと採否判断を行った
（詳細な試行錯誤は33番§実行準備を参照、本書では割愛）。**`complete`は取込上の回答一致であって、実在の
本人・独立性・原典確認・第三者裁定の認証ではない。artifact/監査fixture/quality/publicationの4認可は
常にfalse。** 2026-09-07時点の最終host全体回帰は3,004 passed / 1 skipped。実人手回答・実source API・
公開・Docker起動・commit/pushは行っていない。

### 6.5 学会の前年度baseline/ratioローカル評価（34番）

19番が要求する「同じvenueの直近published editionの件数を基準にした前年度比検査」を、現行の
`stability.observation_from_detection`は計算自体は行うが、その整数が実際のpublished state・catalogから
得られたことを結合していなかった。34番はこれを埋める限定pure API。

```python
def assess_previous_edition_ratio(
    registry: ConferenceRegistry, edition: Edition, snapshot: SourceSnapshot,
    previous_state: EditionState, *, previous_catalog_bytes: bytes,
) -> PreviousEditionRatioAssessment: ...
```

registry・前年度published state・前年度catalog bytes・現年度snapshotの4者を全件相互検証し、一つでも
不整合があれば部分評価を返さない。結果は`passed`/`below_minimum`/`above_maximum`の3状態のみ。
reportのauthorityは`trusted_persistent_state_proof`/`baseline_state_trusted`/`fresh_tip_checked`/
`staging_materialized`/`promotion_authorized`/`publication_authorized`のすべてが常にfalseであり、
**`status=passed`は「与えられたbounded入力が内部整合し件数が範囲内」を意味するだけで、公式sourceの
完全性・stateの出所・公開可能性を意味しない**。

2026-09-08時点でsnapshot共有検査・baseline結合検査・public assessment API・report Schema/exportを
（Single-agent運用方針に切替後）親が単独実装済み。CLI・workflow・trusted state/CAS・実sourceによる検証・
公開接続は未実装。C3a/C3bの`previous_edition_ratio=not_checked`は本設計の実装後も維持されている
（後続gateとして§9参照）。

---

## 7. UI/UX

*（出典: [35-ui-ux-navigation-polish.md](35-ui-ux-navigation-polish.md)、2026-09-08〜09-11の一連の改善記録）*

2026-09-08にユーザー指定順で5単位のUI改善に着手した。

1. Focus Viewの初期表示を1-hop/最大7論文へ縮小し、明示的な上限拡張（5〜50論文）と、先行/発展/比較の
   読み分けを提供する。
2. 関係一覧に根拠の解釈文と信頼段階（verified/corroborated/tentative）を日本語で表示する。
3. 検索結果を残したまま論文詳細を確認できるダイアログ（同一originのiframeで既存catalogを再利用）。
4. 学会一覧を「準備中の系譜」より前に配置し、準備中領域を縮小する。
5. スライドの閲覧/依頼/準備/処理/エラー状態を言葉で明示する（依頼受付のゲートは緩めない）。

検索アルゴリズム・graph投影の本数上限・監査/公開ゲートは変更していない。5単位とも実装・テスト済みで、
localhostでの実ブラウザ確認を反復している（詳細な確認ログは35番本文を参照、本書では割愛）。

**2026-09-08〜11にかけての継続改善**として、以下が実装・実画面確認済み:

- 論文カードの「中心・先行・発展・比較・その他の関連論文」への方向別区分（accepted genealogy claimのみ辿る）。
- graph配置関数の入力境界修正（rejected/未知信頼段階が世代順位に影響しないよう修正）。
- 比較claim（comparison family）を中心論文に直接接続する形でFocus View投影へ追加する設計変更
  （既存の「selected nodes間のみ」という投影契約を修正）。
- 関係線のカード回避（有限グリッド探索による直交折れ線への変更）、区分見出しとの重なり解消、
  ラベル重複抑制（配置候補を試し、重なる場合は別区間または文字省略）。
- Focus Viewキーボード操作時のnull参照防止（37番で採用、§2.5参照）。

**2026-09-11時点で残っている既知の課題**（未完了、詳細は35番末尾の各節）:

- 線同士の共有経路とラベルの重なりは解消されていない。
- 狭幅（375px等）での大規模グラフ表示、および変更後の全キーボード経路の再検証は未実施。
- 全体mypyは既知268〜286 errors（46ファイル前後）で未解消。今回のUI変更はいずれもこれを解消していない。
- 公開pilot indexは空のままであり、実画面確認はすべて明示的なsynthetic fixtureによるものである
  （実論文の監査承認を意味しない）。

---

## 8. その他契約・候補

### 8.1 Lineage Artifact v1 Contract（14番）

*（[14-lineage-contract-v1.md](14-lineage-contract-v1.md)、2026-08-30更新）*

P2 producer/quality gate/conference・deep consumerが共有するwire contract。公開artifactは
`schema_version/root/nodes/edges/clusters/meta`を持つtop-level object。root選択はfocus node degree降順、
first-node fallbackは禁止。edge provenanceは`producer`/`evidence`/`classification`の閉じた構造を持つ。
`deep-manifest-v1`はarray ではなくwrapper object。既存conference/deep artifactはschema・seed・
structured provenanceが不足しており、**exact aliasで一意に監査できないものは書き換えず`audit_status=failed`
または`unknown`のまま通常棚から外す**（2026-08-30時点の既存deep 14件は全件再生成対象）。
なお、この v1 の`links/edges`分離前の設計は、§4.2で述べた18番の**v2契約（links/claims分離）**によって
意味論的な信頼度判定の面では置き換えられている。v1の識別・hash binding・deep-manifest契約自体は
v2でも土台として維持される。詳細契約は元文書[14]を参照。

### 8.2 Replay Lite R0 実装契約（15番）

*（[15-replay-lite-contract.md](15-replay-lite-contract.md)、2026-08-30更新、実装可能状態）*

決定論的byte生成・run manifest・短期artifact検証・network-free fixture replayの契約。R0は任意の過去
pipelineを再実行する仕組みではなく、retention内の凍結入力とコード内へ明示登録した純粋projectorに限定して
出力byteの再現性を検証する。canonical JSON/gzip契約、`run-manifest-v1`のclosed schema、secret scanの
拒否key/value一覧、`REPLAY_*`のerror taxonomy（11種）を定める。最初のregistryは`identity-lite-v1`のみ。
外部副作用（workflow dispatch、Pages/Worker/PyPI公開、実collector/API/LLM呼び出し等）は全面禁止。
詳細契約は元文書[15]を参照。

### 8.3 CSV識別子保持の改善候補（36番）

*（[36-csv-identity-preservation-candidate.md](36-csv-identity-preservation-candidate.md)、2026-09-12）*

補助CSV出力（exporter）が入力のDOIとlegacy `Paper.uid`を出力に含めていなかった問題への小改善候補。
既存36列を維持したまま末尾に2列（`uid`/`doi`）を追加することで、出力から元の入力レコードへの照合材料を
保持できるようにした。対象はCSVシリアライザー1モジュールのみで、サイトのcanonical ID・引用・要約内容・
科学的な関係判定・検索順位には触れていない。固定4件の合成テストで検証し、既存列の式・順序が不変であること、
全体回帰（3,133→3,136 passed）に新規失敗がないことを確認して採用された。uidはlegacy aliasであり、
恒久的canonical `paper_id`やfield-level provenanceの代替ではない点に注意。

---

## 9. 未解決事項・今後の課題

各機能ごとに、ローカル実装が完了していても**実source・人手監査・本番公開・外部設定変更**の観点で
残っている代表的なgateを一覧する。個別の詳細受入条件は各設計文書を参照。

### 9.1 リネージ

- L2（evidence収集とdecision ledgerの本実装）・L5（pilot監査、quality/artifactの同時公開）が未完了。
  実論文6〜12件の根拠付き関係を人手監査してから、初めて検索導線への露出を検討する。
- `automated-calibrated-v1`プロファイルの実slice較正（Wilson lower bound/ECE/Brier/coverage実測）は
  未実装であり、機械分類ベースのcollectionを通常棚へ出す条件が整っていない。
- 既存475 edge（v1 legacy）の全件review・migrationは未着手。

### 9.2 Paper Slide

- VT1〜VT4（rasterize+OCR、image digest承認、Linux/Docker Desktop E2E、既知OA PDFでの人手照合）が
  完了するまで、`full_text` coverageは有効化できない。
- production request planeの活性化条件（27番§5、10項目）が未達（Durable Object binding、Secrets設定、
  provider adapter承認、E2E検証など）。
- live LLM呼び出し（Sol API等）による実論文でのcanary実行は未実施（APIキー未設定）。

### 9.3 学会自動更新

- 前年度baseline/ratio（34番）のpublic assessment実装は完了したが、`EditionState`の永続化・CAS検証・
  fresh tip上でのsingle writerといったdurable state本体は未実装。C3a/C3bの`previous_edition_ratio`は
  引き続き`not_checked`。
- workflow（`conference-release-watch.yml`）自体・live dry-run観測・`apply_enabled`の有効化はすべて未実施。
- 初回rollout対象はOpenReview（ICLR/NeurIPS/ICML）のみで、CVF/ACL Anthology/ECCVは対象外のまま。

### 9.4 実行環境

- approved Dockerイメージのpull/build/runtime検証、CI shadow gate、workflow移行が未実施。現行CIは
  引き続きhost `uv`で動作している。
- mypyは環境側のINTERNAL ERROR（typeshed起因）で長期間未検証。2026-09時点でも268〜286 errors
  （46ファイル前後）の既知未解消分がある。

### 9.5 UI/UX

- Focus Viewの大規模グラフ・狭幅表示での線/ラベル重なり解消、全キーボード経路の再検証。
- 検索の固定クエリ評価（precision@k/recall@k/MRR）は未着手（28番§6で設計のみ）。

### 9.6 運用体制

- 実装のagent routing方針（Codex CLI + Qwen Flash/MAX routing、GPT-5.6 Sol等）は13-agent-workboard.mdおよび
  AGENTS.mdで継続的に更新されており、本書はその詳細を追跡しない。Claude Codeセッションにはこの運用は
  適用されず、CLAUDE.mdが正本である点に変わりはない。

以上いずれの項目も、**workflow dispatch・公開・secret設定変更・`develop`へのmerge/push**は
ユーザーの明示承認を経て初めて実施される、という制約を各設計文書が一貫して明記している。
