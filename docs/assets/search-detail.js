// Preserve the search page while reusing the canonical catalog detail view.
(() => {
  "use strict";
  const dialog = document.getElementById("search-detail-dialog");
  const close = document.getElementById("search-detail-close");
  const body = document.getElementById("search-detail-body");
  const direct = document.getElementById("search-detail-open");
  const status = document.getElementById("search-detail-status");
  if (!dialog || !close || !body || !direct || !status || typeof dialog.showModal !== "function") return;
  let trigger = null;
  let timer = null;
  let activeFrame = null;
  dialog.addEventListener("close", () => {
    if (dialog.open) return; // Ignore a queued close from a previous opening.
    clearTimeout(timer);
    activeFrame = null;
    body.replaceChildren(); // Unload the catalog and its background requests.
    if (trigger?.isConnected) trigger.focus({preventScroll:true});
    trigger = null;
  });
  close.addEventListener("click", () => dialog.close());
  document.addEventListener("click", event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest("a.s0-results__link");
    if (!anchor || dialog.open) return;
    let url;
    try {
      url = new URL(anchor.href, window.location.href);
      const base = new URL("./", window.location.href);
      const suffix = url.pathname.slice(base.pathname.length);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
          || !/^[a-z0-9][a-z0-9-]*-\d{4}\/$/.test(suffix)
          || url.searchParams.getAll("paper").length !== 1
          || !/^[0-9a-f]{40}$/.test(url.searchParams.get("paper"))
          || [...url.searchParams.keys()].some(key => key !== "paper") || url.hash) return;
    } catch (_) { return; }
    event.preventDefault();
    trigger = anchor;
    direct.href = url.href;
    status.textContent = "論文詳細を読み込んでいます。表示されない場合は「通常ページで開く」を選んでください。";
    const frame = document.createElement("iframe");
    frame.title = "選択した論文の学会カタログ詳細";
    frame.src = url.href;
    frame.setAttribute("referrerpolicy", "same-origin");
    frame.addEventListener("load", () => {
      if (!dialog.open || activeFrame !== frame) return;
      clearTimeout(timer);
      status.textContent = "閉じると検索結果の元の位置に戻ります。";
      // Key events inside an iframe do not bubble to the parent dialog.
      try {
        frame.contentDocument?.addEventListener("keydown", event => {
          if (event.key === "Escape" && !event.defaultPrevented
              && dialog.open && activeFrame === frame
              && !frame.contentDocument?.querySelector("dialog[open]")) {
            event.preventDefault();
            dialog.close();
          }
        });
      } catch (_) { /* Cross-origin navigation retains the visible close button. */ }
    });
    activeFrame = frame;
    body.replaceChildren(frame);
    dialog.showModal();
    close.focus();
    timer = setTimeout(() => {
      if (!dialog.open || activeFrame !== frame) return;
      status.textContent = "読み込みに時間がかかっています。「通常ページで開く」からも確認できます。";
    }, 15000);
  });
})();
