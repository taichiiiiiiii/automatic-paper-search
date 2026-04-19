// PaperPilot viewer — vanilla, no framework. Loads papers.json and renders a filterable list.
const DATA_URL = "papers.json";

const state = {
  papers: [],
  search: "",
  type: "all",       // all | Oral | Poster
  activeTags: new Set(),
};

const els = {
  list: document.getElementById("paper-list"),
  search: document.getElementById("search"),
  typeChips: document.getElementById("type-chips"),
  tagChips: document.getElementById("tag-chips"),
  resultsMeta: document.getElementById("results-meta"),
  statTotal: document.getElementById("stat-total"),
  statOral: document.getElementById("stat-oral"),
  statTags: document.getElementById("stat-tags"),
  statUpdated: document.getElementById("stat-updated"),
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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

  return `
    <li class="paper" data-idx="${idx}">
      <span class="paper__type ${typeClass}">${escapeHtml(p.type)}</span>
      <div class="paper__body">
        <h3 class="paper__title">
          <a href="${escapeHtml(p.arxiv_url || p.pdf_url || '#')}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
        </h3>
        <p class="paper__authors">${escapeHtml(authorPreview || "—")}</p>
        ${tagsHtml ? `<div class="paper__tags">${tagsHtml}</div>` : ""}
        <div class="paper__meta">${linksHtml}${hasAbstract ? '<button class="paper__expand-btn" type="button">Abstract</button>' : ""}</div>
        ${hasAbstract ? `<div class="paper__abstract">${escapeHtml(p.abstract)}</div>` : ""}
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

function renderList() {
  const filtered = getFiltered();
  els.resultsMeta.textContent = `${filtered.length} of ${state.papers.length} papers`;
  if (filtered.length === 0) {
    els.list.innerHTML = `<li class="empty-state">No papers match the current filters.</li>`;
    return;
  }
  els.list.innerHTML = filtered.map((p, i) => renderPaper(p, i)).join("");
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
    renderList();
  });

  els.typeChips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-type]");
    if (!btn) return;
    state.type = btn.dataset.type;
    [...els.typeChips.querySelectorAll(".chip")].forEach((c) =>
      c.setAttribute("aria-pressed", c.dataset.type === state.type)
    );
    renderList();
  });

  els.tagChips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tag]");
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (state.activeTags.has(tag)) state.activeTags.delete(tag);
    else state.activeTags.add(tag);
    btn.setAttribute("aria-pressed", state.activeTags.has(tag));
    renderList();
  });

  els.list.addEventListener("click", (e) => {
    const tagBtn = e.target.closest(".paper__tag");
    if (tagBtn) {
      const tag = tagBtn.dataset.tag;
      state.activeTags.add(tag);
      const chip = els.tagChips.querySelector(`.chip[data-tag="${CSS.escape(tag)}"]`);
      if (chip) chip.setAttribute("aria-pressed", "true");
      renderList();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const expandBtn = e.target.closest(".paper__expand-btn");
    if (expandBtn) {
      const paper = expandBtn.closest(".paper");
      paper.classList.toggle("is-expanded");
      expandBtn.textContent = paper.classList.contains("is-expanded") ? "Hide abstract" : "Abstract";
    }
  });
}

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    state.papers = await res.json();
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
