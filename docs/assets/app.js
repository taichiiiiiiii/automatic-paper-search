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

function renderPaper(p, idx) {
  const typeClass = p.type === "Oral" ? "paper__type--oral" : "paper__type--poster";
  const tagsHtml = p.tags.map((t) =>
    `<button class="paper__tag" data-tag="${escapeHtml(t)}" type="button">${escapeHtml(t)}</button>`
  ).join("");
  const authorPreview = p.authors.slice(0, 4).join(", ") + (p.authors.length > 4 ? `, +${p.authors.length - 4}` : "");
  const linksHtml = [
    p.arxiv_url ? `<a href="${escapeHtml(p.arxiv_url)}" target="_blank" rel="noopener">arXiv</a>` : "",
    p.pdf_url ? `<a href="${escapeHtml(p.pdf_url)}" target="_blank" rel="noopener">PDF</a>` : "",
  ].filter(Boolean).join("");
  const hasAbstract = p.abstract && p.abstract.length > 0;
  const relationsHtml = renderRelationsSection(p);

  return `
    <li class="paper" data-idx="${idx}">
      <span class="paper__type ${typeClass}">${escapeHtml(p.type)}</span>
      <div class="paper__body">
        <h2 class="paper__title">
          <a href="${escapeHtml(p.arxiv_url || p.pdf_url || '#')}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
        </h2>
        <p class="paper__authors">${escapeHtml(authorPreview || "—")}</p>
        ${tagsHtml ? `<div class="paper__tags">${tagsHtml}</div>` : ""}
        <div class="paper__meta">${linksHtml}${hasAbstract ? '<button class="paper__expand-btn" type="button">Abstract</button>' : ""}</div>
        ${hasAbstract ? `<div class="paper__abstract">${escapeHtml(p.abstract)}</div>` : ""}
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

// Any change to the result SET (filter / search / sort) restarts the
// progressive reveal from the top; growing the window does not.
function resetAndRender() {
  state.visibleCount = PAGE_SIZE;
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
    `<button class="chip" data-tag="${escapeHtml(tag)}" type="button" aria-pressed="false">${escapeHtml(tag)}<span class="chip__count">${n}</span></button>`
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
  els.search.addEventListener("input", (e) => {
    state.search = e.target.value;
    resetAndRender();
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
      const paper = expandBtn.closest(".paper");
      paper.classList.toggle("is-expanded");
      expandBtn.textContent = paper.classList.contains("is-expanded") ? "Hide abstract" : "Abstract";
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
  if (els.statUpdated) els.statUpdated.textContent = new Date().toISOString().slice(0, 10);

  buildTypeChips();
  buildTagChips();
  bindEvents();
  renderList();
}

init();
