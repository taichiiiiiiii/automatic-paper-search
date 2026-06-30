// PaperPilot catalog viewer. Requires utils.js loaded first.
const PAPERS_URL = "papers.json";

// Progressive reveal: render the first PAGE_SIZE rows, then grow by
// PAGE_SIZE per "show more" click. A 218-row catalog rendered in one
// shot is a ~40,000px scroll wall — capping the initial paint keeps the
// page fast to scan and cheap to lay out. Reset to PAGE_SIZE whenever
// the result set changes (filter / search / sort).
const PAGE_SIZE = 30;

const state = {
  papers: [],
  search: "",
  type: "all",
  activeTags: new Set(),
  sort: "default",
  visibleCount: PAGE_SIZE,
  lineage: null,
  relationsByPaperId: new Map(),
};

const { escapeHtml, loadLineage } = window.PP;

const els = {
  list: document.getElementById("paper-list"),
  search: document.getElementById("search"),
  typeChips: document.getElementById("type-chips"),
  tagChips: document.getElementById("tag-chips"),
  resultsMeta: document.getElementById("results-meta"),
  resultsClear: document.getElementById("results-clear"),
  sort: document.getElementById("sort"),
  statTotal: document.getElementById("stat-total"),
  statOral: document.getElementById("stat-oral"),
  statTags: document.getElementById("stat-tags"),
  statUpdated: document.getElementById("stat-updated"),
};

const REL_LABEL = {
  supersedes: { icon: "🔄", label: "Supersedes", direction: "down" },
  successor:  { icon: "🟡", label: "Successor", direction: "down" },
  extends:    { icon: "🌱", label: "Extended by", direction: "down" },
  ablation:   { icon: "🔬", label: "Ablation by", direction: "down" },
  baseline_only: { icon: "📏", label: "Used as baseline by", direction: "down" },
  contrasts:  { icon: "⚔️", label: "Contrasts with", direction: "down" },
};
const REL_LABEL_REVERSE = {
  supersedes: { icon: "⬆️", label: "Supersedes", direction: "up" },
  successor:  { icon: "⬆️", label: "Continues from", direction: "up" },
  extends:    { icon: "⬆️", label: "Extends", direction: "up" },
  ablation:   { icon: "🔬", label: "Ablates", direction: "up" },
  baseline_only: { icon: "📏", label: "Uses as baseline", direction: "up" },
  contrasts:  { icon: "⚔️", label: "Contrasted with", direction: "up" },
};

function buildRelationsIndex() {
  if (!state.lineage) return;
  const { nodes, edges } = state.lineage;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    state.relationsByPaperId.set(node.id, { incoming: [], outgoing: [] });
  }
  for (const e of edges) {
    const srcEntry = state.relationsByPaperId.get(e.src);
    const dstEntry = state.relationsByPaperId.get(e.dst);
    if (srcEntry) srcEntry.outgoing.push({ ...e, other: nodeById.get(e.dst) });
    if (dstEntry) dstEntry.incoming.push({ ...e, other: nodeById.get(e.src) });
  }
}

function findLineageId(paper) {
  if (paper.lineage_id) return paper.lineage_id;
  if (!state.lineage) return null;
  const t = paper.title.toLowerCase().trim();
  const node = state.lineage.nodes.find((n) => t === n.title.toLowerCase().trim());
  return node ? node.id : null;
}

function renderRelationsSection(paper) {
  const lineageId = findLineageId(paper);
  if (!lineageId) return "";
  const rel = state.relationsByPaperId.get(lineageId);
  if (!rel || (rel.incoming.length === 0 && rel.outgoing.length === 0)) return "";

  const groups = new Map();
  for (const e of rel.incoming) {
    const meta = REL_LABEL_REVERSE[e.rel] || { icon: "•", label: e.rel };
    const key = `up:${e.rel}`;
    if (!groups.has(key)) groups.set(key, { meta, items: [] });
    groups.get(key).items.push(e);
  }
  for (const e of rel.outgoing) {
    const meta = REL_LABEL[e.rel] || { icon: "•", label: e.rel };
    const key = `down:${e.rel}`;
    if (!groups.has(key)) groups.set(key, { meta, items: [] });
    groups.get(key).items.push(e);
  }

  const groupOrder = ["up:supersedes", "up:successor", "up:extends", "up:ablation",
                      "down:supersedes", "down:successor", "down:extends",
                      "down:ablation", "down:baseline_only",
                      "up:baseline_only", "up:contrasts", "down:contrasts"];
  const orderedKeys = groupOrder.filter((k) => groups.has(k));

  const groupHtml = orderedKeys.map((k) => {
    const { meta, items } = groups.get(k);
    const itemsHtml = items.map((e) => {
      const venue = PP.formatVenue(e.other.venue, e.other.year);
      const why = e.rationale ? `<span class="rel-rationale">→ ${escapeHtml(e.rationale)}</span>` : "";
      return `<li class="rel-item">
        <span class="rel-item__title">${escapeHtml(e.other.title)}</span>
        <span class="rel-item__venue">${escapeHtml(venue)}</span>
        ${why}
      </li>`;
    }).join("");
    return `<div class="rel-group rel-group--${k.split(":")[1]}">
      <div class="rel-group__head">${meta.icon} ${meta.label} <span class="rel-group__count">(${items.length})</span></div>
      <ul class="rel-group__items">${itemsHtml}</ul>
    </div>`;
  }).join("");

  const total = rel.incoming.length + rel.outgoing.length;
  return `
    <div class="paper__relations">
      <button class="paper__relations-toggle" type="button" aria-expanded="false">
        🌳 Relations <span class="paper__relations-count">(${total})</span>
      </button>
      <div class="paper__relations-body">
        ${groupHtml}
        <a class="paper__relations-link" href="lineage.html?focus=${encodeURIComponent(lineageId)}">View full lineage →</a>
      </div>
    </div>`;
}

// --- Relevance scanning ----------------------------------------------------
// With tens of thousands of papers, the reader's real question while
// scrolling is "is this in my field?" — and answering it should NOT require
// opening each paper. Two signals do that work: (1) an always-visible
// abstract dek so every card states its own topic, and (2) when searching,
// the query is highlighted and the dek is re-anchored to the first match so
// the matched context is in view without expanding.

const SNIPPET_LEAD = 70; // chars of context kept before the first match
const CLAMP_MIN = 140; // abstracts shorter than this need no "more" toggle

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Only ever emit http(s) links; anything else (e.g. a javascript: URI that
// slipped into the source data) collapses to "#". papers.json is generated
// from arXiv/OpenAlex, so this is defense-in-depth, not a known vector.
function safeHref(url) {
  return url && /^https?:\/\//i.test(url) ? url : "#";
}

// Wrap every case-insensitive occurrence of `escQuery` inside the
// already-HTML-escaped `escText` with <mark>. Matching on escaped text on
// both sides keeps it consistent (e.g. "&" -> "&amp;" on each side) and the
// markup safe — the only tags ever injected are our own <mark>.
function highlightTerms(escText, escQuery) {
  if (!escQuery) return escText;
  return escText.replace(new RegExp(escapeRegExp(escQuery), "gi"), (m) => `<mark class="hl">${m}</mark>`);
}

// Build the abstract dek. When the query hits the abstract, slice a window
// that begins a little before the first match (snapped to a word boundary)
// so the highlighted term lands inside the 2-line clamp; otherwise show from
// the top. `rawQuery` is the already-lowercased/trimmed search string.
function buildAbstractView(abstract, rawQuery) {
  const escQuery = rawQuery ? escapeHtml(rawQuery) : "";
  if (rawQuery) {
    const i = abstract.toLowerCase().indexOf(rawQuery);
    if (i > SNIPPET_LEAD) {
      let start = i - SNIPPET_LEAD;
      const sp = abstract.lastIndexOf(" ", start);
      if (sp > 0) start = sp + 1;
      const sliced = abstract.slice(start);
      const lead = '<span aria-hidden="true">… </span>';
      return { html: lead + highlightTerms(escapeHtml(sliced), escQuery), len: sliced.length };
    }
  }
  return { html: highlightTerms(escapeHtml(abstract), escQuery), len: abstract.length };
}

function renderPaper(p, idx) {
  const typeClass = p.type === "Oral" ? "paper__type--oral" : "paper__type--poster";
  const q = state.search.toLowerCase().trim();
  const escQuery = q ? escapeHtml(q) : "";

  const tagsHtml = p.tags.map((t) => {
    const active = state.activeTags.has(t) ? " is-active" : "";
    return `<button class="paper__tag${active}" data-tag="${escapeHtml(t)}" type="button">${escapeHtml(t)}</button>`;
  }).join("");
  const authorPreview = p.authors.slice(0, 4).join(", ") + (p.authors.length > 4 ? `, +${p.authors.length - 4}` : "");
  const titleHtml = highlightTerms(escapeHtml(p.title), escQuery);
  const linksHtml = [
    p.arxiv_url ? `<a href="${escapeHtml(safeHref(p.arxiv_url))}" target="_blank" rel="noopener">arXiv</a>` : "",
    p.pdf_url ? `<a href="${escapeHtml(safeHref(p.pdf_url))}" target="_blank" rel="noopener">PDF</a>` : "",
  ].filter(Boolean).join("");

  const hasAbstract = p.abstract && p.abstract.length > 0;
  let abstractHtml = "";
  let expandBtn = "";
  if (hasAbstract) {
    const view = buildAbstractView(p.abstract, q);
    const needsToggle = view.len > CLAMP_MIN;
    abstractHtml = `<p class="paper__abstract${needsToggle ? " is-clamped" : ""}" id="abstract-${idx}">${view.html}</p>`;
    if (needsToggle) {
      expandBtn = `<button class="paper__expand-btn" type="button" aria-expanded="false" aria-controls="abstract-${idx}">続きを読む</button>`;
    }
  }
  // No separate "matched in body" badge: the dek is windowed to the first
  // match, so the highlighted term is always already on screen — that IS the
  // relevance signal, and a per-card badge would be noise on body-wide queries.
  const relationsHtml = renderRelationsSection(p);

  return `
    <li class="paper" data-idx="${idx}">
      <span class="paper__type ${typeClass}">${escapeHtml(p.type)}</span>
      <div class="paper__body">
        <h2 class="paper__title">
          <a href="${escapeHtml(safeHref(p.arxiv_url || p.pdf_url))}" target="_blank" rel="noopener">${titleHtml}</a>
        </h2>
        <p class="paper__authors">${escapeHtml(authorPreview || "—")}</p>
        ${abstractHtml}
        ${expandBtn}
        ${tagsHtml ? `<div class="paper__tags">${tagsHtml}</div>` : ""}
        ${linksHtml ? `<div class="paper__meta">${linksHtml}</div>` : ""}
        ${relationsHtml}
      </div>
    </li>`;
}

function getFiltered() {
  const q = state.search.toLowerCase().trim();
  return state.papers.filter((p) => {
    if (state.type !== "all" && p.type !== state.type) return false;
    if (state.activeTags.size > 0 && !p.tags.some((t) => state.activeTags.has(t))) return false;
    if (q) {
      const hay = (p.title + " " + p.authors.join(" ") + " " + p.abstract).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Sort the filtered set. citation_count / venue_tier / github_stars are
// ~0 for fresh-from-arXiv ICLR papers, so sorting on them would be
// misleading; the meaningful axes are recency (arXiv id), Oral-first, and
// title. Array.sort is stable, so "oral" preserves the collection order
// within each group.
function getSorted(list) {
  const arr = [...list];
  switch (state.sort) {
    case "newest":
      return arr.sort((a, b) =>
        (b.arxiv_id || "").localeCompare(a.arxiv_id || "", undefined, { numeric: true }));
    case "oral":
      return arr.sort((a, b) => (a.type === "Oral" ? 0 : 1) - (b.type === "Oral" ? 0 : 1));
    case "title":
      return arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    default:
      return arr;
  }
}

function hasActiveFilters() {
  return state.search.trim() !== "" || state.type !== "all" || state.activeTags.size > 0;
}

function updateClearButton() {
  if (els.resultsClear) els.resultsClear.hidden = !hasActiveFilters();
}

// The "show more" sentinel — a non-paper <li> at the tail of the list.
// Shared by the full render and the incremental append so the markup
// stays in one place.
function moreSentinelHtml(remaining) {
  return `<li class="list-more">
      <button class="list-more__btn" type="button" id="list-more-btn">
        さらに表示 <span class="list-more__count">残り ${remaining} 件</span>
      </button>
    </li>`;
}

function setResultsMeta(shown, filteredLen, total) {
  els.resultsMeta.textContent =
    shown < filteredLen
      ? `${shown} / ${filteredLen} 件を表示${filteredLen < total ? `（全 ${total} 件）` : ""}`
      : `${filteredLen} / ${total} 件`;
}

function renderList() {
  const sorted = getSorted(getFiltered());
  const total = state.papers.length;
  updateClearButton();

  if (sorted.length === 0) {
    els.resultsMeta.textContent = `0 / ${total} 件`;
    els.list.innerHTML = `<li class="empty-state">条件に一致する論文がありません。${hasActiveFilters() ? ' <button class="empty-state__clear" type="button" id="empty-clear">フィルタを解除</button>' : ""}</li>`;
    return;
  }

  const shown = Math.min(state.visibleCount, sorted.length);
  setResultsMeta(shown, sorted.length, total);

  // slice from 0, so the map index IS the absolute index into `sorted`.
  let html = sorted.slice(0, shown).map((p, i) => renderPaper(p, i)).join("");
  if (shown < sorted.length) html += moreSentinelHtml(sorted.length - shown);
  els.list.innerHTML = html;
}

// URL state: filters / search / sort live in the query string so a
// filtered view is shareable, survives reload, and the back button
// restores it. Read once at init; written via replaceState on every
// mutation (NOT pushState — filter twiddles must not pile up in history).
// Params are omitted when they equal defaults so the common URL stays clean:
//   q=<search>   type=Oral|Poster   tags=a,b,c   sort=newest|oral|title
let _urlSyncSuppressed = false;
const _SORTS = ["default", "newest", "oral", "title"];

function readUrlState() {
  _urlSyncSuppressed = true;
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (typeof q === "string") state.search = q;
    const type = params.get("type");
    if (type === "Oral" || type === "Poster" || type === "all") state.type = type;
    const sort = params.get("sort");
    if (sort && _SORTS.includes(sort)) state.sort = sort;
    const tags = params.get("tags");
    if (tags) state.activeTags = new Set(tags.split(",").map((t) => t.trim()).filter(Boolean));
  } catch (e) {
    console.warn("[url-state] read failed:", e);
  } finally {
    _urlSyncSuppressed = false;
  }
}

function syncUrlState() {
  if (_urlSyncSuppressed) return;
  try {
    const url = new URL(window.location.href);
    const p = url.searchParams;
    const q = state.search.trim();
    if (q) p.set("q", q); else p.delete("q");
    if (state.type !== "all") p.set("type", state.type); else p.delete("type");
    if (state.activeTags.size > 0) p.set("tags", [...state.activeTags].join(",")); else p.delete("tags");
    if (state.sort !== "default") p.set("sort", state.sort); else p.delete("sort");
    history.replaceState(null, "", url.toString());
  } catch (e) {
    console.warn("[url-state] sync failed:", e);
  }
}

// Any change to the result SET (filter / search / sort) restarts the
// progressive reveal from the top; growing the window does not. The URL is
// rewritten here so every mutation path stays in sync in one place.
function resetAndRender() {
  state.visibleCount = PAGE_SIZE;
  syncUrlState();
  renderList();
}

function clearAllFilters() {
  state.search = "";
  state.type = "all";
  state.activeTags.clear();
  if (els.search) els.search.value = "";
  [...els.typeChips.querySelectorAll(".chip")].forEach((c) =>
    c.setAttribute("aria-pressed", String(c.dataset.type === "all")));
  [...els.tagChips.querySelectorAll(".chip")].forEach((c) =>
    c.setAttribute("aria-pressed", "false"));
  resetAndRender();
}

function buildTagChips() {
  const counts = new Map();
  for (const p of state.papers) {
    for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  els.tagChips.innerHTML = sorted.map(([tag, n]) =>
    `<button class="chip" data-tag="${escapeHtml(tag)}" type="button" aria-pressed="${state.activeTags.has(tag)}">${escapeHtml(tag)}<span class="chip__count">${n}</span></button>`
  ).join("");
}

function buildTypeChips() {
  const counts = new Map([["all", state.papers.length]]);
  for (const p of state.papers) counts.set(p.type, (counts.get(p.type) || 0) + 1);
  const labels = [["all", "All"], ["Oral", "Oral"], ["Poster", "Poster"]];
  els.typeChips.innerHTML = labels
    .filter(([k]) => counts.has(k) || k === "all")
    .map(([k, label]) => {
      const isActive = state.type === k;
      return `<button class="chip" data-type="${k}" type="button" aria-pressed="${isActive}">${label}<span class="chip__count">${counts.get(k) || 0}</span></button>`;
    })
    .join("");
}

function bindEvents() {
  // Debounce the search: a full filter + innerHTML re-render on every
  // keystroke janks on the larger catalogs (ICLR ~1,700, CVPR 4,068 papers)
  // and punishes fast typists. 180ms keeps it responsive without re-rendering
  // mid-word.
  let searchDebounce;
  els.search.addEventListener("input", (e) => {
    state.search = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(resetAndRender, 180);
  });

  if (els.sort) {
    els.sort.addEventListener("change", (e) => {
      state.sort = e.target.value;
      resetAndRender();
    });
  }

  if (els.resultsClear) {
    els.resultsClear.addEventListener("click", clearAllFilters);
  }

  els.typeChips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-type]");
    if (!btn) return;
    state.type = btn.dataset.type;
    [...els.typeChips.querySelectorAll(".chip")].forEach((c) =>
      c.setAttribute("aria-pressed", c.dataset.type === state.type)
    );
    resetAndRender();
  });

  els.tagChips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tag]");
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (state.activeTags.has(tag)) state.activeTags.delete(tag);
    else state.activeTags.add(tag);
    btn.setAttribute("aria-pressed", state.activeTags.has(tag));
    resetAndRender();
  });

  els.list.addEventListener("click", (e) => {
    // Grow the progressive-reveal window by APPENDING only the newly
    // revealed rows. Re-rendering the whole list would discard the state
    // of rows already on screen (open abstracts / relations) and drop
    // keyboard focus to <body>; appending preserves both and keeps the
    // viewport steady.
    if (e.target.closest("#list-more-btn")) {
      const sorted = getSorted(getFiltered());
      const prevShown = Math.min(state.visibleCount, sorted.length);
      state.visibleCount += PAGE_SIZE;
      const shown = Math.min(state.visibleCount, sorted.length);

      const sentinel = els.list.querySelector(".list-more");
      if (sentinel) sentinel.remove();

      const rows = document.createElement("template");
      rows.innerHTML = sorted
        .slice(prevShown, shown)
        .map((p, i) => renderPaper(p, prevShown + i))
        .join("");
      els.list.append(rows.content);

      if (shown < sorted.length) {
        const more = document.createElement("template");
        more.innerHTML = moreSentinelHtml(sorted.length - shown);
        els.list.append(more.content);
        // Keep focus on the (new) button so repeated keyboard activation works.
        els.list.querySelector("#list-more-btn")?.focus({ preventScroll: true });
      } else {
        // Fully expanded: land focus on the first newly revealed paper.
        els.list.querySelectorAll(".paper")[prevShown]
          ?.querySelector(".paper__title a")
          ?.focus({ preventScroll: true });
      }
      setResultsMeta(shown, sorted.length, state.papers.length);
      return;
    }
    if (e.target.closest("#empty-clear")) {
      clearAllFilters();
      return;
    }
    const tagBtn = e.target.closest(".paper__tag");
    if (tagBtn) {
      const tag = tagBtn.dataset.tag;
      state.activeTags.add(tag);
      const chip = els.tagChips.querySelector(`.chip[data-tag="${CSS.escape(tag)}"]`);
      if (chip) chip.setAttribute("aria-pressed", "true");
      resetAndRender();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const expandBtn = e.target.closest(".paper__expand-btn");
    if (expandBtn) {
      const abs = expandBtn.closest(".paper").querySelector(".paper__abstract");
      if (abs) {
        const open = abs.classList.toggle("is-open");
        abs.classList.toggle("is-clamped", !open);
        expandBtn.setAttribute("aria-expanded", String(open));
        expandBtn.textContent = open ? "閉じる" : "続きを読む";
      }
      return;
    }
    const relToggle = e.target.closest(".paper__relations-toggle");
    if (relToggle) {
      const open = relToggle.getAttribute("aria-expanded") === "true";
      relToggle.setAttribute("aria-expanded", String(!open));
      const body = relToggle.nextElementSibling;
      if (body) body.classList.toggle("is-open", !open);
    }
  });
}

// Set the "last updated" stat to the conference's real data date, read from
// the shared conferences.json (build_pages stamps `generated` = the newest
// papers_*.csv date). Slug is derived from the URL path. Best-effort: on any
// failure the "—" placeholder stays, which is more honest than a wrong date.
async function setLastUpdated() {
  if (!els.statUpdated) return;
  try {
    const slug = window.location.pathname.split("/").filter(Boolean).pop() || "";
    const res = await fetch("../conferences.json");
    if (!res.ok) return;
    const confs = await res.json();
    const entry = Array.isArray(confs) ? confs.find((c) => c.name === slug) : null;
    if (entry && entry.generated) els.statUpdated.textContent = entry.generated;
  } catch (_) {
    /* leave the placeholder */
  }
}

async function init() {
  try {
    const [papersRes, lineage] = await Promise.all([
      // Default cache — papers.json is regenerated by the weekly collect
      // job, so _headers Cache-Control (max-age=300 + SWR=3600) is the
      // right policy. Stale within 5 min is fine; deploys evict edge.
      fetch(PAPERS_URL),
      loadLineage(),
    ]);
    state.papers = await papersRes.json();
    if (lineage) {
      state.lineage = lineage;
      buildRelationsIndex();
    }
  } catch (e) {
    els.list.innerHTML = `<li class="empty-state">Failed to load papers.json</li>`;
    return;
  }

  const allTags = new Set();
  let oralCount = 0;
  for (const p of state.papers) {
    p.tags.forEach((t) => allTags.add(t));
    if (p.type === "Oral") oralCount++;
  }
  if (els.statTotal) els.statTotal.textContent = state.papers.length.toLocaleString();
  if (els.statOral) els.statOral.textContent = oralCount.toLocaleString();
  if (els.statTags) els.statTags.textContent = allTags.size.toLocaleString();
  // "Last updated" = the real data collection date (from conferences.json),
  // not the page-load date. Best-effort: leave the "—" placeholder if the
  // index can't be read, since a wrong date is worse than none.
  setLastUpdated();

  // Hydrate filter state from the URL, then reflect it into the static
  // controls (the chips read state during their build below).
  readUrlState();
  if (els.search) els.search.value = state.search;
  if (els.sort) els.sort.value = state.sort;
  buildTypeChips();
  buildTagChips();
  bindEvents();
  setupBackToTop();
  renderList();
}

// A back-to-top button for the long catalogs: after progressive reveal the
// sticky filter bar scrolls off, leaving no quick way back to search/filters.
// Injected here so it works on all 10 catalog pages without editing each HTML.
function setupBackToTop() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "back-to-top";
  btn.id = "back-to-top";
  btn.setAttribute("aria-label", "ページ上部（検索・絞り込み）へ戻る");
  btn.hidden = true;
  btn.innerHTML = '<span aria-hidden="true">↑</span> Top';
  document.body.appendChild(btn);
  const SHOW_AFTER = 600;
  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        btn.hidden = window.scrollY < SHOW_AFTER;
        ticking = false;
      });
    },
    { passive: true },
  );
  btn.addEventListener("click", () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    if (els.search) els.search.focus();
  });
}

init();
