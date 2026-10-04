/**
 * Display-count summary + exclusion/status breakdown -- ported from
 * docs/assets/lineage-focus.js `renderSummary`.
 */
import { EXCLUSION_LABELS } from "../../../lib/lineage/v2/layout";
import type { FocusProjection } from "../../../lib/lineage/v2/projection";
import styles from "./focus.module.css";

export interface SummaryProps {
  projection: FocusProjection;
}

export function Summary({ projection }: SummaryProps) {
  const { counts, exclusions, statusCodes } = projection;
  const parts = Object.entries(exclusions)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${EXCLUSION_LABELS[key] || key} ${count}`);
  const statuses = statusCodes.length ? ` · URL状態: ${statusCodes.join(", ")}` : "";

  return (
    <section className={styles.summary} aria-label="表示集計">
      <p aria-live="polite">
        {`表示 ${counts.shownNodes} / ${counts.totalNodes} 論文 · ${counts.shownClaims} / ${counts.eligibleClaims} 関係（採択 ${counts.acceptedClaims}）`}
      </p>
      <p>{(parts.length ? `除外: ${parts.join(" · ")}` : "除外なし") + statuses}</p>
    </section>
  );
}
