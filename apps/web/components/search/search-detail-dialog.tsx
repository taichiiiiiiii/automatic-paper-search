"use client";

/**
 * Port of docs/assets/search-detail.js (SCR-08): clicking a full-results
 * link opens that paper's catalog detail inside a same-origin `<dialog>`
 * iframe instead of navigating away, so the search state survives.
 *
 * Delegated (document-level) click handling mirrors the original -- the
 * result links live inside SearchArea, which this component never
 * reaches into; it only listens for clicks that bubble up and validates
 * the href with lib/search-detail.ts's `detailFrameUrl`.
 */
import { useEffect, useRef, useState } from "react";
import { detailFrameUrl } from "../../lib/search-detail";
import styles from "./search-detail-dialog.module.css";

const LOADING_MESSAGE =
  "論文詳細を読み込んでいます。表示されない場合は「通常ページで開く」を選んでください。";
const LOADED_MESSAGE = "閉じると検索結果の元の位置に戻ります。";
const SLOW_MESSAGE = "読み込みに時間がかかっています。「通常ページで開く」からも確認できます。";
const SLOW_TIMEOUT_MS = 15000;

function isResultLink(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a.s0-results__link");
  return anchor instanceof HTMLAnchorElement ? anchor : null;
}

export function SearchDetailDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [directHref, setDirectHref] = useState("./");
  const [status, setStatus] = useState("");

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const anchor = isResultLink(event.target);
      const dialog = dialogRef.current;
      if (!anchor || !dialog || dialog.open) return;
      const url = detailFrameUrl(anchor.href, window.location.href);
      if (!url) return;
      event.preventDefault();
      triggerRef.current = anchor;
      setDirectHref(url.href);
      setStatus(LOADING_MESSAGE);
      setFrameSrc(url.href);
      dialog.showModal();
      // showModal() would otherwise focus the first focusable element in
      // tree order -- the "通常ページで開く" link, not the close button
      // a keyboard/screen-reader user expects to land on when a dialog
      // opens.
      closeButtonRef.current?.focus();
    }
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, []);

  // One "this is taking a while" timer per opening, tied to the iframe's
  // src -- never reset by an unrelated re-render (e.g. the load handler
  // setting `status`), and always cancelled when the dialog closes
  // (frameSrc -> null), a new paper is opened (frameSrc changes), or the
  // iframe finishes loading before the timeout (handleFrameLoad clears
  // it) -- a paper that loads in 2s must not have its LOADED_MESSAGE
  // overwritten by SLOW_MESSAGE 13s later.
  useEffect(() => {
    if (!frameSrc) return;
    slowTimerRef.current = setTimeout(() => {
      if (dialogRef.current?.open) setStatus(SLOW_MESSAGE);
    }, SLOW_TIMEOUT_MS);
    return () => clearTimeout(slowTimerRef.current);
  }, [frameSrc]);

  function handleClose() {
    const dialog = dialogRef.current;
    if (dialog?.open) return; // Ignore a queued close from a previous opening.
    frameRef.current = null;
    setFrameSrc(null); // Unload the catalog and its background requests.
    const trigger = triggerRef.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    triggerRef.current = null;
  }

  function handleFrameLoad(frame: HTMLIFrameElement) {
    const dialog = dialogRef.current;
    // A load event from an iframe that is no longer the tracked one (a
    // stale dialog opening) must not touch the current dialog's state.
    if (!dialog?.open || frameRef.current !== frame) return;
    clearTimeout(slowTimerRef.current);
    setStatus(LOADED_MESSAGE);
    // Key events inside an iframe do not bubble to the parent dialog.
    try {
      frame.contentDocument?.addEventListener("keydown", (event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          dialog.open &&
          frameRef.current === frame &&
          !frame.contentDocument?.querySelector("dialog[open]")
        ) {
          event.preventDefault();
          dialog.close();
        }
      });
    } catch {
      /* Cross-origin navigation retains the visible close button. */
    }
  }

  return (
    <dialog
      ref={dialogRef}
      id="search-detail-dialog"
      className={styles.dialog}
      aria-labelledby="search-detail-title"
      aria-describedby="search-detail-status"
      onClose={handleClose}
    >
      <header className={styles.head}>
        <h2 id="search-detail-title">論文詳細</h2>
        <a id="search-detail-open" href={directHref}>
          通常ページで開く →
        </a>
        <button
          ref={closeButtonRef}
          id="search-detail-close"
          type="button"
          onClick={() => dialogRef.current?.close()}
        >
          閉じて検索に戻る
        </button>
      </header>
      <p id="search-detail-status" className={styles.status} role="status">
        {status}
      </p>
      <div id="search-detail-body" className={styles.body}>
        {frameSrc && (
          <iframe
            ref={frameRef}
            title="選択した論文の学会カタログ詳細"
            src={frameSrc}
            referrerPolicy="same-origin"
            onLoad={(event) => handleFrameLoad(event.currentTarget)}
          />
        )}
      </div>
    </dialog>
  );
}
