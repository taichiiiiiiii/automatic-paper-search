"use client";

import { formatStars } from "../../../lib/lineage/layout/format";
/**
 * Topics gallery (cluster-grouped paper cards) -- ported from
 * docs/assets/lineage.js `renderTopicsGallery`/`buildTopicsCard`.
 * Pure presentation over a `TopicsModel`
 * (lib/lineage/layout/view-model.ts); the empty-clusters and
 * unresolved-focus_id handling already happened there.
 */
import type { TopicsModel } from "../../../lib/lineage/layout/view-model";

export interface TopicsGalleryProps {
  topics: TopicsModel;
  onSelect: (nodeId: string, clusterId: string) => void;
}

export function TopicsGallery({ topics, onSelect }: TopicsGalleryProps) {
  if (topics.clusters.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-ink-subtle">
        クラスタ情報がありません。lineage.json を再生成してください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-ink-muted">
        {topics.clusters.length} サブフィールド · Oral 採択 {topics.totalPapers} 本を primary tag
        でグループ化。カードをクリックすると家系図に切り替わります。
      </p>
      {topics.clusters.map((cluster) => (
        <section
          key={cluster.id}
          aria-labelledby={`topics-cluster-${cluster.id}`}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-baseline gap-2 border-b border-rule pb-2">
            <h2
              id={`topics-cluster-${cluster.id}`}
              className="font-serif text-lg font-semibold text-ink"
            >
              {cluster.label}
            </h2>
            {cluster.subtitle && (
              <span className="text-sm text-ink-subtle">{cluster.subtitle}</span>
            )}
            <span className="ml-auto text-xs text-ink-subtle">{cluster.count} 件</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cluster.nodes.map((node) => {
              const authorsList = Array.isArray(node.authors) ? node.authors : [];
              const authors =
                authorsList.slice(0, 3).join(", ") +
                (authorsList.length > 3 ? ` +${authorsList.length - 3}` : "");
              const kinds = Array.isArray(node.kinds) ? (node.kinds as unknown[]).slice(0, 4) : [];
              const stars = formatStars(node.github_stars);
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onSelect(node.id, cluster.id)}
                  className="flex flex-col gap-1 rounded-md border border-rule bg-surface-elevated p-3 text-left text-xs transition hover:border-rule-strong"
                >
                  <div className="line-clamp-2 font-serif text-sm font-semibold text-ink">
                    {typeof node.title === "string" ? node.title : node.id}
                  </div>
                  {authors && <div className="truncate text-ink-subtle">{authors}</div>}
                  {typeof node.tldr === "string" && node.tldr && (
                    <p className="line-clamp-2 text-ink-muted">{node.tldr}</p>
                  )}
                  {(kinds.length > 0 || stars) && (
                    <div className="mt-auto flex flex-wrap gap-1 text-[0.65rem] text-ink-subtle">
                      {kinds.map((k) => (
                        <span key={String(k)} className="rounded bg-surface-2 px-1 py-0.5">
                          #{String(k)}
                        </span>
                      ))}
                      {stars && <span>⭐{stars}</span>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
