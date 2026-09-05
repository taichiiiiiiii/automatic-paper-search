// Deep lineage viewer — single-paper family tree with multi-hop BFS data.
// Loads only the filename selected by a validated deep-manifest-v1 entry.
//
// Differences vs. lineage.js:
//   - Only tree layout (no topics/timeline)
//   - No MAX_DEPTH cap on render — show everything in the data
//   - Larger node cards with more metadata, height measured at render
//   - No clustering
const { escapeHtml, formatStars } = window.PP;
const LineageCore = window.PaperPilotLineageCore;

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
      view: state.view,
      visibleRelations: [...state.visibleRelations],
    }));
  } catch { /* disabled */ }
}

const prefs = loadPrefs();
const initialParams = new URLSearchParams(window.location.search);
const urlRelations = (initialParams.get("relations") || "")
  .split(",")
  .filter((relation) => ALL_RELATIONS.includes(relation));
const state = {
  data: null,
  focusId: null,
  manifest: null,
  quality: null,
  manifestSha256: null,
  currentPaperId: null,
  currentArxivId: null,
  view: LineageCore.resolveView({
    urlView: initialParams.get("view"),
    savedView: prefs?.view,
    matchMedia: window.matchMedia?.bind(window),
  }),
  visibleRelations: new Set(
    urlRelations.length > 0
      ? urlRelations
      : Array.isArray(prefs?.visibleRelations) && prefs.visibleRelations.length > 0
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
  relationList: document.getElementById("relation-list"),
};

async function loadManifest() {
  const loaded = await LineageCore.fetchJsonWithSha256("deep-manifest.json");
  if (!loaded) return null;
  const manifest = LineageCore.parseDeepManifest(loaded.data);
  return manifest ? { manifest, sha256: loaded.sha256 } : null;
}

async function loadQualityManifest() {
  try {
    const response = await fetch("../lineage-quality-v1.json", { cache: "no-cache" });
    if (!response.ok) return null;
    return LineageCore.parseQualityManifest(await response.json());
  } catch {
    return null;
  }
}

function renderPicker() {
  if (!els.picker) return;
  const entries = state.manifest?.entries || [];
  if (entries.length === 0) {
    els.picker.hidden = true;
    return;
  }
  els.picker.hidden = false;
  els.picker.innerHTML = entries
    .map((e) => {
      const label = `${e.arxiv_id} — ${e.title || "(untitled)"}`;
      const selected = e.paper_id === state.currentPaperId ? " selected" : "";
      return `<option value="${escapeHtml(e.paper_id)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

// Split from renderPicker() so re-rendering the options doesn't stack
// duplicate change listeners — init() should be the only place this runs.
function bindPicker() {
  if (!els.picker) return;
  els.picker.addEventListener("change", () => {
    const id = els.picker.value;
    const entry = LineageCore.resolveManifestEntry(state.manifest, { paper: id });
    if (!entry) return;
    const url = new URL(window.location.href);
    url.searchParams.set("paper", entry.paper_id);
    url.searchParams.delete("arxiv");
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
  // Same pattern as theme.js / lineage.js: the HTML now ships a
  // `.canvas-loading` element with a spinner; we just hide it once
  // the data resolves.
  const [loadedManifest, quality] = await Promise.all([
    loadManifest(),
    loadQualityManifest(),
  ]);
  state.quality = quality;
  state.manifestSha256 = loadedManifest?.sha256 || null;
  if (loadedManifest && quality) {
    const conference = loadedManifest.manifest.conference;
    const entries = loadedManifest.manifest.entries.filter((candidate) => {
      const path = `${conference}/${candidate.filename}`;
      const row = LineageCore.resolveQualityCollection(quality, {
        kind: "deep", conference, paperId: candidate.paper_id, path,
      });
      return LineageCore.qualityRowIsEligible(row, {
        manifestSha256: loadedManifest.sha256,
      });
    });
    state.manifest = { ...loadedManifest.manifest, entries };
  }
  const params = new URLSearchParams(window.location.search);
  const requestedPaper = params.get("paper");
  const requestedArxiv = requestedPaper ? null : params.get("arxiv");
  const entry = LineageCore.resolveManifestEntry(state.manifest, {
    paper: requestedPaper,
    arxiv: requestedArxiv,
  });
  // A specific paper was requested but it has no pre-built deep tree —
  // e.g. a theme card links here with a non-conference arxiv id (themes
  // viewer papers are virtually never in the conference deep manifest).
  // Previously this SILENTLY fell back to manifest[0], so the page showed
  // a DIFFERENT paper's lineage under the requested id (the user clicked
  // "深掘り: X" and got paper Y). Surface it honestly instead of swapping.
  if ((requestedPaper || requestedArxiv) && !entry) {
    const canvasLoading = document.getElementById("canvas-loading");
    if (canvasLoading) canvasLoading.hidden = true;
    return;
  }
  // With no explicit ID, the first already-validated manifest entry is the
  // landing view. Raw URL values never become filenames.
  if (!entry) {
    const canvasLoading = document.getElementById("canvas-loading");
    if (canvasLoading) canvasLoading.hidden = true;
    return;
  }
  state.currentPaperId = entry.paper_id;
  state.currentArxivId = entry.arxiv_id;

  const jsonName = entry.filename;
  const artifactPath = `${state.manifest.conference}/${jsonName}`;
  const qualityRow = LineageCore.resolveQualityCollection(state.quality, {
    kind: "deep",
    conference: state.manifest.conference,
    paperId: entry.paper_id,
    path: artifactPath,
  });
  const loadedArtifact = await LineageCore.fetchJsonWithSha256(jsonName);
  if (loadedArtifact && LineageCore.qualityRowIsPublishable(qualityRow, {
    artifactSha256: loadedArtifact.sha256,
    manifestSha256: state.manifestSha256,
  })) {
    state.data = LineageCore.parseArtifact(loadedArtifact.data, { kind: "deep" });
  }
  const canvasLoading = document.getElementById("canvas-loading");
  if (canvasLoading) canvasLoading.hidden = true;

  if (!state.data) {
    return;
  }

  const rootFocus = LineageCore.resolveFocus(state.data, entry.paper_id);
  if (!rootFocus || rootFocus.id !== state.data.root
      || state.data.meta.seed_paper_id !== entry.paper_id) {
    showErrorHtml(`<p>manifest と deep lineage の起点IDが一致しません。</p>`);
    return;
  }
  state.focusId = rootFocus.id;
  const auditStatus = document.getElementById("lineage-audit-status");
  const readyUi = document.getElementById("lineage-ready-ui");
  if (auditStatus) auditStatus.hidden = true;
  if (readyUi) readyUi.hidden = false;
  const heroTitle = document.getElementById("lineage-page-title");
  const heroLede = document.getElementById("lineage-page-lede");
  const heroNote = document.getElementById("lineage-page-note");
  const footerHint = document.getElementById("deep-footer-hint");
  if (heroTitle) heroTitle.textContent = "Deep Lineage — 1 本を深掘り（監査済み）";
  if (heroLede) heroLede.textContent = "品質監査に合格した論文の深掘り系譜を表示しています。";
  if (heroNote) heroNote.textContent = "表示中のデータは構造・識別子・関係根拠と入力ハッシュを検証済みです。";
  if (footerHint) footerHint.textContent = "エッジにホバー → 分類理由 · カードクリック → 中心を切替";
  bindViewButtons();

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
  if (n) document.title = `${PP.truncateTitle(n.title)} — Deep Lineage — PaperPilot`;
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
    syncDisplayUrl();
    render();
  });
}

function bindViewButtons() {
  for (const button of document.querySelectorAll(".view-btn[data-view]")) {
    button.addEventListener("click", () => setView(button.dataset.view));
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }
}

function setView(view) {
  if (!["list", "graph"].includes(view) || state.view === view) return;
  state.view = view;
  for (const button of document.querySelectorAll(".view-btn[data-view]")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  savePrefs();
  syncDisplayUrl();
  render();
  if (view === "list") els.relationList?.focus({ preventScroll: true });
}

function syncDisplayUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("view", state.view);
  url.searchParams.set("relations", [...state.visibleRelations].sort().join(","));
  window.history.replaceState({}, "", url);
}

function focusPaper(id) {
  if (!id || state.focusId === id) return;
  // Mirror lineage.js: after re-render, move keyboard focus to the new
  // center card so Tab navigation continues from the deepened view.
  const cameFromKeyboard = document.activeElement?.classList?.contains("node-card");
  state.focusId = id;
  render();
  scrollToFocus(true);
  updateTitle();
  if (cameFromKeyboard) {
    requestAnimationFrame(() => {
      const next = els.svg?.querySelector(".node-card--focus");
      if (next instanceof HTMLElement) next.focus({ preventScroll: true });
    });
  }
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
  const positioned = layoutTree(nodes, edges, state.focusId);
  const activeEdges = LineageCore.selectActiveEdges(
    edges,
    state.visibleRelations,
    new Set(positioned.map((node) => node.id)),
  );
  const isList = state.view === "list";
  els.canvas.hidden = isList;
  if (els.relationList) els.relationList.hidden = !isList;
  if (isList) {
    renderRelationList(activeEdges);
    return;
  }
  // drawSvg returns a promise once fonts/layout settle so card heights
  // and edge endpoints align after web fonts finish loading. Surface
  // any unexpected rejection in the console instead of silently
  // dropping it via `void` — a blank graph with no signal is worse
  // than a visible error during development.
  drawSvg(positioned, activeEdges).catch((err) => {
    console.error("[deep] drawSvg failed:", err);
  });
}

function renderRelationList(edges) {
  if (!els.relationList) return;
  const nodes = new Map(state.data.nodes.map((node) => [node.id, node]));
  if (edges.length === 0) {
    els.relationList.innerHTML = `<p class="empty-state">現在の条件で表示できる関係はありません。</p>`;
    return;
  }
  els.relationList.innerHTML = `<ol class="relation-list__items">${edges.map((edge) => {
    const source = nodes.get(edge.src);
    const target = nodes.get(edge.dst);
    const provenance = edge.provenance;
    const classification = provenance.classification;
    return `<li class="relation-row">
      <div class="relation-row__path">
        <span>${escapeHtml(source?.title || edge.src)}</span>
        <strong>${escapeHtml(RELATION_LABEL_JA[edge.relation] || edge.relation)}</strong>
        <span>${escapeHtml(target?.title || edge.dst)}</span>
      </div>
      <p class="relation-row__rationale">${escapeHtml(edge.rationale)}</p>
      <dl class="relation-row__meta">
        <div><dt>確信度</dt><dd>${Math.round(edge.confidence * 100)}%</dd></div>
        <div><dt>根拠</dt><dd>${escapeHtml(`${provenance.evidence.source}/${provenance.evidence.kind}`)}</dd></div>
        <div><dt>生成</dt><dd>${escapeHtml(`${provenance.producer.name}@${provenance.producer.version}`)}</dd></div>
        <div><dt>分類</dt><dd>${escapeHtml(`${classification.method} · ${classification.model || "非LLM"} · ${classification.schema_version}`)}</dd></div>
      </dl>
    </li>`;
  }).join("")}</ol>`;
}

// ---------- Tree layout (unbounded depth) ----------

function layoutTree(nodes, edges, focusId) {
  const parents = new Map();
  const children = new Map();
  for (const n of nodes) { parents.set(n.id, []); children.set(n.id, []); }
  for (const e of edges) {
    if (!GENEALOGY.has(e.relation) && e.relation !== "contrasts"
        && e.relation !== "baseline_only") continue;
    parents.get(e.dst)?.push({ id: e.src, rel: e.relation });
    children.get(e.src)?.push({ id: e.dst, rel: e.relation });
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
    ["supersedes", "oklch(50% 0.14 75)", "filled"],
    ["successor",  "oklch(64% 0.13 80)", "filled"],
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
    // a11y: see equivalent block in lineage.js — Tab + Enter / Space
    // re-centers the family-tree on this paper.
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `論文を中心に設定: ${p.title || p.id}`);
    card.addEventListener("click", () => focusPaper(p.id));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        focusPaper(p.id);
      }
    });

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
  // Fan-out: spread each parent's edge origins across its card bottom
  // (shared PP.fanOffsets) so children don't all radiate from one point.
  const fanOff = PP.fanOffsets(edges, posById, NODE_W);
  for (const e of edges) {
    const a = posById.get(e.src), b = posById.get(e.dst);
    if (!a || !b) continue;
    const ax = a._x + NODE_W / 2 + (fanOff.get(e) || 0);
    const ay = a._y + (a._actualH ?? NODE_H);
    const bx = b._x + NODE_W / 2;
    const by = b._y;
    const midY = (ay + by) / 2;
    const d = `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`;
    const mc = e.relation === "baseline_only" ? "baseline" : e.relation;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `edge edge--${mc}`);
    path.setAttribute("marker-end", `url(#arrow-${mc})`);
    // Shared backbone/branch hierarchy (PP.edgeStyle) — opacity + width
    // per relation, matching the theme + conference viewers.
    const est = PP.edgeStyle(mc, e.confidence);
    if (est) {
      path.style.strokeOpacity = est.opacity;
      path.style.strokeWidth = est.width;
    }
    path.dataset.rel = e.relation;
    path.dataset.rationale = e.rationale || "";
    path.dataset.conf = e.confidence ?? "";
    path.addEventListener("mouseenter", onEdgeHover);
    path.addEventListener("mousemove", onEdgeMove);
    path.addEventListener("mouseleave", onEdgeLeave);
    eg.appendChild(path);
    const label = RELATION_LABEL_JA[e.relation];
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
