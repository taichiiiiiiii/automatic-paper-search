// Unified tree controller — conf + deep lineage viewer.
//
// Replaces the tree-mode portions of the legacy docs/assets/lineage.js
// (conf, tree + topics layouts) and docs/assets/deep.js (deep, single
// unbounded tree) with one controller. Invoked from lineage-shell.js
// once the URL router decides to mount the tree viewer.
//
//   PPLineageTree.init({ source: "conf"|"deep", data, mount })
//
// - `source`: "conf" or "deep". Selects layout constants (card size /
//   depth bound) and enables the topics gallery on conf only.
// - `data`: the already-fetched lineage/deep JSON. Data fetches are
//   shell's responsibility — this module has no fetch calls so it can
//   be statically verified to be side-effect free w.r.t. the network.
// - `mount`: DOM element to attach the viewer into. The module replaces
//   the mount's contents entirely.
//
// Edge visual hierarchy = PP.edgeStyle() (shared with theme.js + the
// legacy viewers). Card HTML is built via innerHTML with PP.escapeHtml
// on every interpolated value — this matches the legacy lineage.js /
// deep.js approach and keeps card markup readable. Static test
// test_lineage_tree_js.py verifies every innerHTML site escapes its
// inputs via PP.escapeHtml.
//
// Design spec: DESIGN-372.md §2 S2, brief §Agent V2.

(function (root) {
  "use strict";
  const PP = root.PP || {};

  const SVG_NS = "http://www.w3.org/2000/svg";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  const GENEALOGY = new Set(["supersedes", "successor", "extends", "ablation"]);
  const ALL_RELATIONS = [
    "supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts",
  ];
  const DEFAULT_RELATIONS = [
    "supersedes", "successor", "extends", "ablation", "contrasts",
  ];
  const RELATION_LABEL_JA = {
    supersedes: "置換", successor: "後継", extends: "拡張",
    ablation: "成分分析", baseline_only: "比較", contrasts: "対立",
  };
  // Japanese subtitles for the conf clusters. Unknown clusters fall
  // through to an empty string so the label stands alone.
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

  // Per-mode layout constants. Kept small so the deep cards breathe a
  // little more (more metadata — citations, longer TLDRs) and the conf
  // tree fits a wider fan on a typical laptop viewport.
  const MODE_LAYOUT = {
    conf: {
      NODE_W: 220, NODE_H: 150, LEVEL_GAP: 80,
      SIBLING_GAP: 28, PADDING: 40, MAX_DEPTH: 3,
    },
    deep: {
      NODE_W: 240, NODE_H: 180, LEVEL_GAP: 100,
      SIBLING_GAP: 32, PADDING: 48, MAX_DEPTH: Infinity,
    },
  };

  // Per-source preference localStorage keys. Keeps conf and deep filter
  // selections independent so toggling relations in one viewer doesn't
  // perturb the other.
  const STORAGE_KEY = {
    conf: "pp.lineage-tree.conf.prefs",
    deep: "pp.lineage-tree.deep.prefs",
  };

  if (typeof PP.escapeHtml !== "function") {
    // utils.js must load first — an identity fallback here would turn
    // every innerHTML interpolation into an XSS sink. Fail loudly.
    throw new Error("lineage-tree.js requires utils.js (PP.escapeHtml) to be loaded first");
  }
  const e = PP.escapeHtml;
  const truncateTitle = (typeof PP.truncateTitle === "function")
    ? PP.truncateTitle : (s) => String(s || "").slice(0, 60);
  const formatStars = (typeof PP.formatStars === "function")
    ? PP.formatStars : (n) => (typeof n === "number" && n > 0 ? n.toString() : "");
  const formatVenue = (typeof PP.formatVenue === "function")
    ? PP.formatVenue : (v, y) => [v, y].filter(Boolean).join(" ");

  let state = null;
  let els = null;

  // ---------- Persistence ------------------------------------------------

  function loadPrefs() {
    if (!state) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY[state.source]);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function savePrefs() {
    if (!state) return;
    try {
      localStorage.setItem(STORAGE_KEY[state.source], JSON.stringify({
        visibleRelations: [...state.visibleRelations],
      }));
    } catch { /* disabled */ }
  }

  // ---------- init --------------------------------------------------------

  // Public entry point. Clears `mount`, builds the viewer shell inside,
  // loads persisted prefs, resolves the initial focus, and renders.
  function init({ source, data, mount }) {
    if (!mount || !data || !Array.isArray(data.nodes)) return;
    if (!MODE_LAYOUT[source]) return;
    const prefs = loadPrefsFor(source);
    state = {
      source,
      data,
      mount,
      layout: source === "conf" ? "topics" : "tree",
      focusId: null,
      currentCluster: null,
      visibleRelations: new Set(
        Array.isArray(prefs?.visibleRelations) && prefs.visibleRelations.length > 0
          ? prefs.visibleRelations.filter((r) => ALL_RELATIONS.includes(r))
          : DEFAULT_RELATIONS
      ),
      ...MODE_LAYOUT[source],
    };

    // Wipe any V1 placeholder the shell may have mounted before this
    // module loaded.
    while (mount.firstChild) mount.removeChild(mount.firstChild);

    // Choose initial focus. Deep mode has a single natural root (the
    // paper being deepened). Conf mode shows the topics gallery first;
    // focusId is set on cluster-card click.
    if (source === "deep") {
      state.focusId = data.root || (data.nodes[0] && data.nodes[0].id) || null;
      if (!state.focusId) {
        mount.appendChild(messageEl("表示可能なノードがありません"));
        return;
      }
    }

    buildShell();
    render();
    scrollToFocus(false);
    updateTitle();

    root.PPLineageTree = root.PPLineageTree || {};
    root.PPLineageTree._state = state;
  }

  function loadPrefsFor(source) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY[source]);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  // ---------- Shell construction -----------------------------------------

  function buildShell() {
    const wrap = document.createElement("div");
    wrap.className = `lineage-tree lineage-tree--${state.source}`;

    // Breadcrumb / mode switcher (conf only; deep has no topics).
    if (state.source === "conf") {
      const crumb = document.createElement("div");
      crumb.className = "lineage-crumb";
      crumb.id = "lineage-crumb";
      wrap.appendChild(crumb);
    }

    // Search + layout buttons row (conf has layout toggle; deep does not).
    const toolbar = document.createElement("div");
    toolbar.className = "lineage-tree__toolbar";

    if (state.source === "conf") {
      const layouts = document.createElement("div");
      layouts.className = "lineage-tree__layouts";
      layouts.setAttribute("role", "group");
      layouts.setAttribute("aria-label", "レイアウト切替");
      for (const [id, label] of [
        ["topics", "📚 トピック"], ["tree", "🌳 家系図"],
      ]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "layout-btn";
        b.dataset.layout = id;
        b.setAttribute("aria-pressed", state.layout === id ? "true" : "false");
        b.textContent = label;
        b.addEventListener("click", () => setLayout(id));
        layouts.appendChild(b);
      }
      toolbar.appendChild(layouts);
    }

    const search = document.createElement("div");
    search.className = "lineage-search";
    const input = document.createElement("input");
    input.type = "search";
    input.id = "search-input";
    input.className = "lineage-search__input";
    input.placeholder = "タイトル / 著者で検索";
    input.setAttribute("aria-label", "論文検索");
    input.autocomplete = "off";
    const results = document.createElement("div");
    results.id = "search-results";
    results.className = "lineage-search__results";
    search.appendChild(input);
    search.appendChild(results);
    toolbar.appendChild(search);
    wrap.appendChild(toolbar);

    // Filter chips.
    const filterBar = document.createElement("div");
    filterBar.id = "relation-filter";
    filterBar.className = "lineage-tree__filter-bar";
    filterBar.setAttribute("role", "group");
    filterBar.setAttribute("aria-label", "関係種別フィルタ");
    wrap.appendChild(filterBar);
    renderFilterChips(filterBar);

    // Availability note (design §2 S2): conference lineages carry no
    // citation_count, so the timeline layout the theme viewer offers is
    // not available here — say why instead of silently hiding it.
    if (state.source === "conf") {
      const note = document.createElement("p");
      note.className = "lineage-tree__availability-note";
      note.textContent =
        "この会議の系譜データは引用数メタを持たないため、年表レイアウトは提供していません（ツリー / トピックのみ）。";
      wrap.appendChild(note);
    }

    // Canvas.
    const canvas = document.createElement("div");
    canvas.className = "lineage-canvas";
    canvas.id = "canvas";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.id = "lineage-svg";
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label",
      state.source === "deep"
        ? "Deep lineage family tree"
        : "Conference lineage family tree");
    canvas.appendChild(svg);
    wrap.appendChild(canvas);

    // Tooltip (single instance, reused on edge hover).
    const tooltip = document.createElement("div");
    tooltip.className = "edge-tooltip";
    tooltip.id = "tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.setAttribute("aria-hidden", "true");
    const ttRel = document.createElement("div");
    ttRel.className = "edge-tooltip__rel";
    ttRel.id = "tt-rel";
    const ttRationale = document.createElement("div");
    ttRationale.id = "tt-rationale";
    const ttConf = document.createElement("div");
    ttConf.className = "edge-tooltip__conf";
    ttConf.id = "tt-conf";
    tooltip.appendChild(ttRel);
    tooltip.appendChild(ttRationale);
    tooltip.appendChild(ttConf);
    wrap.appendChild(tooltip);

    els = {
      wrap,
      canvas,
      svg,
      tooltip,
      ttRel,
      ttRationale,
      ttConf,
      filterBar,
      crumb: wrap.querySelector("#lineage-crumb"),
      input,
      results,
    };

    bindSearch();
    state.mount.appendChild(wrap);
  }

  // Plain message paragraph used for terminal "no data" states. Built
  // via textContent so the CSP story is unchanged.
  function messageEl(text) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = text;
    return p;
  }

  // ---------- Filter chips ----------------------------------------------

  function renderFilterChips(bar) {
    // Called from buildShell() BEFORE `els` is assigned — the container
    // must come in as a parameter (reading els.filterBar here silently
    // rendered zero chips; caught in review 2026-08-24).
    if (!bar) return;
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    const labels = {
      supersedes: "置換", successor: "後継", extends: "拡張",
      ablation: "成分分析", baseline_only: "比較", contrasts: "対立",
    };
    for (const r of ALL_RELATIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip chip--rel";
      btn.dataset.rel = r;
      btn.setAttribute("aria-pressed", state.visibleRelations.has(r) ? "true" : "false");
      const dot = document.createElement("span");
      dot.className = `chip__dot chip__dot--${r === "baseline_only" ? "baseline" : r}`;
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode(labels[r] || r));
      btn.addEventListener("click", () => {
        if (state.visibleRelations.has(r)) state.visibleRelations.delete(r);
        else state.visibleRelations.add(r);
        btn.setAttribute("aria-pressed", state.visibleRelations.has(r) ? "true" : "false");
        savePrefs();
        render();
      });
      bar.appendChild(btn);
    }
  }

  // ---------- Layout routing --------------------------------------------

  function setLayout(layout) {
    if (state.source !== "conf") return;
    if (layout !== "topics" && layout !== "tree") return;
    if (state.layout === layout) return;
    state.layout = layout;
    for (const b of els.wrap.querySelectorAll(".layout-btn[data-layout]")) {
      b.setAttribute("aria-pressed", b.dataset.layout === layout ? "true" : "false");
    }
    savePrefs();
    render();
  }

  // ---------- Render dispatch -------------------------------------------

  function render() {
    renderCrumb();
    if (state.source === "conf" && state.layout === "topics") {
      renderTopicsGallery();
      return;
    }
    // Tree mode: drop any topics gallery and restore the SVG.
    const gallery = els.canvas.querySelector(".topics-gallery");
    if (gallery) gallery.remove();
    els.svg.style.display = "";

    const { nodes, edges } = state.data;
    const visibleEdges = edges.filter((ed) => state.visibleRelations.has(ed.rel));
    const positioned = layoutTree(nodes, edges, state.focusId);
    drawSvg(positioned, visibleEdges).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[lineage-tree] drawSvg failed:", err);
    });
  }

  function renderCrumb() {
    if (!els.crumb) return;
    while (els.crumb.firstChild) els.crumb.removeChild(els.crumb.firstChild);
    const clusters = state.data?.clusters || [];
    if (clusters.length === 0 || state.layout !== "tree") {
      els.crumb.hidden = true;
      return;
    }
    els.crumb.hidden = false;
    const cluster = state.currentCluster
      ? clusters.find((c) => c.id === state.currentCluster)
      : clusterForFocus(state.focusId);

    const topicsBtn = document.createElement("button");
    topicsBtn.type = "button";
    topicsBtn.className = "lineage-crumb__link";
    topicsBtn.dataset.action = "topics";
    topicsBtn.textContent = "トピック";
    els.crumb.appendChild(topicsBtn);

    const sep1 = document.createElement("span");
    sep1.className = "lineage-crumb__sep";
    sep1.textContent = "/";
    els.crumb.appendChild(sep1);

    if (cluster) {
      const clBtn = document.createElement("button");
      clBtn.type = "button";
      clBtn.className = "lineage-crumb__link";
      clBtn.dataset.action = "cluster";
      clBtn.dataset.cluster = cluster.id;
      clBtn.textContent = cluster.label;
      els.crumb.appendChild(clBtn);
    }

    const focusNode = state.data.nodes.find((n) => n.id === state.focusId);
    if (focusNode) {
      const sep2 = document.createElement("span");
      sep2.className = "lineage-crumb__sep";
      sep2.textContent = "/";
      els.crumb.appendChild(sep2);
      const cur = document.createElement("span");
      cur.className = "lineage-crumb__current";
      cur.textContent = truncateTitle(focusNode.title, 80);
      els.crumb.appendChild(cur);
    }

    els.crumb.addEventListener("click", onCrumbClick);
  }

  function onCrumbClick(ev) {
    const btn = ev.target.closest("[data-action]");
    if (!btn || !els.crumb.contains(btn)) return;
    if (btn.dataset.action === "topics") {
      state.currentCluster = null;
      setLayout("topics");
    } else if (btn.dataset.action === "cluster") {
      state.currentCluster = btn.dataset.cluster || null;
      setLayout("topics");
    }
  }

  function clusterForFocus(id) {
    for (const c of state.data?.clusters || []) {
      if (Array.isArray(c.focus_ids) && c.focus_ids.includes(id)) return c;
    }
    return null;
  }

  // ---------- Topics gallery (conf only) --------------------------------

  function renderTopicsGallery() {
    els.svg.style.display = "none";
    els.canvas.querySelector(".topics-gallery")?.remove();

    const clusters = state.data?.clusters || [];
    const gallery = document.createElement("div");
    gallery.className = "topics-gallery";

    if (clusters.length === 0) {
      gallery.appendChild(messageEl("クラスタ情報がありません。lineage.json を再生成してください。"));
      els.canvas.appendChild(gallery);
      return;
    }

    const totalPapers = clusters.reduce((s, c) => s + (c.focus_ids?.length || 0), 0);
    const intro = document.createElement("p");
    intro.className = "topics-gallery__intro";
    intro.textContent =
      `${clusters.length} サブフィールド · Oral 採択 ${totalPapers} 本を primary tag でグループ化。カードをクリックすると家系図に切り替わります。`;
    gallery.appendChild(intro);

    const nodesById = new Map(state.data.nodes.map((n) => [n.id, n]));
    for (const cluster of clusters) {
      const section = document.createElement("section");
      section.className = "topics-cluster";
      section.dataset.clusterId = cluster.id;

      const head = document.createElement("div");
      head.className = "topics-cluster__head";
      const h = document.createElement("h2");
      h.className = "topics-cluster__label";
      h.textContent = cluster.label;
      head.appendChild(h);
      const sub = CLUSTER_SUBTITLE[cluster.label] || "";
      if (sub) {
        const s = document.createElement("span");
        s.className = "topics-cluster__subtitle";
        s.textContent = sub;
        head.appendChild(s);
      }
      const count = document.createElement("span");
      count.className = "topics-cluster__count";
      count.textContent = `${(cluster.focus_ids || []).length} 件`;
      head.appendChild(count);
      section.appendChild(head);

      const grid = document.createElement("div");
      grid.className = "topics-cluster__grid";
      for (const fid of cluster.focus_ids || []) {
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
    btn.dataset.focusId = node.id;

    const title = document.createElement("div");
    title.className = "topics-card__title";
    title.textContent = node.title || "";
    btn.appendChild(title);

    const authors = (node.authors || []).slice(0, 3).join(", ")
      + ((node.authors || []).length > 3 ? ` +${node.authors.length - 3}` : "");
    const aEl = document.createElement("div");
    aEl.className = "topics-card__authors";
    aEl.textContent = authors;
    btn.appendChild(aEl);

    const tldr = document.createElement("div");
    tldr.className = "topics-card__tldr";
    tldr.textContent = node.tldr || "";
    btn.appendChild(tldr);

    const meta = document.createElement("div");
    meta.className = "topics-card__meta";
    for (const k of (node.kinds || []).slice(0, 4)) {
      const s = document.createElement("span");
      s.textContent = `#${k}`;
      meta.appendChild(s);
    }
    const starStr = formatStars(node.github_stars);
    if (starStr) {
      const s = document.createElement("span");
      s.textContent = `⭐${starStr}`;
      meta.appendChild(s);
    }
    btn.appendChild(meta);

    btn.addEventListener("click", () => {
      state.currentCluster = clusterId;
      focusPaper(node.id);
      setLayout("tree");
    });
    return btn;
  }

  // ---------- Tree layout -------------------------------------------------

  function layoutTree(nodes, edges, focusId) {
    const parents = new Map();
    const children = new Map();
    for (const n of nodes) { parents.set(n.id, []); children.set(n.id, []); }
    for (const ed of edges) {
      if (!GENEALOGY.has(ed.rel)) continue;
      parents.get(ed.dst)?.push({ id: ed.src, rel: ed.rel });
      children.get(ed.src)?.push({ id: ed.dst, rel: ed.rel });
    }

    const level = new Map();
    if (focusId != null) level.set(focusId, 0);
    else return [];

    // BFS bounded by MAX_DEPTH in each direction. Deep mode uses
    // Infinity so the entire connected component is laid out.
    const maxDown = state.MAX_DEPTH;
    const maxUp = state.MAX_DEPTH;

    const qUp = [focusId];
    while (qUp.length) {
      const id = qUp.shift();
      const lv = level.get(id);
      if (lv <= -maxUp) continue;
      for (const { id: p } of parents.get(id) || []) {
        if (!level.has(p)) { level.set(p, lv - 1); qUp.push(p); }
      }
    }
    const qDown = [focusId];
    while (qDown.length) {
      const id = qDown.shift();
      const lv = level.get(id);
      if (lv >= maxDown) continue;
      for (const { id: c } of children.get(id) || []) {
        if (!level.has(c)) { level.set(c, lv + 1); qDown.push(c); }
      }
    }

    const byLevel = new Map();
    for (const n of nodes) {
      if (!level.has(n.id)) continue;
      const lv = level.get(n.id);
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv).push(n);
    }
    const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
    const zeroIdx = sortedLevels.indexOf(0);
    const GAP_X = state.NODE_W + state.SIBLING_GAP;

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
      positionRow(byLevel.get(sortedLevels[i]) || [], (node) => {
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
        positioned.push({
          ...n,
          _x: xByNodeId.get(n.id) ?? 0,
          _y: idx * (state.NODE_H + state.LEVEL_GAP),
        });
      }
    });
    if (positioned.length === 0) return [];
    const minX = Math.min(...positioned.map((p) => p._x));
    const minY = Math.min(...positioned.map((p) => p._y));
    for (const p of positioned) {
      p._x += state.PADDING - minX;
      p._y += state.PADDING - minY;
    }
    return positioned;
  }

  // ---------- SVG rendering --------------------------------------------

  async function drawSvg(positioned, edges) {
    const posById = new Map(positioned.map((p) => [p.id, p]));

    if (positioned.length === 0) {
      els.svg.innerHTML = "";
      els.canvas.querySelector(".empty-state")?.remove();
      els.canvas.appendChild(messageEl("No data to display."));
      return;
    }

    const W = Math.max(...positioned.map((p) => p._x + state.NODE_W)) + state.PADDING;
    const H = Math.max(...positioned.map((p) => p._y + state.NODE_H)) + state.PADDING;

    els.svg.setAttribute("width", W);
    els.svg.setAttribute("height", H);
    els.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    els.svg.innerHTML = "";

    const defs = buildMarkers();
    els.svg.appendChild(defs);

    // Nodes first so they can be measured before edges land.
    const ng = document.createElementNS(SVG_NS, "g");
    ng.setAttribute("id", "nodes");
    const foById = new Map();
    for (const p of positioned) {
      const fo = document.createElementNS(SVG_NS, "foreignObject");
      fo.setAttribute("x", p._x);
      fo.setAttribute("y", p._y);
      fo.setAttribute("width", state.NODE_W);
      fo.setAttribute("height", state.NODE_H);
      // Let the FOCUS badge (top: -10px) and box-shadow halos render
      // outside the foreignObject viewport — without this they get
      // clipped at the card edge.
      fo.setAttribute("overflow", "visible");
      fo.style.overflow = "visible";
      fo.dataset.nodeId = p.id;

      const card = buildCard(p);
      fo.appendChild(card);
      ng.appendChild(fo);
      foById.set(p.id, { fo, card });
    }
    els.svg.appendChild(ng);

    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch { /* ignore */ }
    }
    await new Promise((r) => requestAnimationFrame(() => r()));

    for (const p of positioned) {
      const entry = foById.get(p.id);
      if (!entry) { p._actualH = state.NODE_H; continue; }
      const h = Math.ceil(entry.card.getBoundingClientRect().height) || state.NODE_H;
      p._actualH = h;
      entry.fo.setAttribute("height", h);
    }
    const measuredH = Math.max(...positioned.map((p) => p._y + p._actualH)) + state.PADDING;
    if (measuredH > H) {
      els.svg.setAttribute("height", measuredH);
      els.svg.setAttribute("viewBox", `0 0 ${W} ${measuredH}`);
    }

    const eg = document.createElementNS(SVG_NS, "g");
    eg.setAttribute("id", "edges");
    const fanOff = (typeof PP.fanOffsets === "function")
      ? PP.fanOffsets(edges, posById, state.NODE_W) : new Map();
    for (const ed of edges) {
      const a = posById.get(ed.src);
      const b = posById.get(ed.dst);
      if (!a || !b) continue;
      const ax = a._x + state.NODE_W / 2 + (fanOff.get(ed) || 0);
      const ay = a._y + (a._actualH ?? state.NODE_H);
      const bx = b._x + state.NODE_W / 2;
      const by = b._y;
      const midY = (ay + by) / 2;
      const d = `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`;
      const mc = markerClass(ed.rel);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", `edge edge--${mc}`);
      path.setAttribute("marker-end", `url(#arrow-${mc})`);
      const est = (typeof PP.edgeStyle === "function") ? PP.edgeStyle(mc, ed.conf) : null;
      if (est) {
        path.style.strokeOpacity = est.opacity;
        path.style.strokeWidth = est.width;
      }
      path.dataset.rel = ed.rel;
      path.dataset.rationale = ed.rationale || "";
      path.dataset.conf = ed.conf ?? "";
      path.dataset.src = ed.src;
      path.dataset.dst = ed.dst;
      path.addEventListener("mouseenter", onEdgeHover);
      path.addEventListener("mousemove", onEdgeMove);
      path.addEventListener("mouseleave", onEdgeLeave);
      eg.appendChild(path);

      const label = RELATION_LABEL_JA[ed.rel];
      if (label) {
        const lx = (ax + bx) / 2;
        const ly = midY;
        const bg = document.createElementNS(SVG_NS, "rect");
        bg.setAttribute("class", `edge-label-bg edge-label-bg--${mc}`);
        bg.setAttribute("x", lx - 14);
        bg.setAttribute("y", ly - 8);
        bg.setAttribute("width", 28);
        bg.setAttribute("height", 16);
        bg.setAttribute("rx", 3);
        eg.appendChild(bg);
        const text = document.createElementNS(SVG_NS, "text");
        text.setAttribute("class", `edge-label edge-label--${mc}`);
        text.setAttribute("x", lx);
        text.setAttribute("y", ly + 4);
        text.setAttribute("text-anchor", "middle");
        text.textContent = label;
        eg.appendChild(text);
      }
    }
    els.svg.insertBefore(eg, ng);
  }

  // Arrow marker definitions. Colours come from the same oklch values
  // the theme viewer uses — the legend + 仕組み page describe them,
  // this module just paints them on the SVG markers.
  function buildMarkers() {
    const defs = document.createElementNS(SVG_NS, "defs");
    const palette = state.source === "deep"
      ? [
          ["supersedes", "oklch(50% 0.14 75)", "filled"],
          ["successor",  "oklch(64% 0.13 80)", "filled"],
          ["extends",    "oklch(62% 0.14 145)", "filled"],
          ["ablation",   "oklch(60% 0.13 240)", "hollow"],
          ["baseline",   "oklch(60% 0.02 270)", "dot"],
          ["contrasts",  "oklch(58% 0.20 25)", "cross"],
        ]
      : [
          ["supersedes", "oklch(55% 0.14 75)", "filled"],
          ["successor",  "oklch(72% 0.13 80)", "filled"],
          ["extends",    "oklch(62% 0.14 145)", "filled"],
          ["ablation",   "oklch(60% 0.13 240)", "hollow"],
          ["baseline",   "oklch(60% 0.02 270)", "dot"],
          ["contrasts",  "oklch(58% 0.20 25)", "cross"],
        ];
    for (const [key, color, kind] of palette) {
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
        shape.setAttribute("cx", "5");
        shape.setAttribute("cy", "5");
        shape.setAttribute("r", "3");
        shape.setAttribute("fill", "white");
        shape.setAttribute("stroke", color);
        shape.setAttribute("stroke-width", "1.5");
      } else if (kind === "dot") {
        shape = document.createElementNS(SVG_NS, "circle");
        shape.setAttribute("cx", "5");
        shape.setAttribute("cy", "5");
        shape.setAttribute("r", "1.8");
        shape.setAttribute("fill", color);
      } else {
        shape = document.createElementNS(SVG_NS, "path");
        shape.setAttribute("d", "M0,0 L10,10 M10,0 L0,10");
        shape.setAttribute("stroke", color);
        shape.setAttribute("stroke-width", "1.8");
        shape.setAttribute("fill", "none");
      }
      m.appendChild(shape);
      defs.appendChild(m);
    }
    return defs;
  }

  function buildCard(p) {
    const card = document.createElement("div");
    card.setAttribute("xmlns", XHTML_NS);
    card.className = "node-card" + (state.source === "deep" ? " node-card--deep" : "");
    if (p.id === state.focusId) card.classList.add("node-card--focus");
    if (p.is_trending && state.source === "conf") card.classList.add("node-card--trending");
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `論文を選択: ${p.title || p.id}`);
    card.addEventListener("click", () => focusPaper(p.id));
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
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
    const venue = formatVenue(p.venue, p.year);
    const authors = (p.authors || []).slice(0, state.source === "deep" ? 3 : 2).join(", ")
      + ((p.authors || []).length > (state.source === "deep" ? 3 : 2)
          ? ` +${(p.authors || []).length - (state.source === "deep" ? 3 : 2)}` : "");
    const kinds = (p.kinds || [])
      .map((k) => `<span class="node-card__kind">${e(k)}</span>`)
      .join("");
    const starStr = formatStars(p.github_stars);
    const stars = starStr ? `<span class="node-card__stars">⭐${e(starStr)}</span>` : "";
    const trending = (p.is_trending && state.source === "conf")
      ? `<span class="trending-badge">📈 trending</span>` : "";
    const cits = (state.source === "deep" && typeof p.citation_count === "number" && p.citation_count > 0)
      ? `<span class="node-card__cit">📖 ${e(p.citation_count.toLocaleString())}</span>` : "";

    // Every interpolated value passes through PP.escapeHtml (aliased
    // as `e`). innerHTML here is acceptable because no raw fetch /
    // user input reaches the template without escaping.
    card.innerHTML = `
      <div class="node-card__venue">
        <span class="node-card__venue-tier node-card__venue-tier--${e(tier)}">${e(venue || "—")}</span>
        ${trending}
      </div>
      <h3 class="node-card__title">${e(p.title || "")}</h3>
      <div class="node-card__authors">${e(authors)}</div>
      <div class="node-card__tldr">${e(p.tldr || "")}</div>
      <div class="node-card__meta">
        ${kinds}
        ${stars}
        ${cits}
      </div>
    `;
    return card;
  }

  function markerClass(rel) {
    return rel === "baseline_only" ? "baseline" : rel;
  }

  // ---------- Focus / scroll / title -----------------------------------

  function focusPaper(id) {
    if (!id || state.focusId === id) return;
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

  function updateTitle() {
    const n = state.data?.nodes.find((x) => x.id === state.focusId);
    if (n) {
      const suffix = state.source === "deep" ? " — Deep Lineage" : " — Lineage";
      document.title = `${truncateTitle(n.title)}${suffix} — PaperPilot`;
    }
  }

  function scrollToFocus(smooth) {
    requestAnimationFrame(() => {
      if (!els.svg || !els.canvas) return;
      const focusFo = [...els.svg.querySelectorAll("foreignObject")].find(
        (el) => el.querySelector(".node-card--focus")
      );
      if (!focusFo) return;
      const x = parseFloat(focusFo.getAttribute("x")) + state.NODE_W / 2;
      const y = parseFloat(focusFo.getAttribute("y")) + state.NODE_H / 2;
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

  function highlightConnectedEdges(nodeId, on) {
    if (!els.svg) return;
    for (const path of els.svg.querySelectorAll(".edge")) {
      if (path.dataset.src === nodeId || path.dataset.dst === nodeId) {
        path.classList.toggle("edge--highlight", on);
      } else {
        path.classList.toggle("edge--dim", on);
      }
    }
  }

  // ---------- Search ----------------------------------------------------

  function bindSearch() {
    if (!els.input || !els.results) return;
    const renderResults = (q) => {
      if (!q) {
        els.results.classList.remove("is-open");
        while (els.results.firstChild) els.results.removeChild(els.results.firstChild);
        return;
      }
      const lower = q.toLowerCase();
      const matches = state.data.nodes
        .filter((n) => ((n.title + " " + (n.authors || []).join(" ")).toLowerCase()).includes(lower))
        .slice(0, 8);
      while (els.results.firstChild) els.results.removeChild(els.results.firstChild);
      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "lineage-search__empty";
        empty.textContent = "一致なし";
        els.results.appendChild(empty);
      } else {
        for (const n of matches) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "lineage-search__item";
          btn.dataset.id = n.id;
          const t = document.createElement("span");
          t.className = "lineage-search__title";
          t.textContent = n.title || "";
          const s = document.createElement("span");
          s.className = "lineage-search__sub";
          s.textContent = formatVenue(n.venue, n.year);
          btn.appendChild(t);
          btn.appendChild(s);
          els.results.appendChild(btn);
        }
      }
      els.results.classList.add("is-open");
    };
    els.input.addEventListener("input", (ev) => renderResults(ev.target.value.trim()));
    els.input.addEventListener("focus", (ev) => {
      if (ev.target.value.trim()) renderResults(ev.target.value.trim());
    });
    els.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        els.input.value = "";
        els.results.classList.remove("is-open");
        els.input.blur();
      }
      if (ev.key === "Enter") {
        const first = els.results.querySelector(".lineage-search__item");
        if (first) first.click();
      }
    });
    els.results.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".lineage-search__item");
      if (!btn) return;
      focusPaper(btn.dataset.id);
      if (state.source === "conf" && state.layout !== "tree") setLayout("tree");
      els.input.value = "";
      els.results.classList.remove("is-open");
    });
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest(".lineage-search")) {
        els.results.classList.remove("is-open");
      }
    });
  }

  // ---------- Edge tooltip ----------------------------------------------

  function onEdgeHover(ev) {
    const cur = ev.currentTarget;
    els.ttRel.textContent = (cur.dataset.rel || "").replace("_", " ");
    els.ttRationale.textContent = cur.dataset.rationale || "";
    const c = cur.dataset.conf;
    els.ttConf.textContent = c ? `confidence ${Number(c).toFixed(2)}` : "";
    els.tooltip.classList.add("is-visible");
    els.tooltip.setAttribute("aria-hidden", "false");
    onEdgeMove(ev);
  }
  function onEdgeMove(ev) {
    const pad = 12;
    const tt = els.tooltip;
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    const w = tt.offsetWidth || 280;
    const h = tt.offsetHeight || 80;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    tt.style.left = `${Math.max(8, x)}px`;
    tt.style.top = `${Math.max(8, y)}px`;
  }
  function onEdgeLeave() {
    els.tooltip.classList.remove("is-visible");
    els.tooltip.setAttribute("aria-hidden", "true");
  }

  root.PPLineageTree = { init };
})(window);
