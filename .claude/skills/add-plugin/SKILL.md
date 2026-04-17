---
name: add-plugin
description: PaperPilot に新しい Source / Signal / Exporter / LLMProvider を TDD で追加する手順。ユーザーが「新しい〜を追加して」「別の API / モデルに対応して」と言った時に起動する。
---

# add-plugin — PaperPilot プラグイン追加スキル

PaperPilot は Open/Closed 原則で設計されている。新しい外部連携は基底クラスを継承して追加し、既存コードは変更しない。

## いつ起動するか

- 「新しい Source を追加（例：PubMed / Crossref / bioRxiv）」
- 「新しい Signal を追加（例：Altmetric / Twitter mentions）」
- 「新しい Exporter を追加（例：Discord / Notion）」
- 「新しい LLM Provider を追加（例：Claude / OpenAI / Groq）」

## 判断：どの基底クラスを継承するか

| やりたいこと | 継承先 | 配置 |
|-------------|-------|------|
| 外部 API から論文メタデータを取りたい | `sources.base.AbstractSource` | `paperpilot/sources/<name>_source.py` |
| 論文に品質シグナル（venue/引用/stars 等）を付加したい | `signals.base.AbstractSignal` | `paperpilot/signals/<name>_signal.py` |
| 結果を新しい宛先に配信したい | `exporters.base.AbstractExporter` | `paperpilot/exporters/<name>_exporter.py` |
| 別の LLM で Stage 4 をやりたい | `llm.base.AbstractLLMProvider` | `paperpilot/llm/<name>_provider.py` |

## TDD 順序（絶対に守る）

### Step 1: RED — テストを先に書く

`paperpilot/tests/test_<module_name>.py` を作成。外部 HTTP は `unittest.mock.patch` でモックする。

**参考にする既存テスト**

| 種類 | お手本 |
|------|-------|
| Source | `tests/test_s2_source.py`（fetch / failure / paging / API key header） |
| Signal (バッチ) | `tests/test_citation_signal.py`（/paper/batch モック、ID 欠落スキップ） |
| Signal (1件処理) | `tests/test_github_signal_flow.py`（多段 lookup、fallback） |
| Exporter | `tests/test_email_exporter.py`（smtplib モック、不完全設定時 no-op） |
| LLM Provider | `tests/test_gemini_provider.py`（generateContent、JSON 3段階パース） |

**必ず含めるテストケース**

- 正常系（happy path）
- HTTP 障害（非200、None、exception）でも raise しない（Fail-Safe）
- API キー / webhook / SMTP 等が未設定のときに no-op / enabled=False
- バッチ API の場合：入力リストより少ない結果が返ったら None で pad
- バッチ API の場合：余分な結果は truncate

### Step 2: GREEN — 最小実装

**テンプレ（Source 例）**

```python
# paperpilot/sources/pubmed_source.py
from __future__ import annotations
from datetime import date
from ..models import Paper
from ..utils.http import request_with_retry  # 必ずこれを使う（429/5xx retry 込み）
from ..utils.logger import get_logger
from ..utils.rate_limiter import RateLimiter
from .base import AbstractSource

logger = get_logger(__name__)

class PubMedSource(AbstractSource):
    name = "pubmed"

    def __init__(self, config: dict, api_key: str | None = None) -> None:
        super().__init__(config)
        self._limiter = RateLimiter(float(self.config.get("delay_seconds", 1.0)))
        self._api_key = api_key

    def fetch(self, keywords, categories, since_date, max_results) -> list[Paper]:
        papers: list[Paper] = []
        for kw in keywords:
            self._limiter.wait()
            papers.extend(self._search(kw, since_date, max_results))
        return papers

    def _search(self, keyword, since_date, max_results) -> list[Paper]:
        resp = request_with_retry("GET", URL, params={...})
        if resp is None or resp.status_code != 200:
            return []  # Fail-Safe
        # parse ...
```

### Step 3: REFACTOR — 整える

- 関数は 50 行以内・ファイルは 800 行以内
- 型ヒント + docstring（Why を書く、What はコードから読める）
- `logger.info` / `logger.warning` を要所に

### Step 4: 登録

1. **`__init__.py` の `__all__` に追加**
   ```python
   # paperpilot/sources/__init__.py
   from .pubmed_source import PubMedSource
   __all__ = [..., "PubMedSource"]
   ```

2. **`pipeline/runner.py` の該当 builder に分岐追加**
   ```python
   def _build_sources(self):
       ...
       if "pubmed" in srcs_cfg:
           sources.append(PubMedSource(srcs_cfg["pubmed"], api_key=env.get("pubmed_api_key")))
   ```

3. **`config.yaml` に設定を追加**
   ```yaml
   sources:
     pubmed:
       enabled: false
       delay_seconds: 1.0
   ```

4. **`.env.example` に環境変数を追加**（秘匿情報ある場合）
   ```
   PAPERPILOT_PUBMED_API_KEY=
   ```

5. **`utils/config_loader.py` の env 統合に追加**
   ```python
   config["env"] = {
       ...,
       "pubmed_api_key": os.getenv("PAPERPILOT_PUBMED_API_KEY"),
   }
   ```

6. **CLAUDE.md のフォルダ構成・ステータス表を更新**

### Step 5: VERIFY

```bash
# テスト + カバレッジ維持
python3 -m pytest paperpilot/tests/test_<new_module>.py -v
python3 -m pytest paperpilot/tests/ --cov=paperpilot --cov-report=term --cov-config=/dev/null

# 80% 以上を維持（現状 97%）
```

## 絶対に守ること

- **外部 API を叩くテストを書かない。** `request_with_retry` を必ずモックする
- **秘匿情報（API キー / webhook）は `.env` のみ。** `config.yaml` にも `.py` にも書かない
- **失敗時は return None / 空リスト。** `raise` で pipeline を落とさない
- **Signal は `enrich_batch` を優先。** バッチ API がある場合は 1件ずつループで呼ばない（§4.3.1 の設計意図）
- **スコアは 0〜100 に正規化。** `weights` は config で指定、コードに埋め込まない
- **`__init__.py` の `__all__` 更新を忘れない**

## よくあるミス

| ミス | 対策 |
|------|------|
| `requests.get` を直接呼んでしまう | `utils.http.request_with_retry` を使う（指数バックオフ付き） |
| バッチ API なのに 1件ずつループ | `enrich_batch` を override する |
| テストで live API を叩く | `unittest.mock.patch` で `request_with_retry` をモック |
| `runner.py` の登録を忘れる | 追加したら `_build_sources/signals/exporters/llm_provider` の該当関数を必ず確認 |
| `.env.example` の更新を忘れる | 他の人が再現できなくなる。必ず追記 |
| config のキー変更で既存テストが落ちる | `tests/test_config_loader.py` と既存 `runner` テストを確認 |

## チェックリスト

実装完了時に全てチェック：

- [ ] `tests/test_<name>.py` が先にあり、それが全部 pass する
- [ ] 正常系 + 失敗系 + 未設定系のテストが揃っている
- [ ] `request_with_retry` を使っている（直接 `requests.X` していない）
- [ ] 秘匿情報は引数で渡される設計（`__init__` で受け取る）
- [ ] `paperpilot/<kind>/__init__.py` の `__all__` に追加済み
- [ ] `pipeline/runner.py` の builder に登録済み
- [ ] `config.yaml` に設定セクション追加（`enabled: false` がデフォルト）
- [ ] `.env.example` に必要な環境変数を追加
- [ ] `utils/config_loader.py` の env dict に追加（秘匿情報ある場合）
- [ ] `CLAUDE.md` のフォルダ構成・実装ステータス表を更新
- [ ] `pytest --cov=paperpilot` で 80% 以上キープ
- [ ] `develop` ブランチに commit（main には push しない）
