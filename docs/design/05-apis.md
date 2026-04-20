# 6. 外部APIインターフェース仕様

## 6.1 API一覧と制約

| API | 認証 | レート制限 | 用途 |
|---|---|---|---|
| arXiv API | 不要 | 3秒間隔（推奨） | 論文メタデータ取得 |
| S2 API | env: S2_API_KEY（任意） | 無し:100req/5min、有:1req/sec | 論文/著者/引用（バッチ対応） |
| OpenAlex API | env: OPENALEX_EMAIL（任意） | なし（1秒間隔推奨） | OA論文取得 |
| PwC API | env: PWC_TOKEN（任意） | なし（常識的範囲） | 論文→GitHubリポジトリ対応 |
| GitHub API | env: GITHUB_TOKEN（推奨） | 無:60req/h、有:5000req/h | Star数取得（GraphQL対応） |
| OpenReview API | 不要 | なし | 学会採択データ取得 |
| Altmetric API | 不要 | なし（商用はキー必要） | ソーシャルバズスコア |
| Claude API | env: CLAUDE_API_KEY（必須） | Tier依存 | LLM要約・関連度判定 |

## 6.2 エラーハンドリング方針

| エラー種別 | 対応方針 | リトライ | ログレベル |
|---|---|---|---|
| HTTP 429 | 指数バックオフ（初回2秒、最大30秒） | 最大3回 | WARNING |
| HTTP 5xx | 固定待機3秒後リトライ | 最大2回 | WARNING |
| HTTP 404 | 該当データなしとして処理続行 | なし | DEBUG |
| Timeout (10s) | ログ後スキップ | 最大1回 | WARNING |
| JSON Parse Error | 該当論文をスキップ | なし | ERROR |
| LLM API Error | Stage 3スコアのみで出力 | 最大1回 | ERROR |
| LLM JSON壊れ | 【v2.0追加】3段階フォールバックパース→全失敗時はNone | 1回(Step3まで) | WARNING |

## 6.3 Papers with Code APIエンドポイント仕様（v2.0新設）
**【v2.0修正】 **PwC APIの具体的なリクエスト/レスポンス形式を追記。

```
# 論文検索（arXiv IDから）
GET https://paperswithcode.com/api/v1/papers/?arxiv_id=2604.02322
Response: {
  "count": 1,
  "results": [{
    "id": "attention-is-all-you-need",
    "arxiv_id": "2604.02322",
    "title": "...",
    "url_abs": "https://arxiv.org/abs/2604.02322"
  }]
}
```

```
# リポジトリ取得
GET https://paperswithcode.com/api/v1/papers/{paper_id}/repositories/
Response: {
  "count": 2,
  "results": [{
    "url": "https://github.com/author/repo",
    "stars": 1523,
    "framework": "pytorch",
    "is_official": true
  }]
}
```

## 6.4 Semantic Scholar バッチAPI（v2.1新設）
**【v2.0修正】 **§4.3.1で参照されていたバッチAPIの仕様を追記。

```
POST https://api.semanticscholar.org/graph/v1/paper/batch
Body: { ids: ['ARXIV:2604.02322', ...] }  # 最大500件
Params: ?fields=title,citationCount,influentialCitationCount,venue,publicationDate
Response: [{ paperId, citationCount: 42, venue: 'ICLR', ... }, ...]
```

```
POST https://api.semanticscholar.org/graph/v1/author/batch
Body: { ids: ['author_id_1', ...] }  # 最大1000件
Params: ?fields=name,hIndex,citationCount
```

## 6.5 GitHub GraphQL API（v2.1新設）
**【v2.0修正】 **100件/リクエストでStar数を一括取得するGraphQLクエリ。

```
POST https://api.github.com/graphql
Headers: { Authorization: bearer <GH_PAT> }
query {
  repo0: repository(owner:'a', name:'b') { stargazerCount createdAt }
  repo1: repository(owner:'c', name:'d') { stargazerCount createdAt }
  ... # 最大100件/リクエスト
}
```

## 6.6 OpenReview API（v2.1新設）
**【v2.0修正】 **学会採択論文リストを取得するAPI仕様。

```
GET https://api2.openreview.net/notes
Params: invitation='ICLR.cc/2026/Conference/-/Submission'
        details='directReplies', limit=1000, offset=0
# directReplies内のdecision → 'Accept (Oral)' | 'Accept (Poster)' | 'Reject'
# タイトルマッチング: note.content.title.value
```