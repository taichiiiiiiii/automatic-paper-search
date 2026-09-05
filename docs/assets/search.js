/* Unified cross-conference search for the PaperPilot landing page.
 *
 * The compact v2 index is validated as one unit before use. Canonical paper
 * IDs live in 256-row blocks and are fetched only for results that will be
 * rendered, keeping the initial index small without falling back to title
 * joins. Every catalog-derived value reaches the DOM through textContent.
 */
(function (root) {
  "use strict";

  const INDEX_URL = "search-index-v2.json";
  const ID_BLOCK_ROOT = "search-paper-ids-v1/";
  const BLOCK_SIZE = 256;
  const PAGE_SIZE = 20;
  const MIN_QUERY = 2;
  const DEBOUNCE_MS = 120;
  const ANNOUNCE_MS = 500;

  const TITLE = 0;
  const CONFERENCE = 1;
  const PAPER_REF = 2;
  const AUTHORS = 3;
  const TAGS = 4;
  const YEAR = 5;
  const PAPER_TYPE = 6;
  const CONFERENCE_RE = /^[a-z0-9][a-z0-9-]*$/;
  const PAPER_ID_RE = /^[0-9a-f]{40}$/;

  const MATCH_LABELS = Object.freeze({
    "exact-title": "タイトル完全一致",
    title: "タイトル一致",
    author: "著者一致",
    tag: "タグ一致",
  });

  function normalizeText(value) {
    return String(value)
      .normalize("NFKC")
      .toLocaleLowerCase("ja")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function validateStringArray(value, field, ordinal) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`row ${ordinal}: ${field} must be a string array`);
    }
  }

  function validateIndex(data) {
    if (!Array.isArray(data)) throw new Error("search index must be an array");
    data.forEach((row, ordinal) => {
      if (!Array.isArray(row) || row.length !== 7) {
        throw new Error(`row ${ordinal}: expected exactly 7 fields`);
      }
      if (typeof row[TITLE] !== "string" || !row[TITLE].trim()) {
        throw new Error(`row ${ordinal}: title is required`);
      }
      if (typeof row[CONFERENCE] !== "string" || !CONFERENCE_RE.test(row[CONFERENCE])) {
        throw new Error(`row ${ordinal}: conference slug is invalid`);
      }
      if (!Number.isSafeInteger(row[PAPER_REF]) || row[PAPER_REF] !== ordinal) {
        throw new Error(`row ${ordinal}: paper_ref must equal its global ordinal`);
      }
      validateStringArray(row[AUTHORS], "authors", ordinal);
      validateStringArray(row[TAGS], "tags", ordinal);
      if (
        row[YEAR] !== null &&
        (!Number.isInteger(row[YEAR]) || row[YEAR] < 1900 || row[YEAR] > 2200)
      ) {
        throw new Error(`row ${ordinal}: year is invalid`);
      }
      if (row[PAPER_TYPE] !== "Oral" && row[PAPER_TYPE] !== "Poster") {
        throw new Error(`row ${ordinal}: paper type is invalid`);
      }
    });
    return data;
  }

  function rankResults(rows, query) {
    const needle = normalizeText(query);
    if (!needle) return [];
    const hits = [];
    rows.forEach((row, ordinal) => {
      const title = normalizeText(row[TITLE]);
      let rank = -1;
      let matchKind = "";
      if (title === needle) {
        rank = 0;
        matchKind = "exact-title";
      } else if (title.includes(needle)) {
        rank = 1;
        matchKind = "title";
      } else if (row[AUTHORS].some((author) => normalizeText(author).includes(needle))) {
        rank = 2;
        matchKind = "author";
      } else if (row[TAGS].some((tag) => normalizeText(tag).includes(needle))) {
        rank = 3;
        matchKind = "tag";
      }
      if (rank >= 0) {
        hits.push({ row, ordinal, rank, matchKind, matchLabel: MATCH_LABELS[matchKind] });
      }
    });
    hits.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const aYear = a.row[YEAR] === null ? -Infinity : a.row[YEAR];
      const bYear = b.row[YEAR] === null ? -Infinity : b.row[YEAR];
      if (aYear !== bYear) return bYear - aYear;
      return a.ordinal - b.ordinal;
    });
    return hits;
  }

  function paginate(hits, requestedPage, pageSize) {
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(hits.length / size));
    const parsed = Number.parseInt(String(requestedPage), 10);
    const page = Math.min(Math.max(Number.isSafeInteger(parsed) ? parsed : 1, 1), totalPages);
    const start = (page - 1) * size;
    return { page, totalPages, items: hits.slice(start, start + size) };
  }

  function blockFile(paperRef) {
    if (!Number.isSafeInteger(paperRef) || paperRef < 0) {
      throw new Error("paper_ref must be a non-negative integer");
    }
    const block = Math.floor(paperRef / BLOCK_SIZE);
    return `${ID_BLOCK_ROOT}${String(block).padStart(4, "0")}.json`;
  }

  function validateIdBlock(data, expectedBlock, totalRows) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("paper ID block must be an object");
    }
    const keys = Object.keys(data).sort();
    const expectedKeys = ["block", "paper_ids", "schema_version", "start"];
    if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) {
      throw new Error("paper ID block has unexpected fields");
    }
    if (data.schema_version !== "search-paper-ids-v1") {
      throw new Error("paper ID block schema_version is invalid");
    }
    if (data.block !== expectedBlock || data.start !== expectedBlock * BLOCK_SIZE) {
      throw new Error("paper ID block address does not match requested block");
    }
    const expectedLength = Math.min(BLOCK_SIZE, totalRows - data.start);
    if (
      !Array.isArray(data.paper_ids) ||
      expectedLength <= 0 ||
      data.paper_ids.length !== expectedLength ||
      !data.paper_ids.every((paperId) => typeof paperId === "string" && PAPER_ID_RE.test(paperId))
    ) {
      throw new Error("paper ID block contents are invalid");
    }
    return data;
  }

  const core = Object.freeze({ validateIndex, rankResults, paginate, blockFile, validateIdBlock });
  root.PaperPilotSearchCore = core;

  if (typeof document === "undefined") return;

  const form = document.querySelector("[data-search]");
  if (!form) return;
  const input = form.querySelector(".site-search__input");
  const list = document.getElementById("s0-search-listbox");
  const status = document.getElementById("s0-search-status");
  const retry = document.getElementById("s0-search-retry");
  const more = document.getElementById("s0-search-more");
  const fullSection = document.getElementById("s0-results");
  const fullHeading = document.getElementById("s0-results-heading");
  const fullSummary = document.getElementById("s0-results-summary");
  const fullList = document.getElementById("s0-results-list");
  const pagination = document.getElementById("s0-results-pagination");
  if (
    !input || !list || !status || !retry || !more || !fullSection ||
    !fullHeading || !fullSummary || !fullList || !pagination
  ) return;

  let index = null;
  let indexPromise = null;
  const blockPromises = new Map();
  let inputTimer = null;
  let announceTimer = null;
  let active = -1;
  let runSerial = 0;

  function setBusy(busy) {
    form.setAttribute("aria-busy", busy ? "true" : "false");
    fullSection.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function say(message) {
    clearTimeout(announceTimer);
    status.textContent = message;
  }

  function announce(message) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { status.textContent = message; }, ANNOUNCE_MS);
  }

  function confLabel(slug) {
    const match = /^(.*)-(\d{4})$/.exec(slug);
    return match ? `${match[1].toUpperCase()} ${match[2]}` : slug.toUpperCase();
  }

  function resultUrl(hit, paperId) {
    return `${encodeURIComponent(hit.row[CONFERENCE])}/?paper=${encodeURIComponent(paperId)}`;
  }

  function searchUrl(query, page) {
    const url = new URL(window.location.href);
    url.searchParams.set("q", query);
    if (page === null) url.searchParams.delete("page");
    else url.searchParams.set("page", String(page));
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function clearSuggestions() {
    list.replaceChildren();
    list.hidden = true;
    more.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function hideFullResults() {
    fullSection.hidden = true;
    fullList.replaceChildren();
    pagination.replaceChildren();
  }

  function showError(error) {
    console.warn("[search] search data failed validation or loading:", error);
    clearSuggestions();
    hideFullResults();
    retry.hidden = false;
    say("検索データを読み込めませんでした。再試行してください。");
  }

  async function ensureIndex() {
    if (index !== null) return index;
    if (indexPromise) return indexPromise;
    say("検索索引を読み込み中…");
    indexPromise = fetch(INDEX_URL, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`search index HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        index = validateIndex(data);
        return index;
      })
      .finally(() => { indexPromise = null; });
    return indexPromise;
  }

  async function ensureIdBlock(block) {
    if (blockPromises.has(block)) return blockPromises.get(block);
    const promise = fetch(blockFile(block * BLOCK_SIZE), { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`paper ID block HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => validateIdBlock(data, block, index.length))
      .catch((error) => {
        blockPromises.delete(block);
        throw error;
      });
    blockPromises.set(block, promise);
    return promise;
  }

  async function resolvePaperIds(hits) {
    const blocks = [...new Set(hits.map((hit) => Math.floor(hit.row[PAPER_REF] / BLOCK_SIZE)))];
    say("論文IDを解決中…");
    await Promise.all(blocks.map((block) => ensureIdBlock(block)));
    return Promise.all(hits.map(async (hit) => {
      const paperRef = hit.row[PAPER_REF];
      const block = Math.floor(paperRef / BLOCK_SIZE);
      const data = await ensureIdBlock(block);
      const paperId = data.paper_ids[paperRef - data.start];
      if (!PAPER_ID_RE.test(paperId || "")) throw new Error("paper ID reference is missing");
      return { ...hit, paperId };
    }));
  }

  function appendResultContent(anchor, hit) {
    const title = document.createElement("span");
    title.className = "site-search__title";
    title.textContent = hit.row[TITLE];

    const meta = document.createElement("span");
    meta.className = "site-search__meta";
    const bits = [confLabel(hit.row[CONFERENCE])];
    if (hit.row[YEAR] !== null) bits.push(String(hit.row[YEAR]));
    bits.push(hit.row[PAPER_TYPE], hit.matchLabel);
    meta.textContent = bits.join(" · ");
    anchor.append(title, meta);

    if (hit.row[AUTHORS].length) {
      const authors = document.createElement("span");
      authors.className = "site-search__authors";
      const visible = hit.row[AUTHORS].slice(0, 3).join(", ");
      authors.textContent = hit.row[AUTHORS].length > 3 ? `${visible} ほか` : visible;
      anchor.append(authors);
    }
  }

  function suggestionNode(hit, ordinal) {
    const item = document.createElement("li");
    item.id = `site-search-opt-${ordinal}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    const anchor = document.createElement("a");
    anchor.tabIndex = -1;
    anchor.setAttribute("href", resultUrl(hit, hit.paperId));
    appendResultContent(anchor, hit);
    item.append(anchor);
    return item;
  }

  function fullResultNode(hit) {
    const item = document.createElement("li");
    item.className = "s0-results__item";
    const anchor = document.createElement("a");
    anchor.className = "s0-results__link";
    anchor.setAttribute("href", resultUrl(hit, hit.paperId));
    appendResultContent(anchor, hit);
    item.append(anchor);
    return item;
  }

  function renderSuggestions(hits, query, total) {
    active = -1;
    list.replaceChildren(...hits.map(suggestionNode));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    more.hidden = false;
    more.href = searchUrl(query, 1);
    more.textContent = `すべての ${total.toLocaleString("ja-JP")} 件を見る`;
    announce(`${total.toLocaleString("ja-JP")} 件中、上位 ${hits.length} 件を表示中。`);
  }

  function pagerLink(label, query, page, rel) {
    const anchor = document.createElement("a");
    anchor.className = "s0-results__pager-link";
    anchor.href = searchUrl(query, page);
    anchor.dataset.searchPage = String(page);
    if (rel) anchor.rel = rel;
    anchor.textContent = label;
    return anchor;
  }

  function renderFullResults(resolved, allHits, query, pageInfo, focusHeading) {
    fullHeading.textContent = `「${query}」の検索結果`;
    const start = (pageInfo.page - 1) * PAGE_SIZE + 1;
    const end = start + resolved.length - 1;
    fullSummary.textContent = `${allHits.length.toLocaleString("ja-JP")} 件中 ${start}〜${end} 件`;
    fullList.replaceChildren(...resolved.map(fullResultNode));

    const children = [];
    if (pageInfo.page > 1) children.push(pagerLink("← 前へ", query, pageInfo.page - 1, "prev"));
    const position = document.createElement("span");
    position.className = "s0-results__page-position";
    position.textContent = `${pageInfo.page} / ${pageInfo.totalPages} ページ`;
    children.push(position);
    if (pageInfo.page < pageInfo.totalPages) {
      children.push(pagerLink("次へ →", query, pageInfo.page + 1, "next"));
    }
    pagination.replaceChildren(...children);
    fullSection.hidden = false;
    announce(`${allHits.length.toLocaleString("ja-JP")} 件、${pageInfo.page} ページ目を表示中。`);
    if (focusHeading) fullHeading.focus({ preventScroll: false });
  }

  async function runQuery(query, requestedPage, options) {
    const serial = ++runSerial;
    const normalized = normalizeText(query);
    retry.hidden = true;
    if (Array.from(normalized).length < MIN_QUERY) {
      setBusy(false);
      clearSuggestions();
      hideFullResults();
      say(normalized ? `${MIN_QUERY} 文字以上で検索します。` : "");
      return;
    }

    setBusy(true);
    try {
      const rows = await ensureIndex();
      if (serial !== runSerial) return;
      const allHits = rankResults(rows, normalized);
      if (!allHits.length) {
        clearSuggestions();
        hideFullResults();
        announce(`「${query}」に一致する論文は見つかりませんでした。`);
        return;
      }

      if (requestedPage !== null) {
        clearSuggestions();
        const pageInfo = paginate(allHits, requestedPage, PAGE_SIZE);
        if (pageInfo.page !== requestedPage) {
          window.history.replaceState(null, "", searchUrl(query, pageInfo.page));
        }
        const resolved = await resolvePaperIds(pageInfo.items);
        if (serial !== runSerial) return;
        renderFullResults(resolved, allHits, query, pageInfo, Boolean(options && options.focus));
      } else {
        hideFullResults();
        const resolved = await resolvePaperIds(allHits.slice(0, PAGE_SIZE));
        if (serial !== runSerial) return;
        renderSuggestions(resolved, query, allHits.length);
      }
    } catch (error) {
      if (serial === runSerial) showError(error);
    } finally {
      if (serial === runSerial) setBusy(false);
    }
  }

  function pageFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("page")) return null;
    const raw = params.get("page");
    if (!/^\d+$/.test(raw || "")) return 1;
    const page = Number(raw);
    return Number.isSafeInteger(page) && page > 0 ? page : 1;
  }

  function restoreFromUrl(options) {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("q") || "";
    input.value = query;
    return runQuery(query, pageFromUrl(), options);
  }

  function updateQueryUrl(query) {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    url.searchParams.delete("page");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function move(delta) {
    const items = [...list.querySelectorAll('[role="option"]')];
    if (!items.length) return;
    active = (active + delta + items.length) % items.length;
    items.forEach((item, ordinal) => {
      item.setAttribute("aria-selected", ordinal === active ? "true" : "false");
    });
    input.setAttribute("aria-activedescendant", items[active].id);
    items[active].scrollIntoView({ block: "nearest" });
  }

  function activeHref() {
    const anchors = [...list.querySelectorAll('[role="option"] a')];
    if (!anchors.length) return null;
    return (active >= 0 ? anchors[active] : anchors[0]).href;
  }

  function shouldHandleLink(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  input.addEventListener("input", () => {
    clearTimeout(inputTimer);
    const query = input.value.trim();
    updateQueryUrl(query);
    inputTimer = setTimeout(() => { runQuery(query, null); }, DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    else if (event.key === "Escape") { clearSuggestions(); say(""); }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const href = activeHref();
    if (href) window.location.href = href;
  });

  more.addEventListener("click", (event) => {
    if (!shouldHandleLink(event)) return;
    event.preventDefault();
    const query = input.value.trim();
    window.history.pushState(null, "", searchUrl(query, 1));
    runQuery(query, 1, { focus: true });
  });

  pagination.addEventListener("click", (event) => {
    const anchor = event.target.closest("a[data-search-page]");
    if (!anchor || !shouldHandleLink(event)) return;
    event.preventDefault();
    const page = Number(anchor.dataset.searchPage);
    const query = input.value.trim();
    window.history.pushState(null, "", searchUrl(query, page));
    runQuery(query, page, { focus: true });
  });

  retry.addEventListener("click", () => {
    index = null;
    indexPromise = null;
    blockPromises.clear();
    restoreFromUrl();
  });

  input.addEventListener("blur", (event) => {
    if (!form.contains(event.relatedTarget)) clearSuggestions();
  });

  document.addEventListener("click", (event) => {
    if (!form.contains(event.target)) clearSuggestions();
  });

  window.addEventListener("popstate", () => {
    clearTimeout(inputTimer);
    restoreFromUrl();
  });

  restoreFromUrl();
})(typeof globalThis === "undefined" ? this : globalThis);
