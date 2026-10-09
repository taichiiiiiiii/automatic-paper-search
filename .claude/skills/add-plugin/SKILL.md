---
name: add-plugin
description: PaperPilot に新しい Source / Signal / Exporter / LLM provider を TDD で追加する手順（TypeScript、apps/pipeline）。ユーザーが「新しい〜を追加して」「別の API / モデルに対応して」と言った時に起動する。
---

# add-plugin — PaperPilot プラグイン追加スキル

PaperPilot は Open/Closed で作られている。新しい外部連携は決まったインターフェースを実装して足し、既存の実装は書き換えない。コードは TypeScript（`apps/pipeline/src/collect/`）。

## いつ使うか

- 「新しい Source を足して（例: PubMed / Crossref / bioRxiv）」
- 「新しい Signal を足して（例: Altmetric）」
- 「新しい Exporter を足して（例: Discord / Notion）」
- 「新しい LLM provider を足して（例: OpenAI）」

## どのインターフェースを実装するか

| やりたいこと | 実装するもの | 置き場所 | テスト |
|---|---|---|---|
| 外部 API から論文を取る | `Source`（`collect/sources/source.ts`） | `collect/sources/<name>.ts` | `test/collect/sources/<name>.test.ts` |
| 論文に品質シグナルを付ける | `BaseSignal`（`collect/signals/signal.ts`） | `collect/signals/<name>.ts` | `test/collect/signals/<name>.test.ts` |
| 結果を新しい宛先に配る | `Exporter`（`collect/exporters/exporter.ts`） | `collect/exporters/<name>.ts` | `test/collect/exporters/<name>.test.ts` |
| 別の LLM で Stage 4 / 関係分類をする | `LLMProvider`（`collect/llm/provider.ts`） | `lineage/llm/<name>.ts` | `test/lineage/llm/<name>.test.ts` |

パスはすべて `apps/pipeline/` から。

## TDD の順序（必ず守る）

### Step 1: RED — テストを先に書く

外部 HTTP は `fetchImpl` を注入してモックする。時計と sleep も注入する。

| 種類 | お手本 |
|---|---|
| Source | `test/collect/sources/s2.test.ts`（取得・失敗・ページング・API キーのヘッダ） |
| Signal（バッチ） | `test/collect/signals/citation.test.ts`（/paper/batch、ID 欠落の論文を飛ばす） |
| Signal（多段） | `test/collect/signals/github.test.ts`、`githubApi.test.ts` |
| Exporter | `test/collect/exporters/slack.test.ts`（未設定で no-op、失敗で throw） |
| LLM provider | `test/lineage/llm/gemini.test.ts`、`groq.test.ts` |

必ず入れるケース:

- 正常系
- HTTP の失敗（200 以外・`null`・例外）が**記録される**こと（Source は `degradedKeywords` / `AllKeywordsFailedError`、Signal は `runFailures`、Exporter は throw、LLM は `null` を返してヒューリスティックへ）。失敗を空データや 0 点として出さない
- API キー・webhook が無いときに no-op / `enabled = false`
- バッチ API なら、結果が入力より少ない・多い場合

### Step 2: GREEN — 最小の実装

**雛形（Source の例）**

```ts
// apps/pipeline/src/collect/sources/pubmed.ts
import { RateLimiter } from "../http/rateLimiter.js";
import { type FetchLike, requestWithRetry } from "../http/requestWithRetry.js";
import type { Paper } from "../model/paper.js";
import {
  AllKeywordsFailedError,
  type DegradedKeyword,
  type FetchParams,
  type FetchResult,
  type Source,
} from "./source.js";

export interface PubMedSourceConfig {
  enabled?: boolean;
  delaySeconds?: number;
}

export interface PubMedSourceDeps {
  fetchImpl: FetchLike;
  apiKey: string | null; // 秘密は引数で受け取る。process.env を読まない
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PubMedSource implements Source {
  readonly name = "pubmed";
  // RateLimiter の引数は rateLimiter.ts のコンストラクタに合わせる

  constructor(
    private readonly config: PubMedSourceConfig,
    private readonly deps: PubMedSourceDeps,
  ) {}

  async fetch(params: FetchParams): Promise<FetchResult> {
    const papers: Paper[] = [];
    const truncatedKeywords: string[] = [];
    const degradedKeywords: DegradedKeyword[] = [];
    for (const keyword of params.keywords) {
      const resp = await requestWithRetry(
        { method: "GET", url: URL, params: { term: keyword } },
        { fetchImpl: this.deps.fetchImpl, sleep: this.deps.sleep, now: this.deps.now },
      );
      if (resp === null || resp.status !== 200) {
        degradedKeywords.push([keyword, `HTTP ${resp?.status ?? "no response"}`]);
        continue; // 失敗は記録して次へ。黙って 0 件にしない
      }
      // 本文を検査して Paper に変換する。読めない項目も degradedKeywords に残す
    }
    if (degradedKeywords.length === params.keywords.length && params.keywords.length > 0) {
      throw new AllKeywordsFailedError("pubmed: every keyword failed", { truncatedKeywords, degradedKeywords });
    }
    return { papers, truncatedKeywords, degradedKeywords };
  }
}
```

`HttpResponseLike` の項目名（`status` など）と `RateLimiter` の使い方は、書く前に `collect/http/` の実物で確かめる。

### Step 3: REFACTOR

- 関数は短く、ファイルは 800 行以内
- 公開する関数には「なぜ」のコメント
- 丸め・数値表記・並び順は `packages/core/src/pycompat/` を使う
- `pnpm exec biome check <files>` と typecheck を通す

### Step 4: 登録

1. **`collect/runner.ts` の該当する builder に分岐を足す**
   ```ts
   // buildSources()
   if (srcsCfg.pubmed) {
     entries.push({
       source: new PubMedSource(
         { enabled: srcsCfg.pubmed.enabled, delaySeconds: srcsCfg.pubmed.delay_seconds },
         { fetchImpl: this.deps.fetchImpl, apiKey: env.pubmedApiKey, sleep: this.deps.sleep, now: this.deps.now },
       ),
       enabled: srcsCfg.pubmed.enabled ?? true,
     });
   }
   ```
   LLM provider は `collect/runtime/llmProvider.ts` の `buildLlmProviderFromConfig()` に `case` を足す。
2. **設定の型** — `collect/config/types.ts`（例: `SourcesConfig` に `pubmed?: SourceEntryConfig`）
3. **`data/config/config.yaml` に設定を足す**
   ```yaml
   sources:
     pubmed:
       enabled: false
       delay_seconds: 1.0
   ```
4. **秘密があれば `data/config/.env.example` に名前を足す**
   ```
   PAPERPILOT_PUBMED_API_KEY=
   ```
5. **`collect/config/env.ts` の `Env` と読み込みに足す**（`pubmedApiKey: get("PAPERPILOT_PUBMED_API_KEY")` の形）
6. **CLAUDE.md のフォルダ構成を更新する**

### Step 5: VERIFY

```bash
pnpm --filter @paperpilot/pipeline exec vitest run test/collect/sources/pubmed.test.ts
pnpm --filter @paperpilot/pipeline typecheck
pnpm exec biome check apps/pipeline/src/collect/sources/pubmed.ts apps/pipeline/test/collect/sources/pubmed.test.ts
pnpm --filter @paperpilot/pipeline test      # 既存のテスト（runner・config）が壊れていないか
```

## 必ず守ること

- **外部 API を叩くテストを書かない。** `fetchImpl` を注入する
- **秘密は環境変数（`data/config/.env`・secrets）だけ。** `config.yaml` にもソースにも書かない
- **失敗を空データにしない。** 記録して続ける（run は止めない）。CLI は `--fail-on-errors` で非 0 にできる
- **Signal は `enrichBatch` を優先する**（§4.3.1）
- **スコアは 0〜100。** 重みは config から。コードに書かない
- **データのパスを直書きしない。** `packages/core/src/layout` を使う
- **新しい依存を足さない**（足すならユーザー承認）

## よくあるミス

| ミス | 対策 |
|---|---|
| `fetch` を直接呼ぶ | `requestWithRetry` と注入した `fetchImpl` を使う |
| バッチ API なのに 1 件ずつ | `enrichBatch` を上書きする |
| テストで本物の API | `fetchImpl` を偽物にする |
| runner への登録忘れ | `buildSources()` / `buildSignals()` / `buildExporters()` / `buildLlmProviderFromConfig()` を確かめる |
| `.env.example` の更新忘れ | 他の人が再現できない。必ず足す |
| 設定キーの変更で既存テストが落ちる | `test/collect/config/` と `runner.test.ts` を確かめる |

## チェックリスト

- [ ] テストが先にあり、全部通る
- [ ] 正常・失敗・未設定のテストがそろっている
- [ ] `requestWithRetry` を使っている（`fetch` の直呼びなし）
- [ ] 秘密は引数で受け取る
- [ ] runner（または `llmProvider.ts`）に登録した
- [ ] `config/types.ts` と `config.yaml` に設定を足した（既定 `enabled: false`）
- [ ] `.env.example` と `config/env.ts` に秘密の名前を足した
- [ ] CLAUDE.md のフォルダ構成を更新した
- [ ] lint・typecheck・pipeline のテストが通る
- [ ] commit・push はユーザーの承認の後にメインセッションが行う（`develop` / `main` に直接 push しない）
