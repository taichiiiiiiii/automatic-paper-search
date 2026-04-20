# 1. expires_at を超過している場合、Run開始時に自動更新

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