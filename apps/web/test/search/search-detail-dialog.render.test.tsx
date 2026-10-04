// @vitest-environment jsdom
/**
 * Component-level contract test for SearchDetailDialog (M6, search
 * half, SCR-08's "stale load cannot change new dialog" case): renders
 * the real component and drives it with native DOM events, since
 * `handleFrameLoad`'s staleness guard
 * (`!dialog?.open || frameRef.current !== frame`) lives entirely inside
 * the component's closures and isn't reachable from lib/search-detail.ts's
 * pure `detailFrameUrl` tests.
 *
 * jsdom (as of the jsdom@30.1.2 pinned here) does not implement
 * `<dialog>`'s `showModal`/`close`/`open` at all, so this file installs
 * a minimal same-semantics polyfill on `HTMLDialogElement.prototype`
 * for the duration of these tests only -- it never touches production
 * code, and `dialog.close()` dispatches a synchronous `close` event
 * exactly like a real browser, so `onClose={handleClose}` fires the
 * same way it would in Chrome/Firefox.
 *
 * The first scenario below was confirmed to go red by deleting the
 * `!dialog?.open ||` clause from `handleFrameLoad`'s guard (reverted
 * after confirming) -- see the comment above that assertion. The
 * guard's other clause (`frameRef.current !== frame`) was checked too,
 * by deleting the whole `if (...) return;` line: with it gone, the
 * *second* test below still passed, because React fully unmounts a
 * closed opening's `<iframe>` (detaching its listeners) before the
 * next one mounts, so a `load` event fired on the old, by-then-detached
 * node never reaches `handleFrameLoad` at all, guard or no guard -- the
 * frameRef half of the guard is defensive against the original vanilla
 * `search-detail.js`'s reused-iframe-element design, not reachable
 * through this port's actual (fresh node per opening) mount lifecycle.
 * The second test below is kept for its own, still-real value (status
 * resets to "loading" on a genuine close+reopen) but its assertions do
 * not and cannot pin that second clause; only the first test does.
 *
 * Local Node 20 runs cannot load jsdom at all (see
 * search-area.render.test.tsx's header comment for why); this file
 * needs the same Node >= 22 workaround to execute locally.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SearchDetailDialog } from "../../components/search/search-detail-dialog";

const LOADING_MESSAGE =
  "論文詳細を読み込んでいます。表示されない場合は「通常ページで開く」を選んでください。";
const LOADED_MESSAGE = "閉じると検索結果の元の位置に戻ります。";

beforeAll(() => {
  // jsdom has no <dialog> behaviour at all: showModal/close are missing
  // and `.open` is just a plain (non-reflecting) property. This gives
  // the component exactly the semantics it relies on (open flips
  // synchronously, close() fires a synchronous native 'close' event)
  // without touching apps/web production code.
  const proto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      // Sync the reflected attribute too: jsdom (like real browsers)
      // applies a default `dialog:not([open]) { display: none }` UA
      // style, so Testing Library's accessibility-tree-based queries
      // (getByRole) only see the dialog's contents once the attribute
      // -- not just the JS property -- is present.
      this.setAttribute("open", "");
      Object.defineProperty(this, "open", { value: true, configurable: true });
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function close(this: HTMLDialogElement) {
      if (!this.open) return;
      this.removeAttribute("open");
      Object.defineProperty(this, "open", { value: false, configurable: true });
      this.dispatchEvent(new Event("close"));
    };
  }
});

afterEach(() => {
  cleanup();
  document.querySelectorAll("a.s0-results__link").forEach((node) => {
    node.remove();
  });
});

function appendResultLink(paperId: string, confSlug: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.className = "s0-results__link";
  anchor.href = `${confSlug}/?paper=${paperId}`;
  document.body.appendChild(anchor);
  return anchor;
}

describe("SearchDetailDialog: stale load guard (SCR-08)", () => {
  // Mutation checked: removing `!dialog?.open ||` from
  // `handleFrameLoad`'s guard (leaving only the frameRef check) makes
  // this test fail -- the late `load` event then overwrites
  // LOADING_MESSAGE with LOADED_MESSAGE even though the dialog this
  // opening belonged to is no longer the current one.
  it("ignores a load event for an opening the dialog no longer considers current", () => {
    render(<SearchDetailDialog />);
    const anchor = appendResultLink("a".repeat(40), "cvpr-2026");

    fireEvent.click(anchor);

    const dialog = document.getElementById("search-detail-dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(LOADING_MESSAGE);
    const iframe = dialog.querySelector("iframe");
    expect(iframe).not.toBeNull();

    // Simulate the dialog opening this iframe belongs to no longer
    // being the current one (e.g. a native close that raced the
    // in-flight navigation) without going through handleClose, so the
    // iframe node itself is untouched and still fires its own events.
    Object.defineProperty(dialog, "open", { value: false, configurable: true });

    fireEvent.load(iframe as HTMLIFrameElement);

    expect(screen.getByRole("status").textContent).toBe(LOADING_MESSAGE);
  });

  it("resets to the loading status on a genuine close + reopen for a different paper", () => {
    render(<SearchDetailDialog />);
    const anchorA = appendResultLink("a".repeat(40), "cvpr-2026");
    fireEvent.click(anchorA);

    const dialog = document.getElementById("search-detail-dialog") as HTMLDialogElement;
    const iframeA = dialog.querySelector("iframe") as HTMLIFrameElement;
    fireEvent.load(iframeA);
    expect(screen.getByRole("status").textContent).toBe(LOADED_MESSAGE);

    // Close normally through the close button (dialog.close() -> a real
    // synchronous 'close' event -> handleClose), then open a different
    // paper. handleClose must not leave LOADED_MESSAGE on screen for an
    // opening that has not loaded yet.
    fireEvent.click(screen.getByRole("button", { name: "閉じて検索に戻る" }));
    const anchorB = appendResultLink("b".repeat(40), "iclr-2026");
    fireEvent.click(anchorB);
    expect(screen.getByRole("status").textContent).toBe(LOADING_MESSAGE);
  });
});

describe("SearchDetailDialog: LOW fixes", () => {
  it("focuses the close button on open, not the first focusable element (通常ページで開く link)", () => {
    render(<SearchDetailDialog />);
    const anchor = appendResultLink("a".repeat(40), "cvpr-2026");
    fireEvent.click(anchor);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "閉じて検索に戻る" }));
  });

  it("clears the slow-load timer once the iframe has loaded, so a late-firing timer does not overwrite the loaded status", async () => {
    vi.useFakeTimers();
    try {
      render(<SearchDetailDialog />);
      const anchor = appendResultLink("a".repeat(40), "cvpr-2026");
      fireEvent.click(anchor);
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;
      fireEvent.load(iframe);
      expect(screen.getByRole("status").textContent).toBe(LOADED_MESSAGE);
      // Past SLOW_TIMEOUT_MS (15s): if the timer weren't cleared on
      // load, this would overwrite LOADED_MESSAGE with the slow-load
      // message even though the paper loaded fine. The state update a
      // real timer callback schedules is not wrapped in React's act()
      // automatically, so advance inside act() to flush it before
      // reading the DOM.
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByRole("status").textContent).toBe(LOADED_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });
});
