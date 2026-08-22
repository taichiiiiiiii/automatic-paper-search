# 4. 各Stage詳細設計


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
> - 🔴 embedding は **MiniLM**（`sentence-transformers/all-MiniLM-L6-v2`）。SPECTER2 は設定上 "future" 扱いです。
> - 🔴 重みに `social` は存在せず、実際は **`follow: 3.5`（最高重み）**。理論最大値の計算も成り立ちません。


## 4.1 Stage 0: データ収集
**【v2.0修正】 **並列化方式をasyncio + aiohttpに確定。各Sourceはafetch()をオーバーライドし、asyncio.gather()で並列実行する。

| 項目 | 内容 |
|---|---|
| 入力 | config.yaml（keywords, categories, days_back, max_results_per_keyword） |
| 出力 | list[Paper]（生データ、未フィルタ。commentフィールド含む） |
| 処理 | 【v2.0変更】各Sourceのafetch()をasyncio.gather()で並列呼び出し → マージ → 重複排除 |
| 並列化 | 【v2.0追加】asyncio + aiohttp。同一Sourceへの同時接続は1に制限（Semaphore） |
| エラー処理 | gather(return_exceptions=True)で個別Source障害を捕捉。障害Sourceはスキップ |
| レート制限 | arXiv: 3秒間隔、S2: 1秒間隔（API Key有無で変動）。rate_limiter.pyで制御 |

## 4.2 Stage 1: ルールベースフィルタ
**【v2.0修正】 **キーワードブースト（旧フィルタ3）をStage 2に移動。Stage 1は純粋な通過/除外のフィルタのみに限定。

| 項目 | 内容 |
|---|---|
| 入力 | list[Paper]（Stage 0出力） |
| 出力 | list[Paper]（条件を満たすもののみ） |
| フィルタ1 | カテゴリフィルタ: 指定カテゴリ（cs.LG等）に該当するもののみ通過 |
| フィルタ2 | 日付フィルタ: since_date以降に公開されたもののみ |
| フィルタ3 | 除外ワード: title/commentに「survey」「tutorial」「thesis」を含む場合は除外（設定で無効化可） |
| フィルタ4 | 差分フィルタ: seen_ids.jsonに存在するIDを除外 |
| 設計意図 | 【v2.0変更】純粋なpass/rejectフィルタのみ。スコアリングは一切行わない |

## 4.3 Stage 2: メトリクススコアリング
**【v2.0修正】 **バッチAPI対応。S2 /paper/batchで最大500件/リクエスト、GitHub GraphQLで100件/リクエストに対応。API呼び出し回数を800回→約10回に削減。キーワードブーストもここで処理。
### 4.3.1 バッチAPI対応設計

| Signal | バッチAPI | バッチサイズ | v1.0比較 |
|---|---|---|---|
| VenueSignal | arXivコメント: ローカル処理（バッチ不要） | — | 変更なし |
| GitHubSignal | curated map (一次) → GitHub Search by title (フォールバック) → GitHub /repos REST | 1〜2 calls/paper | PwC 廃止後 (#92) |
| CitationSignal | S2 /paper/batch: 500件/req | 500件 | 200回→1回 |
| AuthorSignal | S2 /author/batch: 500件/req | 500件 | 200回→1回 |
| SocialSignal | Altmetric: 個別（バッチAPI無し） | 1件 | 変更なし |
| KeywordBoost | 【v2.0追加】ローカル処理（バッチ不要） | — | Stage 1から移動 |

合計API呼び出し回数: v1.0 = 約800回（5〜8分）→ v2.0 = 約10〜15回（30〜60秒）
### 4.3.2 シグナル取得フローと正規化
**【v2.0修正】 **全シグナルの正規化出力を0〜100に統一。embedding_similarityも同様（v1.0では0〜1だった）。

| シグナル | 正規化方法 | 出力範囲 | v1.0からの変更 |
|---|---|---|---|
| 学会採択 | Tier 1=100, Tier 2=80, Tier 3=60, WS=30, 未査読=0 | 0〜100 | 変更なし |
| GitHub Stars | log(stars+1) / log(MAX_STARS+1) × 100。【v2.1修正】MAX_STARS=10000（定数） | 0〜100 | 定数を明記 |
| 引用速度 | citations/days（上位5%を100に正規化） | 0〜100 | 変更なし |
| 著者h-index | min(h_index / 50, 1) × 100 | 0〜100 | 変更なし |
| ソーシャル | min(altmetric / 100, 1) × 100 | 0〜100 | 変更なし |
| キーワード一致 | 【v2.0追加】min(match_count / 3, 1) × 100 | 0〜100 | Stage 1から移動 |
| Embedding類似度 | 【v2.0変更】cosine_sim × 100（0〜1を0〜100に変換） | 0〜100 | 桁を統一 |

### 4.3.3 統合スコア計算（修正版）
**【v2.0修正】 **値域を明確化。全シグナル0〜100 × weight → 理論最大値 = 100 × (3.0+2.0+1.5+1.0+1.0+0.5+2.5) = 1,150。

```
DEFAULT_WEIGHTS = {
    "venue":     3.0,   # 学会採択（最重要）
    "github":    2.0,   # GitHub Stars
    "citation":  1.5,   # 引用速度
    "author":    1.0,   # 著者h-index
    "social":    1.0,   # ソーシャルバズ
    "keyword":   0.5,   # 【v2.0追加】キーワード一致（Stage 1から移動）
    "embedding": 2.5,   # 研究テーマ類似度（Stage 3で加算）
}
# 理論最大値: 100 × 11.5 = 1,150
# 実用的な最高スコア例: ICLR採択(300) + 1000★(200) + 高引用(150)
#   + 著名著者(100) + バズ(100) + KW一致(50) + 高類似(250) = 1,150
```

## 4.4 Stage 3: Embedding類似度マッチ
**【v2.0修正】 **プロファイル未存在時の3つのフォールバック動作を定義。

| 項目 | 内容 |
|---|---|
| 入力 | list[Paper]（Stage 2出力、上位N件） |
| 出力 | list[Paper]（embedding_similarity付き、リランク済み） |
| モデル | SPECTER2（allenai/specter2、768次元） |
| 類似度 | コサイン類似度を算出し、0〜100に正規化してtotal_scoreに加算 |
| MMR | Maximal Marginal Relevance（λ=0.7）で多様性を確保 |
| 【v2.0追加】プロファイル未存在時A | Stage 3をスキップ。Stage 2のtotal_scoreのみで次Stageへ |
| 【v2.0追加】プロファイル未存在時B | paperpilot init-profile コマンドでarXiv ID入力→プロファイル生成 |
| 【v2.0追加】プロファイル未存在時C | config.yamlのkeywordsからテキストembeddingを生成する簡易モード（精度は低い） |

## 4.5 Stage 4: LLMリランキング + 要約

| 項目 | 内容 |
|---|---|
| 入力 | list[Paper]（Stage 3出力、上位30件） |
| 出力 | list[Paper]（llm_relevance, llm_summary_ja等が付与。None=LLM未実行） |
| LLM | Claude API（claude-sonnet-4-20250514） |
| バッチサイズ | 1リクエストに5論文を同時評価 |
| フォールバック | API障害時はStage 3のtotal_scoreのみで出力（LLMフィールドはNone） |

### 4.5.1 LLMプロンプト設計

```
SYSTEM_PROMPT = '''
あなたは学術論文の評価アシスタントです。
ユーザーの研究プロファイルに基づき、各論文の有用性を判定してください。
```

```
## 出力形式（厳守）
- JSON配列のみを返してください
- マークダウンのバッククォート（```）は絶対に含めないでください
- 各要素: {relevance: 1-5, summary_ja: str, reason: str, tags: [str]}
'''
```

**【v2.0修正】 **v2.1追加: USER_PROMPTのテンプレート。研究プロファイルと論文リストのフォーマットを定義。

```
USER_PROMPT_TEMPLATE = '''
## あなたの研究プロファイル
{profile_keywords}
```

```
## 評価対象の論文（{count}件）
{papers_block}
```

```
上記の論文をJSON配列で評価してください。
'''
```

```
# papers_blockの各論文フォーマット:
# [論文{i}]
# タイトル: {title}
# アブストラクト: {abstract[:500]}
# カテゴリ: {categories}
# 学会: {venue or '未査読'}
# GitHub Stars: {github_stars}
```

### 4.5.2 JSONパース戦略（v2.0新設）
**【v2.0修正】 **LLMのJSON出力が壊れた場合の3段階フォールバックパース戦略を定義。

```python
# utils/json_parser.py
def parse_llm_response(text: str) -> list[dict] | None:
    '''3段階フォールバックでLLM出力をパース'''
```

```
    # Step 1: 直接パース
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
```

```
    # Step 2: マークダウンのコードブロックを除去して再パース
    cleaned = re.sub(r'^```(?:json)?\n?|\n?```$', '', text.strip())
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
```

```
    # Step 3: テキスト内のJSON配列部分を正規表現で抽出
    match = re.search(r'[\s*\{.*\}\s*]', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
```

```
    # 全段階失敗: Noneを返し、呼び出し元でリトライ or スキップ
    logger.error(f'JSON parse failed after 3 attempts: {text[:200]}')
    return None
```