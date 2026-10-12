"use client";

/**
 * Prior / Derivative panel and two-paper path for the theme page —
 * design doc 48 P0-5 (first step: papers already in the lineage) and
 * P1-5 (I5).
 *
 * For the selected paper it lists the papers it builds on (土台) and the
 * papers that build on it (発展): strong relations first (direct, then
 * through a chain of strong relations), then plain references. Each row
 * carries the relation label, a "根拠" button that opens the existing
 * evidence panel for that edge, and a link to the paper. A second picker
 * finds the shortest path between two papers over the lineage edges
 * (strong relations preferred).
 *
 * Only lineage edges are used: nothing here adds papers or relations
 * that are not in the published artifact (design doc 48 §6). All text
 * goes through React's escaping; no inline styles (CSP).
 */
import { useMemo, useState } from "react";
import { paperLink } from "../../lib/lineage/evidence";
import type { LineagePath, NeighborItem, PriorDerivative } from "../../lib/lineage/paper-neighbors";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";
import { edgeKey, relationLabelJa } from "./EdgeEvidence";

const LIST_LIMIT = 12;

function titleOf(nodeById: ReadonlyMap<string, LineageNode>, id: string): string {
  const t = nodeById.get(id)?.title;
  return typeof t === "string" && t ? t : id;
}

function yearOf(nodeById: ReadonlyMap<string, LineageNode>, id: string): string {
  const y = nodeById.get(id)?.year;
  return typeof y === "number" ? String(y) : "—";
}

/** `<option>` label: "2017 · Attention Is All You Need". */
function optionLabel(n: LineageNode): string {
  const t = typeof n.title === "string" && n.title ? n.title : n.id;
  const short = t.length > 80 ? `${t.slice(0, 79)}…` : t;
  return `${typeof n.year === "number" ? n.year : "—"} · ${short}`;
}

export function sortedPaperOptions(nodes: readonly LineageNode[]): LineageNode[] {
  return [...nodes].sort((a, b) => {
    const ya = typeof a.year === "number" ? a.year : 99999;
    const yb = typeof b.year === "number" ? b.year : 99999;
    if (ya !== yb) return ya - yb;
    const ta = String(a.title ?? a.id);
    const tb = String(b.title ?? b.id);
    return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : 1;
  });
}

function NeighborList({
  title,
  hint,
  items,
  side,
  nodeById,
  onSelectPaper,
  onShowEvidence,
  mainPathNodeIds,
}: {
  title: string;
  hint: string;
  items: NeighborItem<LineageEdge>[];
  side: "prior" | "derivative";
  nodeById: ReadonlyMap<string, LineageNode>;
  onSelectPaper: (id: string) => void;
  onShowEvidence: (key: string, opener?: Element) => void;
  mainPathNodeIds: ReadonlySet<string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, LIST_LIMIT);
  return (
    <div data-neighbor-side={side} className="min-w-0 flex-1">
      <h4 className="text-sm font-semibold text-ink">
        {title} <span className="font-normal text-ink-subtle">{items.length} 本</span>
      </h4>
      <p className="text-xs text-ink-subtle">{hint}</p>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-ink-muted">この系譜の中にはありません。</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {shown.map((item) => {
            const node = nodeById.get(item.id);
            const link = paperLink(node ?? { id: item.id });
            const via =
              item.kind === "strong-indirect"
                ? (side === "prior"
                    ? item.chain.slice(1).map((e) => e.src)
                    : item.chain.slice(0, -1).map((e) => e.dst)
                  ).map((id) => titleOf(nodeById, id))
                : [];
            return (
              <li
                key={item.id}
                data-neighbor-kind={item.kind}
                className="rounded-md border border-rule bg-surface px-2 py-1 text-xs"
              >
                <div className="flex flex-wrap items-baseline gap-1">
                  <span
                    className={`rounded px-1 ${
                      item.kind === "reference"
                        ? "bg-surface-2 text-ink-subtle"
                        : "bg-accent/10 text-accent-strong"
                    }`}
                  >
                    {relationLabelJa(item.edge.relation)}
                    {item.kind === "strong-indirect" && `・${item.hops} 段`}
                  </span>
                  <span className="text-ink-subtle">{yearOf(nodeById, item.id)}</span>
                  {mainPathNodeIds.has(item.id) && (
                    <span className="rounded bg-accent/10 px-1 text-accent-strong">本流</span>
                  )}
                  <button
                    type="button"
                    onClick={() => onSelectPaper(item.id)}
                    title="この論文を選ぶ"
                    className="min-w-0 text-left font-medium text-ink underline decoration-rule hover:decoration-accent"
                  >
                    {titleOf(nodeById, item.id)}
                  </button>
                </div>
                {via.length > 0 && (
                  <div className="mt-0.5 text-ink-subtle">経由: {via.join(" → ")}</div>
                )}
                <div className="mt-0.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={(ev) => onShowEvidence(edgeKey(item.edge), ev.currentTarget)}
                    data-neighbor-evidence
                    className="-my-1 py-1 text-accent-strong underline"
                  >
                    根拠
                  </button>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-strong underline"
                  >
                    {link.label}
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > LIST_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 text-xs text-accent-strong underline"
        >
          {showAll ? "少なく表示" : `すべて表示（${items.length} 本）`}
        </button>
      )}
    </div>
  );
}

function PathView({
  path,
  nodeById,
  onSelectPaper,
  onShowEvidence,
}: {
  path: LineagePath<LineageEdge>;
  nodeById: ReadonlyMap<string, LineageNode>;
  onSelectPaper: (id: string) => void;
  onShowEvidence: (key: string, opener?: Element) => void;
}) {
  return (
    <div data-lineage-path-result>
      <p className="text-xs text-ink-muted">
        {path.steps.length} 段（強い関係 {path.strongCount} 本・参照（背景）
        {path.steps.length - path.strongCount} 本）
      </p>
      <ol className="mt-1 space-y-0.5 text-xs">
        {path.nodeIds.map((id, i) => {
          const step = i > 0 ? path.steps[i - 1] : undefined;
          return (
            <li key={id}>
              {step && (
                <div className="ml-3 flex flex-wrap items-center gap-2 text-ink-subtle">
                  <span aria-hidden="true">{step.direction === "forward" ? "↓" : "↑"}</span>
                  <span>
                    {step.direction === "forward"
                      ? `次の論文がこの論文を基にした（${relationLabelJa(step.edge.relation)}）`
                      : `この論文が次の論文を基にした（${relationLabelJa(step.edge.relation)}）`}
                  </span>
                  <button
                    type="button"
                    onClick={(ev) => onShowEvidence(edgeKey(step.edge), ev.currentTarget)}
                    className="text-accent-strong underline"
                  >
                    根拠
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => onSelectPaper(id)}
                className="text-left text-ink underline decoration-rule hover:decoration-accent"
              >
                <span className="text-ink-subtle">{yearOf(nodeById, id)}</span>{" "}
                {titleOf(nodeById, id)}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function PaperNeighborsPanel({
  nodes,
  nodeById,
  selectedId,
  onSelectPaper,
  neighbors,
  pathToId,
  onPathTo,
  path,
  onShowEvidence,
  mainPathNodeIds,
}: {
  nodes: readonly LineageNode[];
  nodeById: ReadonlyMap<string, LineageNode>;
  selectedId: string | null;
  onSelectPaper: (id: string | null) => void;
  neighbors: PriorDerivative<LineageEdge> | null;
  pathToId: string | null;
  onPathTo: (id: string | null) => void;
  path: LineagePath<LineageEdge> | null;
  onShowEvidence: (key: string, opener?: Element) => void;
  mainPathNodeIds: ReadonlySet<string>;
}) {
  const options = useMemo(() => sortedPaperOptions(nodes), [nodes]);
  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const link = selected ? paperLink(selected) : null;
  return (
    <section
      aria-labelledby="paper-neighbors-title"
      data-prior-derivative
      className="mt-4 rounded-md border border-rule bg-surface-elevated p-3"
    >
      <h3 id="paper-neighbors-title" className="font-serif text-base font-semibold text-ink">
        論文ごとの土台と発展
      </h3>
      <p className="text-xs text-ink-subtle">
        家系図のカードか下の一覧で論文を選ぶと、その論文の土台と発展を出します（強い関係が先、参照（背景）は後）。
      </p>
      <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span>論文</span>
        <select
          value={selectedId ?? ""}
          onChange={(e) => onSelectPaper(e.target.value || null)}
          data-neighbor-select
          className="min-h-9 max-w-full rounded-md border border-rule bg-surface px-2 py-1 text-xs"
        >
          <option value="">— 論文を選ぶ —</option>
          {options.map((n) => (
            <option key={n.id} value={n.id}>
              {optionLabel(n)}
            </option>
          ))}
        </select>
        {selectedId && (
          <button
            type="button"
            onClick={() => onSelectPaper(null)}
            className="text-accent-strong underline"
          >
            選択を解除
          </button>
        )}
      </label>

      {selected && neighbors && (
        <>
          <p className="mt-2 text-sm text-ink" data-neighbor-selected={selected.id}>
            <span className="text-ink-subtle">
              {typeof selected.year === "number" ? selected.year : "—"}
            </span>{" "}
            <strong>{selected.title || selected.id}</strong>
            {mainPathNodeIds.has(selected.id) && (
              <span className="ml-1 rounded bg-accent/10 px-1 text-xs text-accent-strong">
                本流
              </span>
            )}
            {link && (
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-xs text-accent-strong underline"
              >
                {link.label}
              </a>
            )}
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <NeighborList
              title="土台"
              hint="この論文が基にした論文"
              items={neighbors.prior}
              side="prior"
              nodeById={nodeById}
              onSelectPaper={onSelectPaper}
              onShowEvidence={onShowEvidence}
              mainPathNodeIds={mainPathNodeIds}
            />
            <NeighborList
              title="発展"
              hint="この論文を基にした論文"
              items={neighbors.derivative}
              side="derivative"
              nodeById={nodeById}
              onSelectPaper={onSelectPaper}
              onShowEvidence={onShowEvidence}
              mainPathNodeIds={mainPathNodeIds}
            />
          </div>

          <div className="mt-3 border-t border-rule pt-2" data-lineage-path>
            <h4 className="text-sm font-semibold text-ink">2 本をつなぐ経路</h4>
            <label className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span>つなぐ先</span>
              <select
                value={pathToId ?? ""}
                onChange={(e) => onPathTo(e.target.value || null)}
                data-path-select
                className="min-h-9 max-w-full rounded-md border border-rule bg-surface px-2 py-1 text-xs"
              >
                <option value="">— 論文を選ぶ —</option>
                {options
                  .filter((n) => n.id !== selectedId)
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {optionLabel(n)}
                    </option>
                  ))}
              </select>
            </label>
            <p className="mt-1 text-xs text-ink-subtle">
              系譜の線だけを使った最短の経路です（向きは問いません。強い関係を優先し、参照（背景）は
              2 本分に数えます）。
            </p>
            {pathToId &&
              pathToId !== selectedId &&
              (path ? (
                <PathView
                  path={path}
                  nodeById={nodeById}
                  onSelectPaper={onSelectPaper}
                  onShowEvidence={onShowEvidence}
                />
              ) : (
                <p className="mt-1 text-xs text-ink-muted" data-lineage-path-none>
                  この 2 本は系譜の線でつながっていません。
                </p>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
