// SSII-style technology map: lanes (theme) × time (year) with semantic edges.
// Requires utils.js loaded first.

const TECHMAP_URL = "techmap-data.json";

const { escapeHtml } = window.PP;

const MIN_YEAR = 2010;
const MAX_YEAR = 2026;
const YEAR_W = 120;
const LANE_PAD = 12;
const LANE_TOP = 40;
const LANE_LEFT = 120;
const NODE_W = 156;
const NODE_H = 42;
const NODE_VGAP = 4;
const SVG_PAD = 20;

const state = {
  data: null,
  hiddenLanes: new Set(),
  positioned: new Map(),
};

const svg = document.getElementById("techmap-svg");
const tooltip = document.getElementById("tooltip");
const laneToggle = document.getElementById("lane-toggle");

function ns(tag, attrs = {}, children = []) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(c);
  return el;
}

function yearToX(year) {
  const clamped = Math.max(MIN_YEAR, Math.min(MAX_YEAR, year));
  return LANE_LEFT + (clamped - MIN_YEAR) * YEAR_W;
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function computeLayout() {
  const { nodes, lanes } = state.data;
  const visibleLanes = lanes.filter((l) => !state.hiddenLanes.has(l));

  const cellStacks = new Map(); // `${lane}:${year}` → count so far
  state.positioned.clear();

  let laneTops = new Map();
  let y = LANE_TOP;
  const laneHeights = new Map();

  // First pass: count per (lane, year) to size lanes
  const cellCount = new Map();
  for (const n of nodes) {
    if (!visibleLanes.includes(n.theme)) continue;
    if (n.year < MIN_YEAR) continue;
    const key = `${n.theme}:${n.year}`;
    cellCount.set(key, (cellCount.get(key) || 0) + 1);
  }

  for (const lane of visibleLanes) {
    let maxStack = 1;
    for (let yr = MIN_YEAR; yr <= MAX_YEAR; yr++) {
      const c = cellCount.get(`${lane}:${yr}`) || 0;
      if (c > maxStack) maxStack = c;
    }
    const h = maxStack * NODE_H + (maxStack - 1) * NODE_VGAP + LANE_PAD * 2;
    laneTops.set(lane, y);
    laneHeights.set(lane, h);
    y += h;
  }
  const totalHeight = y + SVG_PAD;

  // Second pass: position nodes
  for (const n of nodes) {
    if (!visibleLanes.includes(n.theme)) continue;
    if (n.year < MIN_YEAR) continue;
    const laneTop = laneTops.get(n.theme);
    const cellKey = `${n.theme}:${n.year}`;
    const stackIdx = cellStacks.get(cellKey) || 0;
    cellStacks.set(cellKey, stackIdx + 1);
    const x = yearToX(n.year) - NODE_W / 2;
    const ny = laneTop + LANE_PAD + stackIdx * (NODE_H + NODE_VGAP);
    state.positioned.set(n.id, { node: n, x, y: ny });
  }

  const totalWidth = yearToX(MAX_YEAR) + NODE_W / 2 + SVG_PAD;
  return { visibleLanes, laneTops, laneHeights, totalHeight, totalWidth };
}

function renderBackground(layout) {
  const frag = document.createDocumentFragment();
  const { visibleLanes, laneTops, laneHeights, totalWidth } = layout;

  // Lane bands
  visibleLanes.forEach((lane, idx) => {
    const top = laneTops.get(lane);
    const h = laneHeights.get(lane);
    frag.appendChild(ns("rect", {
      class: idx % 2 === 0 ? "tm-lane-bg" : "tm-lane-bg--odd tm-lane-bg",
      x: 0, y: top, width: totalWidth, height: h,
    }));
    frag.appendChild(ns("text", {
      class: "tm-lane-label",
      x: 12, y: top + h / 2 + 4,
    })).textContent = `${lane}`;
  });

  // Year ticks
  for (let yr = MIN_YEAR; yr <= MAX_YEAR; yr++) {
    const x = yearToX(yr);
    frag.appendChild(ns("line", {
      class: "tm-year-line",
      x1: x, y1: LANE_TOP - 20, x2: x, y2: layout.totalHeight - SVG_PAD,
    }));
    if (yr % 2 === 0 || yr === MAX_YEAR) {
      const t = ns("text", {
        class: "tm-year-label",
        x, y: LANE_TOP - 24, "text-anchor": "middle",
      });
      t.textContent = String(yr);
      frag.appendChild(t);
    }
  }

  return frag;
}

function renderEdges() {
  const frag = document.createDocumentFragment();
  const { edges } = state.data;

  // Arrow marker defs (one per relation type for color)
  const defs = ns("defs");
  const rels = ["supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts"];
  for (const r of rels) {
    const marker = ns("marker", {
      id: `tm-arrow-${r}`, viewBox: "0 -4 8 8",
      refX: 7, refY: 0, markerWidth: 6, markerHeight: 6, orient: "auto",
    });
    marker.appendChild(ns("path", {
      d: "M0,-3L7,0L0,3Z",
      fill: `var(--rel-${r === "baseline_only" ? "baseline" : r})`,
    }));
    defs.appendChild(marker);
  }
  frag.appendChild(defs);

  for (const e of edges) {
    const s = state.positioned.get(e.src);
    const d = state.positioned.get(e.dst);
    if (!s || !d) continue;

    const x1 = s.x + NODE_W, y1 = s.y + NODE_H / 2;
    const x2 = d.x, y2 = d.y + NODE_H / 2;
    const midX = (x1 + x2) / 2;
    const pathD = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;

    const path = ns("path", {
      class: `tm-edge tm-edge--${e.rel}`,
      d: pathD,
      "marker-end": `url(#tm-arrow-${e.rel})`,
    });
    path.addEventListener("mouseenter", (ev) => showTooltip(ev, e));
    path.addEventListener("mouseleave", hideTooltip);
    frag.appendChild(path);
  }
  return frag;
}

function renderNodes() {
  const frag = document.createDocumentFragment();
  for (const { node, x, y } of state.positioned.values()) {
    const g = ns("g", {
      class: `tm-node${node.is_focus ? " tm-node--focus" : ""}${node.is_trending ? " tm-node--trending" : ""}`,
      transform: `translate(${x},${y})`,
    });
    g.appendChild(ns("rect", {
      class: "tm-node__box",
      width: NODE_W, height: NODE_H,
    }));

    const titleText = truncate(node.title, 38);
    const titleEl = ns("text", {
      class: "tm-node__title",
      x: 6, y: 14,
    });
    titleEl.textContent = titleText;
    g.appendChild(titleEl);

    const meta = ns("text", {
      class: "tm-node__meta",
      x: 6, y: 32,
    });
    const venue = node.venue || "";
    meta.textContent = `${venue} · ${node.year}`;
    g.appendChild(meta);

    // Native title tooltip for full info
    const nativeTitle = ns("title");
    nativeTitle.textContent = `${node.title}\n${venue} ${node.year}${node.tldr ? "\n" + node.tldr : ""}`;
    g.appendChild(nativeTitle);

    g.addEventListener("click", () => {
      window.location.href = `lineage.html?focus=${encodeURIComponent(node.id)}`;
    });
    frag.appendChild(g);
  }
  return frag;
}

function render() {
  const layout = computeLayout();
  svg.setAttribute("width", layout.totalWidth);
  svg.setAttribute("height", layout.totalHeight);
  svg.setAttribute("viewBox", `0 0 ${layout.totalWidth} ${layout.totalHeight}`);
  svg.textContent = "";

  svg.appendChild(renderBackground(layout));
  svg.appendChild(renderEdges());
  svg.appendChild(renderNodes());
}

function showTooltip(ev, edge) {
  const rectTip = tooltip.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = ev.clientX + 12;
  let top = ev.clientY + 12;
  if (left + 300 > vw) left = ev.clientX - 300;
  if (top + 120 > vh) top = ev.clientY - 120;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  document.getElementById("tt-rel").textContent = edge.rel;
  document.getElementById("tt-rationale").textContent = edge.rationale || "";
  document.getElementById("tt-conf").textContent = edge.conf ? `conf ${edge.conf.toFixed(2)}` : "";
  tooltip.classList.add("is-visible");
  tooltip.setAttribute("aria-hidden", "false");
}

function hideTooltip() {
  tooltip.classList.remove("is-visible");
  tooltip.setAttribute("aria-hidden", "true");
}

function renderLaneToggle() {
  const { lanes, lane_counts } = state.data;
  laneToggle.innerHTML = lanes.map((lane) => {
    const pressed = !state.hiddenLanes.has(lane);
    const count = lane_counts[lane] || 0;
    return `<button class="tm-chip" data-lane="${escapeHtml(lane)}" type="button" aria-pressed="${pressed}">${escapeHtml(lane)}<span class="tm-chip__count">${count}</span></button>`;
  }).join("");
  laneToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".tm-chip");
    if (!btn) return;
    const lane = btn.dataset.lane;
    if (state.hiddenLanes.has(lane)) state.hiddenLanes.delete(lane);
    else state.hiddenLanes.add(lane);
    btn.setAttribute("aria-pressed", !state.hiddenLanes.has(lane));
    render();
  });
}

async function init() {
  try {
    const res = await fetch(TECHMAP_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (e) {
    svg.innerHTML = `<text x="20" y="30" fill="red">Failed to load ${TECHMAP_URL}: ${escapeHtml(e.message)}</text>`;
    return;
  }

  // Hide noisy "Other" lane by default
  if (state.data.lanes.includes("Other")) state.hiddenLanes.add("Other");

  renderLaneToggle();
  render();
}

init();
