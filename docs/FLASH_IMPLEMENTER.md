# PaperPilot の Flash 実装担当

**履歴文書:** 2026-09-06の明示依頼で実装担当はAlibaba Cloud `qwen3.7-plus`へ変更した。
現行手順は[`QWEN_IMPLEMENTER.md`](QWEN_IMPLEMENTER.md)。以下は移行前の記録であり、
現在の起動手順・モデル利用可否を示さない。共有Flashサービス自体は変更していない。

<details>
<summary>履歴・非運用・現行起動に使用禁止（旧命令・実行例を含む）</summary>

現行手順は[AGENTS.md](../AGENTS.md)と評価入口の説明を参照。

更新: 2026-09-05。開発支援の実装モデルだけを変更する設定。
PaperPilot製品内のSolによる論文スライド生成モデル・API設定は変更しない。
親・調査・研究・独立レビューのSolモデルとタスク別effortは従来どおり。

## 経路

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

backendは `paperpilot_backend_implementer`、frontendは `paperpilot_frontend_implementer`。どちらも外部ワーカーで、native spawn_agentでは起動しない。必ず --role backend または --role frontend を明示する。

- モデル: `qwen38-flash-next`（ローカルQwen3.8-Flash-Next MLX 4-bit）
- provider: `qwen_flash_local`、effort: `none`
- 接続先: `http://127.0.0.1:11436/v1`（モデル本体は11435番）
- 認証不要。専用設定: `/Users/example/.codex-local-flash`
- 共通キュー: `/Users/example/.local/bin/qwen-flash-queue`
- Music / Kaggle / NEDO / paper / Cryptoを通して実装は1件ずつ。モデルを複数起動しない。このキューは製品の実行jobや取引を排他管理するものではない。
- 旧クラウドQwen、27B、Solへの自動fallbackなし。429・サービス異常・検証失敗は親へ報告する。

## 作業場所と依頼

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

主作業ツリーの最新ランナーから、このリポジトリに登録されたcleanなlinked worktreeを指定する。
primary checkout、main/master/develop、detached HEAD、別リポジトリ、dirty/untracked状態、変更を隠すindex flagsは拒否する。
現在の主作業ツリーはdevelopで多数の未commit変更があり、そのままFlashの書込先にしない。

親が範囲、変更許可ファイル、受入条件、関連テストを固定し、必要な指示と対象ソース・証拠を隔離先へ準備する。
通常のworktree作成だけでは未commit・未追跡の成果物は引き継がれない。必要な対象だけを確認して準備し、秘密情報・データ一式・過去成果物を一括コピーしない。
開始点をcleanにする準備用のローカルコミット等は親の責任で行い、ワーカーへcommitやbranch操作を任せない。
既存の実行中ワーカーを勝手に止めたり、同じファイルに重ねて実装を依頼したりしない。

```sh
/Users/example/work/paper/.codex/bin/qwen-implement --role backend /absolute/linked/worktree < /absolute/bounded-task.md
```

画面側は上の `--role backend` を `--role frontend` に変更する。

## 検証・安全境界

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

Flashは指定ファイルと直接テストだけを変更する。親Solが差分全体を読み直し、必要なテストを自分で再実行して採用する。
`none` は追加の推論生成なし。mediumでの速度・品質は未検証で、今回mediumへは変更していない。
短い課題でも待ち時間がある。32Kテキスト、RAM計画上限35%（約18GB目安）は共通設定であり、OS全体の厳密なメモリ隔離ではない。

OpenAI Docsの[カスタムプロバイダー設定](https://learn.chatgpt.com/ja-JP/docs/config-file/config-advanced)を確認し、プロジェクト設定だけに接続先を置かず、ランナーの実行引数でモデル・provider・カタログを固定する。
ユーザー設定を無視し、匿名利用統計、apps/plugins、web、ワーカーのネットワークとsubagentを停止する。
`workspace-write` とプロンプト規則は、ディスク全体の読取隔離や完全なセキュリティ境界ではない。
Docker/image/runtime/publication gateは維持し、host補助テストをDockerや本番検証成功と呼ばない。
設定変更だけで外部API利用・公開の承認が増えることはない。

## 検証記録

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

- 2026-09-05: 専用ランナーのオフライン回帰17/17、既存agent profile contract 3/3、構文確認・対象Ruffに成功。独立レビューでも17/17と3/3を再実行し、必須の追加指摘なし。
- backend/frontendの実接続確認は未実施。別タスクの実装が共通キューを使用中だったため、約5分45秒の待機後、今回の待機プロセスだけを取り消した（終了143）。Codex/modelは起動しておらず、キュー待機をモデル・providerの接続成功や失敗とは扱わない。
- 共通Flashサービスの受付準備完了は確認。既存のMusic/Biohub/NEDOでの接続成功は、PaperPilot専用ランナーの実接続の証拠とは別。
- 確認用worktreeは差分なし・HEAD不変を確認して、今回作成した一時worktreeとブランチだけを削除した。既存の作業・実行中ワーカーは維持。
- 詳細記録: `/Users/example/.local/share/qwen-flash/verification/paper-crypto/verification.json`。次の小さな実装課題で専用ランナーの実接続と生成差分を確認するまでは、実装品質・所要時間は未評価。
- 製品の機能実装・Docker検証・実API呼び出し・公開・主作業のcommit/pushはこの移行作業では行っていない。
- 18:20追記: NEDOから報告された共通bridgeの `Unknown tool call in history` を修正・反映済み。Codexの履歴要約で `tools=[]` でも過去の呼出・結果を保持し、新規実行の許可は現在のtool catalogだけに限定する。共通回帰48/48、実Codex＋模擬モデルで要約前後の操作継続、独立レビュー、実Flashの短い履歴受入確認に成功。モデル本体は再起動していない。詳細は `/Users/example/.local/share/qwen-flash/verification/compaction-20260905/verification.json`。これは上記PaperPilot専用canary未実施を成功に変えるものではない。

オフライン起動回帰テスト（使い捨てGit fixtureと模擬Codexを使用）:

```sh
python3 /Users/example/work/paper/.codex/tests/test_flash_launcher.py
```

既存のhost-only agent profile contractも新しい経路へ更新済み。Docker build contextに.codexがない場合にskipする既存の扱いは維持。

## 旧設定

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](../AGENTS.md)。

旧native実装roleは発見対象の `.codex/agents/` から削除し、原文を
`/Users/example/.local/share/qwen-flash/migration-before/paper/` に保存した。必要なら元ファイルを復元できる。
既存のドメイン契約は `.codex/runners/` の固定ポリシーへ移した。nativeの残り4役と `.codex/config.toml` はそのまま。

</details>
