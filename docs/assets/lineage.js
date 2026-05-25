// Lineage viewer — pure SVG family tree / timeline. Requires utils.js loaded first.
const { escapeHtml, formatStars, loadLineage } = window.PP;
const NODE_W = 220;
const NODE_H = 150;
const LEVEL_GAP = 80;
const SIBLING_GAP = 28;
const PADDING = 40;
const MAX_DEPTH = 3;

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

const GENEALOGY = new Set(["supersedes", "successor", "extends", "ablation"]);
const ALL_RELATIONS = ["supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts"];
const RELATION_RANK = {
  supersedes: 0, successor: 1, extends: 2, ablation: 3, contrasts: 4, baseline_only: 5,
};
const RELATION_LABEL_JA = {
  supersedes: "置換", successor: "後継", extends: "拡張",
  ablation: "分析", baseline_only: "比較", contrasts: "対立",
};

const STORAGE_KEY = "pp.lineage.prefs";
const DEFAULT_RELATIONS = ["supersedes", "successor", "extends", "ablation", "contrasts"];
const VALID_LAYOUTS = new Set(["tree", "timeline", "topics"]);

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      layout: state.layout,
      visibleRelations: [...state.visibleRelations],
    }));
  } catch { /* localStorage may be disabled */ }
}

const prefs = loadPrefs();
const state = {
  data: null,
  // Default to Topics on first visit — it gives immediate bird's-eye context
  // (which subfields dominate Oral?) before asking the user to pick a paper
  // to center the tree on.
  layout: VALID_LAYOUTS.has(prefs?.layout) ? prefs.layout : "topics",
  focusId: null,
  currentCluster: null,
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
  crumb: document.getElementById("lineage-crumb"),
  legend: document.querySelector(".legend"),
  footerHint: document.getElementById("footer-hint"),
};

// Copy surfaced in the footer per-mode — tells the user what clicking does.
const FOOTER_HINT = {
  topics: "カードをクリック → その論文の家系図に遷移",
  tree: "カードをクリック → その論文を中心に家系図を再描画",
  timeline: "カードをクリック → 家系図モードでその論文にフォーカス",
};

// Japanese subtitles for common primary-tag cluster labels. Falls through to
// an empty string when unknown so the label stays on its own (not "LLM — ")
// and so adding new kinds at Stage 2 doesn't need a JS change.
const CLUSTER_SUBTITLE = {
  LLM: "大規模言語モデル",
  Vision: "コンピュータビジョン",
  VLM: "視覚-言語モデル",
  MLLM: "マルチモーダル LLM",
  Diffusion: "拡散モデル",
  RL: "強化学習",
  SSL: "自己教師あり学習",
  Transformer: "Transformer 系アーキテクチャ",
  MoE: "Mixture of Experts",
  Medical: "医療応用",
  TimeSeries: "時系列",
  Theory: "理論",
  Optim: "最適化",
  Eval: "評価・ベンチマーク",
  uncategorized: "未分類",
};

function clusterForFocus(id) {
  for (const c of state.data?.clusters || []) {
    if (c.focus_ids.includes(id)) return c;
  }
  return null;
}

async function init() {
  // Bind sync controls immediately so aria-pressed + click handlers reflect
  // the restored state.layout before the data-load await — otherwise the
  // hardcoded HTML `aria-pressed` flashes wrong when prefs = "topics".
  bindLayoutButtons();
  bindCrumb();

  // #ui: the HTML ships a `.canvas-loading` element with a spinner;
  // just hide it once the data resolves. Replaces the previous
  // dynamically-injected `<p class="empty-state">…` paragraph.
  state.data = await loadLineage();
  const canvasLoading = document.getElementById("canvas-loading");
  if (canvasLoading) canvasLoading.hidden = true;
  if (!state.data) {
    els.canvas.insertAdjacentHTML("beforeend", `
      <div class="empty-state">
        <p>lineage データの読み込みに失敗しました</p>
        <button class="layout-btn" onclick="location.reload()">🔄 再試行</button>
      </div>`);
    return;
  }
  if (!state.data.root || !state.data.nodes.some((n) => n.id === state.data.root)) {
    state.data.root = state.data.nodes[0]?.id;
  }
  if (!state.data.root) {
    els.canvas.insertAdjacentHTML("beforeend", `<p class="empty-state">lineage に表示可能なノードがありません</p>`);
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const requested = params.get("focus");
  const known = new Set(state.data.nodes.map((n) => n.id));
  state.focusId = requested && known.has(requested) ? requested : state.data.root;

  bindRootButton();
  bindSearch();
  renderFilterChips();
  render();
  scrollToFocus(false);
  updateTitle();

  window.addEventListener("popstate", () => {
    const p = new URLSearchParams(window.location.search);
    const r = p.get("focus");
    const next = r && known.has(r) ? r : state.data.root;
    if (state.focusId !== next) focusPaper(next, { push: false });
  });
}

function bindRootButton() {
  const btn = document.getElementById("btn-root");
  if (!btn) return;
  btn.addEventListener("click", () => {
    focusPaper(state.data.root);
    // Ensures "home" always lands in the tree view — otherwise clicking it
    // from Topics/Timeline would just update state.focusId invisibly.
    if (state.layout !== "tree") setLayout("tree");
  });
}

function bindLayoutButtons() {
  for (const btn of document.querySelectorAll(".layout-btn[data-layout]")) {
    btn.addEventListener("click", () => setLayout(btn.dataset.layout));
    btn.setAttribute("aria-pressed", btn.dataset.layout === state.layout ? "true" : "false");
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
    savePrefs();
    render();
  });
}

function focusPaper(id, { push = true, smooth = true } = {}) {
  if (state.focusId === id) return;
  // Remember whether the action was triggered by keyboard (focus was on a
  // card) so we can move the keyboard focus to the new center card after
  // re-render instead of dropping back to <body>.
  const cameFromKeyboard = document.activeElement?.classList?.contains("node-card");
  state.focusId = id;
  const url = new URL(window.location.href);
  url.searchParams.set("focus", id);
  if (push) window.history.pushState({}, "", url);
  else window.history.replaceState({}, "", url);
  render();
  scrollToFocus(smooth);
  updateTitle();
  if (cameFromKeyboard) {
    // render() rebuilds the SVG synchronously; querySelector after it
    // returns finds the new focus card. Defer one frame so the focus
    // ring is drawn after the FLIP transitions have started.
    requestAnimationFrame(() => {
      const next = els.svg?.querySelector(".node-card--focus");
      if (next instanceof HTMLElement) next.focus({ preventScroll: true });
    });
  }
}

function updateTitle() {
  const node = state.data?.nodes.find((n) => n.id === state.focusId);
  if (node) document.title = `${node.title.slice(0, 60)} — Lineage — PaperPilot`;
}

function bindSearch() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  if (!input || !results) return;
  const renderResults = (q) => {
    if (!q) { results.classList.remove("is-open"); results.innerHTML = ""; return; }
    const lower = q.toLowerCase();
    const matches = state.data.nodes
      .filter((n) => {
        const hay = (n.title + " " + (n.authors || []).join(" ")).toLowerCase();
        return hay.includes(lower);
      })
      .slice(0, 8);
    if (matches.length === 0) {
      results.innerHTML = `<div class="lineage-search__empty">一致なし</div>`;
    } else {
      results.innerHTML = matches.map((n) => {
        const sub = PP.formatVenue(n.venue, n.year);
        return `<button class="lineage-search__item" data-id="${n.id}" type="button">
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
    if (e.key === "Enter") {
      const first = results.querySelector(".lineage-search__item");
      if (first) first.click();
    }
  });
  results.addEventListener("click", (e) => {
    const btn = e.target.closest(".lineage-search__item");
    if (!btn) return;
    const id = btn.dataset.id;
    focusPaper(id);
    // Same rationale as bindRootButton — a search action that doesn't
    // change what the user sees would feel broken.
    if (state.layout !== "tree") setLayout("tree");
    input.value = "";
    results.classList.remove("is-open");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".lineage-search")) results.classList.remove("is-open");
  });
}

function highlightConnectedEdges(nodeId, on) {
  for (const path of els.svg.querySelectorAll(".edge")) {
    if (path.dataset.src === nodeId || path.dataset.dst === nodeId) {
      path.classList.toggle("edge--highlight", on);
    } else {
      path.classList.toggle("edge--dim", on);
    }
  }
}

function scrollToFocus(smooth) {
  requestAnimationFrame(() => {
    const fo = els.svg.querySelector("foreignObject");
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
    const targetScrollLeft = x * scaleX - canvasRect.width / 2;
    const targetScrollTop = y * scaleY - canvasRect.height / 2;
    els.canvas.scrollTo({
      left: Math.max(0, targetScrollLeft),
      top: Math.max(0, targetScrollTop),
      behavior: smooth ? "smooth" : "auto",
    });
  });
}

function render() {
  applyModeUI();
  renderCrumb();
  if (state.layout === "topics") {
    renderTopicsGallery();
    return;
  }
  // SVG layouts (tree / timeline) share the canvas; topics view replaces it.
  restoreCanvasForSvg();
  const { nodes, edges } = state.data;
  const visibleEdges = edges.filter((e) => state.visibleRelations.has(e.rel));

  const positioned = state.layout === "tree"
    ? layoutTree(nodes, edges, state.focusId)
    : layoutTimeline(nodes);

  // Surface unexpected rejections instead of silently dropping via
  // `void` — a blank graph with no signal is worse than a console
  // error during development.
  drawSvg(positioned, visibleEdges).catch((err) => {
    console.error("[lineage] drawSvg failed:", err);
  });
}

// Show/hide chrome that only makes sense for specific layouts. Keeps the
// screen quieter in topics mode where edges + relation filters don't apply.
function applyModeUI() {
  const isGraph = state.layout === "tree" || state.layout === "timeline";
  if (els.legend) els.legend.hidden = !isGraph;
  if (els.filterBar) els.filterBar.hidden = !isGraph;
  if (els.footerHint) els.footerHint.textContent = FOOTER_HINT[state.layout] || "";
}

function restoreCanvasForSvg() {
  const gallery = els.canvas.querySelector(".topics-gallery");
  if (gallery) gallery.remove();
  if (els.svg) els.svg.style.display = "";
}

function renderCrumb() {
  if (!els.crumb) return;
  const clusters = state.data?.clusters || [];
  // No clusters data → keep crumb hidden (back-compat with older lineage.json).
  if (clusters.length === 0) {
    els.crumb.hidden = true;
    els.crumb.innerHTML = "";
    return;
  }
  // Hide in modes that don't center on a single focus:
  // - topics: shows the gallery itself
  // - timeline: shows all nodes chronologically (no "current focus")
  if (state.layout === "topics" || state.layout === "timeline") {
    els.crumb.hidden = true;
    els.crumb.innerHTML = "";
    return;
  }
  const cluster = state.currentCluster
    ? clusters.find((c) => c.id === state.currentCluster)
    : clusterForFocus(state.focusId);
  if (!cluster) {
    els.crumb.hidden = true;
    els.crumb.innerHTML = "";
    return;
  }
  const focusNode = state.data.nodes.find((n) => n.id === state.focusId);
  const titleFragment = focusNode
    ? `<span class="lineage-crumb__sep">/</span><span class="lineage-crumb__current">${escapeHtml(
        focusNode.title.slice(0, 80)
      )}</span>`
    : "";
  els.crumb.hidden = false;
  els.crumb.innerHTML = `
    <button type="button" class="lineage-crumb__link" data-action="topics">🗂️ トピック</button>
    <span class="lineage-crumb__sep">/</span>
    <button type="button" class="lineage-crumb__link" data-action="cluster" data-cluster="${escapeHtml(cluster.id)}">${escapeHtml(cluster.label)}</button>
    ${titleFragment}
  `;
}

// Event delegation — bound once from init() so re-renders never accumulate
// listeners on stale DOM nodes.
function bindCrumb() {
  if (!els.crumb) return;
  els.crumb.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !els.crumb.contains(btn)) return;
    if (btn.dataset.action === "topics") {
      state.currentCluster = null;
      setLayout("topics");
    } else if (btn.dataset.action === "cluster") {
      state.currentCluster = btn.dataset.cluster || null;
      setLayout("topics");
    }
  });
}

function setLayout(layout) {
  if (!VALID_LAYOUTS.has(layout) || state.layout === layout) return;
  state.layout = layout;
  for (const b of document.querySelectorAll(".layout-btn[data-layout]")) {
    b.setAttribute("aria-pressed", b.dataset.layout === layout ? "true" : "false");
  }
  savePrefs();
  render();
}

// ---------------- Topics layout (cluster gallery) ----------------

function renderTopicsGallery() {
  if (els.svg) els.svg.style.display = "none";
  els.canvas.querySelector(".topics-gallery")?.remove();

  const clusters = state.data?.clusters || [];
  const gallery = document.createElement("div");
  gallery.className = "topics-gallery";

  if (clusters.length === 0) {
    gallery.innerHTML = `<p class="empty-state">クラスタ情報がありません。lineage.json を再生成してください。</p>`;
    els.canvas.appendChild(gallery);
    return;
  }

  const totalPapers = clusters.reduce((s, c) => s + c.focus_ids.length, 0);
  const intro = document.createElement("p");
  intro.className = "topics-gallery__intro";
  intro.textContent = `${clusters.length} サブフィールド · Oral 採択 ${totalPapers} 本を primary tag でグループ化。カードをクリックすると家系図に切り替わります。`;
  gallery.appendChild(intro);

  const nodesById = new Map(state.data.nodes.map((n) => [n.id, n]));
  for (const cluster of clusters) {
    const section = document.createElement("section");
    section.className = "topics-cluster";
    section.setAttribute("data-cluster-id", cluster.id);

    const head = document.createElement("div");
    head.className = "topics-cluster__head";
    const subtitle = CLUSTER_SUBTITLE[cluster.label] || "";
    const subtitleHtml = subtitle
      ? `<span class="topics-cluster__subtitle">${escapeHtml(subtitle)}</span>`
      : "";
    head.innerHTML = `
      <h2 class="topics-cluster__label">${escapeHtml(cluster.label)}</h2>
      ${subtitleHtml}
      <span class="topics-cluster__count">${cluster.focus_ids.length} 件</span>
    `;
    section.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "topics-cluster__grid";
    for (const fid of cluster.focus_ids) {
      const n = nodesById.get(fid);
      if (!n) continue;
      grid.appendChild(buildTopicsCard(n, cluster.id));
    }
    section.appendChild(grid);
    gallery.appendChild(section);
  }
  els.canvas.appendChild(gallery);
}

function buildTopicsCard(node, clusterId) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "topics-card";
  btn.setAttribute("data-focus-id", node.id);

  const authors =
    (node.authors || []).slice(0, 3).join(", ") +
    ((node.authors || []).length > 3 ? ` +${node.authors.length - 3}` : "");
  const kinds = (node.kinds || [])
    .slice(0, 4)
    .map((k) => `<span>#${escapeHtml(k)}</span>`)
    .join("");
  const starStr = formatStars(node.github_stars);
  const stars = starStr ? `<span>⭐${starStr}</span>` : "";

  btn.innerHTML = `
    <div class="topics-card__title">${escapeHtml(node.title || "")}</div>
    <div class="topics-card__authors">${escapeHtml(authors)}</div>
    <div class="topics-card__tldr">${escapeHtml(node.tldr || "")}</div>
    <div class="topics-card__meta">${kinds}${stars}</div>
  `;
  btn.addEventListener("click", () => {
    state.currentCluster = clusterId;
    focusPaper(node.id);
    setLayout("tree");
  });
  return btn;
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

  // Position nodes relative to their neighbor at the adjacent level,
  // so siblings sharing a parent cluster together (minimizes crossings).
  const xByNodeId = new Map();
  xByNodeId.set(focusId, 0);

  const zeroIdx = sortedLevels.indexOf(0);
  const GAP_X = NODE_W + SIBLING_GAP;

  const positionRow = (row, getPreferredX) => {
    if (row.length === 0) return;
    const withPref = row.map((n) => ({ node: n, pref: getPreferredX(n) }));
    withPref.sort((a, b) => a.pref - b.pref);

    let lastX = -Infinity;
    const temp = [];
    for (const { node, pref } of withPref) {
      const x = Math.max(pref, lastX + GAP_X);
      temp.push({ node, pref, x });
      lastX = x;
    }
    // Center the row's actual x around the row's preferred-x centroid so
    // tied-preference groups don't all drift to the right.
    const avgPref = temp.reduce((s, t) => s + t.pref, 0) / temp.length;
    const avgActual = temp.reduce((s, t) => s + t.x, 0) / temp.length;
    const shift = avgPref - avgActual;
    for (const t of temp) xByNodeId.set(t.node.id, t.x + shift);
  };

  // Look at ALL already-positioned connected nodes (any level) so gaps in
  // levels don't force unrelated nodes to pile at x=0.
  for (let i = zeroIdx - 1; i >= 0; i--) {
    const row = byLevel.get(sortedLevels[i]) || [];
    positionRow(row, (node) => {
      const xs = [];
      for (const { id } of children.get(node.id) || []) {
        if (xByNodeId.has(id)) xs.push(xByNodeId.get(id));
      }
      for (const { id } of parents.get(node.id) || []) {
        if (xByNodeId.has(id)) xs.push(xByNodeId.get(id));
      }
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    });
  }
  for (let i = zeroIdx + 1; i < sortedLevels.length; i++) {
    const row = byLevel.get(sortedLevels[i]) || [];
    positionRow(row, (node) => {
      const xs = [];
      for (const { id } of parents.get(node.id) || []) {
        if (xByNodeId.has(id)) xs.push(xByNodeId.get(id));
      }
      for (const { id } of children.get(node.id) || []) {
        if (xByNodeId.has(id)) xs.push(xByNodeId.get(id));
      }
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

async function drawSvg(positioned, edges) {
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

  // Render nodes first so cards can be measured before edges are drawn.
  // Lineage cards have no fixed height and vary from ~180 to ~260 px
  // depending on title wrap, TLDR length, and metadata; using NODE_H
  // for edge endpoints leaves the edge floating tens of pixels above
  // (or below) the visible card bottom.
  const nodeGroup = document.createElementNS(SVG_NS, "g");
  nodeGroup.setAttribute("id", "nodes");
  const foById = new Map();
  for (const p of positioned) {
    const fo = document.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("x", p._x);
    fo.setAttribute("y", p._y);
    fo.setAttribute("width", NODE_W);
    fo.setAttribute("height", NODE_H);
    // Let the ★ FOCUS badge (top: -10px) and box-shadow halos render
    // outside the foreignObject's viewport — without this they get
    // clipped at the card edge.
    fo.setAttribute("overflow", "visible");
    fo.style.overflow = "visible";
    fo.dataset.nodeId = p.id;

    const card = document.createElement("div");
    card.setAttribute("xmlns", XHTML_NS);
    card.className = "node-card";
    if (p.id === state.focusId) card.classList.add("node-card--focus");
    if (p.is_trending) card.classList.add("node-card--trending");
    // a11y: cards are <div> not <button> (foreignObject + nested anchors
    // make button semantics awkward), so promote them to focusable
    // role="button" so Tab can reach them and Enter / Space trigger
    // the same focus-switch as a click. Screen readers get a label
    // pinned to the paper title.
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `論文を選択: ${p.title || p.id}`);
    card.addEventListener("click", () => focusPaper(p.id));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        focusPaper(p.id);
      }
    });
    card.addEventListener("mouseenter", () => highlightConnectedEdges(p.id, true));
    card.addEventListener("mouseleave", () => highlightConnectedEdges(p.id, false));
    card.addEventListener("focus", () => highlightConnectedEdges(p.id, true));
    card.addEventListener("blur", () => highlightConnectedEdges(p.id, false));

    const tier = p.venue_tier === "A+" ? "aplus"
               : p.venue_tier === "A" ? "a"
               : "preprint";
    const venue = PP.formatVenue(p.venue, p.year);
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
    foById.set(p.id, { fo, card });
  }
  els.svg.appendChild(nodeGroup);

  // Wait for web fonts to finish loading before measuring — otherwise
  // cards rendered with the system-font fallback measure shorter than
  // their final state and edges land above the visible card bottom
  // once fonts swap in.
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* ignore */ }
  }
  await new Promise((r) => requestAnimationFrame(() => r()));

  // Measure each card's actual rendered height, update the
  // foreignObject `height` attribute to match (so the bounds match
  // the visible card border), and stash the value on the positioned
  // record so edges land on the visible card bottom rather than the
  // static NODE_H slot.
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

  const edgeGroup = document.createElementNS(SVG_NS, "g");
  edgeGroup.setAttribute("id", "edges");
  for (const e of edges) {
    const a = posById.get(e.src);
    const b = posById.get(e.dst);
    if (!a || !b) continue;
    const ax = a._x + NODE_W / 2;
    const ay = a._y + (a._actualH ?? NODE_H);
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
    path.dataset.src = e.src;
    path.dataset.dst = e.dst;
    path.addEventListener("mouseenter", onEdgeHover);
    path.addEventListener("mousemove", onEdgeMove);
    path.addEventListener("mouseleave", onEdgeLeave);
    edgeGroup.appendChild(path);

    const label = RELATION_LABEL_JA[e.rel];
    if (label) {
      const labelMidX = (ax + bx) / 2;
      const labelMidY = midY;
      const bg = document.createElementNS(SVG_NS, "rect");
      bg.setAttribute("class", `edge-label-bg edge-label-bg--${markerClass(e.rel)}`);
      bg.setAttribute("x", labelMidX - 14);
      bg.setAttribute("y", labelMidY - 8);
      bg.setAttribute("width", 28);
      bg.setAttribute("height", 16);
      bg.setAttribute("rx", 3);
      edgeGroup.appendChild(bg);
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("class", `edge-label edge-label--${markerClass(e.rel)}`);
      text.setAttribute("x", labelMidX);
      text.setAttribute("y", labelMidY + 4);
      text.setAttribute("text-anchor", "middle");
      text.textContent = label;
      edgeGroup.appendChild(text);
    }
  }
  els.svg.insertBefore(edgeGroup, nodeGroup);
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
