/**
 * "系譜での位置" on a selected catalog card (design doc 48 P1-3): when the
 * paper is a node of a published theme lineage, link to the theme page
 * focused on it and summarise how the lineage uses it. Renders nothing
 * when the paper is in no published theme.
 */
import { BASE_PATH } from "../../lib/config";
import { relationLabelFor } from "../../lib/lineage/relations";
import { type ThemePosition, themeFocusPath } from "../../lib/lineage/theme-position";
import styles from "./catalog.module.css";

const ORDER = ["supersedes", "successor", "extends", "ablation", "contrasts", "baseline_only"];

function breakdown(counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1);
  });
  return keys.map((k) => `${relationLabelFor(k, false)} ${counts[k]}`).join("・");
}

export function ThemePositionSection({ positions }: { positions: readonly ThemePosition[] }) {
  if (positions.length === 0) return null;
  return (
    <section
      className="mt-2 rounded-md border border-rule bg-surface-2 px-3 py-2 text-xs"
      data-theme-position
      aria-label="系譜での位置"
    >
      <h4 className="font-semibold text-ink">系譜での位置</h4>
      <ul className="mt-1 space-y-1">
        {positions.map((p) => (
          <li key={`${p.slug}:${p.nodeId}`} className="text-ink-muted">
            <a
              href={`${BASE_PATH}${themeFocusPath(p.slug, p.nodeId)}`}
              className={`font-medium ${styles.strongLink}`}
              data-theme-position-link
            >
              {p.theme} の系譜で見る →
            </a>
            {p.onMainPath && (
              <span className="ml-1 rounded bg-accent/10 px-1 text-accent-strong">本流</span>
            )}
            {p.tier === "unaudited" && <span className="ml-1 text-ink-subtle">（未監査）</span>}
            <div className="mt-0.5">
              発展 {p.derivativeCount} 本{p.derivativeCount > 0 && `（${breakdown(p.derivedBy)}）`}
              ・土台 {p.priorCount} 本{p.priorCount > 0 && `（${breakdown(p.buildsOn)}）`}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
