# PaperPilot profile

Six roles tuned for `taichiiiiiiii/automatic-paper-search` (target branch: `develop`).

| Agent | Purpose | Model | Access |
|---|---|---|---|
| `paperpilot_system_investigator` | Trace pipeline, schemas, workflows, and history | GPT-5.6 Sol / high | danger-full-access |
| `paperpilot_retrieval_researcher` | Retrieval, ranking, metadata, and lineage research | GPT-5.6 Sol / high | danger-full-access |
| `paperpilot_backend_implementer` | Python/API/pipeline implementation with deterministic tests | GPT-5.6 Sol / medium | danger-full-access |
| `paperpilot_frontend_implementer` | Accessible static Pages UI and generated assets | GPT-5.6 Sol / medium | danger-full-access |
| `paperpilot_evaluator` | Frozen-corpus quality, cost, latency, and regression evaluation | GPT-5.6 Sol / high | danger-full-access |
| `paperpilot_security_reviewer` | Secrets, injection, workflow, Worker, and publication review | GPT-5.6 Sol / high | danger-full-access |

Copy the active files into the target repository. Any workflow dispatch, message delivery, or production publication remains a user-approved action.

The implementation roles use the repository default GPT-5.6 Sol route. Do not select a user-level
third-party provider or copy provider credentials into this repository. Earlier provider experiments
are retired; PaperPilot implementation and review work now stays on the repository Sol route.

## Reasoning effort routing

- The effort in each agent TOML is that role's normal default, not a permanent setting. Override it
  when dispatching a task whose scope or risk belongs to another tier.
- `medium`: bounded implementation, fixture updates, focused inspection, routine regression work,
  and changes contained within one established contract.
- `high`: cross-pipeline or schema changes, migrations, retrieval design, evaluation, security,
  release review, and tasks where a mistake could corrupt generated data or publication state.
- `ultra`: do not use for this repository. If a high-effort pass remains inconclusive, split the
  task or request a second independent high-effort review instead of silently escalating effort.
