// PaperPilot catalog viewer. Requires utils.js loaded first.
const PAPERS_URL = "papers.json";
const QUALITY_URL = "../lineage-quality-v1.json";

// Progressive reveal: render the first PAGE_SIZE rows, then grow by
// PAGE_SIZE per "show more" click. A 218-row catalog rendered in one
// shot is a ~40,000px scroll wall — capping the initial paint keeps the
// page fast to scan and cheap to lay out. Reset to PAGE_SIZE whenever
// the result set changes (filter / search / sort).
const PAGE_SIZE = 30;
const PUBLIC_SLIDE_LOOKUP_TIMEOUT_MS = 8_000;
const PAPER_SLIDE_REQUEST_TIMEOUT_MS = 15_000;
const PAPER_SLIDE_POLL_MAX_MS = 15 * 60 * 1_000;
const PAPER_SLIDE_RESPONSE_MAX_BYTES = 16 * 1024;
const PAPER_SLIDE_SESSION_PREFIX = "paperpilotPaperSlideV1:";
const PAPER_SLIDE_CONFIRMATION = [
  "この論文のスライド案を生成します。",
  "",
  "対象範囲: 公開PDFが利用できる場合は本文、利用できない場合は要旨のみ（自動判定）",
  "内容は機械生成です。必ず原論文で確認してください。",
  "人手レビューが完了するまで公開されません。",
  "目安: 数分〜十数分 / 費用カテゴリ: 低額（生成1回）",
].join("\n");

const state = {
  papers: [],
  search: "",
  type: "all",
  activeTags: new Set(),
  sort: "default",
  visibleCount: PAGE_SIZE,
  paperById: new Map(),
  selectedPaperId: null,
  selectedOrigin: null,
  selectionScrollY: 0,
  selectionMessage: "",
  fullAbstractById: new Map(),
  fullAbstractAbortByPaperId: new Map(),
  publicSlidesByPaperId: new Map(),
  publicSlideAbortByPaperId: new Map(),
  paperSlideRequestsByPaperId: new Map(),
  paperSlidePollByPaperId: new Map(),
  collectionQuality: null,
  lineage: null,
  relationsByPaperId: new Map(),
  lineageNodeByPaperId: new Map(),
};

const { escapeHtml } = window.PP;
const LineageCore = window.PaperPilotLineageCore;
const {
  validateCatalog,
  readPaperParam,
  pinSelected,
  detailShardUrl,
  readDetailAbstract,
  setPaperParam,
  isPaperId,
  loadPublicSlideState,
  PAPER_SLIDE_API_BASE,
  parsePaperSlideApiBase,
  paperSlideEligibility,
  parsePaperSlideRequestResponse,
  parsePaperSlideStatusResponse,
  paperSlideDisplayState,
  paperSlideStatusMayFollow,
  paperSlideStatusResponseMayFollow,
  publicSlideEntryMatchesStatus,
  serializePaperSlideSession,
  parsePaperSlideSession,
  paperSlidePollDelay,
} = window.PaperPilotCatalogCore;

const PAPER_SLIDE_API = parsePaperSlideApiBase(PAPER_SLIDE_API_BASE);
let paperSlideDialog = null;
let paperSlideDialogTrigger = null;
let paperSlideDialogPaperId = null;

const CATALOG_HISTORY_VERSION = 1;
const CATALOG_RESTORE_KEY = "paperpilotCatalogRestore";

function makeCatalogHistoryRestore({ visibleCount, scrollY, focusPaperId }) {
  if (!Number.isInteger(visibleCount) || visibleCount < PAGE_SIZE) {
    throw new TypeError("visibleCount must be an integer at least PAGE_SIZE");
  }
  if (!isPaperId(focusPaperId)) throw new TypeError("focusPaperId must be a paper_id");
  const safeScrollY = Number.isFinite(scrollY) ? Math.max(0, scrollY) : 0;
  return {
    version: CATALOG_HISTORY_VERSION,
    visibleCount,
    scrollY: safeScrollY,
    focusPaperId,
  };
}

function buildSelectionHistoryEntries({
  currentState,
  currentUrl,
  paperId,
  visibleCount,
  scrollY,
}) {
  const restore = makeCatalogHistoryRestore({
    visibleCount,
    scrollY,
    focusPaperId: paperId,
  });
  const stateBase = currentState && typeof currentState === "object" && !Array.isArray(currentState)
    ? currentState
    : {};
  return {
    currentState: { ...stateBase, [CATALOG_RESTORE_KEY]: restore },
    selectedState: {
      paperpilotPaperSelection: true,
      [CATALOG_RESTORE_KEY]: restore,
    },
    selectedUrl: setPaperParam(currentUrl, paperId),
  };
}

function readCatalogHistoryRestore(historyState, catalogSize) {
  if (!historyState || typeof historyState !== "object" || Array.isArray(historyState)) return null;
  if (!Number.isInteger(catalogSize) || catalogSize < 0) return null;
  const restore = historyState[CATALOG_RESTORE_KEY];
  if (!restore || typeof restore !== "object" || Array.isArray(restore)) return null;
  const keys = Object.keys(restore).sort();
  if (keys.join(",") !== "focusPaperId,scrollY,version,visibleCount") return null;
  if (restore.version !== CATALOG_HISTORY_VERSION) return null;
  if (!Number.isInteger(restore.visibleCount) || restore.visibleCount < PAGE_SIZE) return null;
  if (!Number.isFinite(restore.scrollY) || restore.scrollY < 0) return null;
  if (!isPaperId(restore.focusPaperId)) return null;
  return {
    visibleCount: Math.max(PAGE_SIZE, Math.min(restore.visibleCount, catalogSize)),
    scrollY: restore.scrollY,
    focusPaperId: restore.focusPaperId,
  };
}

function shouldFocusSelectedPaperAfterPopstate(previousPaperId, selectedPaperId) {
  return previousPaperId === null && isPaperId(selectedPaperId);
}

function createPublicSlideDeadlineOwner(onTimeout, timerHelpers = {}) {
  const setTimer = timerHelpers.setTimer ?? globalThis.setTimeout;
  const clearTimer = timerHelpers.clearTimer ?? globalThis.clearTimeout;
  const controller = new AbortController();
  let timerId = null;
  let active = true;

  function clearDeadline() {
    if (timerId === null) return;
    clearTimer(timerId);
    timerId = null;
  }

  const owner = {
    controller,
    finish() {
      if (!active) return;
      active = false;
      clearDeadline();
    },
    abandon() {
      if (!active) return;
      active = false;
      clearDeadline();
      controller.abort(new DOMException("public-slide lookup abandoned", "AbortError"));
    },
  };
  timerId = setTimer(() => {
    if (!active) return;
    active = false;
    clearDeadline();
    controller.abort(new DOMException("public-slide lookup timed out", "TimeoutError"));
    onTimeout();
  }, PUBLIC_SLIDE_LOOKUP_TIMEOUT_MS);
  return owner;
}

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
  heroToggle: document.getElementById("hero-toggle"),
  heroDetails: document.getElementById("hero-details"),
  heroLineage: document.querySelector("[data-lineage-entry]"),
};

const REL_LABEL = {
  supersedes: { label: "Supersedes", direction: "down" },
  successor:  { label: "Successor", direction: "down" },
  extends:    { label: "Extended by", direction: "down" },
  ablation:   { label: "Ablation by", direction: "down" },
  baseline_only: { label: "Used as baseline by", direction: "down" },
  contrasts:  { label: "Contrasts with", direction: "down" },
};
const REL_LABEL_REVERSE = {
  supersedes: { label: "Supersedes", direction: "up" },
  successor:  { label: "Continues from", direction: "up" },
  extends:    { label: "Extends", direction: "up" },
  ablation:   { label: "Ablates", direction: "up" },
  baseline_only: { label: "Uses as baseline", direction: "up" },
  contrasts:  { label: "Contrasted with", direction: "up" },
};

function currentConferenceSlug() {
  return window.location.pathname
    .split("/")
    .filter((part) => part && !part.endsWith(".html"))
    .pop() || "";
}

async function loadCollectionQuality() {
  const slug = currentConferenceSlug();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  try {
    const response = await fetch(QUALITY_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`quality HTTP ${response.status}`);
    const quality = LineageCore.parseQualityManifest(await response.json());
    if (!quality) throw new Error("invalid lineage quality manifest");
    return LineageCore.resolveQualityCollection(quality, {
      kind: "conference",
      slug,
      path: `${slug}/lineage.json`,
    });
  } catch (error) {
    console.warn("[catalog] lineage quality unavailable; keeping lineage closed:", error);
    return null;
  }
}

function lineageIsPublishable(collection) {
  return Boolean(LineageCore?.qualityRowIsEligible(collection));
}

function enableHeroLineage() {
  if (!els.heroLineage) return;
  const link = document.createElement("a");
  link.className = "hero__meta-link";
  link.href = "lineage.html";
  link.textContent = "家系図ビュー →";
  els.heroLineage.dataset.lineageState = "ready";
  els.heroLineage.replaceChildren(link);
}

function buildRelationsIndex() {
  if (!state.lineage) return;
  const { nodes, edges } = state.lineage;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const relationsByNodeId = new Map(
    nodes.map((node) => [node.id, { incoming: [], outgoing: [] }]),
  );
  for (const e of edges) {
    const srcEntry = relationsByNodeId.get(e.src);
    const dstEntry = relationsByNodeId.get(e.dst);
    if (srcEntry) srcEntry.outgoing.push({ ...e, other: nodeById.get(e.dst) });
    if (dstEntry) dstEntry.incoming.push({ ...e, other: nodeById.get(e.src) });
  }

  // Graph-local IDs (Semantic Scholar/OpenAlex) are a different namespace
  // from PaperPilot paper_id even when both happen to be 40 hex characters.
  // Only an explicit canonical ID carried by the producer may join them.
  const conflicts = new Set();
  for (const node of nodes) {
    if (node.is_focus !== true || !isPaperId(node.seed_paper_id)) continue;
    const paperId = node.seed_paper_id;
    if (state.lineageNodeByPaperId.has(paperId)) {
      conflicts.add(paperId);
      continue;
    }
    state.lineageNodeByPaperId.set(paperId, node.id);
    state.relationsByPaperId.set(paperId, relationsByNodeId.get(node.id));
  }
  for (const paperId of conflicts) {
    state.lineageNodeByPaperId.delete(paperId);
    state.relationsByPaperId.delete(paperId);
  }
}

function renderRelationsSection(paper) {
  const lineageId = state.lineageNodeByPaperId.get(paper.paper_id);
  if (!lineageId) return "";
  const rel = state.relationsByPaperId.get(paper.paper_id);
  if (!rel || (rel.incoming.length === 0 && rel.outgoing.length === 0)) return "";

  const groups = new Map();
  for (const e of rel.incoming) {
    const meta = REL_LABEL_REVERSE[e.relation] || { label: e.relation };
    const key = `up:${e.relation}`;
    if (!groups.has(key)) groups.set(key, { meta, items: [] });
    groups.get(key).items.push(e);
  }
  for (const e of rel.outgoing) {
    const meta = REL_LABEL[e.relation] || { label: e.relation };
    const key = `down:${e.relation}`;
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
      const provenance = e.provenance;
      const classification = provenance.classification;
      return `<li class="rel-item">
        <span class="rel-item__title">${escapeHtml(e.other.title)}</span>
        <span class="rel-item__venue">${escapeHtml(venue)}</span>
        <span class="rel-rationale">→ ${escapeHtml(e.rationale)}</span>
        <span class="rel-provenance">確信度 ${Math.round(e.confidence * 100)}% ·
          根拠 ${escapeHtml(`${provenance.evidence.source}/${provenance.evidence.kind}`)} ·
          ${escapeHtml(`${provenance.producer.name}@${provenance.producer.version}`)} ·
          ${escapeHtml(`${classification.method}/${classification.model || "非LLM"}/${classification.schema_version}`)}</span>
      </li>`;
    }).join("");
    const relKind = k.split(":")[1];
    return `<div class="rel-group rel-group--${relKind}">
      <div class="rel-group__head"><span class="rel-dot rel-dot--${relKind}" aria-hidden="true"></span>${meta.label} <span class="rel-group__count">(${items.length})</span></div>
      <ul class="rel-group__items">${itemsHtml}</ul>
    </div>`;
  }).join("");

  const total = rel.incoming.length + rel.outgoing.length;
  return `
    <div class="paper__relations">
      <button class="paper__relations-toggle" type="button" aria-expanded="false"
        aria-controls="relations-${escapeHtml(lineageId)}">
        Relations <span class="paper__relations-count">(${total})</span>
      </button>
      <div class="paper__relations-body" id="relations-${escapeHtml(lineageId)}">
        ${groupHtml}
        <a class="paper__relations-link" href="lineage.html?focus=${encodeURIComponent(paper.paper_id)}">View full lineage →</a>
      </div>
    </div>`;
}

const PAPER_SLIDE_PHASE_LABELS = Object.freeze({
  resolving_source: "原論文を確認しています。",
  fetching: "公開PDFを取得しています。",
  extracting: "本文を安全に抽出しています。",
  generating: "スライド案を生成しています。",
  validating: "引用と内容を検証しています。",
  awaiting_review: "人手レビューを待っています。",
  promoting: "レビュー済み版を公開準備しています。",
  deploying: "レビュー済み版を公開しています。",
  smoke: "公開結果を最終確認しています。",
});

function paperSlideSessionKey(paperId) {
  return `${PAPER_SLIDE_SESSION_PREFIX}${paperId}`;
}

function paperSlideRequestView(paper, publicResult) {
  if (publicResult.status === "published") {
    return { kind: "published", message: null, action: null };
  }
  if (publicResult.status === "loading") {
    return { kind: "loading", message: "レビュー済みスライドの公開状況を検証中…", action: null };
  }
  if (publicResult.status === "unverified") {
    return {
      kind: "error",
      message: "スライドの公開状況を検証できませんでした。原論文リンクをご利用ください。",
      action: null,
    };
  }

  const request = state.paperSlideRequestsByPaperId.get(paper.paper_id);
  if (request) {
    if (request.status === "submitting") {
      return { kind: "pending", message: "生成依頼を送信しています…", action: null };
    }
    if (request.status === "published_verifying") {
      return {
        kind: "pending",
        message: "公開済み応答を検証済み公開一覧と照合しています…",
        action: null,
      };
    }
    const display = paperSlideDisplayState(request.status);
    if (display === "queued") {
      return { kind: "pending", message: "依頼を受け付けました。生成開始を待っています。", action: null };
    }
    if (display === "generating") {
      const coverage = request.coverage === "abstract_only" ? "要旨のみから作成中です。" : "";
      return {
        kind: "pending",
        message: `${PAPER_SLIDE_PHASE_LABELS[request.phase] || "スライド案を生成しています。"}${coverage}`,
        action: null,
      };
    }
    if (display === "awaiting_review") {
      const coverage = request.coverage === "abstract_only" ? "要旨のみから生成。" : "";
      return {
        kind: "ok",
        message: `${coverage}スライド案が完成し、人手レビューを待っています。レビュー前の案は公開されません。`,
        action: null,
      };
    }
    if (display === "failed") {
      return {
        kind: "error",
        message: request.localMessage || "生成を完了できませんでした。原論文リンクをご利用ください。",
        action: request.retryable === true ? "retry" : null,
      };
    }
  }

  const eligibility = paperSlideEligibility(paper, publicResult.status, PAPER_SLIDE_API);
  if (eligibility.state === "requestable") {
    const note = eligibility.coverage === "abstract_only"
      ? "利用できる公開PDFがないため、要旨のみから作成します。"
      : "公開PDFの利用可否をサーバーで確認し、対象範囲を自動決定します。";
    return { kind: "requestable", message: note, action: "request" };
  }
  const unavailable = eligibility.reason === "api_unavailable"
    ? "スライド生成依頼は現在利用できません。レビュー済み版が公開された場合のみ表示します。"
    : eligibility.reason === "source_unavailable"
      ? "生成に利用できる公開PDFまたは要旨がありません。"
      : "公開状況を安全に確認できないため、生成依頼は利用できません。";
  return { kind: "unavailable", message: unavailable, action: null };
}

function renderPaperSlideAction(paper, view) {
  const statusClass = view.kind === "error" ? " paper__slides-status--error" : "";
  const message = `<p class="paper__slides-status${statusClass}" role="status">${escapeHtml(view.message)}</p>`;
  if (view.action === "request") {
    return `${message}<button class="paper__slides-request" type="button" data-request-slides="${escapeHtml(paper.paper_id)}">スライド案を作る</button>`;
  }
  if (view.action === "retry") {
    return `${message}<button class="paper__slides-request" type="button" data-retry-slides="${escapeHtml(paper.paper_id)}">もう一度依頼する</button>`;
  }
  return message;
}

function renderPublicSlidesSection(paper) {
  const result = state.publicSlidesByPaperId.get(paper.paper_id)
    || { status: "loading", entry: null };
  const headingId = `slides-heading-${paper.paper_id}`;
  let body;
  if (result.status === "published") {
    const coverage = result.entry.coverage === "full_text" ? "本文ベース" : "要旨のみ";
    body = `<p class="paper__slides-status">人手確認済み · ${coverage}</p>
      <a class="paper__slides-link" href="${escapeHtml(result.entry.deck_path)}">レビュー済みスライドを開く →</a>`;
  } else {
    body = renderPaperSlideAction(paper, paperSlideRequestView(paper, result));
  }
  return `<section class="paper__slides" aria-labelledby="${headingId}" aria-live="polite">
    <h3 class="paper__slides-heading" id="${headingId}" tabindex="-1">論文スライド</h3>
    <div class="paper__slides-body" id="slides-body-${paper.paper_id}">${body}</div>
  </section>`;
}

function updatePublicSlidesSection(paperId) {
  const body = document.getElementById(`slides-body-${paperId}`);
  const result = state.publicSlidesByPaperId.get(paperId);
  if (!body || !result || result.status === "loading") return false;

  const status = document.createElement("p");
  status.className = "paper__slides-status";
  if (result.status === "published") {
    const coverage = result.entry.coverage === "full_text" ? "本文ベース" : "要旨のみ";
    status.textContent = `人手確認済み · ${coverage}`;
    const link = document.createElement("a");
    link.className = "paper__slides-link";
    link.setAttribute("href", result.entry.deck_path);
    link.textContent = "レビュー済みスライドを開く →";
    body.replaceChildren(status, link);
  } else {
    const paper = state.paperById.get(paperId);
    if (!paper) return false;
    const view = paperSlideRequestView(paper, result);
    if (view.kind === "error") status.classList.add("paper__slides-status--error");
    status.setAttribute("role", "status");
    status.textContent = view.message;
    if (view.action) {
      const button = document.createElement("button");
      button.className = "paper__slides-request";
      button.type = "button";
      button.dataset[view.action === "retry" ? "retrySlides" : "requestSlides"] = paperId;
      button.textContent = view.action === "retry" ? "もう一度依頼する" : "スライド案を作る";
      body.replaceChildren(status, button);
    } else body.replaceChildren(status);
  }
  return true;
}

// --- Relevance scanning ----------------------------------------------------
// With tens of thousands of papers, the reader's real question while
// scrolling is "is this in my field?" — and answering it should NOT require
// opening each paper. Two signals do that work: (1) an always-visible
// abstract dek so every card states its own topic, and (2) when searching,
// the query is highlighted and the dek is re-anchored to the first match so
// the matched context is in view without expanding.

const SNIPPET_LEAD = 70; // chars of context kept before the first match
const CLAMP_MIN = 140; // abstracts shorter than this need no "more" toggle

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Only ever emit http(s) links; anything else (e.g. a javascript: URI that
// slipped into the source data) collapses to "#". papers.json is generated
// from arXiv/OpenAlex, so this is defense-in-depth, not a known vector.
function safeHref(url) {
  return url && /^https?:\/\//i.test(url) ? url : "#";
}

// Wrap every case-insensitive occurrence of `escQuery` inside the
// already-HTML-escaped `escText` with <mark>. Matching on escaped text on
// both sides keeps it consistent (e.g. "&" -> "&amp;" on each side) and the
// markup safe — the only tags ever injected are our own <mark>.
function highlightTerms(escText, escQuery) {
  if (!escQuery) return escText;
  return escText.replace(new RegExp(escapeRegExp(escQuery), "gi"), (m) => `<mark class="hl">${m}</mark>`);
}

// Build the abstract dek. When the query hits the abstract, slice a window
// that begins a little before the first match (snapped to a word boundary)
// so the highlighted term lands inside the 2-line clamp; otherwise show from
// the top. `rawQuery` is the already-lowercased/trimmed search string.
function buildAbstractView(abstract, rawQuery) {
  const escQuery = rawQuery ? escapeHtml(rawQuery) : "";
  if (rawQuery) {
    const i = abstract.toLowerCase().indexOf(rawQuery);
    if (i > SNIPPET_LEAD) {
      let start = i - SNIPPET_LEAD;
      const sp = abstract.lastIndexOf(" ", start);
      if (sp > 0) start = sp + 1;
      const sliced = abstract.slice(start);
      const lead = '<span aria-hidden="true">… </span>';
      return { html: lead + highlightTerms(escapeHtml(sliced), escQuery), len: sliced.length };
    }
  }
  return { html: highlightTerms(escapeHtml(abstract), escQuery), len: abstract.length };
}

// `revealIndex` opts a row into the staggered entrance: null = no animation
// (the default for filter/search re-renders, which must not re-animate on
// every keystroke), or a small integer used as the stagger step. Only the
// first paint and "show more" appends pass it.
function renderPaper(p, idx, revealIndex = null) {
  const typeClass = p.type === "Oral" ? "paper__type--oral" : "paper__type--poster";
  const isOral = p.type === "Oral";
  const isSelected = p.paper_id === state.selectedPaperId;
  const reveal = revealIndex !== null;
  const paperCls = `paper${isOral ? " paper--oral" : ""}${
    isSelected ? " paper--selected" : ""
  }${reveal ? " paper--reveal" : ""}`;
  const revealStyle = reveal ? ` style="--i:${Math.min(revealIndex, 8)}"` : "";
  const q = state.search.toLowerCase().trim();
  const escQuery = q ? escapeHtml(q) : "";

  const tagsHtml = p.tags.map((t) => {
    const active = state.activeTags.has(t) ? " is-active" : "";
    return `<button class="paper__tag${active}" data-tag="${escapeHtml(t)}" type="button">${escapeHtml(t)}</button>`;
  }).join("");
  const authorPreview = p.authors.slice(0, 4).join(", ") + (p.authors.length > 4 ? `, +${p.authors.length - 4}` : "");
  const titleHtml = highlightTerms(escapeHtml(p.title), escQuery);
  const linksHtml = [
    p.arxiv_url ? `<a href="${escapeHtml(safeHref(p.arxiv_url))}" target="_blank" rel="noopener">arXiv</a>` : "",
    p.pdf_url ? `<a href="${escapeHtml(safeHref(p.pdf_url))}" target="_blank" rel="noopener">PDF</a>` : "",
  ].filter(Boolean).join("");

  const detail = state.fullAbstractById.get(p.paper_id);
  const fullAbstract = isSelected && detail?.status === "ready" ? detail.text : null;
  const displayedAbstract = fullAbstract === null ? p.abstract : fullAbstract;
  const hasAbstract = displayedAbstract && displayedAbstract.length > 0;
  let abstractHtml = "";
  let expandBtn = "";
  if (hasAbstract) {
    const view = fullAbstract === null
      ? buildAbstractView(displayedAbstract, q)
      : {
          html: highlightTerms(escapeHtml(displayedAbstract), escQuery),
          len: displayedAbstract.length,
        };
    const needsToggle = !isSelected && view.len > CLAMP_MIN;
    const abstractClass = `paper__abstract${needsToggle ? " is-clamped" : ""}${
      fullAbstract !== null ? " is-full" : ""
    }`;
    abstractHtml = `<p class="${abstractClass}" id="abstract-${escapeHtml(p.paper_id)}">${view.html}</p>`;
    if (needsToggle) {
      expandBtn = `<button class="paper__expand-btn" type="button" aria-expanded="false" aria-controls="abstract-${escapeHtml(p.paper_id)}">続きを読む</button>`;
    }
  }
  // No separate "matched in body" badge: the dek is windowed to the first
  // match, so the highlighted term is always already on screen — that IS the
  // relevance signal, and a per-card badge would be noise on body-wide queries.
  const detailStatus = isSelected && detail?.status === "loading"
    ? '<p class="paper__detail-status" role="status">全文要旨を読み込み中…</p>'
    : isSelected && detail?.status === "failed"
      ? '<p class="paper__detail-status paper__detail-status--error" role="status">全文要旨を読み込めませんでした。プレビューと原文リンクを表示しています。</p>'
      : isSelected && detail?.status === "ready" && fullAbstract === ""
        ? '<p class="paper__detail-status" role="status">全文要旨は収録されていません。</p>'
        : "";
  const selectionControls = isSelected
    ? `<div class="paper__selection-controls">
        <span class="paper__selected-label">選択中</span>
        <button class="paper__close" type="button" data-close-paper="${escapeHtml(p.paper_id)}">詳細を閉じる</button>
      </div>`
    : `<button class="paper__select" type="button" data-select-paper="${escapeHtml(p.paper_id)}" aria-expanded="false">内容を見る</button>`;
  const relationsHtml = isSelected ? renderRelationsSection(p) : "";
  const slidesHtml = isSelected ? renderPublicSlidesSection(p) : "";

  return `
    <li class="${paperCls}" data-idx="${idx}" data-paper-id="${escapeHtml(p.paper_id)}" id="paper-${escapeHtml(p.paper_id)}"${revealStyle}>
      <span class="paper__type ${typeClass}">${escapeHtml(p.type)}</span>
      <div class="paper__body">
        <h2 class="paper__title" id="paper-heading-${escapeHtml(p.paper_id)}"${isSelected ? ' tabindex="-1"' : ""}>
          <a href="${escapeHtml(safeHref(p.arxiv_url || p.pdf_url))}" target="_blank" rel="noopener">${titleHtml}</a>
        </h2>
        <p class="paper__authors">${escapeHtml(authorPreview || "—")}</p>
        ${selectionControls}
        <div class="paper__detail-body" data-detail-body="${escapeHtml(p.paper_id)}">
          ${abstractHtml}
          ${expandBtn}
          ${detailStatus}
        </div>
        ${tagsHtml ? `<div class="paper__tags">${tagsHtml}</div>` : ""}
        ${linksHtml ? `<div class="paper__meta">${linksHtml}</div>` : ""}
        ${slidesHtml}
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

function getDisplayPapers() {
  const filtered = getSorted(getFiltered());
  const selected = state.selectedPaperId
    ? state.paperById.get(state.selectedPaperId) || null
    : null;
  return pinSelected(filtered, selected);
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

// The results line doubles as the search's "response": when a query is
// active it echoes the term in an editorial serif-italic so the filter reads
// as a deliberate answer, not just a counter. The query is escaped — it is
// user input rendered via innerHTML.
function setResultsMeta(shown, filteredLen, total) {
  const count =
    shown < filteredLen
      ? `${shown} / ${filteredLen} 件を表示${filteredLen < total ? `（全 ${total} 件）` : ""}`
      : `${filteredLen} / ${total} 件`;
  const q = state.search.trim();
  // The echo is aria-hidden: results-meta is an aria-live region, and the
  // user just typed the query — re-announcing the partial term on every
  // debounced keystroke is noise. Screen readers hear only the count.
  const message = state.selectionMessage
    ? `<span class="results-meta__notice">${escapeHtml(state.selectionMessage)}</span>`
    : "";
  els.resultsMeta.innerHTML = (q
    ? `<span class="results-meta__q" aria-hidden="true">«${escapeHtml(q)}»</span>${count}`
    : count) + message;
}

// `animate` triggers the staggered entrance on the first paint only; filter /
// search / sort re-renders pass false so the list doesn't re-animate on every
// debounced keystroke.
function renderList(animate = false) {
  const sorted = getDisplayPapers();
  const total = state.papers.length;
  updateClearButton();

  if (sorted.length === 0) {
    setResultsMeta(0, 0, total);
    els.list.innerHTML = `<li class="empty-state">条件に一致する論文がありません。${hasActiveFilters() ? ' <button class="empty-state__clear" type="button" id="empty-clear">フィルタを解除</button>' : ""}</li>`;
    return;
  }

  const shown = Math.min(state.visibleCount, sorted.length);
  setResultsMeta(shown, sorted.length, total);

  // slice from 0, so the map index IS the absolute index into `sorted`.
  let html = sorted.slice(0, shown).map((p, i) => renderPaper(p, i, animate ? i : null)).join("");
  if (shown < sorted.length) html += moreSentinelHtml(sorted.length - shown);
  els.list.innerHTML = html;
}

// URL state: filters / search / sort live in the query string so a
// filtered view is shareable, survives reload, and the back button
// restores it. Read once at init; written via replaceState on every
// mutation (NOT pushState — filter twiddles must not pile up in history).
// Params are omitted when they equal defaults so the common URL stays clean:
//   q=<search>   type=Oral|Poster   tags=a,b,c   sort=newest|oral|title
let _urlSyncSuppressed = false;
const _SORTS = ["default", "newest", "oral", "title"];

function readUrlState() {
  _urlSyncSuppressed = true;
  try {
    state.search = "";
    state.type = "all";
    state.sort = "default";
    state.activeTags = new Set();
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (typeof q === "string") state.search = q;
    const type = params.get("type");
    if (type === "Oral" || type === "Poster" || type === "all") state.type = type;
    const sort = params.get("sort");
    if (sort && _SORTS.includes(sort)) state.sort = sort;
    const tags = params.get("tags");
    if (tags) state.activeTags = new Set(tags.split(",").map((t) => t.trim()).filter(Boolean));
  } catch (e) {
    console.warn("[url-state] read failed:", e);
  } finally {
    _urlSyncSuppressed = false;
  }
}

function syncUrlState() {
  if (_urlSyncSuppressed) return;
  try {
    const url = new URL(window.location.href);
    const p = url.searchParams;
    const q = state.search.trim();
    if (q) p.set("q", q); else p.delete("q");
    if (state.type !== "all") p.set("type", state.type); else p.delete("type");
    if (state.activeTags.size > 0) p.set("tags", [...state.activeTags].join(",")); else p.delete("tags");
    if (state.sort !== "default") p.set("sort", state.sort); else p.delete("sort");
    history.replaceState(history.state, "", url.toString());
  } catch (e) {
    console.warn("[url-state] sync failed:", e);
  }
}

function applyPaperFromUrl(origin) {
  const { raw, paperId } = readPaperParam(window.location.search);
  state.selectionMessage = "";
  if (raw === null) {
    state.selectedPaperId = null;
    state.selectedOrigin = null;
    return;
  }
  if (!paperId) {
    state.selectedPaperId = null;
    state.selectedOrigin = null;
    state.selectionMessage = "論文IDの形式が正しくありません。通常の一覧を表示しています。";
    return;
  }
  if (!state.paperById.has(paperId)) {
    state.selectedPaperId = null;
    state.selectedOrigin = null;
    state.selectionMessage = "指定された論文はこの学会カタログにありません。通常の一覧を表示しています。";
    return;
  }
  state.selectedPaperId = paperId;
  state.selectedOrigin = origin;
}

function placeSelectedPaper({ focus = false, scroll = true } = {}) {
  const paperId = state.selectedPaperId;
  if (!paperId) return;
  requestAnimationFrame(() => {
    const card = document.getElementById(`paper-${paperId}`);
    const heading = document.getElementById(`paper-heading-${paperId}`);
    if (scroll && card) card.scrollIntoView({ block: "start" });
    if (focus && heading) heading.focus({ preventScroll: true });
  });
}

function updateFullAbstractSection(paperId) {
  if (state.selectedPaperId !== paperId) return false;
  const paper = state.paperById.get(paperId);
  const detail = state.fullAbstractById.get(paperId);
  const body = document.querySelector(
    `.paper[data-paper-id="${CSS.escape(paperId)}"] .paper__detail-body`,
  );
  if (!paper || !detail || !body) return false;

  const children = [];
  const displayedAbstract = detail.status === "ready" ? detail.text : paper.abstract;
  if (displayedAbstract) {
    const abstract = document.createElement("p");
    abstract.className = `paper__abstract${detail.status === "ready" ? " is-full" : ""}`;
    abstract.id = `abstract-${paperId}`;
    // Detail shards are data, not markup. textContent also avoids rebuilding
    // or disconnecting any of the selected card's controls.
    abstract.textContent = displayedAbstract;
    children.push(abstract);
  }

  const status = document.createElement("p");
  status.className = "paper__detail-status";
  status.setAttribute("role", "status");
  if (detail.status === "loading") {
    status.textContent = "全文要旨を読み込み中…";
    children.push(status);
  } else if (detail.status === "failed") {
    status.classList.add("paper__detail-status--error");
    status.textContent = "全文要旨を読み込めませんでした。プレビューと原文リンクを表示しています。";
    children.push(status);
  } else if (detail.status === "ready" && detail.text === "") {
    status.textContent = "全文要旨は収録されていません。";
    children.push(status);
  }
  body.replaceChildren(...children);
  return true;
}

function abortFullAbstractLoad(paperId) {
  const controller = state.fullAbstractAbortByPaperId.get(paperId);
  if (!controller) return;
  state.fullAbstractAbortByPaperId.delete(paperId);
  if (state.fullAbstractById.get(paperId)?.status === "loading") {
    state.fullAbstractById.delete(paperId);
  }
  controller.abort();
}

function startFullAbstractLoad(paperId) {
  if (state.fullAbstractById.has(paperId)) return;
  const controller = new AbortController();
  state.fullAbstractAbortByPaperId.set(paperId, controller);
  state.fullAbstractById.set(paperId, { status: "loading", text: null });
  let resolved = false;
  fetch(detailShardUrl(paperId), { cache: "no-cache", signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`detail shard HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      if (state.fullAbstractAbortByPaperId.get(paperId) !== controller) return;
      const text = readDetailAbstract(data, paperId);
      state.fullAbstractById.set(paperId, { status: "ready", text });
      resolved = true;
    })
    .catch((error) => {
      if (state.fullAbstractAbortByPaperId.get(paperId) !== controller) return;
      if (error?.name === "AbortError") {
        state.fullAbstractById.delete(paperId);
        return;
      }
      console.warn("[catalog] full abstract unavailable:", error);
      state.fullAbstractById.set(paperId, { status: "failed", text: null });
      resolved = true;
    })
    .finally(() => {
      if (state.fullAbstractAbortByPaperId.get(paperId) === controller) {
        state.fullAbstractAbortByPaperId.delete(paperId);
      }
      if (!resolved || state.selectedPaperId !== paperId) return;
      updateFullAbstractSection(paperId);
    });
}

function abortPublicSlidesLoad(paperId) {
  const owner = state.publicSlideAbortByPaperId.get(paperId);
  if (!owner) return;
  state.publicSlideAbortByPaperId.delete(paperId);
  if (state.publicSlidesByPaperId.get(paperId)?.status === "loading") {
    state.publicSlidesByPaperId.delete(paperId);
  }
  owner.abandon();
}

function readPaperSlideSession(paperId) {
  if (!PAPER_SLIDE_API) return null;
  try {
    const key = paperSlideSessionKey(paperId);
    const serialized = window.sessionStorage?.getItem(key);
    if (serialized === null || serialized === undefined) return null;
    const value = parsePaperSlideSession(serialized, paperId);
    if (!value) window.sessionStorage.removeItem(key);
    return value;
  } catch (_) {
    return null;
  }
}

function writePaperSlideSession(value) {
  const serialized = serializePaperSlideSession(value);
  if (!serialized) return false;
  try {
    window.sessionStorage?.setItem(paperSlideSessionKey(value.paper_id), serialized);
    return true;
  } catch (_) {
    return false;
  }
}

function clearPaperSlideSession(paperId) {
  try {
    window.sessionStorage?.removeItem(paperSlideSessionKey(paperId));
  } catch (_) {
    // Storage can be disabled. The in-memory owner is still stopped below.
  }
}

function stopPaperSlidePolling(paperId, { clearSession = false } = {}) {
  const owner = state.paperSlidePollByPaperId.get(paperId);
  if (owner) {
    owner.stopped = true;
    if (owner.timer !== null) clearTimeout(owner.timer);
    owner.timer = null;
    owner.controller?.abort(new DOMException("paper-slide polling stopped", "AbortError"));
    owner.controller = null;
    state.paperSlidePollByPaperId.delete(paperId);
  }
  if (clearSession) clearPaperSlideSession(paperId);
}

function abandonPaperSlideRequest(paperId) {
  stopPaperSlidePolling(paperId);
  state.paperSlideRequestsByPaperId.delete(paperId);
}

async function readPaperSlideJson(response) {
  const contentType = response?.headers?.get?.("content-type") || "";
  const declared = response?.headers?.get?.("content-length");
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return null;
  if (declared !== null && declared !== undefined && declared !== "") {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > PAPER_SLIDE_RESPONSE_MAX_BYTES) {
      return null;
    }
  }
  if (typeof response?.body?.getReader !== "function") return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => {});
      return null;
    }
    total += value.byteLength;
    if (total > PAPER_SLIDE_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (_) {
    return null;
  }
}

function updatePaperSlideRequestSection(paperId, { focus = false } = {}) {
  if (state.selectedPaperId !== paperId) return false;
  const updated = updatePublicSlidesSection(paperId);
  if (updated && focus) {
    document.getElementById(`slides-heading-${paperId}`)?.focus({ preventScroll: true });
  }
  return updated;
}

function paperSlideLocalFailure(paperId, message, retryable = false) {
  state.paperSlideRequestsByPaperId.set(paperId, {
    status: "failed",
    phase: null,
    coverage: null,
    retryable,
    localMessage: message,
  });
  stopPaperSlidePolling(paperId, { clearSession: !retryable });
  updatePaperSlideRequestSection(paperId);
}

async function verifyPublishedPaperSlide(paperId, status, owner) {
  state.paperSlideRequestsByPaperId.set(paperId, {
    status: "published_verifying",
    phase: null,
    coverage: status.coverage,
    retryable: false,
  });
  updatePaperSlideRequestSection(paperId);
  const controller = new AbortController();
  owner.controller = controller;
  const deadline = setTimeout(() => {
    controller.abort(new DOMException("published slide verification timed out", "TimeoutError"));
  }, PUBLIC_SLIDE_LOOKUP_TIMEOUT_MS);
  let verified = null;
  try {
    verified = await loadPublicSlideState(paperId, { signal: controller.signal });
  } catch (_) {
    verified = null;
  } finally {
    clearTimeout(deadline);
    if (owner.controller === controller) owner.controller = null;
  }
  if (owner.stopped || state.paperSlidePollByPaperId.get(paperId) !== owner) return;
  if (verified?.state === "published"
      && publicSlideEntryMatchesStatus(verified.entry, status)) {
    state.publicSlidesByPaperId.set(paperId, {
      status: verified.state,
      entry: verified.entry,
    });
    state.paperSlideRequestsByPaperId.delete(paperId);
    stopPaperSlidePolling(paperId, { clearSession: true });
    updatePaperSlideRequestSection(paperId);
    return;
  }
  paperSlideLocalFailure(
    paperId,
    "公開情報の一致を確認できませんでした。原論文リンクをご利用ください。",
    false,
  );
}

function schedulePaperSlidePoll(owner) {
  if (owner.stopped || state.paperSlidePollByPaperId.get(owner.paperId) !== owner) return;
  if (Date.now() - owner.startedAt >= PAPER_SLIDE_POLL_MAX_MS) {
    paperSlideLocalFailure(
      owner.paperId,
      "状態確認をいったん終了しました。このタブを再読み込みすると確認を再開できます。",
      true,
    );
    return;
  }
  if (document.hidden) return;
  const delay = paperSlidePollDelay(owner.attempt);
  owner.attempt += 1;
  owner.timer = setTimeout(() => {
    owner.timer = null;
    pollPaperSlideStatus(owner);
  }, delay);
}

async function pollPaperSlideStatus(owner) {
  const { paperId, credentials } = owner;
  if (owner.stopped || document.hidden || state.selectedPaperId !== paperId
      || state.paperSlidePollByPaperId.get(paperId) !== owner) return;
  const controller = new AbortController();
  owner.controller = controller;
  const requestDeadline = setTimeout(() => {
    controller.abort(new DOMException("paper-slide status timed out", "TimeoutError"));
  }, PAPER_SLIDE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${PAPER_SLIDE_API}/api/paper-slides/status`, {
      method: "POST",
      headers: {
        authorization: `PaperSlide ${credentials.status_cap}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ request_id: credentials.request_id }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    const raw = response?.status === 200 ? await readPaperSlideJson(response) : null;
    const status = parsePaperSlideStatusResponse(raw, credentials.request_id, paperId);
    if (!status) {
      paperSlideLocalFailure(
        paperId,
        "状態確認の応答を安全に検証できませんでした。原論文リンクをご利用ください。",
        false,
      );
      return;
    }
    if (!paperSlideStatusMayFollow(owner.lastStatus, status.status)
        || (owner.lastResponse
          && !paperSlideStatusResponseMayFollow(owner.lastResponse, status))) {
      paperSlideLocalFailure(
        paperId,
        "状態確認の順序を安全に検証できませんでした。原論文リンクをご利用ください。",
        false,
      );
      return;
    }
    owner.lastStatus = status.status;
    owner.lastResponse = status;
    state.paperSlideRequestsByPaperId.set(paperId, {
      status: status.status,
      phase: status.phase,
      coverage: status.coverage,
      retryable: status.retryable === true,
      localMessage: null,
    });
    updatePaperSlideRequestSection(paperId);
    if (status.status === "published") {
      await verifyPublishedPaperSlide(paperId, status, owner);
      return;
    }
    if (["failed", "rejected", "expired"].includes(status.status)) {
      clearPaperSlideSession(paperId);
      stopPaperSlidePolling(paperId);
      return;
    }
  } catch (_) {
    if (owner.stopped) return;
  } finally {
    clearTimeout(requestDeadline);
    if (owner.controller === controller) owner.controller = null;
  }
  schedulePaperSlidePoll(owner);
}

function beginPaperSlidePolling(credentials) {
  stopPaperSlidePolling(credentials.paper_id);
  const owner = {
    paperId: credentials.paper_id,
    credentials,
    startedAt: Date.now(),
    attempt: 0,
    lastStatus: "queued",
    lastResponse: null,
    timer: null,
    controller: null,
    stopped: false,
  };
  state.paperSlidePollByPaperId.set(credentials.paper_id, owner);
  pollPaperSlideStatus(owner);
  return owner;
}

function restorePaperSlideRequest(paperId) {
  if (state.paperSlidePollByPaperId.has(paperId)
      || state.paperSlideRequestsByPaperId.has(paperId)) return false;
  const credentials = readPaperSlideSession(paperId);
  if (!credentials) return false;
  state.paperSlideRequestsByPaperId.set(paperId, {
    status: "queued",
    phase: null,
    coverage: null,
    retryable: false,
    localMessage: null,
  });
  beginPaperSlidePolling(credentials);
  return true;
}

async function requestPaperSlide(paperId) {
  if (!PAPER_SLIDE_API || state.selectedPaperId !== paperId
      || state.paperSlidePollByPaperId.has(paperId)) return false;
  const paper = state.paperById.get(paperId);
  const publicResult = state.publicSlidesByPaperId.get(paperId);
  if (!paper || publicResult?.status !== "not_published"
      || paperSlideEligibility(paper, publicResult.status, PAPER_SLIDE_API).state !== "requestable") {
    return false;
  }
  const previousCredentials = readPaperSlideSession(paperId);
  clearPaperSlideSession(paperId);
  state.paperSlideRequestsByPaperId.set(paperId, {
    status: "submitting",
    phase: null,
    coverage: null,
    retryable: false,
    localMessage: null,
  });
  const owner = {
    paperId,
    credentials: null,
    startedAt: Date.now(),
    attempt: 0,
    lastStatus: "queued",
    lastResponse: null,
    timer: null,
    controller: new AbortController(),
    stopped: false,
  };
  state.paperSlidePollByPaperId.set(paperId, owner);
  updatePaperSlideRequestSection(paperId, { focus: true });
  const controller = owner.controller;
  const deadline = setTimeout(() => {
    controller.abort(new DOMException("paper-slide request timed out", "TimeoutError"));
  }, PAPER_SLIDE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${PAPER_SLIDE_API}/api/paper-slides`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paper_id: paperId,
        language: "ja",
        coverage_preference: "auto",
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    const raw = response?.status === 202 ? await readPaperSlideJson(response) : null;
    const created = parsePaperSlideRequestResponse(raw, paperId, previousCredentials);
    if (!created || owner.stopped || state.paperSlidePollByPaperId.get(paperId) !== owner) {
      if (!owner.stopped) {
        paperSlideLocalFailure(
          paperId,
          "生成依頼の応答を安全に検証できませんでした。原論文リンクをご利用ください。",
          false,
        );
      }
      return false;
    }
    owner.credentials = {
      paper_id: paperId,
      request_id: created.request_id,
      status_cap: created.status_cap,
    };
    writePaperSlideSession(owner.credentials);
    state.paperSlideRequestsByPaperId.set(paperId, {
      status: "queued",
      phase: null,
      coverage: null,
      retryable: false,
      localMessage: null,
    });
    updatePaperSlideRequestSection(paperId);
    owner.controller = null;
    pollPaperSlideStatus(owner);
    return true;
  } catch (error) {
    if (!owner.stopped && error?.name !== "AbortError") {
      paperSlideLocalFailure(
        paperId,
        "生成依頼を送信できませんでした。通信環境を確認して、もう一度お試しください。",
        true,
      );
    } else if (!owner.stopped) {
      paperSlideLocalFailure(paperId, "生成依頼が時間切れになりました。もう一度お試しください。", true);
    }
    return false;
  } finally {
    clearTimeout(deadline);
  }
}

function ensurePaperSlideConfirmationDialog() {
  if (paperSlideDialog?.isConnected) return paperSlideDialog;
  const dialog = document.createElement("dialog");
  dialog.className = "paper-slide-dialog";
  dialog.setAttribute("aria-labelledby", "paper-slide-dialog-title");
  dialog.setAttribute("aria-describedby", "paper-slide-dialog-description");

  const title = document.createElement("h2");
  title.id = "paper-slide-dialog-title";
  title.textContent = "スライド案を生成しますか？";
  const description = document.createElement("div");
  description.id = "paper-slide-dialog-description";
  for (const text of PAPER_SLIDE_CONFIRMATION.split("\n").filter(Boolean)) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    description.appendChild(paragraph);
  }
  const form = document.createElement("form");
  form.setAttribute("method", "dialog");
  form.className = "paper-slide-dialog__actions";
  const cancel = document.createElement("button");
  cancel.type = "submit";
  cancel.value = "cancel";
  cancel.textContent = "キャンセル";
  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.value = "confirm";
  confirm.className = "paper-slide-dialog__confirm";
  confirm.textContent = "生成を依頼する";
  form.append(cancel, confirm);
  dialog.append(title, description, form);

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dialog.close("cancel");
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close("cancel");
  });
  dialog.addEventListener("close", () => {
    const trigger = paperSlideDialogTrigger;
    const paperId = paperSlideDialogPaperId;
    paperSlideDialogTrigger = null;
    paperSlideDialogPaperId = null;
    if (dialog.returnValue === "confirm" && paperId !== null) {
      requestPaperSlide(paperId);
    } else {
      trigger?.focus?.({ preventScroll: true });
    }
  });
  document.body.appendChild(dialog);
  paperSlideDialog = dialog;
  // Kept as an own reference so initial focus never depends on querying or
  // on browser-specific autofocus timing.
  dialog.paperPilotCancelButton = cancel;
  return dialog;
}

function openPaperSlideConfirmation(paperId, trigger) {
  if (state.selectedPaperId !== paperId || !trigger) return false;
  const paper = state.paperById.get(paperId);
  const publicResult = state.publicSlidesByPaperId.get(paperId);
  if (!paper || publicResult?.status !== "not_published"
      || paperSlideEligibility(paper, publicResult.status, PAPER_SLIDE_API).state !== "requestable") {
    return false;
  }
  const dialog = ensurePaperSlideConfirmationDialog();
  if (dialog.open) return false;
  paperSlideDialogTrigger = trigger;
  paperSlideDialogPaperId = paperId;
  dialog.returnValue = "cancel";
  dialog.showModal();
  dialog.paperPilotCancelButton.focus({ preventScroll: true });
  return true;
}

function finishPublicSlidesLoad(paperId) {
  if (state.selectedPaperId !== paperId) return;
  const result = state.publicSlidesByPaperId.get(paperId);
  if (result?.status === "published") {
    stopPaperSlidePolling(paperId, { clearSession: true });
    state.paperSlideRequestsByPaperId.delete(paperId);
  } else if (result?.status === "not_published") {
    restorePaperSlideRequest(paperId);
  }
  const paperHeadingHadFocus = document.activeElement?.id === `paper-heading-${paperId}`;
  updatePublicSlidesSection(paperId);
  if (paperHeadingHadFocus) {
    document.getElementById(`slides-heading-${paperId}`)?.focus({ preventScroll: true });
  }
}

function startPublicSlidesLoad(paperId, timerHelpers) {
  const cached = state.publicSlidesByPaperId.get(paperId);
  if (cached && cached.status !== "unverified") {
    if (cached.status === "not_published") restorePaperSlideRequest(paperId);
    return;
  }
  if (cached) state.publicSlidesByPaperId.delete(paperId);
  let owner;
  owner = createPublicSlideDeadlineOwner(() => {
    if (state.publicSlideAbortByPaperId.get(paperId) !== owner) return;
    state.publicSlideAbortByPaperId.delete(paperId);
    state.publicSlidesByPaperId.set(paperId, { status: "unverified", entry: null });
    finishPublicSlidesLoad(paperId);
  }, timerHelpers);
  state.publicSlideAbortByPaperId.set(paperId, owner);
  state.publicSlidesByPaperId.set(paperId, { status: "loading", entry: null });
  let resolved = false;
  loadPublicSlideState(paperId, { signal: owner.controller.signal })
    .then((result) => {
      if (state.publicSlideAbortByPaperId.get(paperId) !== owner) return;
      owner.finish();
      state.publicSlidesByPaperId.set(paperId, {
        status: result.state,
        entry: result.entry,
      });
      resolved = true;
    })
    .catch((error) => {
      if (state.publicSlideAbortByPaperId.get(paperId) !== owner) return;
      owner.finish();
      if (error?.name === "AbortError") {
        state.publicSlidesByPaperId.delete(paperId);
        return;
      }
      state.publicSlidesByPaperId.set(paperId, { status: "unverified", entry: null });
      resolved = true;
    })
    .finally(() => {
      if (state.publicSlideAbortByPaperId.get(paperId) === owner) {
        state.publicSlideAbortByPaperId.delete(paperId);
      }
      if (!resolved || state.selectedPaperId !== paperId) return;
      finishPublicSlidesLoad(paperId);
    });
}

function selectPaper(paperId) {
  if (!isPaperId(paperId) || !state.paperById.has(paperId)) return;
  if (state.selectedPaperId && state.selectedPaperId !== paperId) {
    abortFullAbstractLoad(state.selectedPaperId);
    abortPublicSlidesLoad(state.selectedPaperId);
    abandonPaperSlideRequest(state.selectedPaperId);
  }
  state.selectionScrollY = window.scrollY;
  const historyEntries = buildSelectionHistoryEntries({
    currentState: window.history.state,
    currentUrl: window.location.href,
    paperId,
    visibleCount: state.visibleCount,
    scrollY: state.selectionScrollY,
  });
  window.history.replaceState(
    historyEntries.currentState,
    "",
    window.location.href,
  );
  state.selectedPaperId = paperId;
  state.selectedOrigin = "in-page";
  state.selectionMessage = "";
  window.history.pushState(
    historyEntries.selectedState,
    "",
    historyEntries.selectedUrl,
  );
  startFullAbstractLoad(paperId);
  startPublicSlidesLoad(paperId);
  renderList();
  placeSelectedPaper({ focus: true, scroll: true });
}

function focusAfterSelectionClosed(paperId) {
  requestAnimationFrame(() => {
    const returnedSelect = els.list
      ?.querySelector(`.paper__select[data-select-paper="${paperId}"]`);
    const target = returnedSelect || els.search || els.resultsClear || els.sort;
    target?.focus({ preventScroll: true });
  });
}

function closeSelectedPaper() {
  const paperId = state.selectedPaperId;
  if (!paperId) return;
  abortFullAbstractLoad(paperId);
  abortPublicSlidesLoad(paperId);
  abandonPaperSlideRequest(paperId);
  if (state.selectedOrigin === "in-page") {
    window.history.back();
    return;
  }
  window.history.replaceState(null, "", setPaperParam(window.location.href, null));
  state.selectedPaperId = null;
  state.selectedOrigin = null;
  state.selectionMessage = "";
  renderList();
  focusAfterSelectionClosed(paperId);
}

// Any change to the result SET (filter / search / sort) restarts the
// progressive reveal from the top; growing the window does not. The URL is
// rewritten here so every mutation path stays in sync in one place.
function resetAndRender() {
  state.visibleCount = PAGE_SIZE;
  syncUrlState();
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
  // Hierarchy instead of 18 flat chips: top 8 visible, the tail behind a
  // "+N" expander. An active tag in the tail forces the expanded state so
  // a filter restored from the URL is never invisibly on.
  const HEAD_COUNT = 8;
  const head = sorted.slice(0, HEAD_COUNT);
  const tail = sorted.slice(HEAD_COUNT);
  const tailActive = tail.some(([tag]) => state.activeTags.has(tag));
  const chip = ([tag, n]) =>
    `<button class="chip" data-tag="${escapeHtml(tag)}" type="button" aria-pressed="${state.activeTags.has(tag)}">${escapeHtml(tag)}<span class="chip__count">${n}</span></button>`;
  const tailHtml = tail.length
    ? `<span class="chips__tail" id="chips-tail"${tailActive ? "" : " hidden"}>${tail.map(chip).join("")}</span>` +
      (tailActive ? "" : `<button class="chip chip--more" type="button" aria-expanded="false" aria-controls="chips-tail">+${tail.length} タグ</button>`)
    : "";
  els.tagChips.innerHTML = head.map(chip).join("") + tailHtml;
  const more = els.tagChips.querySelector(".chip--more");
  if (more) {
    more.addEventListener("click", () => {
      const tail = els.tagChips.querySelector(".chips__tail");
      tail.hidden = false;
      // Removing the focused button would strand keyboard focus on <body>
      // (WCAG 2.4.3) — hand it to the first revealed chip before removal.
      const first = tail.querySelector(".chip");
      if (first) first.focus();
      more.remove();
    });
  }
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
  // Collapsible hero details — same idiom as theme.js's hero-toggle.
  if (els.heroToggle && els.heroDetails) {
    els.heroToggle.addEventListener("click", () => {
      const open = els.heroDetails.hidden;
      els.heroDetails.hidden = !open;
      els.heroToggle.setAttribute("aria-expanded", String(open));
    });
  }

  // Debounce the search: a full filter + innerHTML re-render on every
  // keystroke janks on the larger catalogs (ICLR ~1,700, CVPR 4,068 papers)
  // and punishes fast typists. 180ms keeps it responsive without re-rendering
  // mid-word.
  let searchDebounce;
  els.search.addEventListener("input", (e) => {
    state.search = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(resetAndRender, 180);
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
      const sorted = getDisplayPapers();
      const prevShown = Math.min(state.visibleCount, sorted.length);
      state.visibleCount += PAGE_SIZE;
      const shown = Math.min(state.visibleCount, sorted.length);

      const sentinel = els.list.querySelector(".list-more");
      if (sentinel) sentinel.remove();

      const rows = document.createElement("template");
      rows.innerHTML = sorted
        .slice(prevShown, shown)
        .map((p, i) => renderPaper(p, prevShown + i, i))
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
    const closeButton = e.target.closest(".paper__close[data-close-paper]");
    if (closeButton) {
      closeSelectedPaper();
      return;
    }
    const selectButton = e.target.closest(".paper__select[data-select-paper]");
    if (selectButton) {
      selectPaper(selectButton.dataset.selectPaper);
      return;
    }
    const slideButton = e.target.closest(
      ".paper__slides-request[data-request-slides], .paper__slides-request[data-retry-slides]",
    );
    if (slideButton) {
      const paperId = slideButton.dataset.requestSlides || slideButton.dataset.retrySlides;
      if (state.selectedPaperId !== paperId) return;
      openPaperSlideConfirmation(paperId, slideButton);
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
      const abs = expandBtn.closest(".paper").querySelector(".paper__abstract");
      if (abs) {
        const open = abs.classList.toggle("is-open");
        abs.classList.toggle("is-clamped", !open);
        expandBtn.setAttribute("aria-expanded", String(open));
        expandBtn.textContent = open ? "閉じる" : "続きを読む";
      }
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

  window.addEventListener("popstate", (event) => {
    const previousPaperId = state.selectedPaperId;
    const previousOrigin = state.selectedOrigin;
    const historyRestore = readCatalogHistoryRestore(event.state, state.papers.length);
    readUrlState();
    applyPaperFromUrl(event.state?.paperpilotPaperSelection ? "in-page" : "direct");
    if (previousPaperId && previousPaperId !== state.selectedPaperId) {
      abortFullAbstractLoad(previousPaperId);
      abortPublicSlidesLoad(previousPaperId);
      abandonPaperSlideRequest(previousPaperId);
    }
    if (els.search) els.search.value = state.search;
    if (els.sort) els.sort.value = state.sort;
    buildTypeChips();
    buildTagChips();
    state.visibleCount = historyRestore?.visibleCount ?? PAGE_SIZE;
    if (state.selectedPaperId) {
      startFullAbstractLoad(state.selectedPaperId);
      startPublicSlidesLoad(state.selectedPaperId);
    }
    renderList();
    if (state.selectedPaperId) {
      placeSelectedPaper({
        focus: shouldFocusSelectedPaperAfterPopstate(previousPaperId, state.selectedPaperId),
        scroll: true,
      });
    } else if (historyRestore) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: historyRestore.scrollY, behavior: "auto" });
        const returnedSelect = els.list.querySelector(
          `.paper__select[data-select-paper="${historyRestore.focusPaperId}"]`,
        );
        (returnedSelect || els.search)?.focus({ preventScroll: true });
      });
    } else if (previousPaperId && previousOrigin === "in-page") {
      // A same-document selection created by an older asset version has no
      // persisted snapshot. Preserve the former in-memory behavior for that
      // one transition; new entries always take the history-backed path.
      requestAnimationFrame(() => {
        window.scrollTo({ top: state.selectionScrollY, behavior: "auto" });
        const returnedSelect = els.list.querySelector(
          `.paper__select[data-select-paper="${previousPaperId}"]`,
        );
        (returnedSelect || els.search)?.focus({ preventScroll: true });
      });
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !state.selectedPaperId) return;
    const owner = state.paperSlidePollByPaperId.get(state.selectedPaperId);
    if (owner && !owner.stopped && owner.timer === null && owner.controller === null) {
      pollPaperSlideStatus(owner);
    }
  });
  window.addEventListener("pagehide", () => {
    for (const paperId of [...state.paperSlidePollByPaperId.keys()]) {
      abandonPaperSlideRequest(paperId);
    }
  });
}

// Set the "last updated" stat to the conference's real data date, read from
// the shared conferences.json (build_pages stamps `generated` = the newest
// papers_*.csv date). Slug is derived from the URL path. Best-effort: on any
// failure the "—" placeholder stays, which is more honest than a wrong date.
async function setLastUpdated() {
  if (!els.statUpdated) return;
  try {
    const slug =
      window.location.pathname
        .split("/")
        .filter((p) => p && !p.endsWith(".html"))
        .pop() || "";
    const res = await fetch("../conferences.json");
    if (!res.ok) return;
    const confs = await res.json();
    const entry = Array.isArray(confs) ? confs.find((c) => c.name === slug) : null;
    if (entry && entry.generated) els.statUpdated.textContent = entry.generated;
  } catch (_) {
    /* leave the placeholder */
  }
}

async function init() {
  try {
    const [papersRes, quality] = await Promise.all([
      // Default cache — papers.json is regenerated by the weekly collect
      // job, so _headers Cache-Control (max-age=300 + SWR=3600) is the
      // right policy. Stale within 5 min is fine; deploys evict edge.
      fetch(PAPERS_URL),
      loadCollectionQuality(),
    ]);
    if (!papersRes.ok) throw new Error(`papers HTTP ${papersRes.status}`);
    state.papers = await papersRes.json();
    state.paperById = validateCatalog(state.papers);
    state.collectionQuality = quality;
    if (lineageIsPublishable(quality)) {
      try {
        const loadedLineage = await LineageCore.fetchJsonWithSha256("lineage.json");
        if (LineageCore.qualityRowIsPublishable(quality, {
          artifactSha256: loadedLineage?.sha256,
        })) {
          const auditedLineage = LineageCore.parseArtifact(
            loadedLineage.data, { kind: "conference" },
          );
          if (auditedLineage) {
            state.lineage = auditedLineage;
            buildRelationsIndex();
            enableHeroLineage();
          }
        }
      } catch (error) {
        // Lineage is an optional audited enhancement. A transient lineage
        // fetch/hash failure must keep that affordance closed without taking
        // the independently valid conference catalog offline.
        console.warn("[catalog] audited lineage unavailable; keeping lineage closed:", error);
      }
    }
  } catch (e) {
    console.warn("[catalog] catalog load failed:", e);
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
  // "Last updated" = the real data collection date (from conferences.json),
  // not the page-load date. Best-effort: leave the "—" placeholder if the
  // index can't be read, since a wrong date is worse than none.
  setLastUpdated();

  // Hydrate filter state from the URL, then reflect it into the static
  // controls (the chips read state during their build below).
  readUrlState();
  applyPaperFromUrl("direct");
  if (els.search) els.search.value = state.search;
  if (els.sort) els.sort.value = state.sort;
  buildTypeChips();
  buildTagChips();
  bindEvents();
  setupBackToTop();
  if (state.selectedPaperId) {
    startFullAbstractLoad(state.selectedPaperId);
    startPublicSlidesLoad(state.selectedPaperId);
  }
  renderList(true);
  if (state.selectedPaperId) placeSelectedPaper({ focus: false, scroll: true });
}

// A back-to-top button for the long catalogs: after progressive reveal the
// sticky filter bar scrolls off, leaving no quick way back to search/filters.
// Injected here so it works on all 10 catalog pages without editing each HTML.
function setupBackToTop() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "back-to-top";
  btn.id = "back-to-top";
  btn.setAttribute("aria-label", "ページ上部（検索・絞り込み）へ戻る");
  btn.hidden = true;
  btn.innerHTML = '<span aria-hidden="true">↑</span> Top';
  document.body.appendChild(btn);
  const SHOW_AFTER = 600;
  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        btn.hidden = window.scrollY < SHOW_AFTER;
        ticking = false;
      });
    },
    { passive: true },
  );
  btn.addEventListener("click", () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    if (els.search) els.search.focus();
  });
}

if (globalThis.__PAPERPILOT_CATALOG_HISTORY_TEST__ === true) {
  globalThis.__test = Object.freeze({
    abortFullAbstractLoad,
    abortPublicSlidesLoad,
    abandonPaperSlideRequest,
    beginPaperSlidePolling,
    buildSelectionHistoryEntries,
    catalogState: state,
    ensurePaperSlideConfirmationDialog,
    openPaperSlideConfirmation,
    paperSlideRequestView,
    pollPaperSlideStatus,
    readCatalogHistoryRestore,
    readPaperSlideJson,
    renderPublicSlidesSection,
    requestPaperSlide,
    restorePaperSlideRequest,
    shouldFocusSelectedPaperAfterPopstate,
    stopPaperSlidePolling,
    startFullAbstractLoad,
    startPublicSlidesLoad,
    updateFullAbstractSection,
    updatePublicSlidesSection,
  });
} else {
  init();
}
