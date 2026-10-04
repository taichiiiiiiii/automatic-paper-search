"use client";

/**
 * Lane-grouped node cards -- ported from docs/assets/lineage-focus.js
 * `renderNodeCards`/`hiddenCounts`. Lane membership reflects GRAPH
 * POSITION relative to the focus (see `nodeLanes`'s doc comment), not
 * trust/verification status.
 *
 * `pendingFocus` mirrors the original's `restoreNodeActionFocus`:
 * after an expand/collapse action regenerates this list, focus must
 * land on the SAME node's new action button (or its heading, if no
 * action remains) rather than being lost to `document.body`.
 */
import { useEffect, useRef } from "react";
import { hiddenCounts, nodeLanes } from "../../../lib/lineage/v2/layout";
import type { FocusProjection } from "../../../lib/lineage/v2/projection";
import styles from "./focus.module.css";

export interface PendingNodeFocus {
  nodeId: string;
  action: "collapse" | "expand" | "heading";
}

export interface NodeCardsProps {
  projection: FocusProjection;
  onCenter: (nodeId: string) => void;
  onExpand: (nodeId: string) => void;
  onCollapse: (nodeId: string) => void;
  pendingFocus: PendingNodeFocus | null;
  onFocusApplied: () => void;
}

function NodeCard({
  nodeId,
  title,
  firstPublishedAt,
  isFocus,
  hidden,
  expanded,
  onCenter,
  onExpand,
  onCollapse,
  pendingFocus,
  onFocusApplied,
}: {
  nodeId: string;
  title: string;
  firstPublishedAt: string;
  isFocus: boolean;
  hidden: { parent: number; child: number };
  expanded: boolean;
  onCenter: () => void;
  onExpand: () => void;
  onCollapse: () => void;
  pendingFocus: PendingNodeFocus | null;
  onFocusApplied: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pendingFocus || pendingFocus.nodeId !== nodeId) return;
    if (pendingFocus.action !== "heading" && actionRef.current) {
      actionRef.current.focus({ preventScroll: true });
    } else {
      headingRef.current?.focus({ preventScroll: true });
    }
    onFocusApplied();
  }, [pendingFocus, nodeId, onFocusApplied]);

  return (
    <article className={styles.card} data-node-id={nodeId}>
      <h3 ref={headingRef} tabIndex={-1}>
        {title}
      </h3>
      <p>{firstPublishedAt ? `初出 ${firstPublishedAt}` : "初出日未収録"}</p>
      <div className={styles.cardActions}>
        {!isFocus && (
          <button type="button" onClick={onCenter}>
            この論文を中心にする
          </button>
        )}
        {expanded ? (
          <button type="button" ref={actionRef} onClick={onCollapse}>
            追加枝を閉じる
          </button>
        ) : hidden.parent + hidden.child > 0 ? (
          <>
            <p>{`折り畳み: 親 ${hidden.parent} 件 · 後継 ${hidden.child} 件`}</p>
            <button type="button" ref={actionRef} onClick={onExpand}>
              追加枝を最大 2 件表示
            </button>
          </>
        ) : null}
      </div>
    </article>
  );
}

export function NodeCards({
  projection,
  onCenter,
  onExpand,
  onCollapse,
  pendingFocus,
  onFocusApplied,
}: NodeCardsProps) {
  const lanes = nodeLanes(projection.nodes, projection.claims, projection.focus.id);
  return (
    <div className={styles.nodeCards}>
      {lanes
        .filter((lane) => lane.nodes.length > 0)
        .map((lane) => (
          <section key={lane.key} className={styles.lane} aria-label={lane.label}>
            <p className={styles.laneHeading}>{`${lane.label} · ${lane.nodes.length} 本`}</p>
            <div className={styles.laneCards}>
              {lane.nodes.map((node) => (
                <NodeCard
                  key={node.id}
                  nodeId={node.id}
                  title={node.title}
                  firstPublishedAt={node.first_published_at}
                  isFocus={node.id === projection.focus.id}
                  hidden={hiddenCounts(projection.hiddenBranches, node.id)}
                  expanded={projection.expandedNodeIds.includes(node.id)}
                  onCenter={() => onCenter(node.id)}
                  onExpand={() => onExpand(node.id)}
                  onCollapse={() => onCollapse(node.id)}
                  pendingFocus={pendingFocus}
                  onFocusApplied={onFocusApplied}
                />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
