"use client";

/**
 * Cross-conference search combobox + facets + full results (port of
 * docs/assets/search.js). The imperative structure (refs for the index
 * cache, the id-block cache, a monotonic `runSerial` to discard stale
 * async work, debounce/announce timers) mirrors the original closely on
 * purpose -- the original's own contract tests (ported to
 * test/search/*) pin that exact state machine, not just its outputs.
 *
 * DOM mutation (`replaceChildren`, `.hidden`, `aria-*` attribute sets)
 * is replaced by React state; everything else -- when a fetch happens,
 * when the URL is read/written, when `history.pushState` vs
 * `replaceState` is used -- is unchanged.
 */
import type { MouseEvent as ReactMouseEvent, Ref } from "react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { fetchSearchIdBlock, loadSearchIndex } from "../../lib/data-search";
import {
  confLabel,
  type Filters,
  filtersFromUrl,
  MIN_QUERY,
  normalizeText,
  PAGE_SIZE,
  pageFromUrl,
  paginate,
  type ResolvedHit,
  rankResults,
  resultUrl,
  type SearchRow,
  searchUrl,
  urlHasDuplicateSearchState,
} from "../../lib/search-core";
import styles from "./search.module.css";

const DEBOUNCE_MS = 120;
const ANNOUNCE_MS = 500;

const EMPTY_FILTERS: Filters = { conference: "", year: null, type: "", invalid: false };

type FullResultsView =
  | { kind: "empty"; query: string; invalid: boolean }
  | {
      kind: "results";
      query: string;
      items: ResolvedHit[];
      allCount: number;
      page: number;
      totalPages: number;
      filters: Filters;
    };

export interface SearchAreaHandle {
  /** Fills the query, runs it through the normal debounce, and focuses
   * the input -- same sequence as landing.js's example-chip handler
   * (`input.value = ...; input.dispatchEvent(new Event("input")); ...`). */
  applyExampleQuery(query: string): void;
  /** landing.js focuses the search box on load only for fine-pointer
   * devices; exposed so components/landing/landing.tsx (which owns that
   * `matchMedia` check) can trigger it without reaching into the DOM. */
  focusInput(): void;
}

function shouldHandleLink(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function currentHref(): string {
  return window.location.href;
}

export function SearchArea({ handleRef }: { handleRef?: Ref<SearchAreaHandle> }) {
  const [queryValue, setQueryValue] = useState("");
  const queryRef = useRef("");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [retryVisible, setRetryVisible] = useState(false);

  const [suggestions, setSuggestions] = useState<ResolvedHit[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [moreHidden, setMoreHidden] = useState(true);
  const [moreHref, setMoreHref] = useState("?q=&page=1");
  const [moreLabel, setMoreLabel] = useState("すべての結果を見る");

  const [filtersHidden, setFiltersHidden] = useState(true);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [facetOptions, setFacetOptions] = useState<{
    conferences: string[];
    years: number[];
    types: Array<"Oral" | "Poster">;
  } | null>(null);

  const [fullResults, setFullResults] = useState<FullResultsView | null>(null);
  const [focusRequestId, setFocusRequestId] = useState(0);

  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);

  const indexRef = useRef<SearchRow[] | null>(null);
  const indexPromiseRef = useRef<Promise<SearchRow[]> | null>(null);
  const blockPromisesRef = useRef<Map<number, Promise<unknown>>>(new Map());
  const runSerialRef = useRef(0);
  const facetsPopulatedRef = useRef(false);
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const say = useCallback((message: string) => {
    clearTimeout(announceTimerRef.current);
    setStatus(message);
  }, []);

  const announce = useCallback((message: string) => {
    clearTimeout(announceTimerRef.current);
    announceTimerRef.current = setTimeout(() => setStatus(message), ANNOUNCE_MS);
  }, []);

  const clearSuggestions = useCallback(() => {
    setSuggestions(null);
    setMoreHidden(true);
    setActiveIndex(-1);
  }, []);

  const hideFullResults = useCallback(() => {
    setFullResults(null);
  }, []);

  const showError = useCallback(
    (error: unknown) => {
      console.warn("[search] search data failed validation or loading:", error);
      clearSuggestions();
      hideFullResults();
      setRetryVisible(true);
      say("検索データを読み込めませんでした。再試行してください。");
    },
    [clearSuggestions, hideFullResults, say],
  );

  async function ensureIndex(): Promise<SearchRow[]> {
    if (indexRef.current !== null) return indexRef.current;
    if (indexPromiseRef.current) return indexPromiseRef.current;
    say("検索索引を読み込み中…");
    const promise = loadSearchIndex()
      .then((result) => {
        if (result.status === "error") throw new Error(result.error);
        indexRef.current = result.data;
        return result.data;
      })
      .finally(() => {
        indexPromiseRef.current = null;
      });
    indexPromiseRef.current = promise;
    return promise;
  }

  async function ensureIdBlock(block: number) {
    const cached = blockPromisesRef.current.get(block);
    if (cached) return cached;
    const totalRows = indexRef.current?.length ?? 0;
    const promise = fetchSearchIdBlock(block, totalRows).then((result) => {
      if (result.status === "error") {
        blockPromisesRef.current.delete(block);
        throw new Error(result.error);
      }
      return result.data;
    });
    blockPromisesRef.current.set(block, promise);
    return promise;
  }

  async function resolvePaperIds(hits: ReturnType<typeof rankResults>): Promise<ResolvedHit[]> {
    const blocks = [...new Set(hits.map((hit) => Math.floor(hit.row[2] / 256)))];
    say("論文IDを解決中…");
    await Promise.all(blocks.map((block) => ensureIdBlock(block)));
    return Promise.all(
      hits.map(async (hit) => {
        const block = Math.floor(hit.row[2] / 256);
        const data = (await ensureIdBlock(block)) as { start: number; paper_ids: string[] };
        const paperId = data.paper_ids[hit.row[2] - data.start];
        if (!paperId || !/^[0-9a-f]{40}$/.test(paperId)) {
          throw new Error("paper ID reference is missing");
        }
        return { ...hit, paperId };
      }),
    );
  }

  function populateFacetsOnce(rows: SearchRow[]) {
    if (facetsPopulatedRef.current) return;
    const conferences = [...new Set(rows.map((row) => row[1]))].sort((a, b) =>
      confLabel(a).localeCompare(confLabel(b), "ja"),
    );
    const years = [
      ...new Set(rows.map((row) => row[5]).filter((y): y is number => y !== null)),
    ].sort((a, b) => b - a);
    const types = [...new Set(rows.map((row) => row[6]))];
    setFacetOptions({ conferences, years, types });
    facetsPopulatedRef.current = true;
  }

  function renderEmptyResults(query: string, invalid: boolean) {
    setFullResults({ kind: "empty", query, invalid });
    announce(invalid ? "無効な絞り込み条件のため検索結果は0件です。" : "検索結果は0件です。");
  }

  function renderSuggestions(
    resolved: ResolvedHit[],
    query: string,
    total: number,
    activeFilters: Filters,
  ) {
    setActiveIndex(-1);
    setSuggestions(resolved);
    setMoreHidden(false);
    setMoreHref(searchUrl(currentHref(), query, 1, activeFilters));
    setMoreLabel(`すべての ${total.toLocaleString("ja-JP")} 件を見る`);
    announce(`${total.toLocaleString("ja-JP")} 件中、上位 ${resolved.length} 件を表示中。`);
  }

  function renderFullResults(
    resolved: ResolvedHit[],
    allCount: number,
    query: string,
    page: number,
    totalPages: number,
    focusHeading: boolean,
    activeFilters: Filters,
  ) {
    setFullResults({
      kind: "results",
      query,
      items: resolved,
      allCount,
      page,
      totalPages,
      filters: activeFilters,
    });
    announce(`${allCount.toLocaleString("ja-JP")} 件、${page} ページ目を表示中。`);
    if (focusHeading) setFocusRequestId((id) => id + 1);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the omitted helpers (ensureIndex, resolvePaperIds, populateFacetsOnce, render*/showError) only ever touch refs and stable setState functions, never a captured state value directly -- they are intentionally re-created each render (like a vanilla-JS module's own function declarations) and adding them here would just thrash runQuery's identity without fixing anything.
  const runQuery = useCallback(
    async (
      query: string,
      requestedPage: number | null,
      options?: { focus?: boolean; invalidUrl?: boolean },
    ) => {
      const serial = ++runSerialRef.current;
      const normalized = normalizeText(query);
      setRetryVisible(false);
      if (Array.from(normalized).length < MIN_QUERY) {
        setBusy(false);
        clearSuggestions();
        hideFullResults();
        setFiltersHidden(true);
        say(normalized ? `${MIN_QUERY} 文字以上で検索します。` : "");
        return;
      }
      setBusy(true);
      try {
        const rows = await ensureIndex();
        if (serial !== runSerialRef.current) return;
        populateFacetsOnce(rows);
        const params = new URLSearchParams(window.location.search);
        const activeFilters = filtersFromUrl(params, rows);
        activeFilters.invalid = activeFilters.invalid || Boolean(options?.invalidUrl);
        setFilters(activeFilters);
        setFiltersHidden(false);
        const allHits = activeFilters.invalid ? [] : rankResults(rows, normalized, activeFilters);
        if (!allHits.length) {
          clearSuggestions();
          renderEmptyResults(query, activeFilters.invalid);
          return;
        }
        const hasFilters = Boolean(
          activeFilters.conference || activeFilters.year !== null || activeFilters.type,
        );
        if (requestedPage !== null || hasFilters) {
          clearSuggestions();
          const pageInfo = paginate(allHits, requestedPage === null ? 1 : requestedPage, PAGE_SIZE);
          if (pageInfo.page !== requestedPage) {
            window.history.replaceState(
              null,
              "",
              searchUrl(currentHref(), query, pageInfo.page, activeFilters),
            );
          }
          const resolved = await resolvePaperIds(pageInfo.items);
          if (serial !== runSerialRef.current) return;
          renderFullResults(
            resolved,
            allHits.length,
            query,
            pageInfo.page,
            pageInfo.totalPages,
            Boolean(options?.focus),
            activeFilters,
          );
        } else {
          hideFullResults();
          const resolved = await resolvePaperIds(allHits.slice(0, PAGE_SIZE));
          if (serial !== runSerialRef.current) return;
          renderSuggestions(resolved, query, allHits.length, activeFilters);
        }
      } catch (error) {
        if (serial === runSerialRef.current) showError(error);
      } finally {
        if (serial === runSerialRef.current) setBusy(false);
      }
    },
    [clearSuggestions, hideFullResults, say, showError],
  );

  const restoreFromUrl = useCallback(
    (options?: { focus?: boolean }) => {
      const params = new URLSearchParams(window.location.search);
      const query = params.get("q") || "";
      queryRef.current = query;
      setQueryValue(query);
      return runQuery(query, pageFromUrl(params), {
        ...options,
        invalidUrl: urlHasDuplicateSearchState(params),
      });
    },
    [runQuery],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: applyExampleQuery/focusInput are only invoked later from user events (never read during this render), and handleInputChange (defined below) only touches refs/stable setters -- the handle object itself never needs to change identity.
  useImperativeHandle(
    handleRef,
    () => ({
      applyExampleQuery(query: string) {
        handleInputChange(query);
        inputRef.current?.focus();
      },
      focusInput() {
        inputRef.current?.focus();
      },
    }),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once by design (matches the original docs/assets/search.js module, which wires these same listeners exactly once at load). restoreFromUrl/clearSuggestions close over refs and stable setState functions only, so freezing this closure at mount is safe, not stale.
  useEffect(() => {
    restoreFromUrl();
    function onPopState() {
      clearTimeout(inputTimerRef.current);
      restoreFromUrl();
    }
    function onDocumentClick(event: MouseEvent) {
      if (!formRef.current?.contains(event.target as Node)) clearSuggestions();
    }
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onDocumentClick);
    return () => {
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onDocumentClick);
      clearTimeout(inputTimerRef.current);
      clearTimeout(announceTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (focusRequestId > 0) resultsHeadingRef.current?.focus({ preventScroll: false });
  }, [focusRequestId]);

  function updateQueryUrl(query: string) {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    url.searchParams.delete("page");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function handleInputChange(value: string) {
    queryRef.current = value;
    setQueryValue(value);
    // The input keeps the raw value the user typed (including spaces),
    // matching search.js's own `input.value` -- but the URL and the
    // query actually run are always the trimmed form (search.js's
    // 'input' handler reads `input.value.trim()`), so leading/trailing
    // spaces never show up as a literal "+" in `?q=`.
    const trimmedQuery = value.trim();
    updateQueryUrl(trimmedQuery);
    clearTimeout(inputTimerRef.current);
    inputTimerRef.current = setTimeout(() => {
      runQuery(trimmedQuery, null);
    }, DEBOUNCE_MS);
  }

  function activeHref(): string | null {
    if (!suggestions?.length) return null;
    const hit = activeIndex >= 0 ? suggestions[activeIndex] : suggestions[0];
    if (!hit) return null;
    return resultUrl(hit.row, hit.paperId);
  }

  function move(delta: number) {
    if (!suggestions?.length) return;
    setActiveIndex((prev) => {
      const next = (prev + delta + suggestions.length) % suggestions.length;
      itemRefs.current[next]?.scrollIntoView({ block: "nearest" });
      return next;
    });
  }

  function applyFilters(nextFilters: Filters) {
    const query = queryRef.current.trim();
    window.history.pushState(null, "", searchUrl(currentHref(), query, 1, nextFilters));
    runQuery(query, 1);
  }

  function handleFacetChange(field: "conference" | "year" | "type", rawValue: string) {
    applyFilters({
      conference: field === "conference" ? rawValue : filters.conference,
      year: field === "year" ? (rawValue ? Number(rawValue) : null) : filters.year,
      type: field === "type" ? rawValue : filters.type,
      invalid: false,
    });
  }

  function handleMoreClick(event: ReactMouseEvent) {
    if (!shouldHandleLink(event)) return;
    event.preventDefault();
    const query = queryRef.current.trim();
    window.history.pushState(null, "", searchUrl(currentHref(), query, 1, EMPTY_FILTERS));
    runQuery(query, 1, { focus: true });
  }

  function handlePagerClick(event: ReactMouseEvent, page: number, activeFilters: Filters) {
    if (!shouldHandleLink(event)) return;
    event.preventDefault();
    const query = queryRef.current.trim();
    window.history.pushState(null, "", searchUrl(currentHref(), query, page, activeFilters));
    runQuery(query, page, { focus: true });
  }

  function handleRetry() {
    indexRef.current = null;
    indexPromiseRef.current = null;
    blockPromisesRef.current.clear();
    restoreFromUrl();
  }

  const headingText = fullResults ? `「${fullResults.query}」の検索結果` : "検索結果";
  const summaryText =
    fullResults?.kind === "empty"
      ? fullResults.invalid
        ? "指定された絞り込み条件が無効です。絞り込みをクリアしてください。"
        : "0 件。短いキーワードに変えるか、絞り込みをクリアしてください。タイトル・著者・タグから検索できます。"
      : fullResults?.kind === "results"
        ? (() => {
            const start = (fullResults.page - 1) * PAGE_SIZE + 1;
            const end = start + fullResults.items.length - 1;
            return `${fullResults.allCount.toLocaleString("ja-JP")} 件中 ${start}〜${end} 件`;
          })()
        : "";

  const resetDisabled = !(
    filters.invalid ||
    filters.conference ||
    filters.year !== null ||
    filters.type
  );

  return (
    <>
      {/* <search> supplies the landmark role docs/index.html got from
          role="search"; the nested <form> stays a real <form> so
          submission (Enter -> navigate to the active result) still works. */}
      <search className={styles.searchLandmark}>
        <form
          ref={formRef}
          className={styles.siteSearch}
          data-search=""
          autoComplete="off"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            const href = activeHref();
            if (href) window.location.href = href;
          }}
        >
          <label className={styles.label} htmlFor="s0-search-input">
            タイトル・著者・タグで横断検索
          </label>
          <input
            ref={inputRef}
            id="s0-search-input"
            className={styles.input}
            type="search"
            name="q"
            placeholder="例: diffusion, 3d gaussian, reasoning"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="s0-search-listbox"
            aria-expanded={suggestions !== null && suggestions.length > 0}
            aria-activedescendant={activeIndex >= 0 ? `site-search-opt-${activeIndex}` : undefined}
            aria-describedby="s0-search-help s0-search-status"
            autoComplete="off"
            spellCheck={false}
            value={queryValue}
            onChange={(event) => handleInputChange(event.target.value)}
            onBlur={(event) => {
              if (!formRef.current?.contains(event.relatedTarget as Node)) clearSuggestions();
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Escape") {
                clearSuggestions();
                say("");
              }
            }}
          />
          <p className={styles.searchHelp} id="s0-search-help">
            2文字以上で検索。タイトル・著者・タグが対象です。要旨・本文の全文検索には未対応です。
          </p>
          <p className={styles.status} id="s0-search-status" role="status">
            {status}
          </p>
          <button
            type="button"
            className={styles.retry}
            id="s0-search-retry"
            hidden={!retryVisible}
            onClick={handleRetry}
          >
            再試行
          </button>
          {/* biome-ignore-start lint/a11y/noNoninteractiveElementToInteractiveRole: ul/li + listbox/option is the ARIA 1.2 combobox-with-listbox pattern (W3C APG), ported verbatim from docs/index.html's #s0-search-listbox. */}
          <ul
            className={styles.results}
            id="s0-search-listbox"
            role="listbox"
            aria-label="検索結果"
            tabIndex={-1}
            hidden={!suggestions || suggestions.length === 0}
          >
            {(suggestions ?? []).map((hit, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: this pattern keeps focus on the combobox <input> (aria-activedescendant), never on the option itself -- the option is deliberately not in the tab order, matching docs/assets/search.js.
              <li
                key={`${hit.row[1]}-${hit.row[2]}`}
                id={`site-search-opt-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
              >
                <a tabIndex={-1} href={resultUrl(hit.row, hit.paperId)}>
                  <span className={styles.title}>{hit.row[0]}</span>
                  <span className={styles.meta}>
                    {[
                      confLabel(hit.row[1]),
                      hit.row[5] !== null ? String(hit.row[5]) : null,
                      hit.row[6],
                      hit.matchLabel,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" · ")}
                  </span>
                  {hit.row[3].length > 0 && (
                    <span className={styles.authors}>
                      {hit.row[3].length > 3
                        ? `${hit.row[3].slice(0, 3).join(", ")} ほか`
                        : hit.row[3].join(", ")}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
          {/* biome-ignore-end lint/a11y/noNoninteractiveElementToInteractiveRole: end of the ARIA combobox-listbox range started above */}
          <a
            className={styles.more}
            id="s0-search-more"
            href={moreHref}
            hidden={moreHidden}
            onClick={handleMoreClick}
          >
            {moreLabel}
          </a>
        </form>
      </search>

      <fieldset className={styles.filters} id="s0-search-filters" hidden={filtersHidden}>
        <legend className={styles.filtersLegend}>検索結果を絞り込む</legend>
        <div className={styles.filtersControls}>
          <label className={styles.filtersField} htmlFor="s0-filter-conference">
            学会
            <select
              className={styles.filtersSelect}
              id="s0-filter-conference"
              name="conference"
              value={filters.conference}
              onChange={(event) => handleFacetChange("conference", event.target.value)}
            >
              <option value="">すべての学会</option>
              {(facetOptions?.conferences ?? []).map((slug) => (
                <option key={slug} value={slug}>
                  {confLabel(slug)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filtersField} htmlFor="s0-filter-year">
            年
            <select
              className={styles.filtersSelect}
              id="s0-filter-year"
              name="year"
              value={filters.year === null ? "" : String(filters.year)}
              onChange={(event) => handleFacetChange("year", event.target.value)}
            >
              <option value="">すべての年</option>
              {(facetOptions?.years ?? []).map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filtersField} htmlFor="s0-filter-type">
            発表種別
            <select
              className={styles.filtersSelect}
              id="s0-filter-type"
              name="type"
              value={filters.type}
              onChange={(event) => handleFacetChange("type", event.target.value)}
            >
              <option value="">すべての発表種別</option>
              {(facetOptions?.types ?? []).map((type) => (
                <option key={type} value={type}>
                  {type === "Oral" ? "口頭発表 (Oral)" : "ポスター (Poster)"}
                </option>
              ))}
            </select>
          </label>
          <button
            className={styles.filtersReset}
            id="s0-filter-reset"
            type="button"
            disabled={resetDisabled}
            onClick={() => applyFilters(EMPTY_FILTERS)}
          >
            絞り込みをクリア
          </button>
        </div>
      </fieldset>

      <section
        className={styles.resultsSection}
        id="s0-results"
        aria-labelledby="s0-results-heading"
        aria-busy={busy}
        hidden={fullResults === null}
      >
        <h2
          className={styles.resultsHeading}
          id="s0-results-heading"
          tabIndex={-1}
          ref={resultsHeadingRef}
        >
          {headingText}
        </h2>
        <p className={styles.resultsSummary} id="s0-results-summary">
          {summaryText}
        </p>
        <ol className={styles.resultsList} id="s0-results-list">
          {fullResults?.kind === "results" &&
            fullResults.items.map((hit) => (
              <li key={`${hit.row[1]}-${hit.row[2]}`} className={styles.resultsItem}>
                <a
                  className={`${styles.resultsLink} s0-results__link`}
                  href={resultUrl(hit.row, hit.paperId)}
                >
                  <span className={styles.title}>{hit.row[0]}</span>
                  <span className={styles.meta}>
                    {[
                      confLabel(hit.row[1]),
                      hit.row[5] !== null ? String(hit.row[5]) : null,
                      hit.row[6],
                      hit.matchLabel,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" · ")}
                  </span>
                  {hit.row[3].length > 0 && (
                    <span className={styles.authors}>
                      {hit.row[3].length > 3
                        ? `${hit.row[3].slice(0, 3).join(", ")} ほか`
                        : hit.row[3].join(", ")}
                    </span>
                  )}
                </a>
              </li>
            ))}
        </ol>
        <nav className={styles.pagination} id="s0-results-pagination" aria-label="検索結果ページ">
          {fullResults?.kind === "results" && fullResults.page > 1 && (
            <a
              className={styles.pagerLink}
              href={searchUrl(
                typeof window !== "undefined" ? window.location.href : "https://example.test/",
                fullResults.query,
                fullResults.page - 1,
                fullResults.filters,
              )}
              rel="prev"
              onClick={(event) =>
                handlePagerClick(event, fullResults.page - 1, fullResults.filters)
              }
            >
              ← 前へ
            </a>
          )}
          {fullResults?.kind === "results" && (
            <span className={styles.pagePosition}>
              {fullResults.page} / {fullResults.totalPages} ページ
            </span>
          )}
          {fullResults?.kind === "results" && fullResults.page < fullResults.totalPages && (
            <a
              className={styles.pagerLink}
              href={searchUrl(
                typeof window !== "undefined" ? window.location.href : "https://example.test/",
                fullResults.query,
                fullResults.page + 1,
                fullResults.filters,
              )}
              rel="next"
              onClick={(event) =>
                handlePagerClick(event, fullResults.page + 1, fullResults.filters)
              }
            >
              次へ →
            </a>
          )}
        </nav>
      </section>
    </>
  );
}
