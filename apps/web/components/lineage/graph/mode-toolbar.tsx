"use client";

/**
 * Layout/view mode switcher + root button + search -- ported from
 * docs/iclr-2026/lineage.html's `.lineage-toolbar` +
 * docs/assets/lineage.js `bindLayoutButtons`/`bindViewButtons`/
 * `bindRootButton`. Same button labels/order/`aria-pressed` wiring as
 * the original toolbar.
 */
import type { LineageNode } from "../../../lib/lineage/core";
import type { LineageLayout, LineageView } from "../../../lib/lineage/layout/constants";
import { SearchBox } from "./search-box";

const LAYOUT_BUTTONS: readonly [LineageLayout, string][] = [
  ["topics", "トピック"],
  ["tree", "家系図"],
  ["timeline", "時系列"],
];

const VIEW_BUTTONS: readonly [LineageView, string][] = [
  ["list", "関係リスト"],
  ["graph", "グラフ"],
];

export interface ModeToolbarProps {
  layout: LineageLayout;
  view: LineageView;
  onSetLayout: (layout: LineageLayout) => void;
  onSetView: (view: LineageView) => void;
  onRoot: () => void;
  nodes: readonly LineageNode[];
  onSearchSelect: (id: string) => void;
}

function toggleButtonClass(pressed: boolean): string {
  return `rounded-md border px-2.5 py-1 text-sm transition ${
    pressed ? "border-ink bg-ink text-paper" : "border-rule text-ink-muted hover:border-ink-muted"
  }`;
}

export function ModeToolbar({
  layout,
  view,
  onSetLayout,
  onSetView,
  onRoot,
  nodes,
  onSearchSelect,
}: ModeToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <fieldset className="flex gap-1.5 border-0 p-0">
        <legend className="sr-only">Layout</legend>
        {LAYOUT_BUTTONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={layout === value}
            onClick={() => onSetLayout(value)}
            className={toggleButtonClass(layout === value)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <fieldset className="flex gap-1.5 border-0 p-0">
        <legend className="sr-only">表示形式</legend>
        {VIEW_BUTTONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => onSetView(value)}
            className={toggleButtonClass(view === value)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        title="ルート論文にフォーカスを戻す"
        onClick={onRoot}
        className={toggleButtonClass(false)}
      >
        ルート
      </button>
      <SearchBox nodes={nodes} onSelect={onSearchSelect} />
    </div>
  );
}
