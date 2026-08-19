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
  const ANNOUNCE_MS = 700;     // let typing settle before announcing counts

  const TITLE = 0;
  const CONFERENCE = 1;

  const form = document.querySelector("[data-search]");
  if (!form) return;

  const input = form.querySelector(".site-search__input");
  const list = form.querySelector(".site-search__results");
  const status = form.querySelector(".site-search__status");

  let index = null;      // null = not loaded, [] = loaded-but-empty
  let loading = null;    // in-flight promise, so racing keystrokes fetch once
  let timer = null;
  let active = -1;       // keyboard cursor into the rendered list

  // Two channels into the one live region. Errors and guidance are said
  // at once; result counts wait for the typing to settle. Without that,
  // typing "diffusion" queues a polite announcement per keystroke and a
  // screen reader spends ten seconds reading counts the user has already
  // moved past.
  let announceTimer = null;
  function say(msg) {
    clearTimeout(announceTimer);
    status.textContent = msg;
  }
  function announce(msg) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { status.textContent = msg; }, ANNOUNCE_MS);
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
      list.replaceChildren();
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      announce(`「${q}」に一致する論文は見つかりませんでした。`);
      return;
    }
    // Built as DOM nodes, not an innerHTML string. Titles come from
    // papers.json, which is generated from scraped conference metadata —
    // i.e. text we do not control. Setting them with textContent means
    // there is no escaping step that can be skipped, and no dependency on
    // a helper that could silently degrade to a no-op if it failed to load.
    list.replaceChildren(
      ...hits.map((h, i) => {
        const li = document.createElement("li");
        li.id = `site-search-opt-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");

        const a = document.createElement("a");
        // Options are not separately tabbable: this is an aria-activedescendant
        // combobox, so the input owns the interaction and Tab must leave the
        // whole widget. Leaving these in the tab order made Tab walk into the
        // result list instead, so the list never closed on the way out.
        a.tabIndex = -1;
        // The whole title is passed through ?q= so the catalog's own filter
        // resolves it; encodeURIComponent keeps titles with & or # intact.
        a.setAttribute(
          "href",
          `${encodeURIComponent(h[CONFERENCE])}/?q=${encodeURIComponent(h[TITLE])}`
        );

        const title = document.createElement("span");
        title.className = "site-search__title";
        title.textContent = h[TITLE];

        const venue = document.createElement("span");
        venue.className = "site-search__venue";
        venue.textContent = confLabel(h[CONFERENCE]);

        a.append(title, venue);
        li.append(a);
        return li;
      })
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    const capped = hits.length === MAX_RESULTS ? `上位 ${MAX_RESULTS} 件` : `${hits.length} 件`;
    announce(`${capped}を表示中。`);
  }

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
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

  // Focus stays in the input; the active option is pointed at with
  // aria-activedescendant. Moving DOM focus into the results instead (the
  // first version did) means the next keystroke goes nowhere and the user
  // has to Escape back out just to refine the query.
  function move(delta) {
    const items = [...list.querySelectorAll('[role="option"]')];
    if (!items.length) return;
    active = (active + delta + items.length) % items.length;
    items.forEach((it, i) => it.setAttribute("aria-selected", i === active ? "true" : "false"));
    input.setAttribute("aria-activedescendant", items[active].id);
    items[active].scrollIntoView({ block: "nearest" });
  }

  function activeHref() {
    const items = [...list.querySelectorAll('[role="option"] a')];
    if (!items.length) return null;
    return (active >= 0 ? items[active] : items[0]).href;
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

  // Enter goes to the active option, or the first hit when the user never
  // arrowed down — it must not reload the page onto nothing.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const href = activeHref();
    if (href) window.location.href = href;
  });

  // Tabbing away must close the list, or it stays open over the CTA below.
  input.addEventListener("blur", (e) => {
    if (!form.contains(e.relatedTarget)) close();
  });

  document.addEventListener("click", (e) => {
    if (!form.contains(e.target)) close();
  });
})();
