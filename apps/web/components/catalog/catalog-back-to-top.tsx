"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./catalog.module.css";

const SHOW_AFTER = 600;

/**
 * Floating "back to top" button, ported from docs/assets/app.js
 * `setupBackToTop` -- after progressive reveal the sticky filter bar
 * scrolls off, leaving no quick way back to search/filters on the
 * longer catalogs.
 */
export function CatalogBackToTop({ onReturnFocus }: { onReturnFocus: () => void }) {
  const [visible, setVisible] = useState(false);
  const tickingRef = useRef(false);

  useEffect(() => {
    function onScroll() {
      if (tickingRef.current) return;
      tickingRef.current = true;
      requestAnimationFrame(() => {
        setVisible(window.scrollY >= SHOW_AFTER);
        tickingRef.current = false;
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function handleClick() {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    onReturnFocus();
  }

  return (
    <button
      type="button"
      id="back-to-top"
      hidden={!visible}
      aria-label="ページ上部（検索・絞り込み）へ戻る"
      onClick={handleClick}
      className={`${styles.backToTop} rounded-full border border-rule bg-surface-elevated px-4 py-2 text-sm font-medium text-ink shadow-sm hover:border-rule-strong`}
    >
      <span aria-hidden="true">↑</span> Top
    </button>
  );
}
