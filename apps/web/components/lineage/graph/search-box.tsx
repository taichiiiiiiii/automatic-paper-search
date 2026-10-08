"use client";

/**
 * Paper search box in the toolbar -- ported from docs/assets/lineage.js
 * `bindSearch`. Matches on title + authors (case-insensitive substring),
 * capped at 8 results, same as the original.
 */
import { useEffect, useRef, useState } from "react";
import type { LineageNode } from "../../../lib/lineage/core";
import { formatVenue } from "../../../lib/lineage/layout/format";

export interface SearchBoxProps {
  nodes: readonly LineageNode[];
  onSelect: (id: string) => void;
}

export function SearchBox({ nodes, onSelect }: SearchBoxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const trimmed = query.trim();
  const matches = trimmed
    ? nodes
        .filter((n) => {
          const hay =
            `${n.title ?? ""} ${Array.isArray(n.authors) ? n.authors.join(" ") : ""}`.toLowerCase();
          return hay.includes(trimmed.toLowerCase());
        })
        .slice(0, 8)
    : [];

  function select(id: string) {
    onSelect(id);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="search"
        aria-label="論文検索（タイトル / 著者）"
        placeholder="論文検索... (タイトル/著者)"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(e.target.value.trim().length > 0);
        }}
        onFocus={() => setOpen(trimmed.length > 0)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            setOpen(false);
          } else if (e.key === "Enter" && matches[0]) {
            select(matches[0].id);
          }
        }}
        className="w-56 rounded-md border border-rule bg-surface px-2 py-1 text-sm text-ink placeholder:text-ink-subtle"
      />
      {open && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute z-10 mt-1 w-72 max-w-[90vw] rounded-md border border-rule bg-surface-elevated shadow-md"
        >
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-ink-subtle">一致なし</div>
          ) : (
            matches.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => select(n.id)}
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-surface-2"
              >
                <span className="line-clamp-1 text-ink">{n.title || n.id}</span>
                <span className="text-ink-subtle">{formatVenue(n.venue, n.year)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
