# 1. expires_at を超過している場合、Run開始時に自動更新


> ## ⚠️ この文書は陳腐化しています（2026-08-20 実測・#360）
>
> **v2.1（2026-04-05）時点の設計のままで、実装から約 4.5 か月ぶん乖離しています。**
> 実測監査で **33 件の食い違い**（高 16 / 中 13 / 低 4）が確認されており、
> **存在しないファイル・CI・モデルを記載している箇所があります。**
>
> - 現況の単一の真実源は **[09-implementation-status.md](09-implementation-status.md)**
> - 手順やフィールド名を使う前に、**必ず実コード・実設定で裏を取ってください**
> - 代表例: `.github/workflows/collect.yml` は存在しない / embedding は SPECTER2 ではなく MiniLM /
>   LLM は Claude 必須ではなく ollama 既定の 4 プロバイダ / `social` シグナルは存在せず実際は `follow`
> - 🔴 **このファイルは overview ではありません。** 中身は §5.6 run_history / venue_cache の断片で、
>   本来の §1/§2（概要・アーキテクチャ）はリポジトリに存在しません。目次の案内が実態と一致していません。


# 2. paperpilot update-venue-cache コマンドで手動更新

```

## 5.6 run_history.jsonl スキーマ（v2.1新設）
**【v2.0修正】 **実行履歴の各行に含まれるフィールドを定義。

```
# 1行 = 1 Runの実行サマリー（JSON Lines形式）
{
  "run_id": "20260405_070000",
  "started_at": "2026-04-05T07:00:00",
  "finished_at": "2026-04-05T07:02:34",
  "duration_seconds": 154,
  "stage_counts": {
    "stage0_collected": 350,
    "stage1_filtered": 200,
    "stage2_scored": 80,
    "stage3_embedded": 30,
    "stage4_ranked": 10
  },
  "sources_status": {
    "arxiv": {"ok": true, "count": 150},
    "s2": {"ok": true, "count": 200},
    "openalex": {"ok": false, "error": "disabled"}
  },
  "errors": [],
  "output_file": "output/papers_20260405.csv"
}
```