# 系譜の人手監査の記録

設計書 41 D5（ノードと強い主張の関係）に沿った人手監査のシート。判定そのものは `data/config/lineage-audit-fixtures-v1.json` が正本で、ここは人が読む控え。

| テーマ | 監査日 | 監査者 | 結果 |
|---|---|---|---|
| vision-transformer | 2026-10-11 | maintainer | 監査済み |
| flash-attention | 2026-10-11 | maintainer | 監査済み |
| mixture-of-experts | 2026-10-11 | maintainer | 監査済み |
| graph-neural-network | 2026-10-11 | maintainer | 監査済み（テーマ外 2 件は基準 10% 以内） |

- シートは成果物の `input_sha256` に結びついている。テーマを作り直すと監査は無効になり、作り直した版で監査し直す（`auditDraftCli.ts draft → suggest → import`）。
- 判定は第二審査の見立て（suggestion）を監査者が確認して採用した。
