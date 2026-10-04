"use client";

import { useEffect, useRef, useState } from "react";
import { buildTagChipGroups, buildTypeChips } from "../../lib/catalog-chips";
import {
  type AcceptanceType,
  CATALOG_LOAD_ERROR,
  PAGE_SIZE,
  type SortValue,
} from "../../lib/catalog-constants";
import type { CatalogCopy } from "../../lib/catalog-copy";
import {
  type CatalogPaper,
  isPaperId,
  pinSelected,
  readPaperParam,
  setPaperParam,
} from "../../lib/catalog-core";
import {
  fetchCatalogPapers,
  fetchFullAbstract,
  fetchPilotLineageIndex,
} from "../../lib/catalog-data";
import {
  buildSelectionHistoryEntries,
  readCatalogHistoryRestore,
  shouldFocusSelectedPaperAfterPopstate,
} from "../../lib/catalog-history";
import {
  createPilotLineageLookupOwner,
  type PilotLineageIndex,
  type PilotLineageLookupOwner,
  type PilotLineageStatus,
  resolvePilotLineageForSelection,
} from "../../lib/catalog-pilot-lineage";
import {
  getFiltered,
  getSorted,
  hasActiveFilters,
  newestAvailability,
} from "../../lib/catalog-sort";
import { buildCatalogUrl, readCatalogUrlState } from "../../lib/catalog-url-state";
import { BASE_PATH } from "../../lib/config";
import { CatalogBackToTop } from "./catalog-back-to-top";
import { CatalogFilters } from "./catalog-filters";
import { CatalogHero } from "./catalog-hero";
import type { FullAbstractState } from "./catalog-paper-card";
import { CatalogPaperCard } from "./catalog-paper-card";
import {
  appendRevealBatch,
  initialRevealBatch,
  type RevealBatch,
  resolveRevealIndex,
} from "./catalog-reveal";

const SEARCH_DEBOUNCE_MS = 180;

/**
 * The conference catalog page's client-side orchestrator -- ported from
 * docs/assets/app.js (`init`, `bindEvents`, `selectPaper`,
 * `closeSelectedPaper`, the `popstate` handler). Owns every piece of
 * mutable UI state the original kept on its module-level `state`
 * object; the pure decisions (filtering, sorting, chip grouping, URL
 * encoding, history-restore validation) all live in `lib/catalog-*.ts`
 * and are unit-tested there (test/catalog/) -- this component is the
 * thin, hand-verified wiring around them.
 */
export function CatalogApp({
  conf,
  generated,
  copy,
}: {
  conf: string;
  generated: string;
  copy: CatalogCopy;
}) {
  const [loadStatus, setLoadStatus] = useState<"loading" | "ok" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const hasAttemptedRef = useRef(false);
  const [papers, setPapers] = useState<CatalogPaper[]>([]);
  const [byId, setById] = useState<Map<string, CatalogPaper>>(new Map());

  const [searchInputValue, setSearchInputValue] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState<AcceptanceType>("all");
  const [sort, setSort] = useState<SortValue>("default");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [tagsManuallyExpanded, setTagsManuallyExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Which absolute positions in the displayed list currently animate in
  // (docs/assets/app.js `renderPaper`'s `revealIndex`): the initial-paint
  // batch, or a "show more" append batch -- null everywhere else (every
  // filter/search/sort/tag change and every popstate restore).
  const [revealBatch, setRevealBatch] = useState<RevealBatch | null>(null);

  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null);
  const [selectedOrigin, setSelectedOrigin] = useState<"in-page" | "direct" | null>(null);
  const [selectionMessage, setSelectionMessage] = useState("");

  const [fullAbstracts, setFullAbstracts] = useState<Map<string, FullAbstractState>>(new Map());
  const [pilotLineage, setPilotLineage] = useState<Map<string, PilotLineageStatus>>(new Map());

  // Mirrors of the latest render's state, read from callbacks that must
  // not re-subscribe on every state change (the popstate listener, the
  // full-abstract/pilot-lineage effects' "already cached?" checks).
  const latestRef = useRef({
    selectedPaperId,
    selectedOrigin,
    papersLength: papers.length,
    byId,
    fullAbstracts,
    pilotLineage,
  });
  useEffect(() => {
    latestRef.current = {
      selectedPaperId,
      selectedOrigin,
      papersLength: papers.length,
      byId,
      fullAbstracts,
      pilotLineage,
    };
  });

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusSelectedHeadingRef = useRef(false);
  // Ported from app.js's popstate handler's `else if (historyRestore)`
  // branch (app.js:1999-2006): set only when Back/Forward returns to the
  // LIST (no selected paper) and the LIST entry carries a restore
  // snapshot. Consumed once by the scroll/focus-restore effect below.
  const pendingListRestoreRef = useRef<{ scrollY: number; focusPaperId: string } | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const retryFocusPendingRef = useRef(false);
  const pilotIndexRef = useRef<PilotLineageIndex | null>(null);
  const pilotOwnerRef = useRef<PilotLineageLookupOwner | null>(null);

  // --- initial load + retry ------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce (below) is not read in the body -- it only forces a re-run when retry() bumps it.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      // The first load shows the loading skeleton; a retry (re-running
      // this same effect via `retryNonce`) keeps the failure row on
      // screen with its button disabled instead, matching
      // docs/assets/app.js `showCatalogLoadFailure`'s retry affordance.
      if (hasAttemptedRef.current) setRetrying(true);
      else setLoadStatus("loading");
      hasAttemptedRef.current = true;
      const result = await fetchCatalogPapers(conf);
      if (cancelled) return;
      setRetrying(false);
      if (result.status === "error") {
        setLoadStatus("error");
        setLoadError(result.error);
        return;
      }
      setPapers(result.papers);
      setById(result.byId);
      setLoadStatus("ok");

      const urlState = readCatalogUrlState(window.location.search);
      setSearch(urlState.search);
      setSearchInputValue(urlState.search);
      setType(urlState.type);
      setSort(urlState.sort);
      setActiveTags(urlState.activeTags);

      const { raw, paperId } = readPaperParam(window.location.search);
      let initialSelectedId: string | null = null;
      if (raw === null) {
        setSelectedPaperId(null);
        setSelectedOrigin(null);
        setSelectionMessage("");
      } else if (!paperId) {
        setSelectedPaperId(null);
        setSelectedOrigin(null);
        setSelectionMessage("論文IDの形式が正しくありません。通常の一覧を表示しています。");
      } else if (!result.byId.has(paperId)) {
        setSelectedPaperId(null);
        setSelectedOrigin(null);
        setSelectionMessage(
          "指定された論文はこの学会カタログにありません。通常の一覧を表示しています。",
        );
      } else {
        focusSelectedHeadingRef.current = false; // a direct/reload landing never steals focus
        setSelectedPaperId(paperId);
        setSelectedOrigin("direct");
        initialSelectedId = paperId;
      }

      // Stagger the very first paint's rows in -- mirrors
      // docs/assets/app.js `init()`'s single `renderList(true)` call.
      // Computed from local values (not the React state just scheduled
      // above, which has not committed yet) using the same pure
      // filter/sort/pin pipeline the render path uses.
      const initialFiltered = getFiltered(result.papers, {
        search: urlState.search,
        type: urlState.type,
        activeTags: urlState.activeTags,
      });
      const initialSorted = getSorted(initialFiltered, urlState.sort);
      const initialSelectedPaper = initialSelectedId
        ? (result.byId.get(initialSelectedId) ?? null)
        : null;
      const initialDisplay = pinSelected(initialSorted, initialSelectedPaper);
      setRevealBatch(initialRevealBatch(Math.min(PAGE_SIZE, initialDisplay.length)));
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [conf, retryNonce]);

  function retry() {
    if (retrying) return;
    retryFocusPendingRef.current = document.activeElement === retryButtonRef.current;
    setRetryNonce((n) => n + 1);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadError (below) is not read -- it re-runs this on a second consecutive failure (loadStatus stays "error").
  useEffect(() => {
    if (loadStatus !== "error" || !retryFocusPendingRef.current) return;
    retryFocusPendingRef.current = false;
    retryButtonRef.current?.focus({ preventScroll: true });
  }, [loadStatus, loadError]);

  // --- URL sync (search / type / tags / sort) ------------------------------
  // Written via replaceState on every change -- filter twiddles must not
  // pile up browser history (docs/assets/app.js `syncUrlState`).
  useEffect(() => {
    if (loadStatus !== "ok" || typeof window === "undefined") return;
    const url = buildCatalogUrl(window.location.href, { search, type, sort, activeTags });
    window.history.replaceState(window.history.state, "", url);
  }, [loadStatus, search, type, sort, activeTags]);

  // "新着順" is only usable when at least one loaded row carries an
  // arXiv id (docs/assets/app.js `applySortAvailability`).
  const newest = newestAvailability(papers);
  useEffect(() => {
    if (sort === "newest" && !newest.usable && papers.length > 0) setSort("default");
  }, [papers, sort, newest.usable]);

  // --- popstate (Back/Forward) --------------------------------------------
  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      const {
        selectedPaperId: previousPaperId,
        papersLength,
        byId: currentById,
      } = latestRef.current;
      const historyRestore = readCatalogHistoryRestore(event.state, papersLength);
      const urlState = readCatalogUrlState(window.location.search);
      setSearch(urlState.search);
      setSearchInputValue(urlState.search);
      setType(urlState.type);
      setSort(urlState.sort);
      setActiveTags(urlState.activeTags);

      const { raw, paperId } = readPaperParam(window.location.search);
      const nextSelectedId = paperId && currentById.has(paperId) ? paperId : null;
      if (raw !== null && !nextSelectedId) {
        setSelectionMessage(
          paperId
            ? "指定された論文はこの学会カタログにありません。通常の一覧を表示しています。"
            : "論文IDの形式が正しくありません。通常の一覧を表示しています。",
        );
      } else {
        setSelectionMessage("");
      }
      focusSelectedHeadingRef.current = shouldFocusSelectedPaperAfterPopstate(
        previousPaperId,
        nextSelectedId,
      );
      setSelectedPaperId(nextSelectedId);
      setSelectedOrigin(
        nextSelectedId
          ? event.state &&
            typeof event.state === "object" &&
            "paperpilotPaperSelection" in event.state
            ? "in-page"
            : "direct"
          : null,
      );
      // Mirrors app.js's `if (state.selectedPaperId) {...} else if
      // (historyRestore) {...}`: a selection restore is handled by the
      // "scroll/focus the selected card" effect; only a plain list
      // restore (no selection) needs the snapshot's scroll/focus target.
      pendingListRestoreRef.current =
        !nextSelectedId && historyRestore
          ? { scrollY: historyRestore.scrollY, focusPaperId: historyRestore.focusPaperId }
          : null;
      setVisibleCount(historyRestore?.visibleCount ?? PAGE_SIZE);
      // A popstate restore never animates either (docs/assets/app.js's
      // popstate handler calls the no-arg `renderList()`).
      setRevealBatch(null);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // --- full-abstract load for the selected card ----------------------------
  useEffect(() => {
    if (!selectedPaperId) return;
    const paperId = selectedPaperId;
    if (latestRef.current.fullAbstracts.has(paperId)) return;
    const controller = new AbortController();
    let settled = false;
    setFullAbstracts((prev) => new Map(prev).set(paperId, { status: "loading", text: null }));
    fetchFullAbstract(paperId, controller.signal)
      .then((res) => {
        settled = true;
        setFullAbstracts((prev) =>
          new Map(prev).set(
            paperId,
            res.status === "ready"
              ? { status: "ready", text: res.text }
              : { status: "failed", text: null },
          ),
        );
      })
      .catch((err: unknown) => {
        settled = true;
        if (err instanceof Error && err.name === "AbortError") {
          setFullAbstracts((prev) => {
            if (prev.get(paperId)?.status !== "loading") return prev;
            const next = new Map(prev);
            next.delete(paperId);
            return next;
          });
          return;
        }
        setFullAbstracts((prev) => new Map(prev).set(paperId, { status: "failed", text: null }));
      });
    return () => {
      if (settled) return;
      controller.abort();
      setFullAbstracts((prev) => {
        if (prev.get(paperId)?.status !== "loading") return prev;
        const next = new Map(prev);
        next.delete(paperId);
        return next;
      });
    };
  }, [selectedPaperId]);

  // --- pilot-lineage probe lookup for the selected card (SCR-19) ----------
  useEffect(() => {
    if (!selectedPaperId) return;
    const paperId = selectedPaperId;
    const cached = latestRef.current.pilotLineage.get(paperId);
    if (cached && cached !== "loading") return;
    let active = true;
    const owner = createPilotLineageLookupOwner(paperId, {}, () => {
      if (pilotOwnerRef.current !== owner) return;
      pilotOwnerRef.current = null;
      setPilotLineage((prev) => new Map(prev).set(paperId, "unavailable"));
    });
    pilotOwnerRef.current = owner;
    setPilotLineage((prev) => new Map(prev).set(paperId, "loading"));

    async function run() {
      let index = pilotIndexRef.current;
      if (!index) {
        try {
          index = await fetchPilotLineageIndex(owner.controller.signal);
        } catch {
          index = null;
        }
        if (!active || !owner.isActive()) return;
        if (index) pilotIndexRef.current = index;
      }
      if (!active || !owner.isActive()) return;
      owner.finish();
      if (pilotOwnerRef.current === owner) pilotOwnerRef.current = null;
      const entry = resolvePilotLineageForSelection(index, paperId, conf);
      setPilotLineage((prev) => new Map(prev).set(paperId, entry ? "ready" : "unavailable"));
    }
    run();
    return () => {
      active = false;
      if (pilotOwnerRef.current === owner) pilotOwnerRef.current = null;
      owner.abandon();
    };
  }, [selectedPaperId, conf]);

  // --- scroll/focus the selected card --------------------------------------
  useEffect(() => {
    if (!selectedPaperId) return;
    const id = selectedPaperId;
    const raf = requestAnimationFrame(() => {
      document.getElementById(`paper-${id}`)?.scrollIntoView({ block: "start" });
      if (focusSelectedHeadingRef.current) {
        document.getElementById(`paper-heading-${id}`)?.focus({ preventScroll: true });
        focusSelectedHeadingRef.current = false;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedPaperId]);

  // --- scroll/focus restore for a plain list return (Back/Forward) --------
  // Ported from app.js's popstate handler's `else if (historyRestore)`
  // branch (app.js:1999-2006): restores the scroll position the reader
  // was at before selecting a paper, and returns keyboard focus to that
  // paper's select button -- falling back to the search input if the
  // list has since changed and that paper is no longer rendered.
  useEffect(() => {
    if (selectedPaperId) return;
    const pending = pendingListRestoreRef.current;
    if (!pending) return;
    pendingListRestoreRef.current = null;
    const raf = requestAnimationFrame(() => {
      window.scrollTo({ top: pending.scrollY, behavior: "auto" });
      const returnedSelect = document.querySelector<HTMLElement>(
        `[data-select-paper="${pending.focusPaperId}"]`,
      );
      (returnedSelect ?? document.getElementById("search"))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
    // `visibleCount` is not read in this body; the one transition this
    // effect cares about always sets it in the SAME batched update as
    // `selectedPaperId` (the popstate handler above), so by the time
    // this effect runs the DOM already reflects both.
  }, [selectedPaperId]);

  // --- user-driven mutations ------------------------------------------------
  function resetReveal() {
    setVisibleCount(PAGE_SIZE);
    // Filter/search/sort/tag changes never animate -- only the initial
    // paint and "show more" appends do (docs/assets/app.js `renderList`
    // default `animate = false`).
    setRevealBatch(null);
  }

  function onSearchInput(value: string) {
    setSearchInputValue(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearch(value);
      resetReveal();
    }, SEARCH_DEBOUNCE_MS);
  }

  function onTypeChange(value: AcceptanceType) {
    setType(value);
    resetReveal();
  }

  function onSortChange(value: SortValue) {
    setSort(value);
    resetReveal();
  }

  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
    resetReveal();
  }

  function addTagFromCard(tag: string) {
    setActiveTags((prev) => new Set(prev).add(tag));
    resetReveal();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function clearAllFilters() {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setSearchInputValue("");
    setSearch("");
    setType("all");
    setActiveTags(new Set());
    resetReveal();
  }

  function selectPaper(paperId: string) {
    if (!isPaperId(paperId) || !byId.has(paperId)) return;
    // Switching away from a previous selection aborts its in-flight full
    // abstract / pilot-lineage lookups via those effects' own cleanup,
    // triggered below by the selectedPaperId change.
    const scrollY = window.scrollY;
    const entries = buildSelectionHistoryEntries({
      currentState: window.history.state,
      currentUrl: window.location.href,
      paperId,
      visibleCount,
      scrollY,
    });
    window.history.replaceState(entries.currentState, "", window.location.href);
    focusSelectedHeadingRef.current = true;
    setSelectedPaperId(paperId);
    setSelectedOrigin("in-page");
    setSelectionMessage("");
    // Selecting a card re-renders the list (pinSelected moves it to the
    // front) but never animates (docs/assets/app.js's `selectPaper`
    // calls the no-arg `renderList()`).
    setRevealBatch(null);
    window.history.pushState(entries.selectedState, "", entries.selectedUrl);
  }

  function closeSelectedPaper() {
    if (!selectedPaperId) return;
    if (selectedOrigin === "in-page") {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", setPaperParam(window.location.href, null));
    setSelectedPaperId(null);
    setSelectedOrigin(null);
    setSelectionMessage("");
    // Same as selectPaper: closing re-renders without animating
    // (docs/assets/app.js's `closeSelectedPaper` calls `renderList()`).
    setRevealBatch(null);
  }

  function focusSearchInput() {
    document.getElementById("search")?.focus();
  }

  // --- derived display list -------------------------------------------------
  const filtered = getFiltered(papers, { search, type, activeTags });
  const sorted = getSorted(filtered, sort);
  const selectedPaper = selectedPaperId ? (byId.get(selectedPaperId) ?? null) : null;
  const displayPapers = pinSelected(sorted, selectedPaper);
  const shown = Math.min(visibleCount, displayPapers.length);
  const total = papers.length;
  const filteredLen = sorted.length;
  const allTags = new Set<string>();
  let oralCount = 0;
  for (const p of papers) {
    for (const t of p.tags) allTags.add(t);
    if (p.type === "Oral") oralCount += 1;
  }
  const tagGroups = buildTagChipGroups(papers, activeTags);
  const typeChips = buildTypeChips(papers);
  const tagsExpanded = tagsManuallyExpanded || tagGroups.tailActiveByDefault;
  const activeFilters = hasActiveFilters({ search, type, activeTags });
  // Review LOW: this used to point at the pre-port `paper-links.html`
  // filename; the ported no-JS route is `/<conf>/paper-links/`
  // (app/[conf]/paper-links/page.tsx, trailingSlash static export).
  const paperLinksHref = `${BASE_PATH}/${conf}/paper-links/`;
  const pilotLineageHref = `${BASE_PATH}/lineage/?paper=${encodeURIComponent(selectedPaperId ?? "")}`;

  return (
    <main id="main-content">
      <noscript>
        <div role="alert" className="border-b border-rule bg-oral-bg px-4 py-3 text-sm text-ink">
          <strong>JavaScript が必要です。</strong> 論文一覧の検索 / フィルタは JavaScript
          で動作します。{" "}
          <a href={paperLinksHref} className="underline">
            JavaScript なしの論文リンク一覧
          </a>
          も利用できます。
        </div>
      </noscript>

      <CatalogHero
        copy={copy}
        generated={generated}
        total={loadStatus === "ok" ? total : null}
        oralCount={loadStatus === "ok" ? oralCount : null}
        tagCount={loadStatus === "ok" ? allTags.size : null}
      />

      {loadStatus === "ok" && (
        <CatalogFilters
          search={searchInputValue}
          onSearchChange={onSearchInput}
          typeChips={typeChips}
          activeType={type}
          onTypeChange={onTypeChange}
          tagHead={tagGroups.head}
          tagTail={tagGroups.tail}
          tagTailExpanded={tagsExpanded}
          onExpandTags={() => setTagsManuallyExpanded(true)}
          activeTags={activeTags}
          onToggleTag={toggleTag}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3 sm:px-6">
        <p aria-live="polite" aria-atomic="true" className="text-sm text-ink-muted">
          {loadStatus === "loading" && "読み込み中…"}
          {loadStatus === "error" && `${CATALOG_LOAD_ERROR}再試行できます。`}
          {loadStatus === "ok" && (
            <>
              {search.trim() && (
                <span aria-hidden="true" className="mr-1 font-serif italic text-ink">
                  «{search.trim()}»
                </span>
              )}
              {filteredLen === 0
                ? "0 件"
                : shown < filteredLen
                  ? `${shown} / ${filteredLen} 件を表示${filteredLen < total ? `（全 ${total} 件）` : ""}`
                  : `${filteredLen} / ${total} 件`}
              {selectionMessage && (
                <span className="ml-2 text-accent-strong">{selectionMessage}</span>
              )}
            </>
          )}
        </p>
        <div className="flex items-center gap-3">
          {loadStatus === "ok" && activeFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="rounded-full border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
            >
              フィルタ解除 <span aria-hidden="true">×</span>
            </button>
          )}
          {loadStatus === "ok" && (
            <div className="flex items-center gap-2 text-sm">
              <label htmlFor="sort" className="text-ink-muted">
                並び替え
              </label>
              <select
                id="sort"
                value={sort}
                onChange={(e) => onSortChange(e.target.value as SortValue)}
                className="rounded-md border border-rule bg-surface-elevated px-2 py-1 text-ink"
              >
                <option value="default">収録順</option>
                <option value="newest" disabled={!newest.usable}>
                  {newest.label}
                </option>
                <option value="oral">Oral 優先</option>
                <option value="title">タイトル A→Z</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {loadStatus === "loading" && (
        <ul className="list-none p-0">
          <li className="px-4 py-10 text-center text-sm text-ink-subtle sm:px-6">
            論文一覧を読み込み中…
          </li>
        </ul>
      )}

      {loadStatus === "error" && (
        <ul className="list-none p-0">
          <li className="flex flex-col items-start gap-2 px-4 py-10 text-sm text-ink-muted sm:px-6">
            <span>{CATALOG_LOAD_ERROR}</span>
            <span className="flex flex-wrap items-center gap-2">
              <a href={paperLinksHref} className="text-accent hover:text-accent-strong">
                JavaScript なしの論文リンク一覧
              </a>
              から探すか、
              <button
                ref={retryButtonRef}
                type="button"
                id="catalog-retry"
                disabled={retrying}
                onClick={retry}
                className="rounded-full border border-rule px-3 py-1 text-ink hover:border-rule-strong"
              >
                再試行
              </button>
              してください。
            </span>
          </li>
        </ul>
      )}

      {loadStatus === "ok" && (
        <ul id="paper-list" className="list-none p-0">
          {filteredLen === 0 ? (
            <li className="flex flex-col items-start gap-2 px-4 py-10 text-sm text-ink-muted sm:px-6">
              条件に一致する論文がありません。
              {activeFilters && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="rounded-full border border-rule px-3 py-1 text-ink hover:border-rule-strong"
                >
                  フィルタを解除
                </button>
              )}
            </li>
          ) : (
            <>
              {displayPapers.slice(0, shown).map((p, i) => (
                <CatalogPaperCard
                  key={p.paper_id}
                  paper={p}
                  isSelected={p.paper_id === selectedPaperId}
                  searchQuery={search}
                  activeTags={activeTags}
                  onAddTagFromCard={addTagFromCard}
                  onSelect={selectPaper}
                  onClose={closeSelectedPaper}
                  fullAbstract={fullAbstracts.get(p.paper_id)}
                  pilotLineage={
                    p.paper_id === selectedPaperId ? pilotLineage.get(p.paper_id) : undefined
                  }
                  pilotLineageHref={pilotLineageHref}
                  revealIndex={resolveRevealIndex(revealBatch, i)}
                />
              ))}
              {shown < displayPapers.length && (
                <li className="px-4 py-4 text-center sm:px-6">
                  <button
                    type="button"
                    id="list-more-btn"
                    onClick={() => {
                      const nextShown = Math.min(visibleCount + PAGE_SIZE, displayPapers.length);
                      setRevealBatch(appendRevealBatch(shown, nextShown));
                      setVisibleCount((v) => v + PAGE_SIZE);
                    }}
                    className="rounded-full border border-rule px-4 py-2 text-sm text-ink hover:border-rule-strong"
                  >
                    さらに表示{" "}
                    <span className="font-mono text-ink-subtle">
                      残り {displayPapers.length - shown} 件
                    </span>
                  </button>
                </li>
              )}
            </>
          )}
        </ul>
      )}

      <footer className="border-t border-rule px-4 py-6 text-xs text-ink-subtle sm:px-6">
        {copy.source && <span>Source: {copy.source}</span>}
      </footer>

      <CatalogBackToTop onReturnFocus={focusSearchInput} />
    </main>
  );
}
