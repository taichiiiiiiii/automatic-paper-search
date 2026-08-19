/* Cross-conference paper search for the landing page.
 *
 * The catalog ships one papers.json per conference (24 MB in total), so no
 * page could answer "find this paper across all ten venues". This reads the
 * pre-built docs/search-index.json ([title, conference] pairs, ~0.7 MB
 * gzipped) and hands a hit off to the conference catalog via `?q=<title>` —
 * app.js already reads that parameter and filters on it, so there is no new
 * per-paper id and no second rendering path to keep in step.
 *
 * The index is fetched on first interaction, never on load: it is an order
 * of magnitude larger than the rest of the page and nobody who does not
 * search should pay for it.
 */
(function () {
  "use strict";

  const INDEX_URL = "search-index.json";
  const MAX_RESULTS = 20;      // a listbox, not a results page
  const MIN_QUERY = 2;         // 1 char matches ~everything and is never useful
  const DEBOUNCE_MS = 120;

  const TITLE = 0;
  const CONFERENCE = 1;

  const form = document.querySelector("[data-search]");
  if (!form) return;

  const input = form.querySelector(".site-search__input");
  const list = form.querySelector(".site-search__results");
  const status = form.querySelector(".site-search__status");
  const escapeHtml = (window.PP && window.PP.escapeHtml) || ((s) => String(s));

  let index = null;      // null = not loaded, [] = loaded-but-empty
  let loading = null;    // in-flight promise, so racing keystrokes fetch once
  let timer = null;
  let active = -1;       // keyboard cursor into the rendered list

  function say(msg) {
    status.textContent = msg;
  }

  async function ensureIndex() {
    if (index) return index;
    if (loading) return loading;
    say("索引を読み込み中…");
    loading = fetch(INDEX_URL)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        index = data;
        say("");
        return index;
      })
      .catch((err) => {
        // A failed index must say so rather than look like "no matches".
        console.warn("[search] index load failed:", err);
        say("検索索引を読み込めませんでした。学会カタログから探してください。");
        loading = null;
        throw err;
      });
    return loading;
  }

  function search(q) {
    const needle = q.toLowerCase();
    const hits = [];
    for (let i = 0; i < index.length && hits.length < MAX_RESULTS; i++) {
      if (index[i][TITLE].toLowerCase().includes(needle)) hits.push(index[i]);
    }
    return hits;
  }

  // Conference slug -> display label, without shipping a second table:
  // "iclr-2026" -> "ICLR 2026".
  function confLabel(slug) {
    const m = /^(.*)-(\d{4})$/.exec(slug);
    return m ? m[1].toUpperCase() + " " + m[2] : slug.toUpperCase();
  }

  function render(hits, q) {
    active = -1;
    if (!hits.length) {
      list.innerHTML = "";
      list.hidden = true;
      say(`「${q}」に一致する論文は見つかりませんでした。`);
      return;
    }
    // The whole title is passed through ?q= so the catalog's own filter
    // resolves it; encodeURIComponent keeps titles with & or # intact.
    list.innerHTML = hits
      .map(
        (h) =>
          `<li role="option" aria-selected="false">` +
          `<a href="${h[CONFERENCE]}/?q=${encodeURIComponent(h[TITLE])}">` +
          `<span class="site-search__title">${escapeHtml(h[TITLE])}</span>` +
          `<span class="site-search__venue">${escapeHtml(confLabel(h[CONFERENCE]))}</span>` +
          `</a></li>`
      )
      .join("");
    list.hidden = false;
    const capped = hits.length === MAX_RESULTS ? `上位 ${MAX_RESULTS} 件` : `${hits.length} 件`;
    say(`${capped}を表示中。`);
  }

  function close() {
    list.hidden = true;
    list.innerHTML = "";
    active = -1;
  }

  async function run() {
    const q = input.value.trim();
    if (q.length < MIN_QUERY) {
      close();
      say(q.length ? `${MIN_QUERY} 文字以上で検索します。` : "");
      return;
    }
    try {
      await ensureIndex();
    } catch {
      close();
      return; // ensureIndex already reported the failure
    }
    render(search(q), q);
  }

  function move(delta) {
    const items = [...list.querySelectorAll('[role="option"]')];
    if (!items.length) return;
    if (active >= 0) items[active].setAttribute("aria-selected", "false");
    active = (active + delta + items.length) % items.length;
    items[active].setAttribute("aria-selected", "true");
    items[active].querySelector("a").focus();
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  // Warm the index on focus so the first keystroke feels instant, without
  // charging visitors who never reach for search.
  input.addEventListener("focus", () => { ensureIndex().catch(() => {}); }, { once: true });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Escape") { close(); say(""); }
  });

  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Escape") { close(); say(""); input.focus(); }
  });

  // Submitting with no selection goes to the first hit — Enter should not
  // reload the page onto nothing.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const first = list.querySelector('[role="option"] a');
    if (first) window.location.href = first.href;
  });

  document.addEventListener("click", (e) => {
    if (!form.contains(e.target)) close();
  });
})();
