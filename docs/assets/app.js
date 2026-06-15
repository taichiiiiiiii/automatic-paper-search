// PaperPilot catalog viewer. Requires utils.js loaded first.
const PAPERS_URL = "papers.json";

const state = {
  papers: [],
  search: "",
  type: "all",
  activeTags: new Set(),
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
