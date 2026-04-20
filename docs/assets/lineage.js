// Lineage viewer — pure SVG family tree / timeline. Requires utils.js loaded first.
const { escapeHtml, formatStars, loadFirstLineage, LINEAGE_URLS } = window.PP;
const NODE_W = 220;
const NODE_H = 150;
const LEVEL_GAP = 80;
const SIBLING_GAP = 28;
const PADDING = 40;
const MAX_DEPTH = 2;
const MAX_SIBLINGS = 6;

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

const GENEALOGY = new Set(["supersedes", "successor", "extends", "ablation"]);
const ALL_RELATIONS = ["supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts"];
const RELATION_RANK = {
  supersedes: 0, successor: 1, extends: 2, ablation: 3, contrasts: 4, baseline_only: 5,
};

const state = {
  data: null,
  layout: "tree",
  focusId: null,
  visibleRelations: new Set(["supersedes", "successor", "extends", "ablation", "contrasts"]),
};

const els = {
  svg: document.getElementById("lineage-svg"),
  canvas: document.getElementById("canvas"),
  tooltip: document.getElementById("tooltip"),
  ttRel: document.getElementById("tt-rel"),
  ttRationale: document.getElementById("tt-rationale"),
  ttConf: document.getElementById("tt-conf"),
  filterBar: document.getElementById("relation-filter"),
};

async function init() {
  state.data = await loadFirstLineage(LINEAGE_URLS);
  if (!state.data) {
    els.canvas.innerHTML = `<p class="empty-state">Failed to load lineage data</p>`;
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const requested = params.get("focus");
  const known = new Set(state.data.nodes.map((n) => n.id));
  state.focusId = requested && known.has(requested) ? requested : state.data.root;

  bindLayoutButtons();
  renderFilterChips();
  render();
}

function bindLayoutButtons() {
  for (const btn of document.querySelectorAll(".layout-btn")) {
    btn.addEventListener("click", () => {
      state.layout = btn.dataset.layout;
      for (const b of document.querySelectorAll(".layout-btn")) {
        b.setAttribute("aria-pressed", b === btn ? "true" : "false");
      }
      render();
    });
  }
}

function renderFilterChips() {
  if (!els.filterBar) return;
  const labels = {
    supersedes: "Supersedes", successor: "Successor", extends: "Extends",
    ablation: "Ablation", baseline_only: "Baseline", contrasts: "Contrasts",
  };
  els.filterBar.innerHTML = ALL_RELATIONS.map((r) => {
    const on = state.visibleRelations.has(r);
    return `<button class="chip chip--rel" data-rel="${r}" aria-pressed="${on}">
      <span class="chip__dot chip__dot--${r === "baseline_only" ? "baseline" : r}"></span>
      ${labels[r]}
    </button>`;
  }).join("");
  els.filterBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip[data-rel]");
    if (!btn) return;
    const rel = btn.dataset.rel;
    if (state.visibleRelations.has(rel)) state.visibleRelations.delete(rel);
    else state.visibleRelations.add(rel);
    btn.setAttribute("aria-pressed", state.visibleRelations.has(rel));
    render();
  });
}

function render() {
  const { nodes, edges } = state.data;
  const visibleEdges = edges.filter((e) => state.visibleRelations.has(e.rel));

  const positioned = state.layout === "tree"
    ? layoutTree(nodes, edges, state.focusId)
    : layoutTimeline(nodes);

  drawSvg(positioned, visibleEdges);
}

// ---------------- Tree layout with pruning + grouping ----------------

function layoutTree(nodes, edges, focusId) {
  const parents = new Map();
  const children = new Map();
  for (const n of nodes) { parents.set(n.id, []); children.set(n.id, []); }
  for (const e of edges) {
    if (!GENEALOGY.has(e.rel)) continue;
    parents.get(e.dst)?.push({ id: e.src, rel: e.rel });
    children.get(e.src)?.push({ id: e.dst, rel: e.rel });
  }

  // BFS bounded by MAX_DEPTH in each direction
  const level = new Map();
  const relToFocus = new Map();  // node -> rel type connecting to focus branch
  level.set(focusId, 0);
  relToFocus.set(focusId, "focus");

  const qUp = [focusId];
  while (qUp.length) {
    const id = qUp.shift();
    if (level.get(id) <= -MAX_DEPTH) continue;
    for (const { id: p, rel } of parents.get(id) || []) {
      if (!level.has(p)) {
        level.set(p, level.get(id) - 1);
        relToFocus.set(p, rel);
        qUp.push(p);
      }
    }
  }
  const qDown = [focusId];
  while (qDown.length) {
    const id = qDown.shift();
    if (level.get(id) >= MAX_DEPTH) continue;
    for (const { id: c, rel } of children.get(id) || []) {
      if (!level.has(c)) {
        level.set(c, level.get(id) + 1);
        relToFocus.set(c, rel);
        qDown.push(c);
      }
    }
  }

  // Bucket nodes by level
  const byLevel = new Map();
  for (const n of nodes) {
    if (!level.has(n.id)) continue;
    const lv = level.get(n.id);
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push({ ...n, _rel: relToFocus.get(n.id) });
  }
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);

  // Within each level, sort by (relation rank, year)
  // and cap to MAX_SIBLINGS, dropping lower-priority siblings
  for (const lv of sortedLevels) {
    if (lv === 0) continue;
    const row = byLevel.get(lv);
    row.sort((a, b) => {
      const ra = RELATION_RANK[a._rel] ?? 99;
      const rb = RELATION_RANK[b._rel] ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.year || 0) - (b.year || 0);
    });
    if (row.length > MAX_SIBLINGS) {
      byLevel.set(lv, row.slice(0, MAX_SIBLINGS));
    }
  }

  const positioned = [];
  sortedLevels.forEach((lv, idx) => {
    const row = byLevel.get(lv);
    const rowWidth = row.length * NODE_W + (row.length - 1) * SIBLING_GAP;
    row.forEach((n, i) => {
      const x = -rowWidth / 2 + i * (NODE_W + SIBLING_GAP);
      const y = idx * (NODE_H + LEVEL_GAP);
      positioned.push({ ...n, _x: x, _y: y });
    });
  });

  if (positioned.length === 0) return [];
  const minX = Math.min(...positioned.map((p) => p._x));
  const minY = Math.min(...positioned.map((p) => p._y));
  for (const p of positioned) {
    p._x = p._x - minX + PADDING;
    p._y = p._y - minY + PADDING;
  }
  return positioned;
}

// ---------------- Timeline layout (x = year) ----------------

function layoutTimeline(nodes) {
  const sorted = [...nodes].sort((a, b) => (a.year || 0) - (b.year || 0));
  const years = [...new Set(sorted.map((n) => n.year))].sort((a, b) => a - b);
  const yearToCol = new Map(years.map((y, i) => [y, i]));
  const countsPerYear = new Map(years.map((y) => [y, 0]));

  return sorted.map((n) => {
    const col = yearToCol.get(n.year);
    const row = countsPerYear.get(n.year);
    countsPerYear.set(n.year, row + 1);
    return {
      ...n,
      _x: PADDING + col * (NODE_W + SIBLING_GAP * 2),
      _y: PADDING + row * (NODE_H + 20),
    };
  });
}

// ---------------- SVG rendering ----------------

function drawSvg(positioned, edges) {
  const posById = new Map(positioned.map((p) => [p.id, p]));

  if (positioned.length === 0) {
    els.svg.innerHTML = "";
    els.canvas.insertAdjacentHTML("beforeend", `<p class="empty-state">No data to display.</p>`);
    return;
  }

  const W = Math.max(...positioned.map((p) => p._x + NODE_W)) + PADDING;
  const H = Math.max(...positioned.map((p) => p._y + NODE_H)) + PADDING;

  els.svg.setAttribute("width", W);
  els.svg.setAttribute("height", H);
  els.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  els.svg.innerHTML = "";

  const defs = document.createElementNS(SVG_NS, "defs");
  const markers = [
    ["supersedes", "oklch(55% 0.14 75)", "filled"],
    ["successor",  "oklch(72% 0.13 80)", "filled"],
    ["extends",    "oklch(62% 0.14 145)", "filled"],
    ["ablation",   "oklch(60% 0.13 240)", "hollow"],
    ["baseline",   "oklch(60% 0.02 270)", "dot"],
    ["contrasts",  "oklch(58% 0.20 25)", "cross"],
  ];
  for (const [key, color, kind] of markers) {
    const m = document.createElementNS(SVG_NS, "marker");
    m.setAttribute("id", `arrow-${key}`);
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "9");
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "7");
    m.setAttribute("markerHeight", "7");
    m.setAttribute("orient", "auto-start-reverse");
    let shape;
    if (kind === "filled") {
      shape = document.createElementNS(SVG_NS, "path");
      shape.setAttribute("d", "M0,0 L10,5 L0,10 z");
      shape.setAttribute("fill", color);
    } else if (kind === "hollow") {
      shape = document.createElementNS(SVG_NS, "circle");
      shape.setAttribute("cx", "5"); shape.setAttribute("cy", "5"); shape.setAttribute("r", "3");
      shape.setAttribute("fill", "white"); shape.setAttribute("stroke", color); shape.setAttribute("stroke-width", "1.5");
    } else if (kind === "dot") {
      shape = document.createElementNS(SVG_NS, "circle");
      shape.setAttribute("cx", "5"); shape.setAttribute("cy", "5"); shape.setAttribute("r", "1.8");
      shape.setAttribute("fill", color);
    } else if (kind === "cross") {
      shape = document.createElementNS(SVG_NS, "path");
      shape.setAttribute("d", "M0,0 L10,10 M10,0 L0,10");
      shape.setAttribute("stroke", color); shape.setAttribute("stroke-width", "1.8");
      shape.setAttribute("fill", "none");
    }
    m.appendChild(shape);
    defs.appendChild(m);
  }
  els.svg.appendChild(defs);

  const edgeGroup = document.createElementNS(SVG_NS, "g");
  edgeGroup.setAttribute("id", "edges");
  for (const e of edges) {
    const a = posById.get(e.src);
    const b = posById.get(e.dst);
    if (!a || !b) continue;
    const ax = a._x + NODE_W / 2;
    const ay = a._y + NODE_H;
    const bx = b._x + NODE_W / 2;
    const by = b._y;
    const midY = (ay + by) / 2;
    const d = `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `edge edge--${markerClass(e.rel)}`);
    path.setAttribute("marker-end", `url(#arrow-${markerClass(e.rel)})`);
    if (typeof e.conf === "number") {
      path.style.strokeOpacity = String(0.5 + e.conf * 0.5);
    }
    path.dataset.rel = e.rel;
    path.dataset.rationale = e.rationale || "";
    path.dataset.conf = e.conf ?? "";
    path.addEventListener("mouseenter", onEdgeHover);
    path.addEventListener("mousemove", onEdgeMove);
    path.addEventListener("mouseleave", onEdgeLeave);
    edgeGroup.appendChild(path);
  }
  els.svg.appendChild(edgeGroup);

  const nodeGroup = document.createElementNS(SVG_NS, "g");
  nodeGroup.setAttribute("id", "nodes");
  for (const p of positioned) {
    const fo = document.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("x", p._x);
    fo.setAttribute("y", p._y);
    fo.setAttribute("width", NODE_W);
    fo.setAttribute("height", NODE_H);

    const card = document.createElement("div");
    card.setAttribute("xmlns", XHTML_NS);
    card.className = "node-card";
    if (p.id === state.focusId) card.classList.add("node-card--focus");
    if (p.is_trending) card.classList.add("node-card--trending");
    card.addEventListener("click", () => {
      state.focusId = p.id;
      if (state.layout === "tree") {
        const url = new URL(window.location.href);
        url.searchParams.set("focus", p.id);
        window.history.replaceState({}, "", url);
        render();
      }
    });

    const tier = p.venue_tier === "A+" ? "aplus"
               : p.venue_tier === "A" ? "a"
               : "preprint";
    const venue = `${p.venue || ""} ${p.year || ""}`.trim();
    const authors = (p.authors || []).slice(0, 2).join(", ") + ((p.authors || []).length > 2 ? ` +${p.authors.length - 2}` : "");
    const kinds = (p.kinds || []).map((k) => `<span class="node-card__kind">${escapeHtml(k)}</span>`).join("");
    const starStr = formatStars(p.github_stars);
    const stars = starStr ? `<span class="node-card__stars">⭐${starStr}</span>` : "";
    const trending = p.is_trending ? `<span class="trending-badge">📈 trending</span>` : "";

    card.innerHTML = `
      <div class="node-card__venue">
        <span class="node-card__venue-tier node-card__venue-tier--${tier}">${escapeHtml(venue)}</span>
        ${trending}
      </div>
      <h3 class="node-card__title">${escapeHtml(p.title || "")}</h3>
      <div class="node-card__authors">${escapeHtml(authors)}</div>
      <div class="node-card__tldr">${escapeHtml(p.tldr || "")}</div>
      <div class="node-card__meta">
        ${kinds}
        ${stars}
      </div>
    `;
    fo.appendChild(card);
    nodeGroup.appendChild(fo);
  }
  els.svg.appendChild(nodeGroup);
}

function markerClass(rel) {
  if (rel === "baseline_only") return "baseline";
  return rel;
}


function onEdgeHover(e) {
  const rel = e.currentTarget.dataset.rel;
  const rationale = e.currentTarget.dataset.rationale;
  const conf = e.currentTarget.dataset.conf;
  els.ttRel.textContent = rel.replace("_", " ");
  els.ttRationale.textContent = rationale || "";
  els.ttConf.textContent = conf ? `confidence ${Number(conf).toFixed(2)}` : "";
  els.tooltip.classList.add("is-visible");
  els.tooltip.setAttribute("aria-hidden", "false");
  onEdgeMove(e);
}

function onEdgeMove(e) {
  const pad = 12;
  const tt = els.tooltip;
  // Default: place to bottom-right of cursor
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  // Flip horizontally if it would overflow the viewport
  const ttW = tt.offsetWidth || 280;
  const ttH = tt.offsetHeight || 80;
  if (x + ttW > window.innerWidth - 8) x = e.clientX - ttW - pad;
  if (y + ttH > window.innerHeight - 8) y = e.clientY - ttH - pad;
  tt.style.left = `${Math.max(8, x)}px`;
  tt.style.top = `${Math.max(8, y)}px`;
}

function onEdgeLeave() {
  els.tooltip.classList.remove("is-visible");
  els.tooltip.setAttribute("aria-hidden", "true");
}

init();
