# 3. モジュール設計


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
> - 🔴 ツリーの `.github/workflows/collect.yml` は**存在しません**。
> - 🔴 `requirements.txt` の実体は arxiv / requests / aiohttp / pyyaml / python-dotenv の **5 件のみ**。
>   本文が挙げる numpy / transformers / torch / anthropic は入っておらず、そのままでは Stage 3/4 は動きません。


## 3.1 ディレクトリ構成

```
paperpilot/
├── config.yaml                # ユーザー設定（秘匿情報を含まない）
├── .env.example               # 【v2.0追加】環境変数テンプレート
├── .gitignore                 # 【v2.0追加】.envを含む
├── collector.py               # メインエントリーポイント（CLI）
├── pipeline/
│   ├── __init__.py
│   ├── runner.py              # パイプライン実行制御
│   ├── stage_collect.py        # Stage 0: データ収集（asyncio対応）
│   ├── stage_rule_filter.py    # Stage 1: ルールベースフィルタ（純粋フィルタのみ）
│   ├── stage_metric_score.py   # Stage 2: メトリクススコアリング（バッチAPI対応）
│   ├── stage_embedding.py      # Stage 3: Embedding類似度
│   └── stage_llm_rank.py       # Stage 4: LLMリランキング
├── sources/
│   ├── base.py                 # AbstractSource（同期 + async）
│   ├── arxiv_source.py
│   ├── s2_source.py
│   └── openalex_source.py
├── signals/
│   ├── base.py                 # 【v2.0変更】AbstractSignal（enrich_batch対応）
│   ├── venue_signal.py
│   ├── github_signal.py
│   ├── citation_signal.py
│   ├── author_signal.py
│   └── social_signal.py
├── exporters/
│   ├── base.py
│   ├── csv_exporter.py
│   ├── json_exporter.py
│   ├── slack_exporter.py
│   └── email_exporter.py
├── models/
│   └── paper.py                # Paperデータクラス（commentフィールド追加済み）
├── utils/
│   ├── config_loader.py        # YAML + .env 統合読み込み
│   ├── dedup.py
│   ├── rate_limiter.py
│   ├── json_parser.py          # 【v2.0追加】LLM出力の堅牢JSONパーサー
│   └── logger.py               # 【v2.0追加】構造化ログ設計
├── data/
│   ├── seen_ids.json           # 【v2.0変更】{id: timestamp}形式
│   ├── profile_vectors.npy
│   ├── run_history.jsonl
│   └── venue_cache.json        # 【v2.0追加】有効期限付きキャッシュ
├── output/
├── logs/                        # 【v2.0追加】ログ出力先
├── tests/
├── .github/workflows/           # 【v2.0追加】GitHub Actions
│   └── collect.yml
└── requirements.txt
```

## 3.2 クラス設計
### 3.2.1 Paper データクラス
システム内で論文を表現する中核データ構造。全Stageで共有される。

| フィールド | 型 | 説明 | ソース |
|---|---|---|---|
| title | str | 論文タイトル | Stage 0 |
| authors | list[str] | 著者名リスト | Stage 0 |
| abstract | str | アブストラクト（最大1000文字） | Stage 0 |
| comment | str | None | 【v2.0追加】arXivコメント欄（学会採択情報を含む） | Stage 0 |
| published_date | date | 公開日 | Stage 0 |
| arxiv_id | str | None | arXiv ID | Stage 0 |
| doi | str | None | DOI | Stage 0 |
| url | str | 論文ページURL | Stage 0 |
| pdf_url | str | None | PDF直リンク | Stage 0 |
| categories | list[str] | カテゴリ（cs.LG等） | Stage 0 |
| source_name | str | 取得元（arXiv / S2 / OpenAlex） | Stage 0 |
| venue | str | None | 掲載学会名 | Stage 2 |
| venue_tier | int | 学会ティア（1〜4, 0=未査読） | Stage 2 |
| github_url | str | None | GitHubリポジトリURL | Stage 2 |
| github_stars | int | GitHub Star数 | Stage 2 |
| star_velocity | float | 1日あたりStar獲得数 | Stage 2 |
| citation_count | int | 引用数 | Stage 2 |
| citation_velocity | float | 1日あたり引用獲得数 | Stage 2 |
| author_h_index | int | 筆頭著者のh-index | Stage 2 |
| influential_citations | int | 影響力のある引用数 | Stage 2 |
| altmetric_score | float | Altmetricスコア | Stage 2 |
| has_code | bool | コード公開の有無 | Stage 2 |
| is_official_repo | bool | 公式リポジトリか | Stage 2 |
| keyword_match_count | int | 【v2.0追加】タイトル/アブスト内のキーワード一致数 | Stage 2 |
| embedding | ndarray | None | 論文のembeddingベクトル | Stage 3 |
| embedding_similarity | float | 研究プロファイルとの類似度（0〜100に正規化済み） | Stage 3 |
| total_score | float | 【v2.1修正】統合スコア（0〜1150、全シグナル0〜100 × 重み合計11.5） | Stage 2+3 |
| llm_relevance | int | None | 【v2.0変更】LLM関連度（1〜5, None=LLM未実行） | Stage 4 |
| llm_summary_ja | str | None | 日本語3行要約 | Stage 4 |
| llm_reason | str | None | 読むべき理由（1文） | Stage 4 |
| llm_tags | list[str] | 自動タグ（新手法/ベンチマーク等） | Stage 4 |

### 3.2.2 共通インターフェース
**【v2.0修正】 **Signal.enrich()を1件処理からバッチ処理に変更。バッチAPIを活用し、API呼び出し回数を800回→約10回に削減する。基底クラスにデフォルトのforループ実装を持たせ、バッチ非対応のSignalでも動作する後方互換を確保する。

```python
# sources/base.py
class AbstractSource(ABC):
    @abstractmethod
    def fetch(self, keywords, categories, since_date, max_results) -> list[Paper]
```

```
    # 【v2.0追加】非同期版（Stage 0の並列化に使用）
    async def afetch(self, keywords, categories, since_date, max_results) -> list[Paper]:
        return self.fetch(keywords, categories, since_date, max_results)
```

```python
# signals/base.py
class AbstractSignal(ABC):
    # 【v2.0変更】バッチ処理がデフォルト
    def enrich_batch(self, papers: list[Paper]) -> list[Paper]:
        '''バッチAPIを持つSignalはこちらをオーバーライド'''
        return [self.enrich_one(p) for p in papers]  # デフォルト: 1件ずつ
```

```python
    @abstractmethod
    def enrich_one(self, paper: Paper) -> Paper:
        '''1件ずつ処理する基本実装'''
        ...
```

```python
# exporters/base.py
class AbstractExporter(ABC):
    @abstractmethod
    def export(self, papers: list[Paper], config: dict) -> None
```

### 3.2.3 PipelineRunner
**【v2.0修正】 **Stage 0でasyncio.gather()による並列収集を追加。Stage 2でenrich_batch()を使用。

```python
class PipelineRunner:
    def __init__(self, config: dict)
```

```
    async def run(self) -> PipelineResult:
        papers = await self._stage0_collect()    # 【v2.0変更】async
        papers = self._stage1_rule_filter(papers)
        papers = self._stage2_metric_score(papers)  # enrich_batch使用
        papers = self._stage3_embedding(papers)
        papers = self._stage4_llm_rank(papers)
        self._export(papers)
        self._save_state(papers)
        return PipelineResult(papers, stats)
```

```
    async def _stage0_collect(self) -> list[Paper]:
        tasks = [src.afetch(...) for src in self.sources if src.enabled]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        papers = []
        for result in results:
            if isinstance(result, Exception):
                logger.warning(f'Source failed: {result}')
                continue
            papers.extend(result)
        return dedup(papers)
```

### 3.2.4 エントリーポイント collector.py（v2.1新設）
**【v2.0修正】 **async PipelineRunnerの呼び出し方法とCLI引数を定義。

```python
# collector.py
import asyncio, argparse
from pipeline.runner import PipelineRunner
from utils.config_loader import load_config
```

```python
def main():
    parser = argparse.ArgumentParser(description='PaperPilot 論文自動収集')
    parser.add_argument('--config', default='config.yaml')
    parser.add_argument('--days', type=int, help='過去N日分を取得')
    parser.add_argument('--keyword', action='append', help='追加キーワード')
    parser.add_argument('--full', action='store_true', help='差分スキップ（全件取得）')
    parser.add_argument('--skip-llm', action='store_true', help='Stage 4をスキップ')
    args = parser.parse_args()
```

```
    config = load_config(args.config)  # YAML + .env 統合読み込み
    # CLI引数でconfigをオーバーライド
    if args.days: config['search']['days_back'] = args.days
    if args.keyword: config['search']['keywords'].extend(args.keyword)
    if args.full: config['incremental']['enabled'] = False
    if args.skip_llm: config['pipeline']['stage4_top_n'] = 0
```

```
    runner = PipelineRunner(config)
    result = asyncio.run(runner.run())  # async→sync変換
    print(f'✅ {result.output_count}件を出力')
```

```
if __name__ == '__main__':
    main()
```

### 3.2.5 requirements.txt（v2.1新設）
**【v2.0修正】 **必要なPythonパッケージを明記。

```
# requirements.txt
arxiv>=2.1.0          # arXiv API クライアント
requests>=2.31.0      # HTTP (同期)
aiohttp>=3.9.0        # HTTP (非同期、Stage 0)
pyyaml>=6.0           # YAML設定読み込み
python-dotenv>=1.0.0  # .env読み込み
numpy>=1.26.0         # embeddingベクトル操作
transformers>=4.40.0  # SPECTER2モデル（Stage 3）
torch>=2.2.0          # PyTorchバックエンド（Stage 3）
anthropic>=0.39.0     # Claude API（Stage 4）
```