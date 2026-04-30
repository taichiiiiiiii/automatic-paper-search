// Deep lineage viewer — single-paper family tree with multi-hop BFS data.
// Loads docs/<conf>/deep.json (produced by build_deep_lineage.py).
//
// Differences vs. lineage.js:
//   - Only tree layout (no topics/timeline)
//   - No MAX_DEPTH cap on render — show everything in the data
//   - Larger node cards with more metadata, height measured at render
//   - No clustering
const { escapeHtml, formatStars, loadLineage } = window.PP;

// arXiv id format with optional version suffix. Enforced so user-supplied
// ?arxiv= values can't be spliced into a fetch URL as path traversal.
const ARXIV_RE = /^\d{4}\.\d{4,5}(v\d+)?$/;

const NODE_W = 240;
// Card content varies (193–277 px observed): venues, multi-line titles,
// 2–3 line TLDRs, multi-author rows. NODE_H is the *layout* slot height
// used by levelizeNodes() to place rows (_y = idx * (NODE_H + LEVEL_GAP)).
// The actual card height is measured after render and used for both the
// foreignObject's `height` attribute (so the visible bounds match the
// card) and edge endpoints (so edges land on the visible card bottom,
// not inside or floating below it). LEVEL_GAP=100 absorbs the spread.
const NODE_H = 180;
const LEVEL_GAP = 100;
const SIBLING_GAP = 32;
const PADDING = 48;

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

const GENEALOGY = new Set(["supersedes", "successor", "extends", "ablation"]);
const ALL_RELATIONS = ["supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts"];
const RELATION_LABEL_JA = {
  supersedes: "置換", successor: "後継", extends: "拡張",
  ablation: "分析", baseline_only: "比較", contrasts: "対立",
};

const STORAGE_KEY = "pp.deep.prefs";
const DEFAULT_RELATIONS = ["supersedes", "successor", "extends", "ablation", "contrasts"];

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      visibleRelations: [...state.visibleRelations],
    }));
  } catch { /* disabled */ }
}

const prefs = loadPrefs();
const state = {
  data: null,
  focusId: null,
  manifest: [],
  currentArxivId: null,
  visibleRelations: new Set(
    Array.isArray(prefs?.visibleRelations) && prefs.visibleRelations.length > 0
      ? prefs.visibleRelations.filter((r) => ALL_RELATIONS.includes(r))
      : DEFAULT_RELATIONS
  ),
};

const els = {
  svg: document.getElementById("lineage-svg"),
  canvas: document.getElementById("canvas"),
  tooltip: document.getElementById("tooltip"),
  ttRel: document.getElementById("tt-rel"),
  ttRationale: document.getElementById("tt-rationale"),
  ttConf: document.getElementById("tt-conf"),
  filterBar: document.getElementById("relation-filter"),
  picker: document.getElementById("paper-picker"),
};

async function loadManifest() {
  try {
    const res = await fetch("deep-manifest.json", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((e) => ARXIV_RE.test(e?.arxiv_id));
  } catch {
    return [];
  }
}

function arxivIdFromLocation() {
  const raw = new URLSearchParams(window.location.search).get("arxiv");
  return raw && ARXIV_RE.test(raw) ? raw : null;
}

function renderPicker() {
  if (!els.picker) return;
  if (state.manifest.length === 0) {
    els.picker.hidden = true;
    return;
  }
  els.picker.hidden = false;
  els.picker.innerHTML = state.manifest
    .map((e) => {
      const label = `${e.arxiv_id} — ${e.title || "(untitled)"}`;
      const selected = e.arxiv_id === state.currentArxivId ? " selected" : "";
      return `<option value="${escapeHtml(e.arxiv_id)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

// Split from renderPicker() so re-rendering the options doesn't stack
// duplicate change listeners — init() should be the only place this runs.
function bindPicker() {
  if (!els.picker) return;
  els.picker.addEventListener("change", () => {
    const id = els.picker.value;
    if (!ARXIV_RE.test(id)) return;
    const url = new URL(window.location.href);
    url.searchParams.set("arxiv", id);
    window.location.href = url.toString();
  });
}

// SECURITY: ``safeHtml`` is interpolated raw into the DOM. Every caller
// in this file passes a static template literal. Never feed untrusted
// strings (URL params, fetch responses, user input) here without
// escaping first via ``escapeHtml`` — that would be a stored /
// reflected XSS sink.
function showErrorHtml(safeHtml) {
  els.canvas.insertAdjacentHTML(
    "beforeend",
    `<div class="empty-state">${safeHtml}</div>`,
  );
}

async function init() {
  els.canvas.insertAdjacentHTML("beforeend", `<p class="empty-state" id="loading-msg">データ読み込み中...</p>`);

  state.manifest = await loadManifest();
  const requested = arxivIdFromLocation();
  const known = new Set(state.manifest.map((e) => e.arxiv_id));
  // If URL param is valid AND present in manifest, honor it. Else pick
  // the manifest's first entry. If manifest is empty, fall back to the
  // legacy docs/<conf>/deep.json path for backward compatibility.
  let targetId = requested && known.has(requested) ? requested : state.manifest[0]?.arxiv_id ?? null;
  state.currentArxivId = targetId;

  const jsonName = targetId ? `deep-${targetId}.json` : "deep.json";
  state.data = await loadLineage(jsonName);
  document.getElementById("loading-msg")?.remove();

  if (!state.data) {
    renderPicker();
    showErrorHtml(`
      <p><code>${escapeHtml(jsonName)}</code> の読み込みに失敗しました。</p>
      <p><code>python paperpilot/scripts/build_deep_lineage.py --arxiv-id &lt;id&gt;</code>
      を実行してから <code>python paperpilot/scripts/generate_deep_manifest.py --docs-dir docs/iclr-2026</code> を実行してください。</p>
    `);
    return;
  }

  // Focus = the data root (what build_deep_lineage.py marked).
  state.focusId = state.data.root || state.data.nodes[0]?.id;
  if (!state.focusId) {
    showErrorHtml(`<p>表示可能なノードがありません</p>`);
    return;
  }

  renderPicker();
  bindPicker();
  renderFilterChips();
  bindSearch();
  render();
  scrollToFocus(false);
  updateTitle();
}

function updateTitle() {
  const n = state.data?.nodes.find((x) => x.id === state.focusId);
  if (n) document.title = `${n.title.slice(0, 60)} — Deep Lineage — PaperPilot`;
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
    savePrefs();
    render();
  });
}

function focusPaper(id) {
  if (!id || state.focusId === id) return;
  state.focusId = id;
  render();
  scrollToFocus(true);
  updateTitle();
}

function bindSearch() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  if (!input || !results) return;
  const renderResults = (q) => {
    if (!q) { results.classList.remove("is-open"); results.innerHTML = ""; return; }
    const lower = q.toLowerCase();
    const matches = state.data.nodes
      .filter((n) => ((n.title + " " + (n.authors || []).join(" ")).toLowerCase().includes(lower)))
      .slice(0, 8);
    if (matches.length === 0) {
      results.innerHTML = `<div class="lineage-search__empty">一致なし</div>`;
    } else {
      results.innerHTML = matches.map((n) => {
        const sub = PP.formatVenue(n.venue, n.year);
        return `<button class="lineage-search__item" data-id="${escapeHtml(n.id)}" type="button">
          <span class="lineage-search__title">${escapeHtml(n.title)}</span>
          <span class="lineage-search__sub">${escapeHtml(sub)}</span>
        </button>`;
      }).join("");
    }
    results.classList.add("is-open");
  };
  input.addEventListener("input", (e) => renderResults(e.target.value.trim()));
  input.addEventListener("focus", (e) => { if (e.target.value.trim()) renderResults(e.target.value.trim()); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { input.value = ""; results.classList.remove("is-open"); input.blur(); }
    if (e.key === "Enter") { results.querySelector(".lineage-search__item")?.click(); }
  });
  results.addEventListener("click", (e) => {
    const btn = e.target.closest(".lineage-search__item");
    if (!btn) return;
    focusPaper(btn.dataset.id);
    input.value = "";
    results.classList.remove("is-open");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".lineage-search")) results.classList.remove("is-open");
  });
}

function scrollToFocus(smooth) {
  requestAnimationFrame(() => {
    const focusFo = [...els.svg.querySelectorAll("foreignObject")].find(
      (el) => el.querySelector(".node-card--focus")
    );
    if (!focusFo || !els.canvas) return;
    const x = parseFloat(focusFo.getAttribute("x")) + NODE_W / 2;
    const y = parseFloat(focusFo.getAttribute("y")) + NODE_H / 2;
    const svgRect = els.svg.getBoundingClientRect();
    const canvasRect = els.canvas.getBoundingClientRect();
    const scaleX = svgRect.width / parseFloat(els.svg.getAttribute("width") || svgRect.width);
    const scaleY = svgRect.height / parseFloat(els.svg.getAttribute("height") || svgRect.height);
    els.canvas.scrollTo({
      left: Math.max(0, x * scaleX - canvasRect.width / 2),
      top: Math.max(0, y * scaleY - canvasRect.height / 2),
      behavior: smooth ? "smooth" : "auto",
    });
  });
}

function render() {
  const { nodes, edges } = state.data;
  const visibleEdges = edges.filter((e) => state.visibleRelations.has(e.rel));
  const positioned = layoutTree(nodes, edges, state.focusId);
  // drawSvg returns a promise once fonts/layout settle so card heights
  // and edge endpoints align after web fonts finish loading. Surface
  // any unexpected rejection in the console instead of silently
  // dropping it via `void` — a blank graph with no signal is worse
  // than a visible error during development.
  drawSvg(positioned, visibleEdges).catch((err) => {
    console.error("[deep] drawSvg failed:", err);
  });
}

// ---------- Tree layout (unbounded depth) ----------

function layoutTree(nodes, edges, focusId) {
  const parents = new Map();
  const children = new Map();
  for (const n of nodes) { parents.set(n.id, []); children.set(n.id, []); }
  for (const e of edges) {
    if (!GENEALOGY.has(e.rel) && e.rel !== "contrasts" && e.rel !== "baseline_only") continue;
    parents.get(e.dst)?.push({ id: e.src, rel: e.rel });
    children.get(e.src)?.push({ id: e.dst, rel: e.rel });
  }

  const level = new Map();
  level.set(focusId, 0);

  // Unbounded BFS — for deep mode, show everything reachable.
  const qUp = [focusId];
  while (qUp.length) {
    const id = qUp.shift();
    for (const { id: p } of parents.get(id) || []) {
      if (!level.has(p)) { level.set(p, level.get(id) - 1); qUp.push(p); }
    }
  }
  const qDown = [focusId];
  while (qDown.length) {
    const id = qDown.shift();
    for (const { id: c } of children.get(id) || []) {
      if (!level.has(c)) { level.set(c, level.get(id) + 1); qDown.push(c); }
    }
  }

  const byLevel = new Map();
  for (const n of nodes) {
    if (!level.has(n.id)) continue;
    const lv = level.get(n.id);
    (byLevel.get(lv) || byLevel.set(lv, []).get(lv)).push(n);
  }
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const zeroIdx = sortedLevels.indexOf(0);
  const GAP_X = NODE_W + SIBLING_GAP;

  const xByNodeId = new Map();
  xByNodeId.set(focusId, 0);

  const positionRow = (row, getPref) => {
    if (row.length === 0) return;
    const withPref = row.map((n) => ({ node: n, pref: getPref(n) }))
                        .sort((a, b) => a.pref - b.pref);
    let lastX = -Infinity;
    const temp = [];
    for (const { node, pref } of withPref) {
      const x = Math.max(pref, lastX + GAP_X);
      temp.push({ node, pref, x });
      lastX = x;
    }
    const avgPref = temp.reduce((s, t) => s + t.pref, 0) / temp.length;
    const avgActual = temp.reduce((s, t) => s + t.x, 0) / temp.length;
    const shift = avgPref - avgActual;
    for (const t of temp) xByNodeId.set(t.node.id, t.x + shift);
  };
  for (let i = zeroIdx - 1; i >= 0; i--) {
    positionRow(byLevel.get(sortedLevels[i]) || [], (node) => {
      const xs = [];
      for (const { id } of children.get(node.id) || []) if (xByNodeId.has(id)) xs.push(xByNodeId.get(id));
      for (const { id } of parents.get(node.id) || []) if (xByNodeId.has(id)) xs.push(xByNodeId.get(id));
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    });
  }
  for (let i = zeroIdx + 1; i < sortedLevels.length; i++) {
    positionRow(byLevel.get(sortedLevels[i]) || [], (node) => {
      const xs = [];
      for (const { id } of parents.get(node.id) || []) if (xByNodeId.has(id)) xs.push(xByNodeId.get(id));
      for (const { id } of children.get(node.id) || []) if (xByNodeId.has(id)) xs.push(xByNodeId.get(id));
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    });
  }

  const positioned = [];
  sortedLevels.forEach((lv, idx) => {
    for (const n of byLevel.get(lv) || []) {
      positioned.push({ ...n, _x: xByNodeId.get(n.id) ?? 0, _y: idx * (NODE_H + LEVEL_GAP) });
    }
  });
  if (positioned.length === 0) return [];
  const minX = Math.min(...positioned.map((p) => p._x));
  const minY = Math.min(...positioned.map((p) => p._y));
  for (const p of positioned) { p._x += PADDING - minX; p._y += PADDING - minY; }
  return positioned;
}

// ---------- SVG rendering with richer cards ----------

async function drawSvg(positioned, edges) {
  if (positioned.length === 0) {
    els.svg.innerHTML = "";
    els.canvas.querySelector(".empty-state")?.remove();
    els.canvas.insertAdjacentHTML("beforeend", `<p class="empty-state">No data to display.</p>`);
    return;
  }
  const posById = new Map(positioned.map((p) => [p.id, p]));
  const W = Math.max(...positioned.map((p) => p._x + NODE_W)) + PADDING;
  const H = Math.max(...positioned.map((p) => p._y + NODE_H)) + PADDING;

  els.svg.setAttribute("width", W);
  els.svg.setAttribute("height", H);
  els.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  els.svg.innerHTML = "";

  // Arrow markers (reuses lineage.css classes)
  const defs = document.createElementNS(SVG_NS, "defs");
  for (const [key, color, kind] of [
    ["supersedes", "oklch(55% 0.14 75)", "filled"],
    ["successor",  "oklch(72% 0.13 80)", "filled"],
    ["extends",    "oklch(62% 0.14 145)", "filled"],
    ["ablation",   "oklch(60% 0.13 240)", "hollow"],
    ["baseline",   "oklch(60% 0.02 270)", "dot"],
    ["contrasts",  "oklch(58% 0.20 25)", "cross"],
  ]) {
    const m = document.createElementNS(SVG_NS, "marker");
    m.setAttribute("id", `arrow-${key}`);
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "9"); m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "7"); m.setAttribute("markerHeight", "7");
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
    } else {
      shape = document.createElementNS(SVG_NS, "path");
      shape.setAttribute("d", "M0,0 L10,10 M10,0 L0,10");
      shape.setAttribute("stroke", color); shape.setAttribute("stroke-width", "1.8");
      shape.setAttribute("fill", "none");
    }
    m.appendChild(shape);
    defs.appendChild(m);
  }
  els.svg.appendChild(defs);

  // Nodes first — render so we can measure each card's actual height
  // before drawing edges. Cards in deep view vary from ~193 to ~277 px
  // depending on title length, TLDR wrapping, and author count, so a
  // fixed NODE_H produces visible "frame mismatch" between the card and
  // the foreignObject viewport. Measuring after layout lets us land
  // edges on the actual visible card bottom.
  const ng = document.createElementNS(SVG_NS, "g");
  ng.setAttribute("id", "nodes");
  const foById = new Map();
  for (const p of positioned) {
    const fo = document.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("x", p._x); fo.setAttribute("y", p._y);
    fo.setAttribute("width", NODE_W); fo.setAttribute("height", NODE_H);
    // Let the ★ FOCUS badge (top: -10px) and box-shadow halos render
    // outside the foreignObject's viewport — without this they get
    // clipped at the card edge.
    fo.setAttribute("overflow", "visible");
    fo.style.overflow = "visible";
    fo.dataset.nodeId = p.id;
    const card = document.createElement("div");
    card.setAttribute("xmlns", XHTML_NS);
    card.className = "node-card node-card--deep";
    if (p.id === state.focusId) card.classList.add("node-card--focus");
    card.addEventListener("click", () => focusPaper(p.id));

    const tier = p.venue_tier === "A+" ? "aplus" : p.venue_tier === "A" ? "a" : "preprint";
    const venue = PP.formatVenue(p.venue, p.year);
    const authors = (p.authors || []).slice(0, 3).join(", ")
      + ((p.authors || []).length > 3 ? ` +${p.authors.length - 3}` : "");
    const cits = typeof p.citation_count === "number" && p.citation_count > 0
      ? `<span class="node-card__cit">📖 ${p.citation_count.toLocaleString()}</span>` : "";
    const stars = formatStars(p.github_stars);
    const starsHtml = stars ? `<span class="node-card__stars">⭐${stars}</span>` : "";
    card.innerHTML = `
      <div class="node-card__venue">
        <span class="node-card__venue-tier node-card__venue-tier--${tier}">${escapeHtml(venue || "—")}</span>
      </div>
      <h3 class="node-card__title">${escapeHtml(p.title || "")}</h3>
      <div class="node-card__authors">${escapeHtml(authors)}</div>
      <div class="node-card__tldr">${escapeHtml(p.tldr || "")}</div>
      <div class="node-card__meta">${cits}${starsHtml}</div>
    `;
    fo.appendChild(card);
    ng.appendChild(fo);
    foById.set(p.id, { fo, card });
  }
  els.svg.appendChild(ng);

  // Wait for web fonts to finish loading before measuring — otherwise
  // cards rendered with the system font fallback measure shorter than
  // their final state and edges land above the visible card bottom
  // once fonts swap in.
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* ignore */ }
  }
  // Yield one frame so any final layout pass settles before we measure.
  await new Promise((r) => requestAnimationFrame(() => r()));

  // Measure each card's actual rendered height. The card div is laid
  // out by the browser inside the foreignObject; getBoundingClientRect
  // is in screen pixels, but the SVG has no zoom transform applied at
  // first render, so screen px == viewBox units (1:1). Update the
  // foreignObject's `height` attribute to match the card so the
  // outline matches the visible card border, and stash the measured
  // height on the positioned record for edge geometry below.
  for (const p of positioned) {
    const entry = foById.get(p.id);
    if (!entry) { p._actualH = NODE_H; continue; }
    const h = Math.ceil(entry.card.getBoundingClientRect().height) || NODE_H;
    p._actualH = h;
    entry.fo.setAttribute("height", h);
  }

  // Cards taller than NODE_H push past the SVG bottom computed above —
  // grow the canvas if needed so the last row isn't clipped.
  const measuredH = Math.max(...positioned.map((p) => p._y + p._actualH)) + PADDING;
  if (measuredH > H) {
    els.svg.setAttribute("height", measuredH);
    els.svg.setAttribute("viewBox", `0 0 ${W} ${measuredH}`);
  }

  // Edges — drawn after measurement, using each source card's actual
  // bottom Y instead of the static NODE_H slot. Insert before the node
  // group so edges render below cards in z-order.
  const eg = document.createElementNS(SVG_NS, "g");
  eg.setAttribute("id", "edges");
  for (const e of edges) {
    const a = posById.get(e.src), b = posById.get(e.dst);
    if (!a || !b) continue;
    const ax = a._x + NODE_W / 2;
    const ay = a._y + (a._actualH ?? NODE_H);
    const bx = b._x + NODE_W / 2;
    const by = b._y;
    const midY = (ay + by) / 2;
    const d = `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`;
    const mc = e.rel === "baseline_only" ? "baseline" : e.rel;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `edge edge--${mc}`);
    path.setAttribute("marker-end", `url(#arrow-${mc})`);
    if (typeof e.conf === "number") path.style.strokeOpacity = String(0.5 + e.conf * 0.5);
    path.dataset.rel = e.rel;
    path.dataset.rationale = e.rationale || "";
    path.dataset.conf = e.conf ?? "";
    path.addEventListener("mouseenter", onEdgeHover);
    path.addEventListener("mousemove", onEdgeMove);
    path.addEventListener("mouseleave", onEdgeLeave);
    eg.appendChild(path);
    const label = RELATION_LABEL_JA[e.rel];
    if (label) {
      const lx = (ax + bx) / 2, ly = midY;
      const bg = document.createElementNS(SVG_NS, "rect");
      bg.setAttribute("class", `edge-label-bg edge-label-bg--${mc}`);
      bg.setAttribute("x", lx - 14); bg.setAttribute("y", ly - 8);
      bg.setAttribute("width", 28); bg.setAttribute("height", 16);
      bg.setAttribute("rx", 3); eg.appendChild(bg);
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("class", `edge-label edge-label--${mc}`);
      text.setAttribute("x", lx); text.setAttribute("y", ly + 4);
      text.setAttribute("text-anchor", "middle");
      text.textContent = label; eg.appendChild(text);
    }
  }
  els.svg.insertBefore(eg, ng);
}

function onEdgeHover(e) {
  els.ttRel.textContent = e.currentTarget.dataset.rel.replace("_", " ");
  els.ttRationale.textContent = e.currentTarget.dataset.rationale || "";
  const c = e.currentTarget.dataset.conf;
  els.ttConf.textContent = c ? `confidence ${Number(c).toFixed(2)}` : "";
  els.tooltip.classList.add("is-visible");
  els.tooltip.setAttribute("aria-hidden", "false");
  onEdgeMove(e);
}
function onEdgeMove(e) {
  const tt = els.tooltip; const pad = 12;
  let x = e.clientX + pad, y = e.clientY + pad;
  const w = tt.offsetWidth || 280, h = tt.offsetHeight || 80;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
  tt.style.left = `${Math.max(8, x)}px`;
  tt.style.top = `${Math.max(8, y)}px`;
}
function onEdgeLeave() {
  els.tooltip.classList.remove("is-visible");
  els.tooltip.setAttribute("aria-hidden", "true");
}

init();
