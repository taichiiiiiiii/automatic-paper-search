"use client";

/**
 * Cluster breadcrumb above the canvas -- ported from
 * docs/assets/lineage.js `renderCrumb`/`bindCrumb`. Renders nothing
 * when `model.visible` is false (clusters absent, layout is
 * topics/timeline, or no cluster resolves for the current focus/
 * currentCluster) -- see lib/lineage/layout/view-model.ts `buildCrumb`
 * for that decision.
 */
import type { CrumbModel } from "../../../lib/lineage/layout/view-model";

export interface CrumbProps {
  crumb: CrumbModel;
  onGoToTopics: () => void;
  onGoToCluster: (clusterId: string) => void;
}

export function Crumb({ crumb, onGoToTopics, onGoToCluster }: CrumbProps) {
  if (!crumb.visible || !crumb.clusterId || !crumb.clusterLabel) return null;
  return (
    <nav
      aria-label="Current cluster"
      className="flex flex-wrap items-center gap-2 text-sm text-ink-muted"
    >
      <button type="button" onClick={onGoToTopics} className="underline hover:text-accent">
        トピック
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        onClick={() => onGoToCluster(crumb.clusterId as string)}
        className="underline hover:text-accent"
      >
        {crumb.clusterLabel}
      </button>
      {crumb.focusTitle && (
        <>
          <span aria-hidden="true">/</span>
          <span className="font-medium text-ink">{crumb.focusTitle}</span>
        </>
      )}
    </nav>
  );
}
