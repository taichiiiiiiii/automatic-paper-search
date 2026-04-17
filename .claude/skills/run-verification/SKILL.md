---
name: run-verification
description: PaperPilot の全検証を一括実行（pytest + カバレッジ + venue 検出率 + スモークテスト）。ユーザーが「テスト流して」「動作確認して」「検証して」「PR を出す前にチェック」と言った時に起動する。
---

# run-verification — PaperPilot 検証ループスキル

## いつ起動するか

- 「テスト全部流して」「CI 相当のチェック」
- 「リリース前／PR 前の検証」
- 「スコア計算が合っているか確認」
- 「develop にマージできる状態か確認」

## 検証レイヤー

| レイヤー | 目的 | 実行コマンド |
|---------|------|------------|
| L1. ユニットテスト | 個別モジュールの挙動 | `pytest paperpilot/tests/` |
| L2. カバレッジ | 80%+ 維持（現状 97%） | `pytest --cov=paperpilot --cov-report=term` |
| L3. Venue 検出率 | ≥95%（§9 Table 21） | `pytest paperpilot/tests/test_venue_stress.py` |
| L4. ランナー統合テスト | Stage 0-4 の通し動作 | `pytest paperpilot/tests/test_runner.py` |
| L5. スモークテスト（任意） | 実 arXiv で小規模実行 | `python -m paperpilot.collector --days 3 --keyword <kw>` |

## 実行手順

### Step 1: 一括テスト + カバレッジ（必須）

```bash
cd /root/work/Research/automatic-paper-search
python3 -m pytest paperpilot/tests/ \
    --cov=paperpilot \
    --cov-report=term \
    --cov-config=/dev/null \
    -q
```

**合格基準**
- 全テスト pass（現状 240）
- TOTAL coverage ≥80%
- 全本体モジュール ≥80%（`paperpilot/tests/`・`__init__.py`・`config_loader.py` の一部は除く）

### Step 2: Venue 検出率の再確認

```bash
python3 -m pytest paperpilot/tests/test_venue_stress.py -v
```

- `test_detection_rate_above_95_percent` が pass すること
- 60+ パターンがすべて期待通り分類されること

### Step 3: CLI 動作確認（軽量スモーク）

**要 arXiv ネット接続**。通常は PR 前に1回回すだけで十分。

```bash
# 3日分 × 1キーワード × CSV出力のみ（最短で 10秒前後）
cat > /tmp/smoke.yaml << 'EOF'
search:
  keywords: [retrieval augmented generation]
  categories: [cs.CL]
  days_back: 3
  max_results_per_keyword: 5
  exclude_words: []
sources:
  arxiv: { enabled: true, delay_seconds: 3 }
signals:
  venue: { enabled: true }
weights:
  venue: 3.0
  keyword: 0.5
pipeline:
  stage2_top_n: 3
  stage4_top_n: 3
llm:
  enabled: false
output:
  csv:  { enabled: true, dir: /tmp/pp_smoke }
  json: { enabled: true, dir: /tmp/pp_smoke }
incremental:
  enabled: false
  seen_ids_file: /tmp/pp_smoke/seen.json
EOF
rm -rf /tmp/pp_smoke && mkdir -p /tmp/pp_smoke
python3 -m paperpilot.collector --config /tmp/smoke.yaml
```

**確認項目**
- `✅ N papers exported` が表示される
- `/tmp/pp_smoke/papers_YYYY-MM-DD.{csv,json}` が生成される
- JSON に `llm_relevance: null` が入っている（Stage 4 無効時の pass-through）
- エラーメッセージが無い

### Step 4: 設定/ドキュメント整合性チェック

- `paperpilot/config.yaml` に書かれているキーが `runner._build_*` 側でハンドルされているか
- `.env.example` に新規環境変数があるか
- `CLAUDE.md` の「実装ステータス」表が最新か

### Step 5: git 状態確認

```bash
# 意図しないファイルを commit しそうになっていないか
git status
# 特に確認するもの：
#   - .env が ignore されているか
#   - paperpilot/output/papers_*.csv はコミット対象でよい（CI も commit する）
#   - paperpilot/logs/ はローカルのみ
```

## 合格条件（すべてクリア）

- [ ] L1: 全テスト pass
- [ ] L2: カバレッジ 80%+（本体モジュール個別でも 80%+）
- [ ] L3: Venue 検出率 ≥95%
- [ ] L4: PipelineRunner の統合テストが pass
- [ ] L5: スモーク実行で 1件以上出力
- [ ] `.env` が `git status` で `Untracked` / `Modified` に出ていない
- [ ] `develop` ブランチで作業している（`main` 直接コミット禁止）

## 失敗時の対処

| 症状 | 原因の目星 | 対処 |
|------|---------|------|
| 新規テストが落ちる | 実装が追いついていない（まだ RED） | `add-plugin` スキルの Step 1〜2 に戻る |
| カバレッジが 80% を割る | 新規コードのテスト不足 | 欠落モジュールを `--cov-report=term-missing` で特定 |
| Venue 検出率が 95% 未満 | 正規表現が壊れた | `signals/venue_signal.py` を直近の commit と diff |
| スモークで 0件出力 | arXiv 側で該当なし or since_date が厳しすぎ | `--days 14` で期間を広げて再確認 |
| `paperpilot/data/seen_ids.json` のせいで 0件 | 前回の実行結果が残っている | `--full` で差分を無視する、または一時的に消す |
| 実API に到達してしまうテスト | モックし忘れ | `unittest.mock.patch` で `request_with_retry` を必ずモック |

## パフォーマンス目安

- ユニットテスト 240 本: ~6 秒
- カバレッジ付き: ~8 秒
- スモーク（arXiv 1 キーワード）: 10〜20 秒
- 本番実行（4 キーワード × 3 カテゴリ）: 30〜60 秒

これより明らかに遅い場合、どこかで `requests` 直呼び出しや `time.sleep` が紛れ込んでいる可能性あり。
