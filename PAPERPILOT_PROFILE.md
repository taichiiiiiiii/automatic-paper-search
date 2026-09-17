# PaperPilot profile

現行ルーティングはAGENTS.mdを正本とする。実装・解析・文献処理・必要テストはFlash、条件付き評価のみMAX、最終採否は親Codex。以下のSingle-agent modeや旧role表は履歴であり、現行方針を上書きしない。設定変更だけではworker起動・外部操作を許可しない。

<details>
<summary>履歴・非運用・現行起動に使用禁止（旧命令・実行例を含む）</summary>

現行手順は[AGENTS.md](AGENTS.md)と評価入口の説明を参照。

## Historical policy: Single-agent mode (2026-09-08; not current)

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](AGENTS.md)。

ユーザー指示によりサブエージェントは使用しない。実装・調査・レビューは現在の親エージェントが単独で行い、
Qwen/Flash外部workerへの委譲や既存subagentの再開も行わない。`.codex/config.toml`の`agents.enabled = false`を維持する。
以下の6 roleとeffort routingは無効な履歴として保持する。製品内の生成モデル、権限、実人手監査・公開gateは変更しない。

## Historical profiles (inactive)

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](AGENTS.md)。

Six roles tuned for `taichiiiiiiii/automatic-paper-search` (target branch: `develop`).

| Agent | Purpose | Model | Access |
|---|---|---|---|
| `paperpilot_system_investigator` | Trace pipeline, schemas, workflows, and history | GPT-5.6 Sol / high | danger-full-access |
| `paperpilot_retrieval_researcher` | Retrieval, ranking, metadata, and lineage research | GPT-5.6 Sol / high | danger-full-access |
| `paperpilot_backend_implementer` | Python/API/pipeline implementation with deterministic tests | qwen3.7-plus / configured none | workspace-write, offline tools |
| `paperpilot_frontend_implementer` | Accessible static Pages UI and generated assets | qwen3.7-plus / configured none | workspace-write, offline tools |
| `paperpilot_evaluator` | Frozen-corpus quality, cost, latency, and regression evaluation | GPT-5.6 Sol / high | danger-full-access |
| `paperpilot_security_reviewer` | Secrets, injection, workflow, Worker, and publication review | GPT-5.6 Sol / high | danger-full-access |

Copy the active files into the target repository. Any workflow dispatch, message delivery, or production publication remains a user-approved action.

The external implementation roles use `.codex/bin/qwen-implement --role backend|frontend WORKTREE`
with the existing Alibaba Cloud `qwen_token_plan` provider, as explicitly requested on 2026-09-06.
Do not use native spawn_agent for those two roles or copy provider credentials into this repository.
Parent/research/review and the product's Sol generation model are unchanged. Live provider/model
availability is not established by the offline configuration tests. See [current routing](docs/QWEN_IMPLEMENTER.md).

## Reasoning effort routing

> 履歴・非運用・現行起動に使用禁止。現行手順は[AGENTS.md](AGENTS.md)。

- The effort in each agent TOML is that role's normal default, not a permanent setting. Override it
  when dispatching a task whose scope or risk belongs to another tier.
- External Qwen implementation is pinned to configured `none`, pending live provider verification;
  the following medium/high guidance applies to native Sol roles, not to this provider's capabilities.
- `medium`: bounded implementation, fixture updates, focused inspection, routine regression work,
  and changes contained within one established contract.
- `high`: cross-pipeline or schema changes, migrations, retrieval design, evaluation, security,
  release review, and tasks where a mistake could corrupt generated data or publication state.
- `ultra`: do not use for this repository. If a high-effort pass remains inconclusive, split the
  task or request a second independent high-effort review instead of silently escalating effort.

</details>
