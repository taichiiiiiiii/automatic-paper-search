"use client";

/**
 * S0 search-first landing page (port of docs/index.html + the parts of
 * docs/assets/landing.js listed in this agent's brief: conference/paper
 * counts with the 複数/多数 fallback, the conference list (rendered from
 * build-time data since the UX audit, design 53),
 * example chips, pointer-gated initial focus, and the audited-lineage
 * shelf). The search box itself, its facets, full results, and the
 * detail dialog are owned by components/search/* (ported from
 * docs/assets/search.js / search-detail.js) and mounted here unchanged.
 *
 * The audited-lineage shelf (`#s0-lineages`, SCR-11,
 * docs/migration/safety-contracts.md) fetches `lineage-quality-v1.json`
 * and opens only for rows `lib/landing-lineage.ts` (which imports, not
 * re-ports, `lib/lineage/core.ts`'s `qualityRowIsEligible`) says are
 * eligible. Every other outcome -- the initial unresolved state, a
 * resolved-but-empty manifest, or any fetch/parse failure -- renders
 * the exact same truthful "closed" copy index.html ships statically,
 * so a visitor never sees a false "nothing published" vs. a false
 * "something published" state (fail closed).
 */
import { useEffect, useRef, useState } from "react";
import type { ConferenceSummary, DataResult } from "../../lib/data";
import { fetchConferences } from "../../lib/data";
import { fetchLineageQualityManifest } from "../../lib/data-lineage";
import {
  CONFERENCE_SECTION_LABEL,
  conferenceHref,
  deriveLandingConferenceState,
  type LandingConferenceState,
  PLACEHOLDER_COUNTS,
  UNKNOWN_COUNTS,
  venueLabel,
} from "../../lib/landing";
import {
  lineageShelfEmptyText,
  lineageShelfHref,
  lineageShelfLede,
  lineageShelfMeta,
  lineageShelfStaleNote,
  lineageShelfStatus,
  lineageShelfTier,
  selectLineageShelfRows,
} from "../../lib/landing-lineage";
import type { QualityRow } from "../../lib/lineage/core";
import { PublicationBadge } from "../lineage/publication-badge";
import { SearchArea, type SearchAreaHandle } from "../search/search-area";
import { SearchDetailDialog } from "../search/search-detail-dialog";
import styles from "./landing.module.css";

// "loading" is the pre-hydration / in-flight state. It used to be "closed",
// so the static HTML (what crawlers, no-JS readers and the first paint
// see) claimed "公開条件を満たす系譜は現在ありません" even while themes
// were published (design doc 48 P0-4). "closed" now means the manifest
// really resolved with no eligible row.
type LineageShelfState =
  | { kind: "loading" }
  | { kind: "closed" }
  | { kind: "failed" }
  | { kind: "open"; rows: QualityRow[] };

/** Latest moment the lineage shelf's manifest is fetched (see below). */
const SHELF_FETCH_FALLBACK_MS = 4000;

const EXAMPLE_CHIPS = ["diffusion", "3d gaussian", "reasoning"] as const;

export interface LandingProps {
  /** Conference counts + list read from conferences.json at build time
   * (app/page.tsx). When that read failed (`unknown`), the component
   * falls back to the runtime fetch it always used to do. */
  initialConferences?: LandingConferenceState;
}

function countsOf(state: LandingConferenceState | undefined) {
  return state?.kind === "loaded" ? { n: state.n, m: state.m } : PLACEHOLDER_COUNTS;
}

export function Landing({ initialConferences }: LandingProps = {}) {
  const loadedAtBuild = initialConferences?.kind === "loaded";
  const [counts, setCounts] = useState(() => countsOf(initialConferences));
  const [confList, setConfList] = useState<Array<{ name: string; papers: number }>>(() =>
    initialConferences?.kind === "loaded" ? initialConferences.list : [],
  );
  const [confLabel, setConfLabel] = useState(() =>
    initialConferences?.kind === "loaded" ? initialConferences.label : CONFERENCE_SECTION_LABEL,
  );
  const [lineageShelf, setLineageShelf] = useState<LineageShelfState>({ kind: "loading" });

  const searchAreaRef = useRef<SearchAreaHandle>(null);

  useEffect(() => {
    // The build already embedded the real list: nothing to fetch.
    if (loadedAtBuild) return;
    let cancelled = false;
    fetchConferences().then((result: DataResult<ConferenceSummary[]>) => {
      if (cancelled) return;
      if (result.status === "error") {
        setCounts(UNKNOWN_COUNTS);
        return;
      }
      const state = deriveLandingConferenceState(result.data);
      if (state.kind === "unknown") {
        setCounts(UNKNOWN_COUNTS);
        return;
      }
      setCounts({ n: state.n, m: state.m });
      setConfList(state.list);
      setConfLabel(state.label);
    });
    return () => {
      cancelled = true;
    };
  }, [loadedAtBuild]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Arriving at a section link (the header's 学会 -> /#s0-confs): show that
    // section instead of focusing the search box, whose focus() scrolled
    // the page back to the top (UX audit, design 53).
    const hash = window.location.hash.slice(1);
    const target = hash ? document.getElementById(decodeURIComponent(hash)) : null;
    if (target) {
      target.scrollIntoView?.({ block: "start" });
      return;
    }
    if (window.matchMedia?.("(pointer: fine)").matches) {
      searchAreaRef.current?.focusInput();
    }
  }, []);

  // The shelf sits below the fold at every width, so its manifest
  // (~126 KB) is fetched once the section comes within 600px of the
  // viewport, or after 4 s at the latest, so it never competes with the
  // first paint and the search index (UX audit, design 53). The timer
  // also covers contexts where IntersectionObserver never reports (a
  // background tab renders no frames); without IntersectionObserver it is
  // fetched right away. Eligibility is still checked here at runtime
  // against the live manifest (SCR-11), unchanged.
  const lineagesRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    function load() {
      if (started) return;
      started = true;
      observer?.disconnect();
      clearTimeout(timer);
      fetchLineageQualityManifest().then((result) => {
        if (cancelled) return;
        if (result.status === "error") {
          setLineageShelf({ kind: "failed" });
          return;
        }
        const rows = selectLineageShelfRows(result.data);
        setLineageShelf(rows.length > 0 ? { kind: "open", rows } : { kind: "closed" });
      });
    }
    const target = lineagesRef.current;
    if (typeof IntersectionObserver === "undefined" || target === null) {
      load();
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) load();
        },
        { rootMargin: "600px 0px" },
      );
      observer.observe(target);
      timer = setTimeout(load, SHELF_FETCH_FALLBACK_MS);
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, []);

  return (
    <main id="main-content" className={styles.s0}>
      {/* The lede is the page's visible h1 (it used to be a <p> under a
          screen-reader-only h1), so a first-time visitor reads what the
          site is before anything else. */}
      <h1 className={styles.lede} id="s0-lede">
        <em className={styles.ledeEm}>AI トップ会議</em>{" "}
        <span className={styles.ledeN} id="s0-n">
          {counts.n}
        </span>{" "}
        学会・
        <span className={styles.ledeN} id="s0-m">
          {counts.m}
        </span>{" "}
        本から論文を探す
      </h1>
      <p className={styles.sublede}>
        論文を検索するか、下の<a href="#s0-confs">学会カタログ</a>・
        <a href="#s0-lineages">テーマ別の系譜</a>から選べます。
      </p>

      <SearchArea handleRef={searchAreaRef} />

      <fieldset className={styles.examples} aria-label="検索の例">
        <span className={styles.examplesLabel}>例:</span>
        {EXAMPLE_CHIPS.map((query) => (
          <button
            key={query}
            type="button"
            className={styles.chip}
            data-query={query}
            onClick={() => searchAreaRef.current?.applyExampleQuery(query)}
          >
            {query}
          </button>
        ))}
      </fieldset>

      <details className={styles.nextSteps}>
        <summary>検索した後は？</summary>
        <ol>
          <li>結果のタイトルを選ぶと、学会カタログでその論文の詳細が開きます。</li>
          <li>公開中の系譜に入っている論文なら、詳細から系譜へ移れます。</li>
        </ol>
      </details>

      {/* Conference catalogs: always visible (they used to sit behind a
          small collapsed uppercase toggle, so the main way into the site's
          content was easy to miss). Rendered from build-time data, so the
          links exist without JavaScript. */}
      <section className={styles.confs} id="s0-confs" aria-labelledby="s0-confs-heading">
        <h2 className={styles.sectionHeading} id="s0-confs-heading">
          {confLabel}
        </h2>
        <p className={styles.sectionLede}>
          学会ごとの採択論文の一覧です。キーワードやタグで絞り込み、結果を書き出せます。
        </p>
        <ul className={styles.confsList} id="s0-confs-list" aria-labelledby="s0-confs-heading">
          {confList.map((conference) => (
            <li key={conference.name} className={styles.conf}>
              <a className={styles.confLink} href={conferenceHref(conference.name)}>
                <span className={styles.confName}>{venueLabel(conference.name)}</span>
                <span className={styles.confCount}>
                  {conference.papers.toLocaleString("en-US")} 本
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      {/* Audited-lineage shelf (SCR-11): fail-closed on any fetch/parse
          failure or on a resolved-but-empty manifest -- see this file's
          header comment. */}
      <section
        ref={lineagesRef}
        className={styles.lineages}
        id="s0-lineages"
        aria-labelledby="s0-lineages-heading"
      >
        <h2 className={styles.sectionHeading} id="s0-lineages-heading">
          テーマ別の系譜
        </h2>
        <p className={styles.sectionLede}>
          研究テーマごとに、論文どうしの関係（後継・拡張など）を家系図で示します。
          <span id="s0-lineage-note">{lineageShelfLede(lineageShelf.kind)}</span>
        </p>
        <p className="visually-hidden" id="s0-lineages-status" role="status">
          {lineageShelf.kind === "open"
            ? `${lineageShelf.rows.length} 件の系譜を表示しています。`
            : lineageShelfStatus(lineageShelf.kind)}
        </p>
        <ul className={styles.lineagesList} id="s0-lineages-list">
          {lineageShelf.kind === "open" ? (
            lineageShelf.rows.map((row) => {
              const stale = lineageShelfStaleNote(row);
              const tier = lineageShelfTier(row);
              return (
                <li key={row.collection_id} className={styles.lineageItem}>
                  <a className={styles.lineageLink} href={lineageShelfHref(row)}>
                    {row.label}
                  </a>
                  {tier !== null ? <PublicationBadge tier={tier} /> : null}
                  <span className={styles.lineageMeta}>{lineageShelfMeta(row)}</span>
                  {stale !== null ? <span className={styles.lineageStale}>{stale}</span> : null}
                </li>
              );
            })
          ) : (
            <li className={styles.lineageEmpty}>{lineageShelfEmptyText(lineageShelf.kind)}</li>
          )}
        </ul>
        <p className={styles.sectionLinks}>
          <a href="/themes/">
            テーマの一覧・依頼 <span aria-hidden="true">→</span>
          </a>
          <a href="/how-it-works/">
            線の色の意味 <span aria-hidden="true">→</span>
          </a>
        </p>
      </section>

      <SearchDetailDialog />
    </main>
  );
}
