// PaperPilot audited lineage Focus View. Requires catalog-core.js and lineage-v2-core.js.
(() => {
  "use strict";

  const INDEX_URL = "../lineage-pilot-index-v1.json";
  const MAX_BYTES = Object.freeze({ index: 256 * 1024, artifact: 8 * 1024 * 1024, fixture: 8 * 1024 * 1024, quality: 256 * 1024, catalog: 8 * 1024 * 1024 });
  const LOAD_TIMEOUT_MS = 30_000;
  const LIST_PAGE_SIZE = 20;
  const PAPER_ID = /^[0-9a-f]{40}$/;
  const RELATIONS = Object.freeze(["supersedes", "successor", "extends", "ablation", "baseline_only", "contrasts"]);
  const RELATION_LABELS = Object.freeze({ supersedes: "置換", successor: "後継", extends: "拡張", ablation: "アブレーション", baseline_only: "ベースライン比較", contrasts: "対照" });
  const EXCLUSION_LABELS = Object.freeze({ decision: "非採択判定", trust: "信頼段階", family: "関係族", relation: "関係タイプ", confidence: "確信度", evidence: "証拠", hop: "hop 範囲", branch: "枝の折り畳み", nodeCap: "論文上限", claimCap: "関係上限", collapse: "折り畳み" });

  const Core = window.PaperPilotLineageV2;
  const CatalogCore = window.PaperPilotCatalogCore;
  const model = {
    release: null,
    paperId: null,
    viewState: null,
    projection: null,
    page: 1,
    loadOwner: null,
    inspectorTrigger: null,
  };

  const els = {
    audit: document.getElementById("lineage-audit-status"),
    auditHeading: document.getElementById("lineage-audit-heading"),
    auditMessage: document.getElementById("lineage-audit-message"),
    ready: document.getElementById("lineage-ready"),
    title: document.getElementById("lineage-title"),
    meta: document.getElementById("lineage-paper-meta"),
    back: document.getElementById("lineage-catalog-back"),
    hops: document.getElementById("lineage-hops"),
    limit: document.getElementById("lineage-limit"),
    confidence: document.getElementById("lineage-confidence"),
    tentative: document.getElementById("lineage-tentative"),
    genealogy: document.getElementById("lineage-genealogy"),
    comparison: document.getElementById("lineage-comparison"),
    advancedSummary: document.getElementById("lineage-advanced-summary"),
    relationOptions: document.getElementById("lineage-relation-options"),
    evidenceSourceOptions: document.getElementById("lineage-evidence-source-options"),
    evidenceKindOptions: document.getElementById("lineage-evidence-kind-options"),
    counts: document.getElementById("lineage-counts"),
    exclusions: document.getElementById("lineage-exclusions"),
    forceList: document.getElementById("lineage-force-list"),
    graphPanel: document.getElementById("lineage-graph-panel"),
    graph: document.getElementById("lineage-graph"),
    nodeCards: document.getElementById("lineage-node-cards"),
    listPanel: document.getElementById("lineage-list-panel"),
    list: document.getElementById("lineage-claim-list"),
    pageStatus: document.getElementById("lineage-page-status"),
    pagination: document.getElementById("lineage-pagination"),
    inspector: document.getElementById("lineage-inspector"),
    inspectorBody: document.getElementById("lineage-inspector-body"),
  };

  function closed(message) {
    closeInspector(false);
    model.release = null;
    model.projection = null;
    if (els.ready) els.ready.hidden = true;
    if (els.audit) {
      els.audit.hidden = false;
      els.audit.classList.add("is-closed");
    }
    if (els.auditMessage) els.auditMessage.textContent = message;
    if (els.auditHeading) els.auditHeading.textContent = "監査済みの系譜は表示できません";
  }

  function loading() {
    if (els.ready) els.ready.hidden = true;
    if (els.audit) {
      els.audit.hidden = false;
      els.audit.classList.remove("is-closed");
    }
    if (els.auditMessage) els.auditMessage.textContent = "公開索引と監査情報の一致を確認しています。";
    if (els.auditHeading) els.auditHeading.textContent = "研究系譜を検証しています";
  }

  function loadOwner(timer = globalThis) {
    const controller = new AbortController();
    let active = true;
    const timerId = timer.setTimeout(() => {
      if (!active) return;
      active = false;
      controller.abort(new DOMException("lineage load timed out", "TimeoutError"));
    }, LOAD_TIMEOUT_MS);
    return Object.freeze({
      controller,
      isActive: () => active,
      finish() {
        if (!active) return;
        active = false;
        timer.clearTimeout(timerId);
      },
      abandon() {
        if (!active) return;
        active = false;
        timer.clearTimeout(timerId);
        controller.abort(new DOMException("lineage load abandoned", "AbortError"));
      },
    });
  }

  async function readBounded(response, maxBytes) {
    if (!response?.ok || response.redirected === true) throw new Error("response refused");
    const length = response.headers?.get?.("content-length");
    if (length !== null && length !== undefined) {
      if (!/^[0-9]+$/.test(length) || Number(length) > maxBytes) throw new Error("response too large");
    }
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error("response too large");
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("response too large");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async function fetchBytes(url, maxBytes, signal, fetchImpl = fetch) {
    const expected = new URL(url, window.location.href);
    if (expected.origin !== window.location.origin) throw new Error("cross-origin path refused");
    const response = await fetchImpl(expected.href, {
      cache: "no-cache",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "same-origin",
      signal,
      headers: { accept: "application/json" },
    });
    if (response.url && new URL(response.url).href !== expected.href) throw new Error("redirected response refused");
    return readBounded(response, maxBytes);
  }

  function parseJsonBytes(bytes) {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  async function loadVerifiedRelease(paperId, owner, deps = {}) {
    const core = deps.core ?? Core;
    const catalogCore = deps.catalogCore ?? CatalogCore;
    const fetchImpl = deps.fetchImpl ?? fetch;
    if (!core || !catalogCore || !PAPER_ID.test(paperId)) return null;
    const root = new URL("../", window.location.href);
    const indexBytes = await fetchBytes(new URL("lineage-pilot-index-v1.json", root), MAX_BYTES.index, owner.controller.signal, fetchImpl);
    const index = core.parsePilotIndex(parseJsonBytes(indexBytes));
    const entry = index && core.resolvePilotEntry(index, paperId);
    if (!entry) return null;
    const urls = {
      artifact: new URL(entry.artifact.path, root),
      fixture: new URL(entry.fixture.path, root),
      quality: new URL(entry.quality.path, root),
      catalog: new URL(`${entry.conference}/papers.json`, root),
    };
    const [artifactBytes, fixtureBytes, qualityBytes, catalogBytes] = await Promise.all([
      fetchBytes(urls.artifact, MAX_BYTES.artifact, owner.controller.signal, fetchImpl),
      fetchBytes(urls.fixture, MAX_BYTES.fixture, owner.controller.signal, fetchImpl),
      fetchBytes(urls.quality, MAX_BYTES.quality, owner.controller.signal, fetchImpl),
      fetchBytes(urls.catalog, MAX_BYTES.catalog, owner.controller.signal, fetchImpl),
    ]);
    const catalog = catalogCore.validateCatalog(parseJsonBytes(catalogBytes));
    const catalogPaperIds = [...catalog.keys()];
    return core.verifyPilotRelease({ entry, artifactBytes, fixtureBytes, qualityBytes, catalogPaperIds });
  }

  function preferenceInput() {
    let prefs = {};
    try {
      const raw = localStorage.getItem("paperpilotLineageFocusV1");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prefs = parsed;
      }
    } catch (_) { /* preference storage is optional */ }
    return {
      params: new URLSearchParams(window.location.search),
      prefs,
      mobile: window.matchMedia?.("(max-width: 720px)").matches === true,
    };
  }

  function persistPreferences(state) {
    try {
      localStorage.setItem("paperpilotLineageFocusV1", JSON.stringify({ view: state.view, hops: String(state.hops), min_conf: String(state.minConfidence) }));
    } catch (_) { /* preference storage is optional */ }
  }

  function nodeMap() {
    return new Map(model.projection.nodes.map((node) => [node.id, node]));
  }

  function evidenceMap() {
    return new Map(model.release.artifact.evidence.map((item) => [item.id, item]));
  }

  function labelForRelation(relation) {
    return RELATION_LABELS[relation] || relation || "未分類";
  }

  function button(label, action, value) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.dataset.action = action;
    if (value !== undefined) element.dataset.value = value;
    return element;
  }

  function buildRelationOptions() {
    if (!els.relationOptions || els.relationOptions.childElementCount) return;
    for (const relation of RELATIONS) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = relation;
      input.dataset.action = "relation";
      label.append(input, document.createTextNode(labelForRelation(relation)));
      els.relationOptions.append(label);
    }
  }

  function buildEvidenceOptions() {
    const addOptions = (container, values, action) => {
      container.replaceChildren();
      for (const value of values) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = value;
        input.dataset.action = action;
        label.append(input, document.createTextNode(value));
        container.append(label);
      }
    };
    const sources = [...new Set(model.release.artifact.evidence.map((item) => item.source))].sort();
    const kinds = [...new Set(model.release.artifact.evidence.map((item) => item.kind))].sort();
    addOptions(els.evidenceSourceOptions, sources, "evidence-source");
    addOptions(els.evidenceKindOptions, kinds, "evidence-kind");
  }

  function renderControls() {
    const state = model.viewState;
    if (els.limit) els.limit.value = String(state.nodeLimit);
    const effectiveView = model.projection.forceList ? "list" : state.view;
    document.querySelectorAll('[data-action="view"]').forEach((control) => control.setAttribute("aria-pressed", String(control.dataset.value === effectiveView)));
    if (els.hops) els.hops.value = String(state.hops);
    if (els.confidence) els.confidence.value = String(state.minConfidence);
    if (els.tentative) els.tentative.checked = state.trustTiers.includes("tentative");
    if (els.genealogy) els.genealogy.checked = state.families.includes("genealogy");
    if (els.comparison) els.comparison.checked = state.families.includes("comparison");
    const advancedActive = state.minConfidence !== 0.7
      || state.trustTiers.includes("tentative")
      || state.families.length !== 1 || state.families[0] !== "genealogy"
      || state.relationFilterExplicit || state.evidenceSourcesExplicit || state.evidenceKindsExplicit;
    if (els.advancedSummary) els.advancedSummary.textContent = advancedActive ? "詳細な絞り込み（適用中）" : "詳細な絞り込み";
    els.relationOptions?.querySelectorAll('input[data-action="relation"]').forEach((input) => { input.checked = state.relations.includes(input.value); });
    els.evidenceSourceOptions?.querySelectorAll('input[data-action="evidence-source"]').forEach((input) => { input.checked = !state.evidenceSourcesExplicit || state.evidenceSources.includes(input.value); });
    els.evidenceKindOptions?.querySelectorAll('input[data-action="evidence-kind"]').forEach((input) => { input.checked = !state.evidenceKindsExplicit || state.evidenceKinds.includes(input.value); });
  }

  function renderSummary() {
    const { counts, exclusions } = model.projection;
    els.counts.textContent = `表示 ${counts.shownNodes} / ${counts.totalNodes} 論文 · ${counts.shownClaims} / ${counts.eligibleClaims} 関係（採択 ${counts.acceptedClaims}）`;
    const parts = Object.entries(exclusions).filter(([, count]) => count > 0).map(([key, count]) => `${EXCLUSION_LABELS[key] || key} ${count}`);
    const statuses = model.projection.statusCodes.length ? ` · URL状態: ${model.projection.statusCodes.join(", ")}` : "";
    els.exclusions.textContent = (parts.length ? `除外: ${parts.join(" · ")}` : "除外なし") + statuses;
  }

  function shortTitle(title, max = 31) {
    return title.length > max ? `${title.slice(0, max - 1)}…` : title;
  }

  function layeredLayout(nodes, claims) {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const trusted = claims.filter((claim) => claim.claim_family === "genealogy"
      && claim.decision === "accepted" && ["verified", "corroborated"].includes(claim.trust_tier)
      && nodeIds.has(claim.src) && nodeIds.has(claim.dst));
    const outgoing = new Map(nodes.map((node) => [node.id, []]));
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const rank = new Map(nodes.map((node) => [node.id, 0]));
    for (const claim of trusted) {
      outgoing.get(claim.src).push(claim.dst);
      indegree.set(claim.dst, indegree.get(claim.dst) + 1);
    }
    for (const values of outgoing.values()) values.sort();
    const queue = nodes.map((node) => node.id).filter((id) => indegree.get(id) === 0).sort();
    while (queue.length) {
      const id = queue.shift();
      for (const child of outgoing.get(id)) {
        rank.set(child, Math.max(rank.get(child), rank.get(id) + 1));
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) {
          queue.push(child);
          queue.sort((left, right) => left.localeCompare(right));
        }
      }
    }
    // The verified producer normally guarantees a DAG. A defensive residual
    // cycle (and its blocked descendants) does not gain partial semantic rank.
    for (const node of nodes) {
      if (indegree.get(node.id) > 0) rank.set(node.id, 0);
    }
    const layers = new Map();
    for (const node of nodes) {
      const value = rank.get(node.id);
      if (!layers.has(value)) layers.set(value, []);
      layers.get(value).push(node);
    }
    for (const values of layers.values()) {
      values.sort((left, right) => left.id.localeCompare(right.id));
    }
    const positions = new Map();
    for (const [layer, values] of [...layers].sort(([left], [right]) => left - right)) {
      values.forEach((node, index) => positions.set(node.id, { x: 105 + layer * 250, y: 75 + index * 122 }));
    }
    return { positions, rankCount: Math.max(1, ...layers.keys()) + 1, maxLayerSize: Math.max(1, ...[...layers.values()].map((values) => values.length)) };
  }

  function rectangleEdgePoints(from, to, halfWidth = 65, halfHeight = 31) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 0 && dy === 0) return { start: { ...from }, end: { ...to } };
    const xScale = dx === 0 ? Infinity : halfWidth / Math.abs(dx);
    const yScale = dy === 0 ? Infinity : halfHeight / Math.abs(dy);
    const scale = Math.min(xScale, yScale);
    return {
      start: { x: from.x + dx * scale, y: from.y + dy * scale },
      end: { x: to.x - dx * scale, y: to.y - dy * scale },
    };
  }

  function segmentHitsCard(a, b, card) {
    // Routing uses axis-aligned segments, with clearance around the visible card.
    return Math.max(a.x, b.x) > card.x - 73 && Math.min(a.x, b.x) < card.x + 73 &&
      Math.max(a.y, b.y) > card.y - 39 && Math.min(a.y, b.y) < card.y + 39;
  }

  function routeEdge(from, to, positions) {
    if (from.x === to.x && from.y === to.y) return [];
    const cards = [...positions.values()];
    const xs = [...new Set(cards.flatMap(p => [p.x - 81, p.x, p.x + 81]))].sort((a, b) => a - b);
    const ys = [...new Set(cards.flatMap(p => [p.y - 47, p.y, p.y + 47]))].sort((a, b) => a - b);
    const key = (x, y) => y * xs.length + x;
    const point = index => ({ x: xs[index % xs.length], y: ys[Math.floor(index / xs.length)] });
    const start = key(xs.indexOf(from.x), ys.indexOf(from.y));
    const end = key(xs.indexOf(to.x), ys.indexOf(to.y));
    const previous = new Map([[start, null]]);
    const queue = [start];
    // A bounded visibility grid: at most (3 * displayed node count)^2 cells.
    for (let head = 0; head < queue.length && !previous.has(end); head++) {
      const current = queue[head];
      const x = current % xs.length, y = Math.floor(current / xs.length);
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        let nx = x + dx, ny = y + dy;
        // Other lanes can introduce grid coordinates inside an endpoint card.
        // Skip those interior grid points, but still collision-check the full segment.
        while (nx >= 0 && ny >= 0 && nx < xs.length && ny < ys.length && key(nx, ny) !== end &&
          cards.some(card => segmentHitsCard(point(key(nx, ny)), point(key(nx, ny)), card))) {
          nx += dx; ny += dy;
        }
        if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
        const next = key(nx, ny);
        if (previous.has(next)) continue;
        const a = point(current), b = point(next);
        if (cards.some(card => {
          if (card.x === from.x && card.y === from.y && current === start) return false;
          if (card.x === to.x && card.y === to.y && next === end) return false;
          return segmentHitsCard(a, b, card);
        })) continue;
        previous.set(next, current);
        queue.push(next);
      }
    }
    if (!previous.has(end)) return []; // Never draw a misleading line through a card.
    const path = [];
    for (let at = end; at !== null; at = previous.get(at)) path.push(point(at));
    path.reverse();
    const compact = path.filter((p, i) => i === 0 || i === path.length - 1 ||
      !((path[i - 1].x === p.x && p.x === path[i + 1].x) ||
        (path[i - 1].y === p.y && p.y === path[i + 1].y)));
    const first = rectangleEdgePoints(compact[0], compact[1]).start;
    const last = rectangleEdgePoints(compact[compact.length - 2], compact[compact.length - 1]).end;
    return [first, ...compact.slice(1, -1), last];
  }

  function placeEdgeLabel(route, text, positions, occupied, bounds = {width:Infinity, height:Infinity}) {
    const width = [...text].length * 12 + 12;
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const cards = [...positions.values()].map(p => ({left:p.x - 73, right:p.x + 73, top:p.y - 39, bottom:p.y + 39}));
    const segments = route.slice(1).map((end, i) => ({start:route[i], end, length:Math.abs(end.x-route[i].x)+Math.abs(end.y-route[i].y)}))
      .sort((a, b) => b.length - a.length);
    for (const {start, end} of segments) {
      const x = (start.x + end.x) / 2, y = (start.y + end.y) / 2 - 8;
      const box = {left:x - width/2, right:x + width/2, top:y - 14, bottom:y + 4};
      if (box.left < 0 || box.top < 0 || box.right > bounds.width || box.bottom > bounds.height ||
        [...cards, ...occupied].some(other => overlaps(box, other))) continue;
      occupied.push(box);
      return {x, y};
    }
    return null;
  }

  function renderGraph() {
    els.graph.replaceChildren();
    if (model.projection.forceList || model.viewState.view === "list") return;
    const nodes = model.projection.nodes;
    const claims = model.projection.claims;
    const layout = laneLayout(nodes, claims, model.projection.focus.id);
    const { width, height } = layout;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("aria-label", `${nodes.length} 論文、${claims.length} 関係のグラフ`);
    const defs = document.createElementNS(svg.namespaceURI, "defs");
    const marker = document.createElementNS(svg.namespaceURI, "marker");
    marker.setAttribute("id", "lineage-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS(svg.namespaceURI, "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.append(arrow); defs.append(marker); svg.append(defs);
    const positions = layout.positions;
    const labelBoxes = layout.labels.map(lane => ({left:lane.x, right:lane.x + [...lane.label].length * 16,
      top:lane.y - 18, bottom:lane.y + 6}));
    for (const claim of claims) {
      const from = positions.get(claim.src);
      const to = positions.get(claim.dst);
      if (!from || !to) continue;
      const route = routeEdge(from, to, positions);
      if (route.length < 2) continue;
      const line = document.createElementNS(svg.namespaceURI, "polyline");
      const points = route.map(p => `${p.x},${p.y}`).join(" ");
      line.setAttribute("points", points);
      line.setAttribute("fill", "none");
      const edgeClass = `lineage-focus__edge${claim.claim_family === "comparison" ? " lineage-focus__edge--comparison" : ""}${claim.trust_tier === "tentative" ? " lineage-focus__edge--tentative" : ""}`;
      line.setAttribute("class", edgeClass);
      line.setAttribute("marker-end", "url(#lineage-arrow)");
      svg.append(line);
      const hit = line.cloneNode();
      hit.setAttribute("points", points);
      hit.setAttribute("fill", "none");
      hit.setAttribute("class", "lineage-focus__edge-hit");
      hit.removeAttribute("marker-end");
      hit.setAttribute("tabindex", "0");
      hit.setAttribute("role", "button");
      hit.setAttribute("aria-label", `${labelForRelation(claim.relation)}${claim.trust_tier === "tentative" ? "（要確認）" : ""}の監査詳細を開く`);
      hit.dataset.claimId = claim.id;
      svg.append(hit);
      const labelText = claim.trust_tier === "tentative" ? `${labelForRelation(claim.relation)} · 要確認` : labelForRelation(claim.relation);
      const labelAt = placeEdgeLabel(route, labelText, positions, labelBoxes, {width, height});
      if (!labelAt) continue; // The accessible edge control and relation list remain available.
      const label = document.createElementNS(svg.namespaceURI, "text");
      label.setAttribute("x", String(labelAt.x));
      label.setAttribute("y", String(labelAt.y));
      label.setAttribute("class", `lineage-focus__edge-label${claim.trust_tier === "tentative" ? " lineage-focus__edge-label--tentative" : ""}`);
      label.setAttribute("text-anchor", "middle");
      label.textContent = labelText;
      svg.append(label);
    }
    for (const node of nodes) {
      const at = positions.get(node.id);
      const group = document.createElementNS(svg.namespaceURI, "g");
      group.setAttribute("class", `lineage-focus__node${node.id === model.projection.focus.id ? " lineage-focus__node--focus" : ""}`);
      group.setAttribute("transform", `translate(${at.x - 65} ${at.y - 31})`);
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `${node.title}を中心にする`);
      group.dataset.focusId = node.id;
      const rect = document.createElementNS(svg.namespaceURI, "rect");
      rect.setAttribute("width", "130"); rect.setAttribute("height", "62"); rect.setAttribute("rx", "4");
      const text = document.createElementNS(svg.namespaceURI, "text");
      text.setAttribute("x", "9"); text.setAttribute("y", "27"); text.textContent = shortTitle(node.title, 18);
      group.append(rect, text);
      svg.append(group);
    }
    for (const lane of layout.labels) {
      const label = document.createElementNS(svg.namespaceURI, "text");
      label.setAttribute("x", String(lane.x));
      label.setAttribute("y", String(lane.y));
      label.setAttribute("class", "lineage-focus__graph-lane-label");
      label.textContent = lane.label;
      svg.append(label);
    }
    els.graph.append(svg);
  }

  function hiddenCounts(nodeId) {
    return model.projection.hiddenBranches.filter((branch) => branch.nodeId === nodeId).reduce((counts, branch) => {
      counts.parent += branch.parent;
      counts.child += branch.child;
      return counts;
    }, { parent: 0, child: 0 });
  }

  function nodeLanes(nodes, claims, focusId) {
    const ids = new Set(nodes.map(node => node.id));
    const incoming = new Map(nodes.map(node => [node.id, []]));
    const outgoing = new Map(nodes.map(node => [node.id, []]));
    const comparisons = new Set();
    for (const claim of claims) {
      if (!ids.has(claim.src) || !ids.has(claim.dst) || claim.decision !== "accepted"
          || !["verified", "corroborated"].includes(claim.trust_tier)) continue;
      if (claim.claim_family === "genealogy") {
        outgoing.get(claim.src).push(claim.dst);
        incoming.get(claim.dst).push(claim.src);
      } else if (claim.claim_family === "comparison") {
        if (claim.src === focusId) comparisons.add(claim.dst);
        if (claim.dst === focusId) comparisons.add(claim.src);
      }
    }
    const reachable = adjacency => {
      const seen = new Set([focusId]);
      const queue = [focusId];
      for (let index = 0; index < queue.length; index++) {
        for (const id of adjacency.get(queue[index]) || []) {
          if (!seen.has(id)) { seen.add(id); queue.push(id); }
        }
      }
      return seen;
    };
    const ancestors = reachable(incoming);
    const descendants = reachable(outgoing);
    const lanes = [
      {key:"focus", label:"中心の論文", nodes:[]},
      {key:"prior", label:"先行研究", nodes:[]},
      {key:"later", label:"発展研究", nodes:[]},
      {key:"comparison", label:"比較対象（継承とは別）", nodes:[]},
      {key:"other", label:"その他の関連論文", nodes:[]},
    ];
    for (const node of [...nodes].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const prior = ancestors.has(node.id);
      const later = descendants.has(node.id);
      const lane = node.id === focusId ? 0 : prior && later ? 4 : prior ? 1 : later ? 2
        : comparisons.has(node.id) ? 3 : 4;
      lanes[lane].nodes.push(node);
    }
    return lanes;
  }

  function laneLayout(nodes, claims, focusId) {
    const lanes = nodeLanes(nodes, claims, focusId);
    const positions = new Map();
    const labels = [];
    let right = 40;
    let bottom = 60;
    for (const key of ["prior", "focus", "later"]) {
      const lane = lanes.find(value => value.key === key);
      if (!lane.nodes.length) continue;
      const local = layeredLayout(lane.nodes, claims);
      labels.push({key, label: lane.label, x: right, y: 30});
      let edge = right;
      for (const [id, point] of local.positions) {
        const at = {x: point.x + right, y: point.y + 20};
        positions.set(id, at);
        edge = Math.max(edge, at.x + 65);
        bottom = Math.max(bottom, at.y + 31);
      }
      right = edge + 80;
    }
    for (const key of ["comparison", "other"]) {
      const lane = lanes.find(value => value.key === key);
      if (!lane.nodes.length) continue;
      const top = bottom + 80;
      labels.push({key, label: lane.label, x: 40, y: top});
      lane.nodes.forEach((node, index) => {
        const at = {x: 145 + (index % 3) * 250, y: top + 65 + Math.floor(index / 3) * 122};
        positions.set(node.id, at);
        right = Math.max(right, at.x + 105);
        bottom = Math.max(bottom, at.y + 31);
      });
    }
    return {positions, labels, width: Math.max(760, right + 40), height: Math.max(360, bottom + 60)};
  }

  function renderNodeCards() {
    els.nodeCards.replaceChildren();
    for (const lane of nodeLanes(model.projection.nodes, model.projection.claims, model.projection.focus.id)) {
      if (!lane.nodes.length) continue;
      const section = document.createElement("section");
      section.className = "lineage-focus__lane";
      section.setAttribute("aria-label", lane.label);
      const label = document.createElement("p");
      label.className = "lineage-focus__lane-heading";
      label.textContent = `${lane.label} · ${lane.nodes.length} 本`;
      const cards = document.createElement("div");
      cards.className = "lineage-focus__lane-cards";
      section.append(label, cards);
      els.nodeCards.append(section);
      for (const node of lane.nodes) {
        const card = document.createElement("article");
        card.className = "lineage-focus__node-card";
        card.dataset.nodeId = node.id;
        const title = document.createElement("h3");
        title.textContent = node.title;
        title.tabIndex = -1;
        const date = document.createElement("p");
        date.textContent = node.first_published_at ? `初出 ${node.first_published_at}` : "初出日未収録";
        const actions = document.createElement("div");
        actions.className = "lineage-focus__node-card-actions";
        if (node.id !== model.projection.focus.id) actions.append(button("この論文を中心にする", "focus", node.id));
        const hidden = hiddenCounts(node.id);
        const expanded = model.projection.expandedNodeIds.includes(node.id);
        if (expanded) {
          actions.append(button("追加枝を閉じる", "collapse", node.id));
        } else if (hidden.parent + hidden.child > 0) {
          const hiddenSummary = document.createElement("p");
          hiddenSummary.textContent = `折り畳み: 親 ${hidden.parent} 件 · 後継 ${hidden.child} 件`;
          actions.append(hiddenSummary, button("追加枝を最大 2 件表示", "expand", node.id));
        }
        card.append(title, date, actions);
        cards.append(card);
      }
    }
  }

  function claimCard(claim, nodes) {
    const card = document.createElement("article");
    card.className = "lineage-focus__claim";
    const heading = document.createElement("h3");
    heading.textContent = `${nodes.get(claim.src)?.title || claim.src} → ${nodes.get(claim.dst)?.title || claim.dst}`;
    const meta = document.createElement("p");
    meta.className = "lineage-focus__claim-meta";
    const trust = { verified: "人手検証済み", corroborated: "複数の根拠で支持", tentative: "要確認の推定" };
    meta.textContent = `${labelForRelation(claim.relation)} · ${claim.claim_family === "comparison" ? "比較（継承ではありません）" : "研究の継承"} · ${trust[claim.trust_tier] || "未確認"}`;
    const rationale = document.createElement("p");
    rationale.textContent = `関係の解釈: ${claim.rationale || "説明は収録されていません。根拠を確認してください。"}`;
    const detail = button("根拠と監査を確認", "inspect", claim.id);
    detail.setAttribute("aria-label", `${heading.textContent}の根拠と監査を確認`);
    card.append(heading, meta, rationale, detail);
    return card;
  }

  function renderList() {
    const claims = model.projection.claims;
    const pages = Math.max(1, Math.ceil(claims.length / LIST_PAGE_SIZE));
    model.page = Math.min(model.page, pages);
    const start = (model.page - 1) * LIST_PAGE_SIZE;
    const nodes = nodeMap();
    els.list.replaceChildren(...claims.slice(start, start + LIST_PAGE_SIZE).map((claim) => claimCard(claim, nodes)));
    if (!claims.length) {
      const empty = document.createElement("p");
      empty.textContent = "現在の条件で表示できる関係はありません。";
      els.list.append(empty);
    }
    els.pageStatus.textContent = `${model.page} / ${pages} ページ（${claims.length} 件）`;
    els.pagination.replaceChildren();
    if (pages > 1) {
      const previous = button("前へ", "page", String(model.page - 1));
      previous.disabled = model.page === 1;
      const next = button("次へ", "page", String(model.page + 1));
      next.disabled = model.page === pages;
      els.pagination.append(previous, next);
    }
  }

  function render() {
    if (!model.release || !model.projection) return;
    els.title.textContent = model.projection.focus.title;
    document.title = `${model.projection.focus.title} — 研究系譜 | PaperPilot`;
    renderControls();
    renderSummary();
    const listOnly = model.projection.forceList || model.viewState.view === "list";
    els.forceList.hidden = !model.projection.forceList;
    els.graphPanel.hidden = listOnly;
    els.listPanel.hidden = !listOnly;
    renderGraph();
    renderNodeCards();
    renderList();
  }

  function normalizeAndProject(nextState, { historyMode = "replace", save = true } = {}) {
    const nextUrl = Core.writeState(new URL(window.location.href), nextState);
    window.history[historyMode === "push" ? "pushState" : "replaceState"]({ paperpilotLineageFocus: true }, "", nextUrl);
    model.viewState = Core.readState(model.release, preferenceInput());
    model.projection = Core.selectFocusProjection(model.release, model.viewState);
    if (!model.projection) {
      closed("指定された focus または表示条件を安全に復元できませんでした。");
      return false;
    }
    model.page = 1;
    if (save) persistPreferences(model.viewState);
    render();
    return true;
  }

  function restoreNodeActionFocus(nodeId, action) {
    const card = [...els.nodeCards.querySelectorAll("[data-node-id]")].find((item) => item.dataset.nodeId === nodeId);
    if (!card) return;
    const target = card.querySelector(`[data-action="${action}"]`) || card.querySelector("h3");
    target?.focus?.({ preventScroll: true });
  }

  function fixtureLabel(claim) {
    const labels = model.release.fixtureCollection?.edge_labels || [];
    if (!claim.review_binding) return null;
    return labels.find((label) => label.review_id === claim.review_binding.review_id
      && label.evidence_sha256 === claim.review_binding.evidence_sha256) || null;
  }

  function valueRow(term, value) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
    return [dt, dd];
  }

  function safeEvidenceLink(url) {
    try {
      const parsed = new URL(url);
      return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null;
    } catch (_) {
      return null;
    }
  }

  function openInspector(claimId, trigger) {
    const claim = model.projection.claims.find((item) => item.id === claimId);
    if (!claim) return;
    const nodes = nodeMap();
    const evidence = evidenceMap();
    const label = fixtureLabel(claim);
    const evidenceRows = claim.evidence_ids.map((id) => evidence.get(id)).filter(Boolean);
    const claimEvidenceIds = new Set(claim.evidence_ids);
    const citationLinks = model.release.artifact.links.filter((link) => link.evidence_ids.some((id) => claimEvidenceIds.has(id)));
    const factsHeading = document.createElement("h3"); factsHeading.textContent = "観測された事実";
    const facts = document.createElement("dl"); facts.className = "lineage-focus__facts";
    for (const link of citationLinks) {
      facts.append(
        ...valueRow("観測リンク", `${link.src} → ${link.dst}`),
        ...valueRow("リンク種別", link.type),
      );
    }
    for (const item of evidenceRows) {
      const locator = Object.entries(item.locator).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`).join(" · ");
      facts.append(
        ...valueRow("引用側 work ID", item.citing_work_id),
        ...valueRow("被引用側 work ID", item.cited_work_id),
        ...valueRow("取得元 work ID", item.source_work_id),
        ...valueRow("取得ソース / 種類", `${item.source} / ${item.kind}`),
        ...valueRow("引用位置", locator),
      );
    }
    const interpretationHeading = document.createElement("h3"); interpretationHeading.textContent = "解釈と判定";
    const interpretation = document.createElement("dl"); interpretation.className = "lineage-focus__facts";
    interpretation.append(
      ...valueRow("起点", nodes.get(claim.src)?.title || claim.src),
      ...valueRow("終点", nodes.get(claim.dst)?.title || claim.dst),
      ...valueRow("推定された関係", labelForRelation(claim.relation)),
      ...valueRow("関係族", claim.claim_family),
      ...valueRow("判定", claim.decision),
      ...valueRow("信頼段階", claim.trust_tier),
    );
    const rationale = document.createElement("p"); rationale.textContent = claim.rationale || "説明は収録されていません。";
    const score = document.createElement("p");
    score.textContent = claim.raw_score === null ? "モデル自己評価は収録されていません。" : `モデル自己評価 ${claim.raw_score.toFixed(2)}（未較正）`;
    const calibrated = document.createElement("p");
    calibrated.textContent = claim.calibrated_probability === null ? "検証データに基づく推定正答率は収録されていません。" : `検証データに基づく推定正答率 ${Math.round(claim.calibrated_probability * 100)}%`;
    const method = document.createElement("p");
    method.textContent = `分類: ${claim.classification.method} / ${claim.classification.provider || "非LLM"} / ${claim.classification.model || "—"} / ${claim.classification.schema_version}`;
    const evidenceHeading = document.createElement("h3"); evidenceHeading.textContent = "根拠";
    const evidenceList = document.createElement("ol"); evidenceList.className = "lineage-focus__evidence";
    for (const item of evidenceRows) {
      const li = document.createElement("li");
      const heading = document.createElement("strong"); heading.textContent = `${item.source} / ${item.kind}`;
      const excerpt = document.createElement("p"); excerpt.textContent = item.excerpt;
      const locator = document.createElement("p");
      locator.textContent = Object.entries(item.locator).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`).join(" · ");
      const provenance = document.createElement("p"); provenance.className = "lineage-focus__hash";
      provenance.textContent = `retrieved ${item.retrieved_at} · excerpt sha256 ${item.excerpt_sha256} · input sha256 ${item.input_sha256} · snapshot ${item.snapshot_ref}`;
      li.append(heading, excerpt, locator, provenance);
      const href = safeEvidenceLink(item.url);
      if (href) {
        const link = document.createElement("a"); link.href = href; link.target = "_blank"; link.rel = "noopener"; link.textContent = "原典を開く";
        li.append(link);
      }
      evidenceList.append(li);
    }
    const reviewHeading = document.createElement("h3"); reviewHeading.textContent = "人手レビュー";
    const review = document.createElement("div");
    if (!label) {
      review.textContent = "公開されたレビュー対応情報はありません。";
    } else {
      const adjudication = document.createElement("p");
      adjudication.textContent = `裁定: citation ${label.adjudication.citation_valid ? "valid" : "invalid"} · ${label.adjudication.gold_family || "familyなし"} / ${label.adjudication.gold_relation || "relationなし"} · ${label.adjudication.evidence_support}`;
      const reviews = document.createElement("ul");
      for (const item of label.reviews) {
        const li = document.createElement("li");
        li.textContent = `${item.reviewer_id}: citation ${item.citation_valid ? "valid" : "invalid"} · ${item.gold_family || "familyなし"} / ${item.gold_relation || "relationなし"} · ${item.evidence_support}${item.notes ? ` — ${item.notes}` : ""}`;
        reviews.append(li);
      }
      review.append(adjudication, reviews);
    }
    els.inspectorBody.replaceChildren(factsHeading, facts, interpretationHeading, interpretation, rationale, score, calibrated, method, evidenceHeading, evidenceList, reviewHeading, review);
    model.inspectorTrigger = trigger;
    // Navigation deliberately leaves the dialog hidden. Clear that state
    // before showModal(), or the native modal makes the page inert while the
    // dialog itself remains invisible.
    els.inspector.hidden = false;
    if (typeof els.inspector.showModal === "function") els.inspector.showModal();
    else els.inspector.setAttribute("open", "");
    els.inspector.querySelector('[data-action="close-inspector"]')?.focus();
  }

  function closeInspector(restoreFocus = true) {
    if (typeof els.inspector.close === "function" && els.inspector.open) els.inspector.close();
    else els.inspector.removeAttribute("open");
    els.inspector.hidden = true;
    const trigger = model.inspectorTrigger;
    model.inspectorTrigger = null;
    if (restoreFocus) trigger?.focus?.({ preventScroll: true });
  }

  function activate(target) {
    if (!model.release) return;
    const action = target.dataset.action;
    if (action === "view") normalizeAndProject({ ...model.viewState, view: target.dataset.value });
    if (action === "focus") {
      if (!Core.resolveFocus(model.release, target.dataset.value)) return;
      if (normalizeAndProject({ ...model.viewState, focusId: target.dataset.value, expandedNodeIds: [] }, { historyMode: "push" })) {
        els.title.focus({ preventScroll: true });
      }
    }
    if (action === "expand" && normalizeAndProject({ ...model.viewState, expandedNodeIds: [...model.viewState.expandedNodeIds, target.dataset.value] })) {
      restoreNodeActionFocus(target.dataset.value, "collapse");
    }
    if (action === "collapse" && normalizeAndProject({ ...model.viewState, expandedNodeIds: model.viewState.expandedNodeIds.filter((id) => id !== target.dataset.value) })) {
      restoreNodeActionFocus(target.dataset.value, "expand");
    }
    if (action === "inspect") openInspector(target.dataset.value, target);
    if (action === "page") { model.page = Number(target.dataset.value); renderList(); document.getElementById("lineage-list-heading")?.focus?.({ preventScroll: true }); }
    if (action === "close-inspector") closeInspector();
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-action]");
      if (action) activate(action);
      const focus = event.target.closest?.("[data-focus-id]");
      if (focus && normalizeAndProject({ ...model.viewState, focusId: focus.dataset.focusId, expandedNodeIds: [] }, { historyMode: "push" })) {
        els.title.focus({ preventScroll: true });
      }
      const claim = event.target.closest?.("[data-claim-id]");
      if (claim) openInspector(claim.dataset.claimId, claim);
    });
    document.addEventListener("keydown", (event) => {
      const focus = event.target.closest?.("[data-focus-id]");
      const claim = event.target.closest?.("[data-claim-id]");
      if ((event.key === "Enter" || event.key === " ") && (focus || claim)) {
        event.preventDefault();
        if (focus && normalizeAndProject({ ...model.viewState, focusId: focus.dataset.focusId, expandedNodeIds: [] }, { historyMode: "push" })) {
          els.title.focus({ preventScroll: true });
        }
        else if (claim) openInspector(claim.dataset.claimId, claim);
      }
      if (event.key === "Escape" && (els.inspector.open || !els.inspector.hidden)) closeInspector();
      if (event.key === "Tab" && els.inspector.open) {
        const focusable = [...els.inspector.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')].filter((item) => !item.disabled && !item.hidden);
        if (!focusable.length) return;
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    els.inspector?.addEventListener("cancel", (event) => { event.preventDefault(); closeInspector(); });
    els.hops?.addEventListener("change", () => normalizeAndProject({ ...model.viewState, hops: Number(els.hops.value) }));
    els.limit?.addEventListener("change", () => normalizeAndProject({ ...model.viewState, nodeLimit: Number(els.limit.value) }));
    els.confidence?.addEventListener("change", () => normalizeAndProject({ ...model.viewState, minConfidence: Number(els.confidence.value) }));
    els.tentative?.addEventListener("change", () => normalizeAndProject({ ...model.viewState, trustTiers: els.tentative.checked ? ["verified", "corroborated", "tentative"] : ["verified", "corroborated"] }));
    const updateFamilies = () => normalizeAndProject({ ...model.viewState, families: [els.genealogy.checked ? "genealogy" : null, els.comparison.checked ? "comparison" : null].filter(Boolean) });
    els.genealogy?.addEventListener("change", updateFamilies);
    els.comparison?.addEventListener("change", updateFamilies);
    els.relationOptions?.addEventListener("change", (event) => {
      if (event.target.dataset.action !== "relation") return;
      const relations = [...els.relationOptions.querySelectorAll('input[data-action="relation"]:checked')].map((input) => input.value);
      normalizeAndProject({ ...model.viewState, relations, relationFilterExplicit: true });
    });
    els.evidenceSourceOptions?.addEventListener("change", (event) => {
      if (event.target.dataset.action !== "evidence-source") return;
      const evidenceSources = [...els.evidenceSourceOptions.querySelectorAll('input[data-action="evidence-source"]:checked')].map((input) => input.value);
      normalizeAndProject({ ...model.viewState, evidenceSources, evidenceSourcesExplicit: true });
    });
    els.evidenceKindOptions?.addEventListener("change", (event) => {
      if (event.target.dataset.action !== "evidence-kind") return;
      const evidenceKinds = [...els.evidenceKindOptions.querySelectorAll('input[data-action="evidence-kind"]:checked')].map((input) => input.value);
      normalizeAndProject({ ...model.viewState, evidenceKinds, evidenceKindsExplicit: true });
    });
    window.addEventListener("popstate", () => {
      closeInspector(false);
      const paperValues = new URLSearchParams(window.location.search).getAll("paper");
      const paperId = paperValues.length === 1 ? paperValues[0] : null;
      if (paperId === model.paperId && model.release) {
        model.viewState = Core.readState(model.release, preferenceInput());
        model.projection = Core.selectFocusProjection(model.release, model.viewState);
        if (model.projection) { model.page = 1; render(); return; }
      }
      start();
    });
    window.addEventListener("pagehide", () => model.loadOwner?.abandon());
  }

  async function start(deps = {}) {
    model.loadOwner?.abandon();
    closeInspector(false);
    const paperValues = new URLSearchParams(window.location.search).getAll("paper");
    const paperId = paperValues.length === 1 ? paperValues[0] : null;
    if (!PAPER_ID.test(paperId || "")) {
      closed("有効な paper ID が指定されていません。論文一覧から監査済みの系譜を開いてください。");
      return false;
    }
    loading();
    const owner = loadOwner(deps.timer ?? globalThis);
    model.loadOwner = owner;
    try {
      const release = await loadVerifiedRelease(paperId, owner, deps);
      if (model.loadOwner !== owner) return false;
      if (!owner.isActive()) {
        closed("監査情報の確認が制限時間内に完了しなかったため、系譜を表示していません。");
        return false;
      }
      owner.finish();
      if (!release) {
        closed("この論文には公開可能な監査済み系譜がありません。");
        return false;
      }
      model.release = release;
      model.paperId = paperId;
      model.viewState = (deps.core ?? Core).readState(release, preferenceInput());
      model.projection = (deps.core ?? Core).selectFocusProjection(release, model.viewState);
      if (!model.projection) {
        closed("指定された focus または表示条件を安全に復元できませんでした。");
        return false;
      }
      const catalogPaper = release.entry.conference;
      buildEvidenceOptions();
      els.meta.textContent = `${catalogPaper.toUpperCase()} · 監査 release ${release.entry.release_id}`;
      els.back.href = `../${encodeURIComponent(catalogPaper)}/?paper=${paperId}`;
      els.audit.hidden = true;
      els.ready.hidden = false;
      render();
      return true;
    } catch (_) {
      if (model.loadOwner !== owner) return false;
      owner.finish();
      closed("監査情報の一致を確認できなかったため、系譜を表示していません。");
      return false;
    }
  }

  buildRelationOptions();
  bindEvents();
  if (globalThis.__PAPERPILOT_LINEAGE_FOCUS_TEST__ === true) {
    globalThis.__lineageFocusTest = Object.freeze({ MAX_BYTES, activate, closeInspector, closed, fetchBytes, laneLayout, layeredLayout, loadOwner, loadVerifiedRelease, model, nodeLanes, openInspector, parseJsonBytes, placeEdgeLabel, readBounded, rectangleEdgePoints, routeEdge, segmentHitsCard, start });
  } else {
    start();
  }
})();
