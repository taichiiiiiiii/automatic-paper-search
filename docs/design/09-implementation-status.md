# 実装ステータス（PaperPilot）

`CLAUDE.md` から切り出した実装状況の記録。CLAUDE.md 本体には現況サマリと
このファイルへのポインタだけを残してある（正本の肥大を防ぐため）。

- 切り出し日: 2026-08-18
- 切り出し範囲: 切り出し前 `CLAUDE.md` の 844–916 行目
- 無損失の検証方法:
  ```bash
  { sed -n '1,843p' <(git show <切り出し前>:CLAUDE.md); \
    sed -n '/^## 実装ステータス（2026-06-03 時点）/,$p' docs/design/09-implementation-status.md; \
    sed -n '917,919p' <(git show <切り出し前>:CLAUDE.md); } | md5sum
  # → 切り出し前 CLAUDE.md の md5 と一致する
  ```

---

## 現況（2026-08-18 実測）

下の「実装ステータス（2026-06-03 時点）」は**当時の記録を原文のまま**保持したもの。
以下は 2026-08-18 に実データを読んで確認した現在値。

| 項目 | 実測値 | 確認方法 |
|---|---|---|
| 学会カタログ | **10 会議 / 28,300 本**（生成 2026-06-28） | `docs/conferences.json` を集計 |
| 内訳 | iclr-2026:5351 / neurips-2025:5286 / cvpr-2026:4068 / icml-2025:3257 / cvpr-2025:2871 / iccv-2025:2701 / emnlp-2025:1809 / acl-2025:1699 / aaai-2026:762 / eccv-2024:496 | 同上 |
| 会議家系図 | **実データは 2 会議のみ**（`iclr-2026` 108KB / `eccv-2024` 38KB）。残り 8 会議の `lineage.json` は **~290B の空スタブ**。🔴 **`iclr-2026` は 63 エッジ中 45（71.4%）が退化 rationale**（`"A"` `"QD"` `"CMA-ES"` 等）＝ tooltip に直接出る。#297 のガードは develop に入っているが**出荷済みデータが再生成されていない**ため症状が残る（#359）。ガード導入後に生成された `eccv-2024` とテーマ 3 本は **0.0%** で clean | `stat -c%s docs/*/lineage.json` |
| テーマ家系図 | **3 本公開**（flash-attention / mixture-of-experts / vision-transformer） | `docs/themes/themes-manifest.json`。※旧記載の「2 themes 公開」は誤り |
| deep tree | 14 本生成済だが **ビューアへの導線が無く orphan** | `docs/iclr-2026/deep-manifest.json` |
| アセット版数 | **`sync_asset_versions.py` が一元管理**（2026-08-19 是正）。内容ハッシュが変わったアセットだけ繰り上がり、`docs/assets/versions.json` から全 HTML に書き戻す。旧状態は `utils.js` が v=75(10) と v=82(4) に分裂＝規約違反だった | `uv run python paperpilot/scripts/sync_asset_versions.py --check` |
| 学会横断検索 | **`docs/search-index.json` = 2,723,015 B / gzip 759,264 B / 28,300 件**。中身は `[タイトル, 会議スラッグ]` の2要素配列（`build_search_index.py` の `TITLE, CONFERENCE = 0, 1`）。**論文 ID は持たない** — `arxiv_id` が 95.5% 空だったため永続リンクに使えず、遷移は既存の `?q=` を再利用する設計にした | `stat -c%s docs/search-index.json`、`gzip -c docs/search-index.json \| wc -c` |
| グローバルナビ | **`<nav class="site-nav">` が 17 / 17 ページに挿入済**。リンクは **3 本のみ**（探す / テーマ系譜 / 仕組み）＋ワードマーク。自ページを指すリンクにだけ `aria-current="page"` が付く | `grep -rl 'class="site-nav"' docs --include='*.html' \| wc -l` |
| テスト | **1,075 passed / 0 failed**（26.53s、2026-08-20 実測）。長年唯一の恒常 failure だった `test_theme_typography_tokens` は #357 で解消。真因はテスト補助関数がグループ化セレクタを読めず、色だけ指定する別規則を検査していたこと（CSS は #329 の意図どおり `--text-micro` で正しかった） | `uv run pytest paperpilot/tests -q` |

直近の出荷（2026-08、いずれも develop へ merge 済）:

| PR | 内容 |
|---|---|
| #347 | 無料家系図 `build_conference_lineage.py`（OpenAlex title 解決→参照/被引用、S2/LLM 不要）+ ECCV 2024 家系図 |
| #348 | CVF / ACL venue の Oral・Highlight 表示を復元（再収集で oral md が消える罠の修正） |
| #349 | `TOPIC_RULES` のトピック分類を細分化 + モバイル改善、9 会議の summary.csv 再生成 |
| #350 | 全サイト UI/UX 監査パス（a11y / インタラクション / 一貫性） |
| #351 | CLAUDE.md にフロントエンド（`docs/`）アーキテクチャと検証手順の章を追加 |
| #352 | カタログカードに常時表示の要旨 dek + 検索語ハイライト + マッチ位置アンカー |
| #353 | 結果リストの editorial polish（Oral 金レール、クエリエコー、段階フェード） |
| #355 | サイト再設計フェーズ1 — 学会横断検索 + グローバルナビ 17 ページ + `?v=` 自動同期（`sync_asset_versions.py`）。2026-08-19 develop マージ・本番公開済。マージコミット b01705b |

---

## 実装ステータス（2026-06-03 時点）

### パイプライン
| 仕様 | 状態 |
|------|------|
| Stage 0 (async 並列収集) | ✅ arXiv / S2 / OpenAlex |
| Stage 1 (rule filter) | ✅ カテゴリ / 日付 / 除外 / seen_ids |
| Stage 2 (metric scoring) | ✅ venue / citation / author / github / keyword / follow |
| Stage 3 (embedding) | ✅ MiniLM / backend=minilm（SPECTER2/BGE は将来拡張） |
| Stage 4 (LLM rerank) | ✅ Ollama / Gemini / Claude / Groq |
| Exporters | ✅ CSV / JSON / Slack / Email |
| 差分更新 (seen_ids) | ✅ `{id: timestamp}` 日次パージ |

### CI / ワークフロー
| 仕様 | 状態 |
|------|------|
| 週次深掘り (`collect-weekly.yml`) | ✅ uv sync 移行 (#136)、合計 3 件の startup_failure + numpy missing + empty-dir guard 修正 (#135-137)、develop push (#141) |
| 毎日 follow-watch (`collect-daily-watch.yml`) | ✅ uv sync 移行 (#142)、develop push (#141) |
| オンデマンド theme (`theme-on-demand.yml`) | ✅ `--llm-strict=ambiguous` + `--primary-source openalex` + **unarXive DuckDB DL (post #222 Phase J)**、timeout 15min |
| 手動バルク theme regen (`regen-themes.yml`) | ✅ `--llm-strict=ambiguous` + `--primary-source openalex` + **unarXive DuckDB DL (post #222)**、timeout 120min。週次 cron は PR #261 で廃止 (gallery は site-request 由来のみに) |
| Push race retry (`commit-and-push.sh`) | ✅ 5 回 retry + jittered sleep + multi-path 対応 (#122 / #140)、12 unit tests |
| Workflow YAML 不変条件 | ✅ `test_workflow_yaml_quality.py` (secrets-in-step-if 防止 #135) |
| Lighthouse CI (`lighthouse.yml`) | ✅ PR + 週次月曜で `treosh/lighthouse-ci-action@v12` 実行、staticDistDir で docs/ をローカル serve → 4 ページ × 3 run。`LHCI_GITHUB_APP_TOKEN` (任意) があれば PR コメント、無ければ temporary-public-storage アップロード。assert は warn-only (LCP 2.5s / CLS 0.1 / TBT 200ms / FCP 1.5s 上限) |
| Data audit (`data-audit.yml`) | ✅ PR/push 時に `docs/themes/**` / `docs/iclr-*/**` / build / audit script 変更で fire。`audit_theme_seeds` (#192) + `audit_lineage_quality` (#197) を順次実行 (両者 exit 1 で job fail)。Job Summary に各監査結果を個別 Markdown 表示 (#199) ※ **実際には 2026-06-15 を最後に一度も起動していない**（トリガが `docs/iclr-*/lineage.json` 限定で他 9 会議の lineage 追加を拾わない）。#358 参照 |

### ビューア
| 仕様 | 状態 |
|------|------|
| 論文一覧 (`papers.json`) | ✅ `index.html` + `build_pages.py` で生成 |
| Conference 家系図 (`lineage.json`) | ✅ `build_lineage.py` が `AbstractLLMProvider.classify_relation` 経由で生成。週次 CI 統合済 ※ **その「週次 CI」は #245（2026-06-04）で cron を外して手動専用になった**。2026-08-20 現在、定期実行される workflow は `lighthouse.yml` だけ |
| Conference deep tree (`deep-*.json`) | ✅ `build_deep_lineage.py`、14 件生成済 |
| **テーマ家系図 (`themes/<slug>/`)** | ✅ `/themes/` のサイトフォーム → CF Worker (`worker/index.ts`) → `theme-on-demand.yml` を自動 dispatch (PR #233 で CF Worker 復活)。**2 themes 公開** (flash-attention / vision-transformer; #260 で site-request-only 化、seed themes 全消し) ※ **現在は 3 本公開（flash-attention / mixture-of-experts / vision-transformer）。上の「現況（2026-08-18 実測）」表を参照 — ここは 2026-06-03 時点の履歴なので原文保持** |
| **家系図ビューアの frontend (#324-#332)** | ✅ editorial 刷新。仕組みページ (#324) / 論文カード polish+a11y+declutter+editorial-flags (#325/#328/#329) / 関係線の幹(successor)・枝(extends)階層 + 3ビューア共有 (`PP.edgeStyle`) + fan-out 発生点 (`PP.fanOffsets`) (#330-#332)。全 merged + 本番 live |

### Theme 家系図の品質改善 (本セッションの主軸)
| 仕様 | 状態 |
|------|------|
| Foundational ref フィルタ (#127) | ✅ `_filter_off_topic_refs`、`citationCount > 2 × max(seed cites)` で除外 |
| Topic relevance seed フィルタ (#127) | ✅ `_filter_topic_relevant_seeds`、多単語テーマでタイトル/アブストラクト一致要求 |
| Implementation denylist (#128) | ✅ `paperpilot/data/lineage_denylist.json` (10 paperIds + 15 title pattern) |
| LLM strict mode (`--llm-strict`) | ✅ off / ambiguous / all、production default = ambiguous |
| Classification cache 共有 (#138/#139) | ✅ `_CachedClassifyProvider` + `paperpilot/data/lineage-cache/classifications.json` を build_lineage と共有、git 永続化 (.gitignore 個別 un-ignore) |
| Groq rate limiter (#130) | ✅ default 25 RPM、`config.yaml` の `llm.rate_limit_rpm` で paid plan 拡張可 |
| LLM prompt 品質 (#131-#133) | ✅ ~250 tokens に圧縮、MUST/MUST NOT block、`TEMPLATE_RATIONALES` 単一 source (#146) |
| Template echo reject (#132) | ✅ `RelationClassification.from_dict` が `_GENERIC_TEMPLATE_RATIONALES` の文字列を拒否 |
| 不変条件 pin (#134, #146) | ✅ prompt size / `--llm-strict` flag / template dedup の regression test 完備 |
| Edge fabrication 廃止 (#209 / #210) | ✅ `_DEFAULT_DERIVED` 削除、信号なし edge は drop (template extends 量産を停止) |
| **Heuristic slot-fill rationale (#300)** | ✅ `_derive_relation_heuristic` の intent_map + year_cite 分岐が parent/child タイトル+年を埋め込む paper-specific rationale を emit、`_TEMPLATE_RATIONALES_SET` 非該当となり LLM=None 時の template-reject drop (relation collapse) を回避。#209 / #131 不変条件は維持 (新エッジ作らず、template echo reject 集合は LLM 用に残置) |
| Seed gate v2 (#209 / #211) | ✅ 2-word phrase + title fallback、hyphen normalization、`_filter_denylisted_seeds` を seed phase に適用 |
| Edge-level audit (#209 / #212) | ✅ `audit_lineage_quality` に `template_rationale_ratio` / `popularity_sinks` / `year_reversals`、themes opt-in (`--include-themes`) |
| Tier 1 非 LLM seed quality (#209 / #214) | ✅ citation velocity ranking、survey title regex penalty (0.30×)、`paperpilot/data/theme_blacklist.json` per-theme veto |
| S2 citation contexts → rationale (#209 / #216) | 🟡 S2 API key 必須、PR #216 で close 済 (post #222 Phase J で OpenAlex/unarXive 経路に置換) |
| **OpenAlex-primary architecture (#209 / #217)** | ✅ `--primary-source openalex` を workflows default 化、S2 API 完全不要で seed + BFS 動作。`_work_to_paper_dict` + `fetch_related_via_openalex` + paperId prefix routing |
| **OpenAlex search relevance / field gate (#219 / #220)** | ✅ `sort=cited_by_count:desc` 削除 (relevance 順)、`primary_topic.field.id:fields/17` で Planck/AlphaFold 排除 |
| **unarXive 2022 citation contexts (#222 Phase J)** | ✅ S2-free で paper-specific rationale 取得。HF `saier/unarXive_citrec` → DuckDB → `_classify_from_contexts` で regex 分類。LLM 不要、月 ¥0 |

### コード品質
| 仕様 | 状態 |
|------|------|
| ruff (lint) | ✅ **145 files clean**（`paperpilot/` 配下、2026-08-20 実測。`uv run ruff check paperpilot/` → All checks passed!） |
| mypy (type check) | ⚠️ **未検証** — mypy 1.20.1 が typeshed の `builtins.pyi:251` で INTERNAL ERROR を出し起動しない（単一ファイル指定でも再現）。本リポジトリ由来ではなく環境側の問題（`CLAUDE.md` の「既知の環境問題」にも同記録あり）。緑チェックは外した |
| pytest テスト数 | ✅ **1,075 passed / 0 failed**（26.53s、2026-08-20 実測）。#357 で唯一の恒常 failure を解消 |
| venue 正規表現検出率 | ✅ 100% (60 パターン / 目標 95%) |
| `build_theme_lineage()` 行数 | ✅ Stage 別 helper 抽出後 238 行 (#148) |

### 既知のオープン項目
- ~~**Bulk regen 19 themes の timeout 問題**~~ — **解消** (PR #260 で site-request-only に移行、21 seed themes 全消し + `regen-themes.yml` 週次 cron 廃止により前提消滅)
- ~~**data-audit の false positives** (lineage.json に short abstract を persist)~~ — **解消** (`lineage.json` に `short_abstract` (1000-char) 全 nodes で persist 済、`audit_theme_seeds.py:158-178` でも `short_abstract` を優先読み。直近 audit すべて clean)
- **LLM rationale 累積**: classifications.json は git 永続化済、theme-on-demand で漸進的に蓄積 (weekly cron は #260 で廃止)。
- **CF Worker 運用**: CF Access を **OFF** にしておく必要あり (PR #233 / 復活時メモ参照)。`one.dash.cloudflare.com` or `dash.cloudflare.com → Workers Settings` のいずれかで管理可能。
- **Foundational ancestor allowlist** (PR #278-#281): `paperpilot/data/lineage_foundational_allowlist.json` の ~30 entries は ML/CV/NLP の canonical 古典のみ。新規 entry は PR description で justification 必須。
- **LLM relation 判定品質 (#285)**: 当初「prompt が真の bottleneck」と判定したが、**#293 で model も同等以上の bottleneck と判明し結論を改訂**。`eval_relation_prompt --provider` の live 測定で **prompt 無変更**のまま Gemini 2.5-flash が macro-F1 0.372 (再測定 0.354) を出し、Groq llama-3.3-70b baseline 0.237 を上回った (Groq が 452 call で 0 emit だった `successor`/`unrelated` を Gemini は emit)。ただし magnitude は信用するな: n=29・単一ラベラー・**free-tier Gemini の 429-storm (再測定で 8/29=28% が None=wrong 汚染)** で ±0.05 はノイズ。**🔴free-tier Gemini は 29 call で 28% 失敗 → 本番 ~90 call/run では崩壊、paid tier 前提**。`ablation`/`supersedes` は gold 0 件で測定不能。**Provenance schema** (#290) + **audit field-read** (#291) 完了済だが provenance は機構 (`llm`) のみで **model を記録しない**。本番 provider 切替 (Groq→Gemini) は user 判断項目。**2026-06-17 実測 (Gemini, `PAPERPILOT_LLM_PROVIDER=gemini` override 経由)**: gold set を 54 行に拡張済み、NEW(#296) vs OLD prompt × supersedes gold(7件) で **NEW recall 4/7・precision 1.00 vs OLD 0/7** — #296 のプロンプト書き換えが supersedes 判定を 0→4 に改善することを実証。フル 55 行 macro-F1 と #285 への結果コメントは未実施 (任意)。**ガードレールは実装済み**: `PAPERPILOT_LLM_PROVIDER` override (#311) + cache entry の `model` field (#313)。**Groq は無料枠の使用上限 (429) が本番ブロッカーで、有効鍵でも 1 テーマ生成中に枯渇→heuristic フォールバック**するため現状維持が妥当 (鍵 rotate は効果限定的)。詳細は `docs/design/08-lineage-roadmap.md` §判定品質の改善計画。

