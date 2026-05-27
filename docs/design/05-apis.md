# 6. 外部APIインターフェース仕様

## 6.1 API一覧と制約

| API | 認証 | レート制限 | 用途 |
|---|---|---|---|
| arXiv API | 不要 | 3秒間隔（推奨） | 論文メタデータ取得 |
| S2 API | env: S2_API_KEY（**任意**） | 無し:100req/5min、有:1req/sec | 論文/著者/引用（バッチ対応）。**post #217 / 2026-05-27: `theme-on-demand` / `regen-themes` workflows は `--primary-source openalex` がデフォルトなので S2 は使用しない。S2 key を持つ環境のみ `--primary-source s2` で利用可（citation contexts + intent labels が取れる利点）** |
| OpenAlex API | env: OPENALEX_EMAIL（**推奨**） | polite pool: 10req/s、100k/day（mailto あり） | **post #217 / 2026-05-27: lineage 用の primary data source**。`/works?search=&filter=concepts.id:`, `Work.referenced_works`, `/works?filter=cites:` で seed + BFS 完結。paperId プレフィクス `openalex:W...` で他経路と区別 |
| ~~PwC API~~ | ~~env: PWC_TOKEN（任意）~~ | ~~なし（常識的範囲）~~ | **2026 廃止** — `paperpilot/utils/github.load_curated_map()` の curated map と GitHub Search API 経由の解決に置換（#92） |
| GitHub API | env: PAPERPILOT_GITHUB_TOKEN（推奨） | 無:60req/h、有:5000req/h | Star数取得 + 論文→repo マッピング検索 |
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

## 6.3 論文 → GitHub リポジトリ解決（PwC 廃止後の置換、#92 で導入）

**Papers with Code は 2026 年に永続停止**（`paperswithcode.com/api/v1/...` は 302 → `huggingface.co/papers/trending`、データダンプも 404）。論文 ID → リポジトリ対応の取得は次の二段構えに置換した。共有実装は `paperpilot/utils/github.py` に集約され、`signals/github_signal.py`（Stage 2）と `scripts/build_theme_lineage.py`（テーマ家系図）の両方が同じ resolver を使う。

### 6.3.1 Curated map（一次解決、authoritative）

```
paperpilot/data/paper_repos.json
{
  "1706.03762": "tensorflow/tensor2tensor",   // arxiv_id -> 'owner/repo'
  "2304.02643": "facebookresearch/segment-anything",
  ...
}
```

- 著者公式 (`facebookresearch/`, `google-research/`, `openai/`, `NVlabs/` など) を優先
- `_meta` キーはドキュメンテーション、ローダで除外
- 各 owner / repo は `^[A-Za-z0-9][A-Za-z0-9._-]*$` の slug 正規表現で検証（leading dot 排除済）

### 6.3.2 GitHub Search（フォールバック、best-effort）

curated map ミス時に論文タイトルで GitHub repos を検索し、title-Jaccard 類似度 ≥ 0.55 のヒットを採用。

```
GET https://api.github.com/search/repositories?q={title:80字}&sort=stars&order=desc&per_page=5
Headers: Authorization: Bearer ${PAPERPILOT_GITHUB_TOKEN}  # 任意
Response: { "items": [{ "full_name": "facebookresearch/segment-anything", ... }] }
```

`title_similarity()` は trim 後 6 文字以上の双方で alnum 正規化後の substring 包含を 1.0 として扱い、それ以外は token Jaccard。`_TITLE_SIM_THRESHOLD = 0.55` 未満のヒットは noise として捨てる。

### 6.3.3 Stars 取得（最終段）

```
GET https://api.github.com/repos/{owner}/{name}
Headers: Authorization: Bearer ${PAPERPILOT_GITHUB_TOKEN}  # 任意
Response: { "stargazers_count": 42000, ... }
```

- owner / name は再度 slug 正規表現で再検証（defense-in-depth）
- 失敗時 `None` を返してパイプライン継続（Fail-Safe §10）
- `is_official_repo` は **curated 経由のみ True**、search fallback は False

### 6.3.4 7 日ディスクキャッシュ（テーマ家系図のみ）

```
paperpilot/data/lineage-cache/github_stars.json
{
  "1706.03762": {
    "stars": 42000,
    "url": "https://github.com/tensorflow/tensor2tensor",
    "fetched_at": "2026-04-29T..."
  }
}
```

- TTL 7 日、`fetched_at` で判定
- cache 読込時に `parse_github_repo_url()` で URL 再検証 → 不正値（`javascript:`、off-host 等）は無視
- 0 stars はキャッシュするが node には書かない（次回再試行可能）
- Stage 2 (`GitHubSignal`) はディスクキャッシュ無し（毎日のフレッシュ性を優先、HTTP コストは PAT で吸収）

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